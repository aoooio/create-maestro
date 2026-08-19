package session

import (
	"testing"
)

func newTestSession(t *testing.T, opts Options) *Session {
	t.Helper()
	s, err := New("sess-1", "MZQ4", "secret-token", opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func joinMusician(t *testing.T, s *Session, id string) ParticipantJoined {
	t.Helper()
	ev, err := s.Join(NewParticipant(ParticipantID(id), id, RoleMusician, 0))
	if err != nil {
		t.Fatalf("join %s: %v", id, err)
	}
	return ev
}

func joinMaestro(t *testing.T, s *Session) ParticipantJoined {
	t.Helper()
	ev, err := s.Join(NewParticipant("maestro", "Nadia", RoleMaestro, 0))
	if err != nil {
		t.Fatalf("join maestro: %v", err)
	}
	return ev
}

func TestJoinAssignsGroupsAndCounts(t *testing.T) {
	s := newTestSession(t, Options{})

	first := joinMusician(t, s, "m1")
	second := joinMusician(t, s, "m2")
	third := joinMusician(t, s, "m3")

	if first.Participant.Group != 1 || second.Participant.Group != 2 || third.Participant.Group != 1 {
		t.Fatalf("balanced strategy misassigned: %d, %d, %d",
			first.Participant.Group, second.Participant.Group, third.Participant.Group)
	}
	counts := s.Counts()
	if len(counts) != 2 || counts[0].Count != 2 || counts[1].Count != 1 {
		t.Fatalf("unexpected counts: %+v", counts)
	}
	if counts[0].Label != "HIGH" || counts[1].Label != "MID" {
		t.Fatalf("unexpected labels: %+v", counts)
	}
	if s.MusicianCount() != 3 || s.ParticipantCount() != 3 {
		t.Fatalf("counts = %d musicians / %d participants", s.MusicianCount(), s.ParticipantCount())
	}
}

func TestOnlyOneMaestro(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)

	_, err := s.Join(NewParticipant("maestro-2", "impostor", RoleMaestro, 0))
	if CodeOf(err) != CodeForbiddenRole {
		t.Fatalf("second maestro must be rejected, got %v", err)
	}
	if !IsRetryable(err) {
		t.Fatal("a taken maestro slot is retryable: the first one may disconnect")
	}

	// Once the first maestro leaves, the slot frees up.
	if _, ok := s.Leave("maestro"); !ok {
		t.Fatal("maestro should have left")
	}
	if s.HasMaestro() {
		t.Fatal("session still reports a maestro")
	}
	if _, err := s.Join(NewParticipant("maestro-2", "second", RoleMaestro, 0)); err != nil {
		t.Fatalf("maestro slot should be free again: %v", err)
	}
}

func TestMaxUsersCapsMusiciansNotMaestro(t *testing.T) {
	s := newTestSession(t, Options{MaxUsers: 2})
	joinMusician(t, s, "m1")
	joinMusician(t, s, "m2")

	_, err := s.Join(NewParticipant("m3", "late", RoleMusician, 0))
	if CodeOf(err) != CodeSessionFull {
		t.Fatalf("want session_full, got %v", err)
	}
	// The maestro is never turned away by the audience cap.
	if _, err := s.Join(NewParticipant("maestro", "Nadia", RoleMaestro, 0)); err != nil {
		t.Fatalf("maestro must always be able to join: %v", err)
	}
}

func TestLeaveRemovesFromGroup(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMusician(t, s, "m1")
	joinMusician(t, s, "m2")

	left, ok := s.Leave("m1")
	if !ok {
		t.Fatal("m1 should have left")
	}
	if left.Counts[0].Count != 0 || left.Counts[1].Count != 1 {
		t.Fatalf("unexpected counts after leave: %+v", left.Counts)
	}
	if _, ok := s.Leave("m1"); ok {
		t.Fatal("a double disconnect must be a no-op")
	}
}

func TestMusicianCannotDriveTheSession(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMusician(t, s, "m1")

	if _, err := s.ApplyTransport(TransportCommand{State: ptr(Playing)}, RoleMusician, 0); CodeOf(err) != CodeForbiddenRole {
		t.Fatalf("transport: want forbidden_role, got %v", err)
	}
	if _, err := s.SetParameter(ParamCutoff, 0.5, TargetAll(), RoleMusician); CodeOf(err) != CodeForbiddenRole {
		t.Fatalf("parameter: want forbidden_role, got %v", err)
	}
	if _, err := s.SetPattern("kick", []Step{{On: true}}, RoleMusician); CodeOf(err) != CodeForbiddenRole {
		t.Fatalf("pattern: want forbidden_role, got %v", err)
	}
	if s.Generation() != 1 {
		t.Fatalf("a rejected command must not bump the generation, got %d", s.Generation())
	}
}

func TestGenerationIsMonotonic(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)

	var last uint64
	step := func(name string, gen uint64) {
		if gen <= last {
			t.Fatalf("%s: generation %d did not grow past %d", name, gen, last)
		}
		last = gen
	}
	last = s.Generation()

	tr, err := s.ApplyTransport(TransportCommand{State: ptr(Playing)}, RoleMaestro, 0)
	if err != nil {
		t.Fatalf("transport: %v", err)
	}
	step("transport", tr.Generation)
	if tr.Transport.Generation != tr.Generation {
		t.Fatal("the transport must carry the generation it was stamped with")
	}

	pa, err := s.SetParameter(ParamCutoff, 0.25, TargetGroup(2), RoleMaestro)
	if err != nil {
		t.Fatalf("parameter: %v", err)
	}
	step("parameter", pa.Generation)

	pt, err := s.SetPattern("kick", []Step{{On: true, Velocity: 0.8}}, RoleMaestro)
	if err != nil {
		t.Fatalf("pattern: %v", err)
	}
	step("pattern", pt.Generation)
	step("leave", func() uint64 { ev, _ := s.Leave("maestro"); return ev.Generation }())
}

func TestSetParameterClampsAndScopes(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)

	ev, err := s.SetParameter(ParamCutoff, 4.2, TargetGroup(1), RoleMaestro)
	if err != nil {
		t.Fatalf("SetParameter: %v", err)
	}
	if ev.Entry.Value.Number != 1 {
		t.Fatalf("cutoff must be clamped to 1, got %v", ev.Entry.Value.Number)
	}
	if ev.Entry.Target.String() != "group:1" {
		t.Fatalf("target = %s", ev.Entry.Target.String())
	}

	if _, err := s.SetParameter(ParamCutoff, 0.5, TargetGroup(9), RoleMaestro); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("unknown group must be rejected, got %v", err)
	}
	if _, err := s.SetParameter("wobble", 0.5, TargetAll(), RoleMaestro); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("unknown key must be rejected, got %v", err)
	}
}

func TestSetPatternValidatesAndIsolates(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)

	steps := []Step{{On: true}, {}, {On: true, Velocity: 3}}
	ev, err := s.SetPattern("kick", steps, RoleMaestro)
	if err != nil {
		t.Fatalf("SetPattern: %v", err)
	}
	if ev.Pattern.Steps[0].Velocity != 1 {
		t.Fatalf("an active step with no velocity must default to 1, got %v", ev.Pattern.Steps[0].Velocity)
	}
	if ev.Pattern.Steps[2].Velocity != 1 {
		t.Fatalf("velocity must be clamped to 1, got %v", ev.Pattern.Steps[2].Velocity)
	}

	// The stored pattern must not alias the caller's slice.
	steps[0].On = false
	if snap := s.Snapshot(0); !snap.Patterns[0].Steps[0].On {
		t.Fatal("mutating the input slice changed the stored pattern")
	}

	if _, err := s.SetPattern("", []Step{{On: true}}, RoleMaestro); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("empty track id must be rejected, got %v", err)
	}
	if _, err := s.SetPattern("kick", make([]Step, MaxSteps+1), RoleMaestro); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("oversized grid must be rejected, got %v", err)
	}
}

func TestSnapshotIsDeterministicAndComplete(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)
	joinMusician(t, s, "m1")
	if _, err := s.SetParameter(ParamGain, 0.3, TargetGroup(2), RoleMaestro); err != nil {
		t.Fatalf("SetParameter: %v", err)
	}
	if _, err := s.SetPattern("snare", []Step{{On: true}}, RoleMaestro); err != nil {
		t.Fatalf("SetPattern: %v", err)
	}
	if _, err := s.SetPattern("kick", []Step{{On: true}}, RoleMaestro); err != nil {
		t.Fatalf("SetPattern: %v", err)
	}

	snap := s.Snapshot(42)
	if snap.ServerTimeMs != 42 {
		t.Fatalf("serverTimeMs = %d", snap.ServerTimeMs)
	}
	if snap.Generation != s.Generation() {
		t.Fatalf("snapshot generation %d != session generation %d", snap.Generation, s.Generation())
	}
	if len(snap.Patterns) != 2 || snap.Patterns[0].TrackID != "kick" {
		t.Fatalf("patterns must be sorted by track id: %+v", snap.Patterns)
	}
	// Defaults for "all" plus the one group-scoped override.
	if len(snap.Params) != len(parameterRegistry)+1 {
		t.Fatalf("got %d parameters, want %d", len(snap.Params), len(parameterRegistry)+1)
	}
	for i := 1; i < len(snap.Params); i++ {
		prev, cur := snap.Params[i-1], snap.Params[i]
		if prev.Target.Group > cur.Target.Group ||
			(prev.Target.Group == cur.Target.Group && prev.Key > cur.Key) {
			t.Fatalf("parameters are not deterministically ordered: %+v", snap.Params)
		}
	}
}

func TestReassignGroup(t *testing.T) {
	s := newTestSession(t, Options{Strategy: ManualStrategy{Default: 1}})
	joinMaestro(t, s)
	joinMusician(t, s, "m1")
	joinMusician(t, s, "m2")

	if counts := s.Counts(); counts[0].Count != 2 || counts[1].Count != 0 {
		t.Fatalf("manual strategy must park everyone in group 1: %+v", counts)
	}

	ev, err := s.ReassignGroup("m2", 2, RoleMaestro, "maestro")
	if err != nil {
		t.Fatalf("ReassignGroup: %v", err)
	}
	if ev.Group != 2 || ev.Label != "MID" {
		t.Fatalf("unexpected assignment: %+v", ev)
	}
	if counts := s.Counts(); counts[0].Count != 1 || counts[1].Count != 1 {
		t.Fatalf("counts after reassignment: %+v", counts)
	}
	if p, _ := s.Participant("m2"); p.Group != 2 {
		t.Fatalf("participant still in group %d", p.Group)
	}

	if _, err := s.ReassignGroup("m1", 2, RoleMusician, ""); CodeOf(err) != CodeForbiddenRole {
		t.Fatalf("want forbidden_role, got %v", err)
	}
	if _, err := s.ReassignGroup("ghost", 2, RoleMaestro, ""); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
	if _, err := s.ReassignGroup("maestro", 2, RoleMaestro, ""); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("the maestro belongs to no group, got %v", err)
	}
}

func TestAuthenticateMaestro(t *testing.T) {
	s := newTestSession(t, Options{})
	if err := s.AuthenticateMaestro("secret-token"); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if err := s.AuthenticateMaestro("nope"); CodeOf(err) != CodeUnauthorized {
		t.Fatalf("want unauthorized, got %v", err)
	}
}

func TestClosedSessionRejectsEverything(t *testing.T) {
	s := newTestSession(t, Options{})
	joinMaestro(t, s)
	s.Close()

	if !s.IsClosed() {
		t.Fatal("session should report itself closed")
	}
	if err := s.AuthenticateMaestro("secret-token"); err == nil {
		t.Fatal("the maestro token must stop being replayable after close")
	}
	if _, err := s.Join(NewParticipant("m1", "late", RoleMusician, 0)); CodeOf(err) != CodeSessionNotFound {
		t.Fatalf("join: want session_not_found, got %v", err)
	}
	if _, err := s.ApplyTransport(TransportCommand{State: ptr(Playing)}, RoleMaestro, 0); CodeOf(err) != CodeSessionNotFound {
		t.Fatalf("transport: want session_not_found, got %v", err)
	}
	if _, err := s.SetParameter(ParamGain, 0.5, TargetAll(), RoleMaestro); CodeOf(err) != CodeSessionNotFound {
		t.Fatalf("parameter: want session_not_found, got %v", err)
	}
	if _, err := s.SetPattern("kick", []Step{{On: true}}, RoleMaestro); CodeOf(err) != CodeSessionNotFound {
		t.Fatalf("pattern: want session_not_found, got %v", err)
	}
}

func TestNewValidatesItsInputs(t *testing.T) {
	if _, err := New("", "CODE", "tok", Options{}); err == nil {
		t.Fatal("an empty id must be rejected")
	}
	if _, err := New("id", "CODE", "tok", Options{BPM: 5}); CodeOf(err) != CodeInvalidPayload {
		t.Fatal("an out-of-range bpm must be rejected")
	}
	s, err := New("id", "CODE", "tok", Options{GroupLabels: []string{"LOW", "MID", "HIGH"}})
	if err != nil {
		t.Fatalf("New with three groups: %v", err)
	}
	if len(s.Counts()) != 3 {
		t.Fatalf("the domain must handle N groups, got %d", len(s.Counts()))
	}
	if s.StrategyName() != "balanced" {
		t.Fatalf("default strategy = %s", s.StrategyName())
	}
}

func TestConcurrentCommandsKeepInvariants(t *testing.T) {
	s := newTestSession(t, Options{MaxUsers: 50})
	joinMaestro(t, s)

	done := make(chan struct{})
	for i := range 50 {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			id := ParticipantID(string(rune('a'+i%26)) + string(rune('0'+i/26)))
			if _, err := s.Join(NewParticipant(id, "x", RoleMusician, 0)); err != nil {
				return
			}
			_, _ = s.Leave(id)
		}(i)
	}
	go func() {
		for range 50 {
			_, _ = s.ApplyTransport(TransportCommand{BPM: ptr(128.0)}, RoleMaestro, 0)
			_ = s.Snapshot(0)
		}
		done <- struct{}{}
	}()
	for range 51 {
		<-done
	}

	if s.MusicianCount() != 0 {
		t.Fatalf("every musician left, still %d", s.MusicianCount())
	}
	for _, c := range s.Counts() {
		if c.Count != 0 {
			t.Fatalf("group %d still holds %d members", c.ID, c.Count)
		}
	}
}
