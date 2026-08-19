package session

import (
	"testing"
	"time"
)

func TestSessionAccessors(t *testing.T) {
	created := time.Date(2026, 8, 19, 20, 0, 0, 0, time.UTC)
	s := newTestSession(t, Options{MaxUsers: 42, CreatedAt: created, BPM: 128})

	if s.ID() != "sess-1" || s.Code() != "MZQ4" || s.MaxUsers() != 42 || !s.CreatedAt().Equal(created) {
		t.Fatalf("unexpected identity: %s / %s / %d / %s", s.ID(), s.Code(), s.MaxUsers(), s.CreatedAt())
	}
	if tr := s.Transport(); tr.State != Stopped || tr.Anchor.BPM != 128 {
		t.Fatalf("unexpected initial transport: %+v", tr)
	}
	if _, ok := s.MaestroID(); ok {
		t.Fatal("a fresh session has no maestro")
	}
	joinMaestro(t, s)
	if id, ok := s.MaestroID(); !ok || id != "maestro" {
		t.Fatalf("MaestroID = %q, %v", id, ok)
	}
	if _, ok := s.Participant("ghost"); ok {
		t.Fatal("an unknown participant must not be found")
	}
	if _, err := s.Join(NewParticipant("maestro", "dup", RoleMaestro, 0)); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("a duplicate id must be rejected, got %v", err)
	}
}

func TestStringSpellings(t *testing.T) {
	if Playing.String() != "playing" || Stopped.String() != "stopped" {
		t.Fatal("play state spellings must match the wire")
	}
	if RoleMaestro.String() != "maestro" || RoleMusician.String() != "musician" {
		t.Fatal("role spellings must match the wire")
	}
	if GroupID(2).String() != "2" {
		t.Fatal("group id spelling")
	}
}

func TestTransportPositionAt(t *testing.T) {
	tr := playing(120, 0, 0)
	pos := tr.PositionAt(2500)
	if pos.Bar != 1 || pos.BeatInBar != 1 || pos.StepInBar != 4 {
		t.Fatalf("PositionAt(2500) = %+v, want bar 1, beat 1, step 4", pos)
	}
}

func TestTrackLimit(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)
	for i := range MaxTracks {
		id := TrackID("t" + string(rune('a'+i%26)) + string(rune('0'+i/26)))
		if _, err := s.SetPattern(id, []Step{{On: true}}, RoleMaestro); err != nil {
			t.Fatalf("track %d: %v", i, err)
		}
	}
	if _, err := s.SetPattern("overflow", []Step{{On: true}}, RoleMaestro); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload past %d tracks, got %v", MaxTracks, err)
	}
	// Overwriting an existing track is still allowed at the cap.
	if _, err := s.SetPattern("ta0", []Step{{}}, RoleMaestro); err != nil {
		t.Fatalf("overwriting an existing track: %v", err)
	}
}

func TestEmptyPatternIsRejected(t *testing.T) {
	if _, err := NewPattern("kick", nil); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
}
