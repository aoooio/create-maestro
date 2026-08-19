package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// Every command must refuse an unknown session before doing anything else.
func TestCommandsRefuseAnUnknownSession(t *testing.T) {
	h := newHarness(t, Options{})
	ctx := context.Background()
	const ghost session.SessionID = "ghost"

	tests := map[string]func() error{
		"transport": func() error {
			bpm := 128.0
			_, err := h.u.SetTransport(ctx, SetTransportInput{SessionID: ghost, Role: session.RoleMaestro, Command: session.TransportCommand{BPM: &bpm}})
			return err
		},
		"parameter": func() error {
			_, err := h.u.SetParameter(ctx, SetParameterInput{SessionID: ghost, Role: session.RoleMaestro, Key: session.ParamGain, Value: 1, Target: session.TargetAll()})
			return err
		},
		"pattern": func() error {
			_, err := h.u.SetPattern(ctx, SetPatternInput{SessionID: ghost, Role: session.RoleMaestro, TrackID: "kick", Steps: []session.Step{{On: true}}})
			return err
		},
		"trigger": func() error {
			return h.u.TriggerEvent(ctx, TriggerEventInput{SessionID: ghost, Role: session.RoleMusician, Kind: "hit"})
		},
		"snapshot": func() error {
			_, err := h.u.GetSnapshot(ctx, ghost)
			return err
		},
		"public state": func() error {
			_, err := h.u.PublicState(ctx, ghost)
			return err
		},
		"leave": func() error {
			return h.u.LeaveSession(ctx, ghost, "p-1")
		},
		"close": func() error {
			return h.u.CloseSession(ctx, ghost, "tok-secret")
		},
	}
	for name, run := range tests {
		t.Run(name, func(t *testing.T) {
			if code := session.CodeOf(run()); code != session.CodeSessionNotFound {
				t.Fatalf("want session_not_found, got %s", code)
			}
		})
	}
}

// A repository that cannot persist must fail the command loudly rather than
// letting the room drift from the stored state.
func TestPersistenceFailuresPropagate(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")

	ctx := context.Background()
	boom := errors.New("disk on fire")
	h.repo.failing = boom
	h.bus.reset()

	bpm := 128.0
	if _, err := h.u.SetTransport(ctx, SetTransportInput{SessionID: created.SessionID, Role: session.RoleMaestro, Command: session.TransportCommand{BPM: &bpm}}); !errors.Is(err, boom) {
		t.Fatalf("transport: want the repository error, got %v", err)
	}
	if _, err := h.u.SetParameter(ctx, SetParameterInput{SessionID: created.SessionID, Role: session.RoleMaestro, Key: session.ParamGain, Value: 0.5, Target: session.TargetAll()}); !errors.Is(err, boom) {
		t.Fatalf("parameter: want the repository error, got %v", err)
	}
	if _, err := h.u.SetPattern(ctx, SetPatternInput{SessionID: created.SessionID, Role: session.RoleMaestro, TrackID: "kick", Steps: []session.Step{{On: true}}}); !errors.Is(err, boom) {
		t.Fatalf("pattern: want the repository error, got %v", err)
	}
	if _, err := h.u.JoinSession(ctx, JoinSessionInput{SessionID: created.SessionID, Role: session.RoleMusician}); !errors.Is(err, boom) {
		t.Fatalf("join: want the repository error, got %v", err)
	}
	if err := h.u.LeaveSession(ctx, created.SessionID, "p-1"); !errors.Is(err, boom) {
		t.Fatalf("leave: want the repository error, got %v", err)
	}
	if len(h.bus.all()) != 0 {
		t.Fatalf("nothing may be broadcast when the state could not be stored: %+v", h.bus.all())
	}
}

func TestCreateSessionGivesUpOnEndlessCodeCollisions(t *testing.T) {
	h := newHarness(t, Options{})
	h.newSession(t) // takes "CODE", which the generator always returns

	_, err := h.u.CreateSession(context.Background(), CreateSessionInput{})
	if session.CodeOf(err) != session.CodeInternal {
		t.Fatalf("want an internal error, got %v", err)
	}
	if session.MessageOf(err) != "internal error" {
		t.Fatalf("internal details must not reach the client: %q", session.MessageOf(err))
	}
}

func TestNowMsExposesTheServerClock(t *testing.T) {
	h := newHarness(t, Options{})
	h.clock.ms = 4242
	if got := h.u.NowMs(); got != 4242 {
		t.Fatalf("NowMs = %d, want 4242", got)
	}
}

func TestOptionDefaults(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	state, err := h.u.PublicState(context.Background(), created.SessionID)
	if err != nil {
		t.Fatalf("PublicState: %v", err)
	}
	if state.MaxUsers != session.DefaultMaxUsers || state.BPM != session.DefaultBPM || len(state.Groups) != 2 {
		t.Fatalf("unexpected defaults: %+v", state)
	}
}
