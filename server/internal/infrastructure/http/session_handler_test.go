package http

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/aoooio/create-maestro/server/internal/application/usecase"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/clock"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/idgen"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/persistence"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/ws"
)

// newTestRouter builds the real router over the real stack: the REST surface
// is thin enough that stubbing anything would only test the stubs.
func newTestRouter(t *testing.T, tune func(*config.Config)) http.Handler {
	t.Helper()
	cfg := config.Config{
		DefaultMaxUsers:        session.DefaultMaxUsers,
		DefaultBPM:             session.DefaultBPM,
		GroupLabels:            session.DefaultGroupLabels,
		MaxMessageBytes:        config.DefaultMaxMessageBytes,
		RateBurst:              config.DefaultRateBurst,
		RateSustained:          config.DefaultRateSustained,
		CreateSessionPerMinute: config.DefaultCreatePerMinute,
		PublicBaseURL:          "https://maestro.example",
	}
	if tune != nil {
		tune(&cfg)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	serverClock := clock.NewMonotonic()
	repo := persistence.NewMemorySessionRepo()
	ids := idgen.New()
	codec := ws.NewCodec(ids, serverClock)
	hub := ws.NewHub(codec, log)
	uc := usecase.New(repo, serverClock, hub, ids, ids, usecase.Options{
		DefaultMaxUsers: cfg.DefaultMaxUsers,
		DefaultBPM:      cfg.DefaultBPM,
		GroupLabels:     cfg.GroupLabels,
	})
	sockets := ws.NewHandler(uc, hub, codec, cfg, log)

	hubCtx, stopHub := context.WithCancel(context.Background())
	hubDone := make(chan struct{})
	go func() {
		defer close(hubDone)
		hub.Run(hubCtx)
	}()
	t.Cleanup(func() {
		stopHub()
		<-hubDone
		sockets.Wait()
	})

	return Router(NewSessionHandler(uc, cfg, log), sockets, cfg, log, func() bool { return true })
}

func do(t *testing.T, router http.Handler, method, target, body string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	for key, values := range header {
		req.Header[key] = values
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), target); err != nil {
		t.Fatalf("cannot decode %s: %v", rec.Body.String(), err)
	}
}

type createdSession struct {
	SessionID    string `json:"sessionId"`
	JoinCode     string `json:"joinCode"`
	MaestroToken string `json:"maestroToken"`
	MaestroURL   string `json:"maestroUrl"`
	JoinURL      string `json:"joinUrl"`
	MaxUsers     int    `json:"maxUsers"`
	Groups       []struct {
		ID    int    `json:"id"`
		Label string `json:"label"`
		Count int    `json:"count"`
	} `json:"groups"`
}

func createSession(t *testing.T, router http.Handler, body string) createdSession {
	t.Helper()
	rec := do(t, router, http.MethodPost, "/api/v1/sessions", body, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status %d, body %s", rec.Code, rec.Body)
	}
	var created createdSession
	decode(t, rec, &created)
	return created
}

func TestCreateSession(t *testing.T) {
	router := newTestRouter(t, nil)
	created := createSession(t, router, `{"maxUsers":42,"bpm":128}`)

	if created.SessionID == "" || len(created.JoinCode) != idgen.JoinCodeLen {
		t.Fatalf("unexpected identifiers: %+v", created)
	}
	if created.MaxUsers != 42 || len(created.Groups) != 2 || created.Groups[0].Label != "HIGH" {
		t.Fatalf("unexpected session shape: %+v", created)
	}
	if !strings.Contains(created.MaestroURL, created.SessionID) ||
		!strings.Contains(created.MaestroURL, created.MaestroToken) {
		t.Fatalf("the maestro url must carry the session and its token: %s", created.MaestroURL)
	}
	if !strings.HasSuffix(created.JoinURL, "/join/"+created.JoinCode) {
		t.Fatalf("unexpected join url: %s", created.JoinURL)
	}
}

func TestCreateSessionAcceptsAnEmptyBody(t *testing.T) {
	router := newTestRouter(t, nil)
	created := createSession(t, router, "")
	if created.MaxUsers != session.DefaultMaxUsers {
		t.Fatalf("maxUsers = %d, want the default %d", created.MaxUsers, session.DefaultMaxUsers)
	}
}

func TestCreateSessionRejectsBadInput(t *testing.T) {
	router := newTestRouter(t, nil)

	rec := do(t, router, http.MethodPost, "/api/v1/sessions", `{not json`, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	rec = do(t, router, http.MethodPost, "/api/v1/sessions", `{"strategy":"chaos"}`, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	rec = do(t, router, http.MethodPost, "/api/v1/sessions", `{"bpm":5}`, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an out-of-range bpm must be refused, got %d", rec.Code)
	}
}

func TestPublicStateLeaksNoSecret(t *testing.T) {
	router := newTestRouter(t, nil)
	created := createSession(t, router, "")

	rec := do(t, router, http.MethodGet, "/api/v1/sessions/"+created.SessionID, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), created.MaestroToken) {
		t.Fatalf("the public state leaked the maestro token: %s", rec.Body)
	}
	var state struct {
		SessionID    string `json:"sessionId"`
		State        string `json:"state"`
		BPM          float64
		Participants int   `json:"participants"`
		ServerTimeMs int64 `json:"serverTimeMs"`
	}
	decode(t, rec, &state)
	if state.SessionID != created.SessionID || state.State != "stopped" || state.Participants != 0 {
		t.Fatalf("unexpected public state: %+v", state)
	}
	if state.ServerTimeMs == 0 {
		t.Fatal("the public state must carry the server clock")
	}
}

func TestResolveByCode(t *testing.T) {
	router := newTestRouter(t, nil)
	created := createSession(t, router, "")

	// A code typed in lower case still resolves.
	rec := do(t, router, http.MethodGet, "/api/v1/sessions/by-code/"+strings.ToLower(created.JoinCode), "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	var resolved map[string]string
	decode(t, rec, &resolved)
	if resolved["sessionId"] != created.SessionID {
		t.Fatalf("unexpected resolution: %+v", resolved)
	}

	rec = do(t, router, http.MethodGet, "/api/v1/sessions/by-code/ZZZZ", "", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestDeleteRequiresTheMaestroToken(t *testing.T) {
	router := newTestRouter(t, nil)
	created := createSession(t, router, "")
	path := "/api/v1/sessions/" + created.SessionID

	if rec := do(t, router, http.MethodDelete, path, "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status %d, want 401", rec.Code)
	}
	wrong := http.Header{"Authorization": {"Bearer nope"}}
	if rec := do(t, router, http.MethodDelete, path, "", wrong); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d, want 401", rec.Code)
	}
	// A token in the wrong scheme is not a token.
	basic := http.Header{"Authorization": {"Basic " + created.MaestroToken}}
	if rec := do(t, router, http.MethodDelete, path, "", basic); rec.Code != http.StatusUnauthorized {
		t.Fatalf("basic scheme: status %d, want 401", rec.Code)
	}

	good := http.Header{"Authorization": {"Bearer " + created.MaestroToken}}
	if rec := do(t, router, http.MethodDelete, path, "", good); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if rec := do(t, router, http.MethodGet, path, "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a closed session must be gone, got %d", rec.Code)
	}
}

func TestProbes(t *testing.T) {
	router := newTestRouter(t, nil)
	for _, path := range []string{"/healthz", "/readyz"} {
		if rec := do(t, router, http.MethodGet, path, "", nil); rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", path, rec.Code)
		}
	}
}

func TestReadinessFollowsDraining(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := config.Config{GroupLabels: session.DefaultGroupLabels, CreateSessionPerMinute: 10}
	draining := true
	router := Router(nil, nil, cfg, log, func() bool { return !draining })

	if rec := do(t, router, http.MethodGet, "/readyz", "", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("a draining server must not be ready, got %d", rec.Code)
	}
	draining = false
	if rec := do(t, router, http.MethodGet, "/readyz", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCreateSessionIsRateLimitedPerIP(t *testing.T) {
	router := newTestRouter(t, func(c *config.Config) { c.CreateSessionPerMinute = 2 })

	for range 2 {
		if rec := do(t, router, http.MethodPost, "/api/v1/sessions", "", nil); rec.Code != http.StatusCreated {
			t.Fatalf("status = %d", rec.Code)
		}
	}
	rec := do(t, router, http.MethodPost, "/api/v1/sessions", "", nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	// Another client is unaffected.
	other := http.Header{"X-Forwarded-For": {"203.0.113.7"}}
	if rec := do(t, router, http.MethodPost, "/api/v1/sessions", "", other); rec.Code != http.StatusCreated {
		t.Fatalf("a different IP must not be throttled, got %d", rec.Code)
	}
}

func TestCORSPreflight(t *testing.T) {
	router := newTestRouter(t, func(c *config.Config) {
		c.AllowedOrigins = []string{"https://maestro.example"}
	})

	allowed := http.Header{"Origin": {"https://maestro.example"}}
	rec := do(t, router, http.MethodOptions, "/api/v1/sessions", "", allowed)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://maestro.example" {
		t.Fatalf("missing CORS header: %+v", rec.Header())
	}

	foreign := http.Header{"Origin": {"https://evil.example"}}
	rec = do(t, router, http.MethodOptions, "/api/v1/sessions", "", foreign)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("a foreign origin must not be allowed")
	}
}

// The WebSocket endpoints live behind the same middleware chain as the REST
// ones. That chain wraps the ResponseWriter, and an upgrade needs to hijack
// the raw connection through it — a wrapper that forgets http.Hijacker makes
// every upgrade fail with a 500 while every unit test still passes.
func TestWebSocketUpgradeWorksThroughTheMiddlewareChain(t *testing.T) {
	router := newTestRouter(t, nil)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	created := createSession(t, router, "")

	endpoint := "ws" + strings.TrimPrefix(srv.URL, "http") +
		"/ws/v1/perform?session=" + url.QueryEscape(created.SessionID)
	conn, resp, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("upgrade through the router failed: %v (status %d)", err, status)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"v": 1, "t": "hello", "id": "hello-1",
		"d": map[string]any{"clientVersion": "test"},
	}); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	var welcome struct {
		T string `json:"t"`
	}
	if err := conn.ReadJSON(&welcome); err != nil {
		t.Fatalf("reading the welcome: %v", err)
	}
	if welcome.T != "welcome" {
		t.Fatalf("first message = %q, want welcome", welcome.T)
	}
}

func TestRecoverTurnsAPanicIntoAnError(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	boom := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") })
	handler := Chain(boom, Recover(log))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("the panic message must not reach the client: %s", rec.Body)
	}
}
