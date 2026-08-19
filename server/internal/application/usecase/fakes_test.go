package usecase

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// fakeClock is driven by the test: no wall time anywhere in these tests.
type fakeClock struct{ ms int64 }

func (c *fakeClock) NowMs() int64 { return c.ms }

// fakeRepo is an in-memory repository that also counts saves, so a test can
// check that a rejected command never persisted anything.
type fakeRepo struct {
	mu      sync.Mutex
	byID    map[session.SessionID]*session.Session
	byCode  map[session.JoinCode]*session.Session
	saves   int
	failing error
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		byID:   map[session.SessionID]*session.Session{},
		byCode: map[session.JoinCode]*session.Session{},
	}
}

func (r *fakeRepo) Save(_ context.Context, s *session.Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failing != nil {
		return r.failing
	}
	r.saves++
	r.byID[s.ID()] = s
	r.byCode[s.Code()] = s
	return nil
}

func (r *fakeRepo) FindByID(_ context.Context, id session.SessionID) (*session.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.byID[id]
	if !ok {
		return nil, session.ErrSessionNotFound
	}
	return s, nil
}

func (r *fakeRepo) FindByCode(_ context.Context, code session.JoinCode) (*session.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.byCode[code]
	if !ok {
		return nil, session.ErrSessionNotFound
	}
	return s, nil
}

func (r *fakeRepo) Delete(_ context.Context, id session.SessionID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.byID[id]; ok {
		delete(r.byCode, s.Code())
		delete(r.byID, id)
	}
	return nil
}

// delivery records one fan-out call.
type delivery struct {
	Scope   string // "session", "group", "participant", "maestro"
	Session session.SessionID
	Group   session.GroupID
	Target  session.ParticipantID
	Msg     application.OutboundMessage
}

type fakeBus struct {
	mu         sync.Mutex
	deliveries []delivery
}

func (b *fakeBus) record(d delivery) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.deliveries = append(b.deliveries, d)
}

func (b *fakeBus) ToSession(id session.SessionID, msg application.OutboundMessage) {
	b.record(delivery{Scope: "session", Session: id, Msg: msg})
}

func (b *fakeBus) ToGroup(id session.SessionID, g session.GroupID, msg application.OutboundMessage) {
	b.record(delivery{Scope: "group", Session: id, Group: g, Msg: msg})
}

func (b *fakeBus) ToParticipant(pid session.ParticipantID, msg application.OutboundMessage) {
	b.record(delivery{Scope: "participant", Target: pid, Msg: msg})
}

func (b *fakeBus) ToMaestro(id session.SessionID, msg application.OutboundMessage) {
	b.record(delivery{Scope: "maestro", Session: id, Msg: msg})
}

func (b *fakeBus) all() []delivery {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]delivery(nil), b.deliveries...)
}

func (b *fakeBus) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.deliveries = nil
}

// only asserts that exactly one message of the given type was delivered, and
// returns it.
func (b *fakeBus) only(t *testing.T, msgType string) delivery {
	t.Helper()
	var found []delivery
	for _, d := range b.all() {
		if d.Msg.Type == msgType {
			found = append(found, d)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %s, got %d (%+v)", msgType, len(found), b.all())
	}
	return found[0]
}

// fakeIDs mints predictable identifiers.
type fakeIDs struct {
	mu       sync.Mutex
	sessions int
	people   int
	codes    []session.JoinCode
	messages int
}

func (g *fakeIDs) NewSessionID() session.SessionID {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sessions++
	return session.SessionID(fmt.Sprintf("sess-%d", g.sessions))
}

func (g *fakeIDs) NewParticipantID() session.ParticipantID {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.people++
	return session.ParticipantID(fmt.Sprintf("p-%d", g.people))
}

func (g *fakeIDs) NewJoinCode() session.JoinCode {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.codes) > 0 {
		code := g.codes[0]
		g.codes = g.codes[1:]
		return code
	}
	return "CODE"
}

func (g *fakeIDs) NewMessageID() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.messages++
	return fmt.Sprintf("msg-%d", g.messages)
}

type fakeTokens struct {
	value session.Token
	err   error
}

func (t fakeTokens) NewToken() (session.Token, error) {
	if t.err != nil {
		return "", t.err
	}
	if t.value == "" {
		return "tok-secret", nil
	}
	return t.value, nil
}

// harness bundles everything a use case test needs.
type harness struct {
	u      *Usecases
	repo   *fakeRepo
	bus    *fakeBus
	clock  *fakeClock
	ids    *fakeIDs
	tokens fakeTokens
}

func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	h := &harness{
		repo:  newFakeRepo(),
		bus:   &fakeBus{},
		clock: &fakeClock{ms: 1_000_000},
		ids:   &fakeIDs{},
	}
	h.u = New(h.repo, h.clock, h.bus, h.ids, h.tokens, opts)
	return h
}

// newSession creates a session through the use case and returns it.
func (h *harness) newSession(t *testing.T) CreateSessionOutput {
	t.Helper()
	out, err := h.u.CreateSession(context.Background(), CreateSessionInput{})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return out
}

// join enters a participant and returns the join output.
func (h *harness) join(t *testing.T, sid session.SessionID, role session.Role, token session.Token, name string) JoinSessionOutput {
	t.Helper()
	out, err := h.u.JoinSession(context.Background(), JoinSessionInput{
		SessionID: sid, Role: role, Token: token, Name: name,
	})
	if err != nil {
		t.Fatalf("JoinSession(%s): %v", role, err)
	}
	return out
}
