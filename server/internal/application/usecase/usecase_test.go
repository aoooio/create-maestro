package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func TestCreateSession(t *testing.T) {
	h := newHarness(t, Options{})
	out, err := h.u.CreateSession(context.Background(), CreateSessionInput{MaxUsers: 12, BPM: 128})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if out.SessionID != "sess-1" || out.JoinCode != "CODE" || out.MaestroToken != "tok-secret" {
		t.Fatalf("unexpected output: %+v", out)
	}
	if out.MaxUsers != 12 || len(out.Groups) != 2 {
		t.Fatalf("unexpected session shape: %+v", out)
	}
	if h.repo.saves != 1 {
		t.Fatalf("the session must be persisted exactly once, got %d", h.repo.saves)
	}
}

func TestCreateSessionRetriesOnJoinCodeCollision(t *testing.T) {
	h := newHarness(t, Options{})
	h.ids.codes = []session.JoinCode{"TAKEN", "FREE"}
	first := h.newSession(t) // consumes "TAKEN"

	h.ids.codes = []session.JoinCode{"TAKEN", "FREE"}
	second, err := h.u.CreateSession(context.Background(), CreateSessionInput{})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if first.JoinCode != "TAKEN" || second.JoinCode != "FREE" {
		t.Fatalf("collision not resolved: %q then %q", first.JoinCode, second.JoinCode)
	}
}

func TestCreateSessionRejectsUnknownStrategy(t *testing.T) {
	h := newHarness(t, Options{})
	_, err := h.u.CreateSession(context.Background(), CreateSessionInput{Strategy: "chaos"})
	if session.CodeOf(err) != session.CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
	if h.repo.saves != 0 {
		t.Fatal("a rejected creation must persist nothing")
	}
}

func TestJoinSessionMaestroNeedsTheToken(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)

	_, err := h.u.JoinSession(context.Background(), JoinSessionInput{
		SessionID: created.SessionID, Role: session.RoleMaestro, Token: "wrong",
	})
	if session.CodeOf(err) != session.CodeUnauthorized {
		t.Fatalf("want unauthorized, got %v", err)
	}

	out := h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	if out.Participant.Role != session.RoleMaestro || out.Participant.Group != session.NoGroup {
		t.Fatalf("unexpected maestro: %+v", out.Participant)
	}
}

func TestJoinSessionReturnsMessagesInsteadOfBroadcasting(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	out := h.join(t, created.SessionID, session.RoleMusician, "", "  Amélie\n")

	// Nothing may be broadcast before the caller has registered the
	// connection: the newcomer would miss its own welcome.
	if len(h.bus.all()) != 0 {
		t.Fatalf("JoinSession must not broadcast, got %+v", h.bus.all())
	}
	if out.Welcome.Type != application.MsgWelcome || out.Snapshot.Type != application.MsgStateSnapshot {
		t.Fatalf("unexpected messages: %s / %s", out.Welcome.Type, out.Snapshot.Type)
	}
	if out.Announce.Class != application.Ephemeral {
		t.Fatal("presence messages are ephemeral")
	}
	if out.Welcome.Class != application.Critical || out.Snapshot.Class != application.Critical {
		t.Fatal("welcome and snapshot are critical")
	}

	welcome := out.Welcome.Payload.(application.Welcome)
	if welcome.ParticipantID != out.Participant.ID || welcome.SessionID != created.SessionID {
		t.Fatalf("unexpected welcome: %+v", welcome)
	}
	if welcome.ServerTimeMs != h.clock.ms {
		t.Fatalf("welcome must carry the server clock, got %d", welcome.ServerTimeMs)
	}
	if welcome.GroupID != 1 {
		t.Fatalf("first musician goes to group 1, got %d", welcome.GroupID)
	}
	if out.Participant.Name != "Amélie" {
		t.Fatalf("the nickname must be sanitized, got %q", out.Participant.Name)
	}
	assigned := out.Group.Payload.(application.GroupAssigned)
	if assigned.Label != "HIGH" || assigned.Reason != "balanced" {
		t.Fatalf("unexpected group assignment: %+v", assigned)
	}
}

func TestPreflightJoinRefusesBeforeAnythingIsAllocated(t *testing.T) {
	h := newHarness(t, Options{})
	created, err := h.u.CreateSession(context.Background(), CreateSessionInput{MaxUsers: 1})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	ctx := context.Background()

	if err := h.u.PreflightJoin(ctx, created.SessionID, session.RoleMusician, ""); err != nil {
		t.Fatalf("an empty session must accept a musician: %v", err)
	}
	if err := h.u.PreflightJoin(ctx, created.SessionID, session.RoleMaestro, created.MaestroToken); err != nil {
		t.Fatalf("the right token must be accepted: %v", err)
	}
	if err := h.u.PreflightJoin(ctx, created.SessionID, session.RoleMaestro, "nope"); session.CodeOf(err) != session.CodeUnauthorized {
		t.Fatalf("want unauthorized, got %v", err)
	}
	if err := h.u.PreflightJoin(ctx, "ghost", session.RoleMusician, ""); session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("want session_not_found, got %v", err)
	}

	h.join(t, created.SessionID, session.RoleMusician, "", "amelie")
	if err := h.u.PreflightJoin(ctx, created.SessionID, session.RoleMusician, ""); session.CodeOf(err) != session.CodeSessionFull {
		t.Fatalf("want session_full, got %v", err)
	}

	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	if err := h.u.PreflightJoin(ctx, created.SessionID, session.RoleMaestro, created.MaestroToken); session.CodeOf(err) != session.CodeForbiddenRole {
		t.Fatalf("a second maestro must be refused up front, got %v", err)
	}
}

func TestJoinSessionUnknownSession(t *testing.T) {
	h := newHarness(t, Options{})
	_, err := h.u.JoinSession(context.Background(), JoinSessionInput{SessionID: "ghost"})
	if session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("want session_not_found, got %v", err)
	}
}

func TestLeaveSessionAnnouncesTheDeparture(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	joined := h.join(t, created.SessionID, session.RoleMusician, "", "Amélie")
	h.bus.reset()

	if err := h.u.LeaveSession(context.Background(), created.SessionID, joined.Participant.ID); err != nil {
		t.Fatalf("LeaveSession: %v", err)
	}
	d := h.bus.only(t, application.MsgParticipantLeft)
	if d.Scope != "session" || d.Session != created.SessionID {
		t.Fatalf("a departure is announced to the session, got %+v", d)
	}
	presence := d.Msg.Payload.(application.ParticipantPresence)
	if presence.ParticipantID != joined.Participant.ID || presence.Counts[0].Count != 0 {
		t.Fatalf("unexpected presence payload: %+v", presence)
	}

	// A second disconnect of the same connection changes nothing.
	h.bus.reset()
	if err := h.u.LeaveSession(context.Background(), created.SessionID, joined.Participant.ID); err != nil {
		t.Fatalf("second leave: %v", err)
	}
	if len(h.bus.all()) != 0 {
		t.Fatalf("a double disconnect must stay silent, got %+v", h.bus.all())
	}
}

func TestSetTransportIsScheduledAndBroadcast(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	h.bus.reset()

	playing := session.Playing
	msg, err := h.u.SetTransport(context.Background(), SetTransportInput{
		SessionID: created.SessionID,
		Role:      session.RoleMaestro,
		Command:   session.TransportCommand{State: &playing},
	})
	if err != nil {
		t.Fatalf("SetTransport: %v", err)
	}
	payload := msg.Payload.(application.TransportUpdated)
	if payload.EffectiveAtServerMs < h.clock.ms+session.MinLeadMs {
		t.Fatalf("a change must never be effective now: %d vs now %d", payload.EffectiveAtServerMs, h.clock.ms)
	}
	if payload.Generation == 0 || payload.Transport.State != session.Playing {
		t.Fatalf("unexpected transport payload: %+v", payload)
	}
	d := h.bus.only(t, application.MsgTransportUpdated)
	if d.Scope != "session" {
		t.Fatalf("the transport goes to the whole session, got %s", d.Scope)
	}
	if d.Msg.Class != application.Critical {
		t.Fatal("a transport change is critical")
	}
}

func TestSetTransportRejectsMusicians(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMusician, "", "Amélie")
	h.bus.reset()
	savesBefore := h.repo.saves

	bpm := 150.0
	_, err := h.u.SetTransport(context.Background(), SetTransportInput{
		SessionID: created.SessionID,
		Role:      session.RoleMusician,
		Command:   session.TransportCommand{BPM: &bpm},
	})
	if session.CodeOf(err) != session.CodeForbiddenRole {
		t.Fatalf("want forbidden_role, got %v", err)
	}
	if len(h.bus.all()) != 0 {
		t.Fatalf("a rejected command must broadcast nothing, got %+v", h.bus.all())
	}
	if h.repo.saves != savesBefore {
		t.Fatal("a rejected command must persist nothing")
	}
}

func TestSetParameterScopesItsAudience(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")

	h.bus.reset()
	if _, err := h.u.SetParameter(context.Background(), SetParameterInput{
		SessionID: created.SessionID, Role: session.RoleMaestro,
		Key: session.ParamCutoff, Value: 0.4, Target: session.TargetAll(),
	}); err != nil {
		t.Fatalf("SetParameter(all): %v", err)
	}
	if d := h.bus.only(t, application.MsgParamUpdated); d.Scope != "session" {
		t.Fatalf("a global parameter goes to the session, got %s", d.Scope)
	}

	h.bus.reset()
	msg, err := h.u.SetParameter(context.Background(), SetParameterInput{
		SessionID: created.SessionID, Role: session.RoleMaestro,
		Key: session.ParamGain, Value: 9, Target: session.TargetGroup(2),
	})
	if err != nil {
		t.Fatalf("SetParameter(group): %v", err)
	}
	if v := msg.Payload.(application.ParamUpdated).Entry.Value.Number; v != 1 {
		t.Fatalf("the value must be clamped, got %v", v)
	}
	scopes := map[string]session.GroupID{}
	for _, d := range h.bus.all() {
		scopes[d.Scope] = d.Group
	}
	if g, ok := scopes["group"]; !ok || g != 2 {
		t.Fatalf("the targeted group must be reached: %+v", h.bus.all())
	}
	if _, ok := scopes["maestro"]; !ok {
		t.Fatalf("the maestro console must see its own change: %+v", h.bus.all())
	}
}

func TestSetPatternIsBroadcastToTheSession(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	h.bus.reset()

	msg, err := h.u.SetPattern(context.Background(), SetPatternInput{
		SessionID: created.SessionID, Role: session.RoleMaestro,
		TrackID: "kick", Steps: []session.Step{{On: true, Velocity: 0.9}, {}},
	})
	if err != nil {
		t.Fatalf("SetPattern: %v", err)
	}
	if p := msg.Payload.(application.PatternUpdated); p.Pattern.TrackID != "kick" || p.Generation == 0 {
		t.Fatalf("unexpected pattern payload: %+v", p)
	}
	if d := h.bus.only(t, application.MsgPatternUpdated); d.Scope != "session" {
		t.Fatalf("scope = %s", d.Scope)
	}
}

func TestTriggerReachesTheMaestroOnly(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	musician := h.join(t, created.SessionID, session.RoleMusician, "", "Amélie")
	h.bus.reset()

	beat := 12.5
	if err := h.u.TriggerEvent(context.Background(), TriggerEventInput{
		SessionID: created.SessionID, ParticipantID: musician.Participant.ID,
		Role: session.RoleMusician, Kind: "hit", Intensity: 3, AtBeat: &beat,
	}); err != nil {
		t.Fatalf("TriggerEvent: %v", err)
	}
	d := h.bus.only(t, application.MsgParticipantTrigger)
	if d.Scope != "maestro" {
		t.Fatalf("without echo a trigger only reaches the maestro, got %s", d.Scope)
	}
	if d.Msg.Class != application.Ephemeral {
		t.Fatal("a trigger is ephemeral")
	}
	payload := d.Msg.Payload.(application.ParticipantTrigger)
	if payload.Intensity != 1 {
		t.Fatalf("intensity must be clamped to 1, got %v", payload.Intensity)
	}
	if payload.GroupID != musician.Participant.Group || payload.AtBeat == nil || *payload.AtBeat != beat {
		t.Fatalf("unexpected trigger payload: %+v", payload)
	}
}

func TestTriggerEchoAlsoReachesTheGroup(t *testing.T) {
	h := newHarness(t, Options{TriggerEcho: true})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	musician := h.join(t, created.SessionID, session.RoleMusician, "", "Amélie")
	h.bus.reset()

	if err := h.u.TriggerEvent(context.Background(), TriggerEventInput{
		SessionID: created.SessionID, ParticipantID: musician.Participant.ID,
		Role: session.RoleMusician, Kind: "hit", Intensity: 0.5,
	}); err != nil {
		t.Fatalf("TriggerEvent: %v", err)
	}
	scopes := map[string]bool{}
	for _, d := range h.bus.all() {
		scopes[d.Scope] = true
	}
	if !scopes["maestro"] || !scopes["group"] {
		t.Fatalf("echo must reach both the maestro and the group: %+v", h.bus.all())
	}
}

func TestTriggerValidation(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	musician := h.join(t, created.SessionID, session.RoleMusician, "", "Amélie")

	tests := []struct {
		name string
		in   TriggerEventInput
		code session.Code
	}{
		{"maestro cannot trigger", TriggerEventInput{Role: session.RoleMaestro, Kind: "hit"}, session.CodeForbiddenRole},
		{"empty kind", TriggerEventInput{Role: session.RoleMusician}, session.CodeInvalidPayload},
		{"oversized kind", TriggerEventInput{Role: session.RoleMusician, Kind: string(make([]byte, MaxTriggerKindLen+1))}, session.CodeInvalidPayload},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			in.SessionID = created.SessionID
			in.ParticipantID = musician.Participant.ID
			if err := h.u.TriggerEvent(context.Background(), in); session.CodeOf(err) != tc.code {
				t.Fatalf("want %s, got %v", tc.code, err)
			}
		})
	}

	t.Run("unknown participant", func(t *testing.T) {
		err := h.u.TriggerEvent(context.Background(), TriggerEventInput{
			SessionID: created.SessionID, ParticipantID: "ghost",
			Role: session.RoleMusician, Kind: "hit",
		})
		if session.CodeOf(err) != session.CodeInvalidPayload {
			t.Fatalf("want invalid_payload, got %v", err)
		}
	})
}

func TestSyncTimeIsStateless(t *testing.T) {
	h := newHarness(t, Options{})
	msg := h.u.SyncTime(111, 222)
	pong := msg.Payload.(application.TimePong)
	if pong.ClientSendMs != 111 || pong.ServerRecvMs != 222 {
		t.Fatalf("unexpected pong: %+v", pong)
	}
	if msg.Class != application.Critical {
		t.Fatal("a pong is critical: the client cannot sync without it")
	}
	if len(h.bus.all()) != 0 {
		t.Fatal("a pong is answered directly, never broadcast")
	}
}

func TestGetSnapshotAndPublicState(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.join(t, created.SessionID, session.RoleMaestro, created.MaestroToken, "Nadia")
	h.join(t, created.SessionID, session.RoleMusician, "", "Amélie")

	msg, err := h.u.GetSnapshot(context.Background(), created.SessionID)
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	snap := msg.Payload.(application.StateSnapshot).Snapshot
	if snap.ServerTimeMs != h.clock.ms || snap.Generation == 0 {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}

	public, err := h.u.PublicState(context.Background(), created.SessionID)
	if err != nil {
		t.Fatalf("PublicState: %v", err)
	}
	if public.Participants != 2 || public.JoinCode != created.JoinCode || public.State != session.Stopped {
		t.Fatalf("unexpected public state: %+v", public)
	}
	if public.BPM != session.DefaultBPM {
		t.Fatalf("bpm = %v", public.BPM)
	}
}

func TestResolveByCode(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)

	id, err := h.u.ResolveByCode(context.Background(), created.JoinCode)
	if err != nil || id != created.SessionID {
		t.Fatalf("ResolveByCode = %q, %v", id, err)
	}
	if _, err := h.u.ResolveByCode(context.Background(), "NOPE"); session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("want session_not_found, got %v", err)
	}
}

func TestCloseSession(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	h.bus.reset()

	if err := h.u.CloseSession(context.Background(), created.SessionID, "wrong"); session.CodeOf(err) != session.CodeUnauthorized {
		t.Fatalf("want unauthorized, got %v", err)
	}
	if err := h.u.CloseSession(context.Background(), created.SessionID, created.MaestroToken); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if _, err := h.u.GetSnapshot(context.Background(), created.SessionID); session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("a closed session must be gone, got %v", err)
	}
	if _, err := h.u.ResolveByCode(context.Background(), created.JoinCode); session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("the join code must stop resolving, got %v", err)
	}
}

func TestUseCasesRefuseAClosedSession(t *testing.T) {
	h := newHarness(t, Options{})
	created := h.newSession(t)
	s, err := h.repo.FindByID(context.Background(), created.SessionID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	s.Close()

	if _, err := h.u.JoinSession(context.Background(), JoinSessionInput{SessionID: created.SessionID}); session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("join: want session_not_found, got %v", err)
	}
	if _, err := h.u.GetSnapshot(context.Background(), created.SessionID); session.CodeOf(err) != session.CodeSessionNotFound {
		t.Fatalf("snapshot: want session_not_found, got %v", err)
	}
}

func TestTokenGeneratorFailurePropagates(t *testing.T) {
	h := newHarness(t, Options{})
	boom := errors.New("no entropy")
	h.u = New(h.repo, h.clock, h.bus, h.ids, fakeTokens{err: boom}, Options{})

	_, err := h.u.CreateSession(context.Background(), CreateSessionInput{})
	if !errors.Is(err, boom) {
		t.Fatalf("want the generator error, got %v", err)
	}
	if h.repo.saves != 0 {
		t.Fatal("nothing must be persisted when the token cannot be minted")
	}
}
