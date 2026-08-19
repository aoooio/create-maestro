// Command maestro-server is the composition root: it reads the configuration,
// wires the layers together and owns the lifecycle of the process.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/aoooio/create-maestro/server/internal/application/usecase"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/clock"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
	maestrohttp "github.com/aoooio/create-maestro/server/internal/infrastructure/http"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/idgen"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/observability"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/persistence"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/ws"
)

// janitorPeriod is how often abandoned sessions are swept.
const janitorPeriod = time.Minute

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "maestro-server:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := observability.NewLogger(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(log)
	if len(cfg.AllowedOrigins) == 0 {
		log.Warn("ALLOWED_ORIGINS is empty: every browser origin is accepted")
	}

	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	// --- wiring: infrastructure → application → domain ---
	serverClock := clock.NewMonotonic()
	repo := persistence.NewMemorySessionRepo()
	ids := idgen.New()
	codec := ws.NewCodec(ids, serverClock)
	hub := ws.NewHub(codec, log)
	usecases := usecase.New(repo, serverClock, hub, ids, ids, usecase.Options{
		TriggerEcho:     cfg.TriggerEcho,
		DefaultMaxUsers: cfg.DefaultMaxUsers,
		DefaultBPM:      cfg.DefaultBPM,
		GroupLabels:     cfg.GroupLabels,
	})
	sockets := ws.NewHandler(usecases, hub, codec, cfg, log)
	sessions := maestrohttp.NewSessionHandler(usecases, cfg, log)

	var draining atomic.Bool
	router := maestrohttp.Router(sessions, sockets, cfg, log, func() bool { return !draining.Load() })

	// --- background workers ---
	workersCtx, stopWorkers := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		hub.Run(workersCtx)
	}()
	go func() {
		defer workers.Done()
		repo.StartJanitor(workersCtx, janitorPeriod, cfg.SessionTTL, func(dropped int) {
			log.Info("purged abandoned sessions", slog.Int("count", dropped))
		})
	}()

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// No WriteTimeout on purpose: it applies to the whole connection and
		// would cut every WebSocket after a few seconds. Each connection sets
		// its own per-frame deadlines instead (§3.6).
	}

	listenErr := make(chan error, 1)
	go func() { listenErr <- server.ListenAndServe() }()
	log.Info("maestro-server listening",
		slog.String("addr", cfg.Addr),
		slog.Int("maxUsers", cfg.DefaultMaxUsers),
		slog.Any("groups", cfg.GroupLabels))

	select {
	case err := <-listenErr:
		stopWorkers()
		workers.Wait()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		log.Info("shutdown requested")
	}

	// Stop advertising readiness first, so a load balancer stops sending new
	// clients while the ones already here are told to go away.
	draining.Store(true)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown did not complete cleanly", slog.Any("error", err))
	}
	// Shutdown ignores hijacked connections, so the hub closes them itself.
	stopWorkers()
	sockets.Wait()
	workers.Wait()
	log.Info("maestro-server stopped")
	return nil
}
