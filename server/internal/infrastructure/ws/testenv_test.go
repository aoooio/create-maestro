package ws

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
)

// readTimeout bounds every expectation in these tests: a message that has not
// arrived by then is a failure, not a slow test.
const readTimeout = 3 * time.Second

// testServer is the whole server stack behind an httptest listener: real
// sockets, real codec, real hub.
type testServer struct {
	http     *httptest.Server
	uc       *usecase.Usecases
	hub      *Hub
	handler  *Handler
	sessions *sessionFixture
}

type sessionFixture struct {
	ID    session.SessionID
	Code  session.JoinCode
	Token session.Token
}

func newTestServer(t *testing.T, tune func(*config.Config)) *testServer {
	t.Helper()

	cfg := config.Config{
		DefaultMaxUsers:        session.DefaultMaxUsers,
		DefaultBPM:             session.DefaultBPM,
		GroupLabels:            session.DefaultGroupLabels,
		MaxMessageBytes:        config.DefaultMaxMessageBytes,
		RateBurst:              config.DefaultRateBurst,
		RateSustained:          config.DefaultRateSustained,
		CreateSessionPerMinute: config.DefaultCreatePerMinute,
	}
	if tune != nil {
		tune(&cfg)
	}

	// Discard logs: a failing test says what went wrong, the server's own
	// chatter only gets in the way.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	serverClock := clock.NewMonotonic()
	repo := persistence.NewMemorySessionRepo()
	ids := idgen.New()
	codec := NewCodec(ids, serverClock)
	hub := NewHub(codec, log)
	uc := usecase.New(repo, serverClock, hub, ids, ids, usecase.Options{
		TriggerEcho:     cfg.TriggerEcho,
		DefaultMaxUsers: cfg.DefaultMaxUsers,
		DefaultBPM:      cfg.DefaultBPM,
		GroupLabels:     cfg.GroupLabels,
	})
	handler := NewHandler(uc, hub, codec, cfg, log)

	hubCtx, stopHub := context.WithCancel(context.Background())
	hubDone := make(chan struct{})
	go func() {
		defer close(hubDone)
		hub.Run(hubCtx)
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/v1/maestro", handler.Maestro)
	mux.HandleFunc("GET /ws/v1/perform", handler.Perform)
	srv := httptest.NewServer(mux)

	created, err := uc.CreateSession(context.Background(), usecase.CreateSessionInput{MaxUsers: cfg.DefaultMaxUsers})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
		stopHub()
		<-hubDone
		handler.Wait()
	})

	return &testServer{
		http:    srv,
		uc:      uc,
		hub:     hub,
		handler: handler,
		sessions: &sessionFixture{
			ID:    created.SessionID,
			Code:  created.JoinCode,
			Token: created.MaestroToken,
		},
	}
}

// received is a decoded envelope; the payload stays raw so each test asks for
// exactly the shape it cares about.
type received struct {
	V   int             `json:"v"`
	T   string          `json:"t"`
	ID  string          `json:"id"`
	Ack string          `json:"ack"`
	TS  int64           `json:"ts"`
	D   json.RawMessage `json:"d"`
}

// into unmarshals the payload of a message into target.
func (r received) into(t *testing.T, target any) {
	t.Helper()
	if err := json.Unmarshal(r.D, target); err != nil {
		t.Fatalf("cannot decode %s payload %s: %v", r.T, r.D, err)
	}
}

// client is a test WebSocket client with a small expectation API.
type client struct {
	t    *testing.T
	name string
	ws   *websocket.Conn
}

// dialMaestro opens the maestro endpoint with the session's real token.
func (s *testServer) dialMaestro(t *testing.T) *client {
	t.Helper()
	return s.dial(t, "maestro", "/ws/v1/maestro", url.Values{
		"session": {string(s.sessions.ID)},
		"token":   {string(s.sessions.Token)},
	}, nil)
}

// dialMusician opens the audience endpoint.
func (s *testServer) dialMusician(t *testing.T, name string) *client {
	t.Helper()
	return s.dial(t, name, "/ws/v1/perform", url.Values{
		"session": {string(s.sessions.ID)},
		"name":    {name},
	}, nil)
}

func (s *testServer) dial(t *testing.T, name, path string, query url.Values, header http.Header) *client {
	t.Helper()
	endpoint := "ws" + strings.TrimPrefix(s.http.URL, "http") + path + "?" + query.Encode()
	conn, resp, err := websocket.DefaultDialer.Dial(endpoint, header)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
			resp.Body.Close()
		}
		t.Fatalf("dial %s: %v (status %d)", path, err, status)
	}
	c := &client{t: t, name: name, ws: conn}
	t.Cleanup(func() { _ = conn.Close() })
	return c
}

// tryDial returns the HTTP response of a refused upgrade instead of failing.
func (s *testServer) tryDial(t *testing.T, path string, query url.Values, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	endpoint := "ws" + strings.TrimPrefix(s.http.URL, "http") + path + "?" + query.Encode()
	return websocket.DefaultDialer.Dial(endpoint, header)
}

// send writes one client message.
func (c *client) send(msgType string, payload any) {
	c.t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		c.t.Fatalf("%s: cannot encode %s: %v", c.name, msgType, err)
	}
	env := map[string]any{"v": ProtocolVersion, "t": msgType, "id": msgType + "-1", "d": json.RawMessage(raw)}
	if err := c.ws.WriteJSON(env); err != nil {
		c.t.Fatalf("%s: cannot send %s: %v", c.name, msgType, err)
	}
}

// sendRaw writes an arbitrary frame, for the malformed and oversized cases.
func (c *client) sendRaw(data []byte) error {
	return c.ws.WriteMessage(websocket.TextMessage, data)
}

// read returns the next message, whatever it is.
func (c *client) read() (received, error) {
	if err := c.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		return received{}, err
	}
	var msg received
	err := c.ws.ReadJSON(&msg)
	return msg, err
}

// expect reads until a message of the given type arrives, skipping the rest.
func (c *client) expect(msgType string) received {
	c.t.Helper()
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		msg, err := c.read()
		if err != nil {
			c.t.Fatalf("%s: waiting for %s: %v", c.name, msgType, err)
		}
		if msg.T == msgType {
			return msg
		}
	}
	c.t.Fatalf("%s: never received %s", c.name, msgType)
	return received{}
}

// expectPresence reads until the presence event of a given participant, which
// is what lets a test ignore the joiner's own announcement.
func (c *client) expectPresence(msgType, participantID string) presenceDTO {
	c.t.Helper()
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		msg, err := c.read()
		if err != nil {
			c.t.Fatalf("%s: waiting for %s of %s: %v", c.name, msgType, participantID, err)
		}
		if msg.T != msgType {
			continue
		}
		var presence presenceDTO
		msg.into(c.t, &presence)
		if presence.ParticipantID == participantID {
			return presence
		}
	}
	c.t.Fatalf("%s: never received %s for %s", c.name, msgType, participantID)
	return presenceDTO{}
}

// expectNot proves that a message did *not* reach this client, without
// relying on a timeout: a read timeout leaves a gorilla connection unusable,
// and a wall-clock window would make the test flaky either way.
//
// It sends a ping and reads up to the matching pong. Anything the server had
// already queued for this client arrives before that pong, so the absence of
// msgType before it is a real absence. Callers must first observe, on another
// client, that the fan-out in question has happened.
func (c *client) expectNot(msgType string) {
	c.t.Helper()
	c.send(TypeTimePing, timePingDTO{ClientSendMs: 7})
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		msg, err := c.read()
		if err != nil {
			c.t.Fatalf("%s: waiting for the sentinel pong: %v", c.name, err)
		}
		switch msg.T {
		case msgType:
			c.t.Fatalf("%s: received an unexpected %s: %s", c.name, msgType, msg.D)
		case "time.pong":
			return
		}
	}
	c.t.Fatalf("%s: the sentinel pong never came back", c.name)
}

// join performs the handshake and returns the welcome payload.
func (c *client) join() welcomeDTO {
	c.t.Helper()
	c.send(TypeHello, map[string]any{"clientVersion": "test", "name": c.name})
	var welcome welcomeDTO
	c.expect("welcome").into(c.t, &welcome)
	c.expect("state.snapshot")
	return welcome
}

// closeCode reads until the connection ends and returns the close code.
func (c *client) closeCode() int {
	c.t.Helper()
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		_, err := c.read()
		if err == nil {
			continue
		}
		var closeErr *websocket.CloseError
		if ok := asCloseError(err, &closeErr); ok {
			return closeErr.Code
		}
		c.t.Fatalf("%s: connection ended without a close frame: %v", c.name, err)
	}
	c.t.Fatalf("%s: connection never closed", c.name)
	return 0
}

// decodeJSON reads a JSON body from an HTTP response.
func decodeJSON(resp *http.Response, target any) error {
	return json.NewDecoder(resp.Body).Decode(target)
}

func asCloseError(err error, target **websocket.CloseError) bool {
	if ce, ok := err.(*websocket.CloseError); ok {
		*target = ce
		return true
	}
	return false
}
