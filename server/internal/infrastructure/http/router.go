package http

import (
	"log/slog"
	"net/http"

	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/ws"
)

// Router wires every route of the server. No third-party router: the pattern
// matching of net/http since Go 1.22 covers what we need.
func Router(sessions *SessionHandler, sockets *ws.Handler, cfg config.Config, log *slog.Logger, ready func() bool) http.Handler {
	mux := http.NewServeMux()

	// REST.
	mux.Handle("POST /api/v1/sessions", Chain(
		http.HandlerFunc(sessions.Create),
		RateLimitByIP(cfg.CreateSessionPerMinute),
	))
	mux.HandleFunc("GET /api/v1/sessions/{id}", sessions.Get)
	mux.HandleFunc("GET /api/v1/sessions/by-code/{code}", sessions.ByCode)
	mux.HandleFunc("DELETE /api/v1/sessions/{id}", sessions.Delete)

	// WebSocket: one endpoint per role.
	mux.HandleFunc("GET /ws/v1/maestro", sockets.Maestro)
	mux.HandleFunc("GET /ws/v1/perform", sockets.Perform)

	// Probes.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ready != nil && !ready() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "draining"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	return Chain(mux, Recover(log), RequestLog(log), CORS(cfg))
}
