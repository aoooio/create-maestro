package session

import (
	"math"
	"testing"
)

func playing(bpm float64, atMs int64, atBeat float64) Transport {
	return Transport{
		State:        Playing,
		Anchor:       TempoAnchor{AtServerMs: atMs, AtBeat: atBeat, BPM: bpm},
		BeatsPerBar:  4,
		StepsPerBeat: 4,
	}
}

func TestBeatAt(t *testing.T) {
	tests := []struct {
		name     string
		tr       Transport
		atMs     int64
		wantBeat float64
	}{
		{"anchor instant", playing(120, 1000, 0), 1000, 0},
		{"one beat at 120bpm", playing(120, 1000, 0), 1500, 1},
		{"one bar at 120bpm", playing(120, 1000, 0), 3000, 4},
		{"before the anchor", playing(120, 1000, 8), 500, 7},
		{"60bpm is one beat per second", playing(60, 0, 0), 3000, 3},
		{"140bpm", playing(140, 0, 0), 60000, 140},
		{"stopped transport is frozen", Transport{State: Stopped, Anchor: TempoAnchor{AtServerMs: 0, AtBeat: 7.5, BPM: 120}, BeatsPerBar: 4, StepsPerBeat: 4}, 999999, 7.5},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.tr.BeatAt(tc.atMs); math.Abs(got-tc.wantBeat) > 1e-9 {
				t.Fatalf("BeatAt(%d) = %v, want %v", tc.atMs, got, tc.wantBeat)
			}
		})
	}
}

func TestBeatAtServerMsRoundTrip(t *testing.T) {
	for _, bpm := range []float64{20, 60, 90, 120, 128, 174, 300} {
		tr := playing(bpm, 1_700_000_000_000, 12.25)
		for _, offset := range []int64{0, 1, 250, 1000, 60_000, 3_600_000} {
			at := tr.Anchor.AtServerMs + offset
			beat := tr.BeatAt(at)
			if got := tr.ServerMsAtBeat(beat); got != at {
				t.Fatalf("bpm=%v offset=%d: round trip gave %d, want %d", bpm, offset, got, at)
			}
		}
	}
}

func TestNextBarBoundary(t *testing.T) {
	t.Run("respects the minimum lead", func(t *testing.T) {
		// At 120 BPM a bar lasts 2000 ms. now=1900 sits 100 ms before the bar
		// at 2000 ms: too close, so the boundary must be the following one.
		tr := playing(120, 0, 0)
		if got := tr.NextBarBoundary(1900); got != 4000 {
			t.Fatalf("NextBarBoundary(1900) = %d, want 4000", got)
		}
	})

	t.Run("takes the next bar when there is room", func(t *testing.T) {
		tr := playing(120, 0, 0)
		if got := tr.NextBarBoundary(1000); got != 2000 {
			t.Fatalf("NextBarBoundary(1000) = %d, want 2000", got)
		}
	})

	t.Run("a boundary exactly at the lead floor is kept", func(t *testing.T) {
		tr := playing(120, 0, 0)
		if got := tr.NextBarBoundary(2000 - MinLeadMs); got != 2000 {
			t.Fatalf("NextBarBoundary(%d) = %d, want 2000", 2000-MinLeadMs, got)
		}
	})

	t.Run("always lands on a bar", func(t *testing.T) {
		tr := playing(137, 4321, 3.7)
		at := tr.NextBarBoundary(10_000)
		beat := tr.BeatAt(at)
		if rem := math.Abs(beat/float64(tr.BeatsPerBar) - math.Round(beat/float64(tr.BeatsPerBar))); rem > 1e-3 {
			t.Fatalf("boundary at %d falls on beat %v, not on a bar", at, beat)
		}
		if at < 10_000+MinLeadMs {
			t.Fatalf("boundary %d is closer than the %d ms floor", at, MinLeadMs)
		}
	})

	t.Run("a stopped transport falls back to the lead floor", func(t *testing.T) {
		tr := playing(120, 0, 0)
		tr.State = Stopped
		if got := tr.NextBarBoundary(5000); got != 5000+MinLeadMs {
			t.Fatalf("NextBarBoundary = %d, want %d", got, 5000+MinLeadMs)
		}
	})
}

func TestApplyKeepsPhaseAcrossTempoChange(t *testing.T) {
	tr := playing(120, 0, 0)
	newBPM := 90.0
	next, effectiveAt, err := tr.Apply(TransportCommand{BPM: &newBPM}, 1000)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if effectiveAt != 2000 {
		t.Fatalf("effectiveAt = %d, want 2000 (next bar)", effectiveAt)
	}
	// The instant the change applies, both transports must agree on the beat:
	// that is what "the tempo change does not break the phase" means.
	if before, after := tr.BeatAt(effectiveAt), next.BeatAt(effectiveAt); math.Abs(before-after) > 1e-9 {
		t.Fatalf("phase jumped at the boundary: %v -> %v", before, after)
	}
	if next.Anchor.BPM != newBPM {
		t.Fatalf("bpm = %v, want %v", next.Anchor.BPM, newBPM)
	}
	// And the new tempo must actually be in effect afterwards: at 90 BPM a
	// beat lasts 666.67 ms.
	if got := next.BeatAt(effectiveAt + 2000); math.Abs(got-(4+3)) > 1e-6 {
		t.Fatalf("beat 2 s after the change = %v, want 7", got)
	}
}

func TestApplyStartAndStop(t *testing.T) {
	tr := NewTransport(0, 120)

	started, effectiveAt, err := tr.Apply(TransportCommand{State: ptr(Playing)}, 1000)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if effectiveAt != 1000+MinLeadMs {
		t.Fatalf("a stopped transport has no bar boundary: effectiveAt = %d, want %d", effectiveAt, 1000+MinLeadMs)
	}
	if started.State != Playing || started.Anchor.AtServerMs != effectiveAt || started.Anchor.AtBeat != 0 {
		t.Fatalf("unexpected anchor after start: %+v", started.Anchor)
	}

	stopped, stopAt, err := started.Apply(TransportCommand{State: ptr(Stopped)}, effectiveAt+1000)
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	frozen := started.BeatAt(stopAt)
	if math.Abs(stopped.BeatAt(stopAt+10_000)-frozen) > 1e-9 {
		t.Fatalf("a stopped transport must freeze on beat %v", frozen)
	}
}

func TestApplyImmediateSkipsAlignment(t *testing.T) {
	tr := playing(120, 0, 0)
	bpm := 150.0
	_, effectiveAt, err := tr.Apply(TransportCommand{BPM: &bpm, Align: AlignImmediate}, 1234)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if effectiveAt != 1234 {
		t.Fatalf("effectiveAt = %d, want 1234", effectiveAt)
	}
}

func TestApplyRejectsOutOfBounds(t *testing.T) {
	tr := playing(120, 0, 0)
	tests := []struct {
		name string
		cmd  TransportCommand
	}{
		{"bpm too low", TransportCommand{BPM: ptr(1.0)}},
		{"bpm too high", TransportCommand{BPM: ptr(9000.0)}},
		{"beats per bar too high", TransportCommand{BeatsPerBar: ptr(64)}},
		{"steps per beat zero", TransportCommand{StepsPerBeat: ptr(0)}},
		{"empty command", TransportCommand{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := tr.Apply(tc.cmd, 0); CodeOf(err) != CodeInvalidPayload {
				t.Fatalf("got %v, want an invalid_payload error", err)
			}
		})
	}
}

func TestParseHelpers(t *testing.T) {
	if s, err := ParsePlayState("playing"); err != nil || s != Playing {
		t.Fatalf("ParsePlayState(playing) = %v, %v", s, err)
	}
	if _, err := ParsePlayState("dancing"); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
	if a, err := ParseAlignment(""); err != nil || a != AlignBar {
		t.Fatalf("empty alignment must default to bar, got %v, %v", a, err)
	}
	if _, err := ParseAlignment("someday"); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
}

func ptr[T any](v T) *T { return &v }
