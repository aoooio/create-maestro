// Package http exposes the REST surface: creating a session, reading its
// public state, resolving a short code, closing it.
package http

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/aoooio/create-maestro/server/internal/application/usecase"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/httperr"
)

// maxRequestBytes caps a REST body. Nothing we accept is remotely this big.
const maxRequestBytes = 8 << 10

// SessionHandler serves the session resources.
type SessionHandler struct {
	uc  *usecase.Usecases
	cfg config.Config
	log *slog.Logger
}

// NewSessionHandler builds the REST handlers.
func NewSessionHandler(uc *usecase.Usecases, cfg config.Config, log *slog.Logger) *SessionHandler {
	return &SessionHandler{uc: uc, cfg: cfg, log: log}
}

type createSessionRequest struct {
	MaxUsers    int      `json:"maxUsers"`
	BPM         float64  `json:"bpm"`
	GroupLabels []string `json:"groupLabels"`
	Strategy    string   `json:"strategy"`
}

type createSessionResponse struct {
	SessionID    string      `json:"sessionId"`
	JoinCode     string      `json:"joinCode"`
	MaestroToken string      `json:"maestroToken"`
	MaestroURL   string      `json:"maestroUrl"`
	JoinURL      string      `json:"joinUrl"`
	MaxUsers     int         `json:"maxUsers"`
	Groups       []groupView `json:"groups"`
}

type groupView struct {
	ID    int    `json:"id"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type publicStateResponse struct {
	SessionID    string      `json:"sessionId"`
	JoinCode     string      `json:"joinCode"`
	State        string      `json:"state"`
	BPM          float64     `json:"bpm"`
	Participants int         `json:"participants"`
	MaxUsers     int         `json:"maxUsers"`
	Groups       []groupView `json:"groups"`
	Generation   uint64      `json:"generation"`
	ServerTimeMs int64       `json:"serverTimeMs"`
}

// Create handles POST /api/v1/sessions. This is the only response that ever
// contains the maestro token.
func (h *SessionHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if err := decodeBody(r, &req); err != nil {
		httperr.Write(w, err)
		return
	}

	out, err := h.uc.CreateSession(r.Context(), usecase.CreateSessionInput{
		MaxUsers:    req.MaxUsers,
		BPM:         req.BPM,
		GroupLabels: req.GroupLabels,
		Strategy:    req.Strategy,
	})
	if err != nil {
		h.log.Error("cannot create session", slog.Any("error", err))
		httperr.Write(w, err)
		return
	}

	h.log.Info("session created",
		slog.String("sessionId", string(out.SessionID)),
		slog.String("joinCode", string(out.JoinCode)),
		slog.Int("maxUsers", out.MaxUsers))

	writeJSON(w, http.StatusCreated, createSessionResponse{
		SessionID:    string(out.SessionID),
		JoinCode:     string(out.JoinCode),
		MaestroToken: string(out.MaestroToken),
		MaestroURL:   h.maestroURL(out.SessionID, out.MaestroToken),
		JoinURL:      h.joinURL(out.JoinCode),
		MaxUsers:     out.MaxUsers,
		Groups:       groupViews(out.Groups),
	})
}

// Get handles GET /api/v1/sessions/{id}: public state, no secret.
func (h *SessionHandler) Get(w http.ResponseWriter, r *http.Request) {
	state, err := h.uc.PublicState(r.Context(), session.SessionID(r.PathValue("id")))
	if err != nil {
		httperr.Write(w, err)
		return
	}
	writeJSON(w, http.StatusOK, publicStateResponse{
		SessionID:    string(state.SessionID),
		JoinCode:     string(state.JoinCode),
		State:        state.State.String(),
		BPM:          state.BPM,
		Participants: state.Participants,
		MaxUsers:     state.MaxUsers,
		Groups:       groupViews(state.Groups),
		Generation:   state.Generation,
		ServerTimeMs: state.ServerTimeMs,
	})
}

// ByCode handles GET /api/v1/sessions/by-code/{code}.
func (h *SessionHandler) ByCode(w http.ResponseWriter, r *http.Request) {
	code := session.JoinCode(strings.ToUpper(r.PathValue("code")))
	id, err := h.uc.ResolveByCode(r.Context(), code)
	if err != nil {
		httperr.Write(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"sessionId": string(id),
		"joinCode":  string(code),
		"joinUrl":   h.joinURL(code),
	})
}

// Delete handles DELETE /api/v1/sessions/{id}, authenticated with the maestro
// token as a bearer.
func (h *SessionHandler) Delete(w http.ResponseWriter, r *http.Request) {
	token, ok := bearerToken(r)
	if !ok {
		httperr.Write(w, session.ErrUnauthorized)
		return
	}
	id := session.SessionID(r.PathValue("id"))
	if err := h.uc.CloseSession(r.Context(), id, token); err != nil {
		httperr.Write(w, err)
		return
	}
	h.log.Info("session closed", slog.String("sessionId", string(id)))
	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) maestroURL(id session.SessionID, token session.Token) string {
	if h.cfg.PublicBaseURL == "" {
		return ""
	}
	return h.cfg.PublicBaseURL + "/maestro/" + string(id) + "#token=" + string(token)
}

func (h *SessionHandler) joinURL(code session.JoinCode) string {
	if h.cfg.PublicBaseURL == "" {
		return ""
	}
	return h.cfg.PublicBaseURL + "/join/" + string(code)
}

func groupViews(counts []session.GroupCount) []groupView {
	views := make([]groupView, len(counts))
	for i, c := range counts {
		views[i] = groupView{ID: int(c.ID), Label: c.Label, Count: c.Count}
	}
	return views
}

func decodeBody(r *http.Request, target any) error {
	body := http.MaxBytesReader(nil, r.Body, maxRequestBytes)
	data, err := io.ReadAll(body)
	if err != nil {
		return session.Invalidf("request body is too large or unreadable")
	}
	if len(data) == 0 {
		return nil // an empty body means "all defaults"
	}
	if err := json.Unmarshal(data, target); err != nil {
		return session.Invalidf("malformed JSON body: %v", err)
	}
	return nil
}

func bearerToken(r *http.Request) (session.Token, bool) {
	raw := r.Header.Get("Authorization")
	value, ok := strings.CutPrefix(raw, "Bearer ")
	if !ok || value == "" {
		return "", false
	}
	return session.Token(value), true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		// The status line is already out; nothing left to do but note it.
		slog.Default().Debug("cannot write response body", slog.Any("error", err))
	}
}
