package ws

import (
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"

	"github.com/aoooio/create-maestro/server/internal/application/usecase"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/httperr"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/observability"
)

// Handler serves the two role endpoints. There is deliberately no `role`
// parameter: the role comes from the URL and is settled before the upgrade,
// so no code path lets a musician reach a maestro command.
type Handler struct {
	uc       *usecase.Usecases
	hub      *Hub
	codec    *Codec
	cfg      config.Config
	log      *slog.Logger
	upgrader websocket.Upgrader

	// conns tracks the live connections so that shutdown can wait for them.
	// draining is guarded by mu and makes the Add of a newcomer mutually
	// exclusive with Wait, which a bare WaitGroup does not allow.
	mu       sync.Mutex
	draining bool
	conns    sync.WaitGroup
}

// NewHandler wires the WebSocket endpoints.
func NewHandler(uc *usecase.Usecases, hub *Hub, codec *Codec, cfg config.Config, log *slog.Logger) *Handler {
	return &Handler{
		uc:       uc,
		hub:      hub,
		codec:    codec,
		cfg:      cfg,
		log:      log,
		upgrader: newUpgrader(cfg),
	}
}

// Maestro serves GET /ws/v1/maestro?session={id}&token={maestroToken}.
func (h *Handler) Maestro(w http.ResponseWriter, r *http.Request) {
	h.accept(w, r, session.RoleMaestro)
}

// Perform serves GET /ws/v1/perform?session={id}&name={pseudo}.
func (h *Handler) Perform(w http.ResponseWriter, r *http.Request) {
	h.accept(w, r, session.RoleMusician)
}

// Wait stops accepting new connections and blocks until every live one has
// finished, so that the process does not exit while a close frame is still in
// flight.
func (h *Handler) Wait() {
	h.mu.Lock()
	h.draining = true
	h.mu.Unlock()
	h.conns.Wait()
}

// track registers a newcomer, unless the server is already draining.
func (h *Handler) track() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.draining {
		return false
	}
	h.conns.Add(1)
	return true
}

func (h *Handler) accept(w http.ResponseWriter, r *http.Request, role session.Role) {
	query := r.URL.Query()
	sid := session.SessionID(query.Get("session"))
	if sid == "" {
		httperr.Write(w, session.Invalidf("the session parameter is required"))
		return
	}
	token := session.Token(query.Get("token"))

	// Everything that can be refused is refused before the upgrade: a full
	// session or a bad token never costs us a connection.
	if err := h.uc.PreflightJoin(r.Context(), sid, role, token); err != nil {
		h.log.Info("upgrade refused",
			slog.String("sessionId", string(sid)),
			slog.String("role", role.String()),
			slog.String("code", string(session.CodeOf(err))))
		httperr.Write(w, err)
		return
	}

	// Claim a slot before upgrading: a server on its way out must not hijack
	// a connection nobody will ever wait for.
	if !h.track() {
		w.Header().Set("Retry-After", "5")
		httperr.WriteStatus(w, http.StatusServiceUnavailable,
			session.CodeInternal, "server is shutting down", true)
		return
	}
	defer h.conns.Done()

	ws, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade has already written its own response.
		h.log.Info("upgrade failed", slog.Any("error", err))
		return
	}

	conn := &Connection{
		ws:        ws,
		hub:       h.hub,
		codec:     h.codec,
		uc:        h.uc,
		log:       observability.Session(h.log, sid).With(slog.String("role", role.String())),
		sessionID: sid,
		role:      role,
		token:     token,
		queryName: query.Get("name"),
		readLimit: h.cfg.MaxMessageBytes,
		out:       make(chan frame, outBuffer),
		closing:   make(chan struct{}),
		limiter:   rate.NewLimiter(rate.Limit(h.cfg.RateSustained), h.cfg.RateBurst),
	}

	// The connection is served on the request goroutine: once hijacked, this
	// goroutine belongs to the socket, and keeping it here keeps the request
	// context alive for the whole life of the connection.
	conn.serve(r.Context())
}
