package session

import (
	"math"
	"strings"
	"testing"
)

func TestBeatMsConversions(t *testing.T) {
	tests := []struct {
		bpm   float64
		beats float64
		ms    float64
	}{
		{60, 1, 1000},
		{120, 1, 500},
		{120, 4, 2000},
		{90, 3, 2000},
		{174, 16, 5517.241379310345},
	}
	for _, tc := range tests {
		if got := BeatsToMs(tc.beats, tc.bpm); math.Abs(got-tc.ms) > 1e-9 {
			t.Fatalf("BeatsToMs(%v, %v) = %v, want %v", tc.beats, tc.bpm, got, tc.ms)
		}
		if got := MsToBeats(tc.ms, tc.bpm); math.Abs(got-tc.beats) > 1e-9 {
			t.Fatalf("MsToBeats(%v, %v) = %v, want %v", tc.ms, tc.bpm, got, tc.beats)
		}
	}
}

func TestStepDuration(t *testing.T) {
	// 120 BPM, sixteenth notes: 125 ms per step, 16 steps per bar.
	if got := StepDurationMs(120, 4); got != 125 {
		t.Fatalf("StepDurationMs = %v, want 125", got)
	}
	if got := StepsPerBar(4, 4); got != 16 {
		t.Fatalf("StepsPerBar = %d, want 16", got)
	}
}

func TestPositionAt(t *testing.T) {
	tests := []struct {
		beat float64
		want Position
	}{
		{0, Position{Bar: 0, BeatInBar: 0, StepInBar: 0}},
		{1.5, Position{Bar: 0, BeatInBar: 1, StepInBar: 6}},
		{4, Position{Bar: 1, BeatInBar: 0, StepInBar: 0}},
		{7.75, Position{Bar: 1, BeatInBar: 3, StepInBar: 15}},
		{-1, Position{Bar: -1, BeatInBar: 3, StepInBar: 12}},
	}
	for _, tc := range tests {
		got := PositionAt(tc.beat, 4, 4)
		if got.Bar != tc.want.Bar || got.BeatInBar != tc.want.BeatInBar || got.StepInBar != tc.want.StepInBar {
			t.Fatalf("PositionAt(%v) = %+v, want %+v", tc.beat, got, tc.want)
		}
		if got.Beat != tc.beat {
			t.Fatalf("PositionAt(%v) lost the absolute beat: %v", tc.beat, got.Beat)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"  Nadia  ", "Nadia"},
		{"a\x00b\nc", "abc"},
		{"", ""},
		{strings.Repeat("x", 40), strings.Repeat("x", MaxNameRunes)},
		{"éléonore-de-très-loin-là-bas", "éléonore-de-très-loin-là"},
	}
	for _, tc := range tests {
		if got := SanitizeName(tc.in); got != tc.want {
			t.Fatalf("SanitizeName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestErrorHelpers(t *testing.T) {
	if CodeOf(nil) != "" {
		t.Fatal("no error means no code")
	}
	if got := CodeOf(errNotDomain{}); got != CodeInternal {
		t.Fatalf("an unknown error must map to internal, got %s", got)
	}
	if MessageOf(errNotDomain{}) != "internal error" {
		t.Fatal("an unknown error must not leak its message to clients")
	}
	if !strings.Contains(ErrSessionFull.Error(), "session_full") {
		t.Fatalf("Error() should carry the code: %s", ErrSessionFull.Error())
	}
	if IsRetryable(ErrForbiddenRole) {
		t.Fatal("a role error is never retryable")
	}
	if !IsRetryable(ErrSessionFull) {
		t.Fatal("a full session is retryable")
	}
}

type errNotDomain struct{}

func (errNotDomain) Error() string { return "boom" }
