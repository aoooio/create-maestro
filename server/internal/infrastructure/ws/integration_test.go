package ws

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
)

// The exit criterion of lot 1: several clients see the same participant count
// and the same state.
func TestJoinFlowSharesTheSameState(t *testing.T) {
	srv := newTestServer(t, nil)

	maestro := srv.dialMaestro(t)
	welcome := maestro.join()
	if welcome.Role != "maestro" || welcome.GroupID != 0 {
		t.Fatalf("unexpected maestro welcome: %+v", welcome)
	}
	if welcome.ProtocolVersion != ProtocolVersion || welcome.ServerTimeMs == 0 {
		t.Fatalf("welcome must carry the protocol version and the server clock: %+v", welcome)
	}

	first := srv.dialMusician(t, "amelie")
	firstWelcome := first.join()
	var assigned groupAssignedDTO
	first.expect("group.assigned").into(t, &assigned)
	if firstWelcome.GroupID != 1 || assigned.Label != "HIGH" {
		t.Fatalf("first musician should land in group 1 HIGH: %+v / %+v", firstWelcome, assigned)
	}

	// The maestro sees the arrival, with the updated counts.
	presence := maestro.expectPresence("participant.joined", firstWelcome.ParticipantID)
	if presence.Name != "amelie" || presence.Role != "musician" {
		t.Fatalf("unexpected presence: %+v", presence)
	}

	second := srv.dialMusician(t, "bruno")
	secondWelcome := second.join()
	if secondWelcome.GroupID != 2 {
		t.Fatalf("the balanced policy should send the second musician to group 2, got %d", secondWelcome.GroupID)
	}

	// Everyone already connected hears about the newcomer and agrees on the
	// same counts.
	for _, c := range []*client{maestro, first} {
		p := c.expectPresence("participant.joined", secondWelcome.ParticipantID)
		if len(p.Counts) != 2 || p.Counts[0].Count != 1 || p.Counts[1].Count != 1 {
			t.Fatalf("%s sees counts %+v, want 1 and 1", c.name, p.Counts)
		}
	}
}

func TestSnapshotIsSentOnJoinAndOnRequest(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()

	maestro.send(TypePatternSet, patternSetDTO{
		TrackID: "kick",
		Steps:   []bool{true, false, true, false},
	})
	maestro.expect("pattern.updated")

	musician := srv.dialMusician(t, "amelie")
	musician.send(TypeHello, map[string]any{"clientVersion": "test"})
	musician.expect("welcome")

	var snapshot snapshotDTO
	musician.expect("state.snapshot").into(t, &snapshot)
	if len(snapshot.Patterns) != 1 || snapshot.Patterns[0].TrackID != "kick" {
		t.Fatalf("the snapshot must carry the patterns: %+v", snapshot.Patterns)
	}
	if len(snapshot.Params) == 0 || snapshot.Generation == 0 || snapshot.Transport.State != "stopped" {
		t.Fatalf("incomplete snapshot: %+v", snapshot)
	}

	// A reconnecting client asks for the state again and gets the same thing.
	musician.send(TypeStateRequest, struct{}{})
	again := musician.expect("state.snapshot")
	if again.Ack != TypeStateRequest+"-1" {
		t.Fatalf("the snapshot must acknowledge the request, got %q", again.Ack)
	}
	var second snapshotDTO
	again.into(t, &second)
	if second.Generation != snapshot.Generation {
		t.Fatalf("generation moved on its own: %d then %d", snapshot.Generation, second.Generation)
	}
}

func TestTransportChangeIsScheduledOnABarBoundary(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()
	musician := srv.dialMusician(t, "amelie")
	musician.join()
	maestro.expect("participant.joined")

	playing := "playing"
	maestro.send(TypeTransportSet, transportSetDTO{State: &playing})

	var start transportUpdatedDTO
	for _, c := range []*client{maestro, musician} {
		var updated transportUpdatedDTO
		c.expect("transport.updated").into(t, &updated)
		if updated.State != "playing" || updated.Generation == 0 {
			t.Fatalf("%s got an unexpected transport: %+v", c.name, updated)
		}
		if updated.EffectiveAtServerMs != updated.Anchor.AtServerMs {
			t.Fatalf("the anchor must sit on the effective instant: %+v", updated)
		}
		if c.name == "maestro" {
			start = updated
		} else if updated.Generation != start.Generation {
			t.Fatal("both clients must see the same generation")
		}
	}

	now := srv.uc.NowMs()
	if start.EffectiveAtServerMs < now {
		t.Fatalf("a change is never effective in the past: %d < %d", start.EffectiveAtServerMs, now)
	}

	// Now change the tempo while playing: the new instant must land on a bar.
	bpm := 90.0
	maestro.send(TypeTransportSet, transportSetDTO{BPM: &bpm})
	var tempo transportUpdatedDTO
	maestro.expect("transport.updated").into(t, &tempo)

	if tempo.Anchor.BPM != bpm {
		t.Fatalf("bpm = %v, want %v", tempo.Anchor.BPM, bpm)
	}
	if tempo.EffectiveAtServerMs < srv.uc.NowMs()+session.MinLeadMs-50 {
		t.Fatalf("the change is too close to now: %d", tempo.EffectiveAtServerMs)
	}
	// The beat carried by the new anchor is where the previous transport was
	// at that instant: the phase does not jump.
	previous := session.Transport{
		State:        session.Playing,
		Anchor:       session.TempoAnchor{AtServerMs: start.Anchor.AtServerMs, AtBeat: start.Anchor.AtBeat, BPM: start.Anchor.BPM},
		BeatsPerBar:  start.BeatsPerBar,
		StepsPerBeat: start.StepsPerBeat,
	}
	expected := previous.BeatAt(tempo.EffectiveAtServerMs)
	if diff := expected - tempo.Anchor.AtBeat; diff > 1e-6 || diff < -1e-6 {
		t.Fatalf("phase jumped: anchor at beat %v, expected %v", tempo.Anchor.AtBeat, expected)
	}
	// And it is a whole number of bars.
	if bars := tempo.Anchor.AtBeat / float64(tempo.BeatsPerBar); bars-float64(int(bars+0.5)) > 1e-6 {
		t.Fatalf("the change does not land on a bar: beat %v", tempo.Anchor.AtBeat)
	}
}

func TestMusicianCannotDriveTheTransport(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()
	musician := srv.dialMusician(t, "amelie")
	musician.join()
	maestro.expect("participant.joined")

	bpm := 200.0
	musician.send(TypeTransportSet, transportSetDTO{BPM: &bpm})

	var failure errorDTO
	musician.expect("error").into(t, &failure)
	if failure.Code != string(session.CodeForbiddenRole) || failure.Retryable {
		t.Fatalf("unexpected error: %+v", failure)
	}
	// Nothing was broadcast: the room never heard about it.
	maestro.expectNot("transport.updated")
}

func TestTimePingAnswersWithABracketedPong(t *testing.T) {
	srv := newTestServer(t, nil)
	musician := srv.dialMusician(t, "amelie")
	musician.join()

	const clientSend = 123456
	musician.send(TypeTimePing, timePingDTO{ClientSendMs: clientSend})

	msg := musician.expect("time.pong")
	var pong timePongDTO
	msg.into(t, &pong)

	if pong.ClientSendMs != clientSend {
		t.Fatalf("the client stamp must come back untouched, got %d", pong.ClientSendMs)
	}
	if pong.ServerRecvMs > pong.ServerSendMs {
		t.Fatalf("serverRecvMs (%d) must not follow serverSendMs (%d)", pong.ServerRecvMs, pong.ServerSendMs)
	}
	if msg.Ack != TypeTimePing+"-1" {
		t.Fatalf("a pong must acknowledge its ping, got %q", msg.Ack)
	}
	if msg.TS < pong.ServerRecvMs {
		t.Fatalf("the envelope timestamp is older than the message it carries")
	}
}

func TestTriggerReachesTheMaestroOnly(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()

	first := srv.dialMusician(t, "amelie")
	firstWelcome := first.join()
	second := srv.dialMusician(t, "bruno")
	second.join()

	first.send(TypeTrigger, triggerDTO{Kind: "hit", Intensity: 0.75})

	var relayed triggerRelayDTO
	maestro.expect("participant.trigger").into(t, &relayed)
	if relayed.ParticipantID != firstWelcome.ParticipantID || relayed.Kind != "hit" || relayed.Intensity != 0.75 {
		t.Fatalf("unexpected trigger: %+v", relayed)
	}
	if relayed.GroupID != firstWelcome.GroupID {
		t.Fatalf("the trigger must carry the sender's group, got %d", relayed.GroupID)
	}
	second.expectNot("participant.trigger")
}

func TestTriggerEchoAlsoReachesTheGroup(t *testing.T) {
	srv := newTestServer(t, func(c *config.Config) { c.TriggerEcho = true })
	maestro := srv.dialMaestro(t)
	maestro.join()
	musician := srv.dialMusician(t, "amelie")
	musician.join()

	musician.send(TypeTrigger, triggerDTO{Kind: "hit", Intensity: 0.5})
	maestro.expect("participant.trigger")
	musician.expect("participant.trigger")
}

func TestParameterReachesItsTargetGroupOnly(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()
	high := srv.dialMusician(t, "high")
	high.join()
	mid := srv.dialMusician(t, "mid")
	mid.join()

	maestro.send(TypeParamSet, map[string]any{"key": "cutoff", "value": 0.42, "target": "group:2"})

	var updated paramUpdatedDTO
	mid.expect("param.updated").into(t, &updated)
	if updated.Key != "cutoff" || updated.Target != "group:2" || updated.Value != 0.42 {
		t.Fatalf("unexpected parameter: %+v", updated)
	}
	// The maestro console sees its own change; the other group does not.
	maestro.expect("param.updated")
	high.expectNot("param.updated")

	// A global parameter reaches everybody, and a boolean survives the trip.
	maestro.send(TypeParamSet, map[string]any{"key": "mute", "value": true, "target": "all"})
	for _, c := range []*client{maestro, high, mid} {
		var global paramUpdatedDTO
		c.expect("param.updated").into(t, &global)
		if global.Key != "mute" || global.Value != true {
			t.Fatalf("%s got %+v, want mute=true", c.name, global)
		}
	}

	// Out-of-range values are clamped rather than refused.
	maestro.send(TypeParamSet, map[string]any{"key": "gain", "value": 12, "target": "all"})
	var clamped paramUpdatedDTO
	maestro.expect("param.updated").into(t, &clamped)
	if clamped.Value != 1.0 {
		t.Fatalf("gain should have been clamped to 1, got %v", clamped.Value)
	}
}

func TestPatternIsBroadcastToTheWholeSession(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()
	musician := srv.dialMusician(t, "amelie")
	musician.join()

	maestro.send(TypePatternSet, patternSetDTO{
		TrackID:  "snare",
		Steps:    []bool{false, true, false, true},
		Velocity: []float64{0, 0.6, 0, 0.9},
	})

	for _, c := range []*client{maestro, musician} {
		var pattern patternDTO
		c.expect("pattern.updated").into(t, &pattern)
		if pattern.TrackID != "snare" || len(pattern.Steps) != 4 || !pattern.Steps[1] {
			t.Fatalf("%s got an unexpected pattern: %+v", c.name, pattern)
		}
		if pattern.Velocity[3] != 0.9 || pattern.Generation == 0 {
			t.Fatalf("%s: velocity or generation lost: %+v", c.name, pattern)
		}
	}

	// A musician may not edit the grid.
	musician.send(TypePatternSet, patternSetDTO{TrackID: "kick", Steps: []bool{true}})
	var failure errorDTO
	musician.expect("error").into(t, &failure)
	if failure.Code != string(session.CodeForbiddenRole) {
		t.Fatalf("want forbidden_role, got %+v", failure)
	}
}

func TestDepartureIsAnnounced(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()
	musician := srv.dialMusician(t, "amelie")
	welcome := musician.join()
	maestro.expect("participant.joined")

	_ = musician.ws.Close()

	var presence presenceDTO
	maestro.expect("participant.left").into(t, &presence)
	if presence.ParticipantID != welcome.ParticipantID {
		t.Fatalf("unexpected departure: %+v", presence)
	}
	if presence.Counts[0].Count != 0 {
		t.Fatalf("the group should be empty again: %+v", presence.Counts)
	}
}

func TestMalformedAndUnknownMessages(t *testing.T) {
	srv := newTestServer(t, nil)
	musician := srv.dialMusician(t, "amelie")
	musician.join()

	if err := musician.sendRaw([]byte("{not json")); err != nil {
		t.Fatalf("send: %v", err)
	}
	var failure errorDTO
	musician.expect("error").into(t, &failure)
	if failure.Code != string(session.CodeInvalidPayload) {
		t.Fatalf("want invalid_payload, got %+v", failure)
	}

	musician.send("dance.set", struct{}{})
	musician.expect("error").into(t, &failure)
	if failure.Code != string(session.CodeInvalidPayload) {
		t.Fatalf("an unknown type must be rejected, got %+v", failure)
	}

	// A future protocol version is refused with its own code, so the client
	// can tell the user to reload rather than retrying forever.
	if err := musician.sendRaw([]byte(`{"v":99,"t":"time.ping","d":{}}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	musician.expect("error").into(t, &failure)
	if failure.Code != string(session.CodeProtocolVersion) {
		t.Fatalf("want protocol_version, got %+v", failure)
	}

	// None of this killed the connection.
	musician.send(TypeTimePing, timePingDTO{ClientSendMs: 1})
	musician.expect("time.pong")
}

func TestOversizedMessageClosesTheConnection(t *testing.T) {
	srv := newTestServer(t, func(c *config.Config) { c.MaxMessageBytes = 1024 })
	musician := srv.dialMusician(t, "amelie")
	musician.join()

	if err := musician.sendRaw([]byte(`{"v":1,"t":"trigger","d":{"kind":"` + strings.Repeat("x", 2048) + `"}}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if code := musician.closeCode(); code != websocket.CloseMessageTooBig {
		t.Fatalf("close code = %d, want %d (message too big)", code, websocket.CloseMessageTooBig)
	}
}

func TestRateLimitWarnsThenCloses(t *testing.T) {
	srv := newTestServer(t, func(c *config.Config) {
		c.RateBurst = 2
		c.RateSustained = 1
	})
	musician := srv.dialMusician(t, "amelie")
	musician.send(TypeHello, map[string]any{"clientVersion": "test"})

	for range 20 {
		if err := musician.ws.WriteJSON(map[string]any{
			"v": ProtocolVersion, "t": TypeTimePing, "d": map[string]any{"clientSendMs": 1},
		}); err != nil {
			break
		}
	}

	limited := 0
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		msg, err := musician.read()
		if err != nil {
			var closeErr *websocket.CloseError
			if !asCloseError(err, &closeErr) {
				t.Fatalf("unexpected read error: %v", err)
			}
			break
		}
		if msg.T == "error" {
			var failure errorDTO
			msg.into(t, &failure)
			if failure.Code == string(session.CodeRateLimited) {
				limited++
			}
		}
	}
	if limited < maxRateStrikes {
		t.Fatalf("got %d rate_limited warnings, want at least %d before the close", limited, maxRateStrikes)
	}
}

func TestHelloIsMandatoryAndBounded(t *testing.T) {
	previous := helloTimeout
	helloTimeout = 200 * time.Millisecond
	t.Cleanup(func() { helloTimeout = previous })

	srv := newTestServer(t, nil)

	t.Run("silence closes the connection", func(t *testing.T) {
		silent := srv.dialMusician(t, "silent")
		var failure errorDTO
		silent.expect("error").into(t, &failure)
		if failure.Code != string(session.CodeUnauthorized) {
			t.Fatalf("want unauthorized, got %+v", failure)
		}
		if code := silent.closeCode(); code != websocket.CloseNormalClosure {
			t.Fatalf("close code = %d", code)
		}
	})

	t.Run("no command is accepted before hello", func(t *testing.T) {
		early := srv.dialMusician(t, "early")
		early.send(TypeTrigger, triggerDTO{Kind: "hit"})
		var failure errorDTO
		early.expect("error").into(t, &failure)
		if failure.Code != string(session.CodeUnauthorized) {
			t.Fatalf("want unauthorized, got %+v", failure)
		}
	})
}

func TestUpgradeIsRefusedBeforeAnythingIsAllocated(t *testing.T) {
	srv := newTestServer(t, func(c *config.Config) { c.DefaultMaxUsers = 1 })

	t.Run("wrong maestro token", func(t *testing.T) {
		_, resp, err := srv.tryDial(t, "/ws/v1/maestro", url.Values{
			"session": {string(srv.sessions.ID)},
			"token":   {"nope"},
		}, nil)
		if err == nil {
			t.Fatal("the upgrade should have been refused")
		}
		assertStatus(t, resp, http.StatusUnauthorized, string(session.CodeUnauthorized))
	})

	t.Run("unknown session", func(t *testing.T) {
		_, resp, err := srv.tryDial(t, "/ws/v1/perform", url.Values{"session": {"ghost"}}, nil)
		if err == nil {
			t.Fatal("the upgrade should have been refused")
		}
		assertStatus(t, resp, http.StatusNotFound, string(session.CodeSessionNotFound))
	})

	t.Run("missing session parameter", func(t *testing.T) {
		_, resp, err := srv.tryDial(t, "/ws/v1/perform", url.Values{}, nil)
		if err == nil {
			t.Fatal("the upgrade should have been refused")
		}
		assertStatus(t, resp, http.StatusBadRequest, string(session.CodeInvalidPayload))
	})

	t.Run("full session", func(t *testing.T) {
		occupant := srv.dialMusician(t, "occupant")
		occupant.join()

		_, resp, err := srv.tryDial(t, "/ws/v1/perform", url.Values{
			"session": {string(srv.sessions.ID)},
		}, nil)
		if err == nil {
			t.Fatal("the upgrade should have been refused")
		}
		assertStatus(t, resp, http.StatusConflict, string(session.CodeSessionFull))
	})

	t.Run("second maestro", func(t *testing.T) {
		maestro := srv.dialMaestro(t)
		maestro.join()

		_, resp, err := srv.tryDial(t, "/ws/v1/maestro", url.Values{
			"session": {string(srv.sessions.ID)},
			"token":   {string(srv.sessions.Token)},
		}, nil)
		if err == nil {
			t.Fatal("a second maestro should have been refused")
		}
		assertStatus(t, resp, http.StatusForbidden, string(session.CodeForbiddenRole))
	})
}

func TestOriginAllowList(t *testing.T) {
	srv := newTestServer(t, func(c *config.Config) {
		c.AllowedOrigins = []string{"https://maestro.example"}
	})

	header := http.Header{"Origin": {"https://evil.example"}}
	if _, resp, err := srv.tryDial(t, "/ws/v1/perform", url.Values{"session": {string(srv.sessions.ID)}}, header); err == nil {
		t.Fatal("a foreign origin must be refused")
	} else if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unexpected response for a foreign origin: %v", resp)
	}

	allowed := http.Header{"Origin": {"https://maestro.example"}}
	conn, _, err := srv.tryDial(t, "/ws/v1/perform", url.Values{"session": {string(srv.sessions.ID)}}, allowed)
	if err != nil {
		t.Fatalf("the allowed origin must get through: %v", err)
	}
	_ = conn.Close()
}

func assertStatus(t *testing.T, resp *http.Response, status int, code string) {
	t.Helper()
	if resp == nil {
		t.Fatal("no HTTP response")
	}
	defer resp.Body.Close()
	if resp.StatusCode != status {
		t.Fatalf("status = %d, want %d", resp.StatusCode, status)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSON(resp, &body); err != nil {
		t.Fatalf("cannot decode error body: %v", err)
	}
	if body.Code != code {
		t.Fatalf("error code = %q, want %q", body.Code, code)
	}
}

// On shutdown the clients must be told the server is going away — code 1001
// is what tells a client to reconnect rather than to give up.
func TestShutdownClosesClientsWithGoingAway(t *testing.T) {
	srv := newTestServer(t, nil)
	maestro := srv.dialMaestro(t)
	maestro.join()
	musician := srv.dialMusician(t, "amelie")
	musician.join()

	srv.stop()

	for _, c := range []*client{maestro, musician} {
		if code := c.closeCode(); code != websocket.CloseGoingAway {
			t.Fatalf("%s: close code = %d, want %d (going away)", c.name, code, websocket.CloseGoingAway)
		}
	}

	// And the door is shut: a latecomer is turned away rather than hijacked.
	_, resp, err := srv.tryDial(t, "/ws/v1/perform", url.Values{"session": {string(srv.sessions.ID)}}, nil)
	if err == nil {
		t.Fatal("a draining server must refuse new connections")
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unexpected response: %v", resp)
	}
	resp.Body.Close()
}
