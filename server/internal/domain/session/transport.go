package session

import "math"

// PlayState is the play/stop state of a session transport.
type PlayState uint8

const (
	Stopped PlayState = iota
	Playing
)

func (s PlayState) String() string {
	if s == Playing {
		return "playing"
	}
	return "stopped"
}

// ParsePlayState reads the wire spelling of a play state.
func ParsePlayState(s string) (PlayState, error) {
	switch s {
	case "playing":
		return Playing, nil
	case "stopped":
		return Stopped, nil
	default:
		return Stopped, Invalidf("unknown transport state %q", s)
	}
}

// Bounds enforced by the domain. They exist so that a hostile or buggy client
// can never push the whole room into an unplayable tempo.
const (
	MinBPM          = 20.0
	MaxBPM          = 300.0
	MinBeatsPerBar  = 1
	MaxBeatsPerBar  = 16
	MinStepsPerBeat = 1
	MaxStepsPerBeat = 8

	// MinLeadMs is the floor applied to every scheduled change (§5.4): a change
	// is never published less than this far in the future, so that clients have
	// time to receive it and re-plan their audio graph.
	MinLeadMs int64 = 300
)

// TempoAnchor pins a musical position to an instant of server time. Deriving
// the position from the latest anchor means a tempo change never rewrites the
// past: everything scheduled before the anchor keeps its original timing.
type TempoAnchor struct {
	AtServerMs int64
	AtBeat     float64
	BPM        float64
}

// Transport is the shared temporal state of a session.
type Transport struct {
	State        PlayState
	Anchor       TempoAnchor
	BeatsPerBar  int
	StepsPerBeat int
	Generation   uint64
}

// NewTransport builds a stopped transport anchored at beat 0.
func NewTransport(nowMs int64, bpm float64) Transport {
	return Transport{
		State:        Stopped,
		Anchor:       TempoAnchor{AtServerMs: nowMs, AtBeat: 0, BPM: bpm},
		BeatsPerBar:  4,
		StepsPerBeat: 4,
	}
}

// Validate checks the invariants of a transport.
func (t Transport) Validate() error {
	if t.Anchor.BPM < MinBPM || t.Anchor.BPM > MaxBPM {
		return Invalidf("bpm must be within [%g, %g], got %g", MinBPM, MaxBPM, t.Anchor.BPM)
	}
	if t.BeatsPerBar < MinBeatsPerBar || t.BeatsPerBar > MaxBeatsPerBar {
		return Invalidf("beatsPerBar must be within [%d, %d], got %d", MinBeatsPerBar, MaxBeatsPerBar, t.BeatsPerBar)
	}
	if t.StepsPerBeat < MinStepsPerBeat || t.StepsPerBeat > MaxStepsPerBeat {
		return Invalidf("stepsPerBeat must be within [%d, %d], got %d", MinStepsPerBeat, MaxStepsPerBeat, t.StepsPerBeat)
	}
	return nil
}

// BeatAt returns the musical position at an instant of server time. A stopped
// transport is frozen on its anchor: musical time does not advance.
func (t Transport) BeatAt(serverMs int64) float64 {
	if t.State != Playing {
		return t.Anchor.AtBeat
	}
	return t.Anchor.AtBeat + MsToBeats(float64(serverMs-t.Anchor.AtServerMs), t.Anchor.BPM)
}

// ServerMsAtBeat is the inverse of BeatAt: the instant a beat is reached.
func (t Transport) ServerMsAtBeat(beat float64) int64 {
	return t.Anchor.AtServerMs + int64(math.Round(BeatsToMs(beat-t.Anchor.AtBeat, t.Anchor.BPM)))
}

// PositionAt projects the transport onto its bar/step grid.
func (t Transport) PositionAt(serverMs int64) Position {
	return PositionAt(t.BeatAt(serverMs), t.BeatsPerBar, t.StepsPerBeat)
}

// NextBarBoundary returns the instant of the first bar boundary that is at
// least MinLeadMs in the future — the point where structural changes are
// applied. On a stopped transport there is no upcoming boundary, so the floor
// itself is returned.
func (t Transport) NextBarBoundary(serverMs int64) int64 {
	earliest := serverMs + MinLeadMs
	if t.State != Playing {
		return earliest
	}
	barBeats := float64(t.BeatsPerBar)
	beat := t.BeatAt(earliest)
	// A tiny epsilon absorbs float noise so that a boundary landing exactly on
	// `earliest` is not pushed a whole bar away.
	next := math.Ceil(beat/barBeats-1e-9) * barBeats
	at := t.ServerMsAtBeat(next)
	if at < earliest {
		at = earliest
	}
	return at
}

// Alignment says when a transport command takes effect.
type Alignment uint8

const (
	AlignBar Alignment = iota
	AlignImmediate
)

// ParseAlignment reads the wire spelling of an alignment.
func ParseAlignment(s string) (Alignment, error) {
	switch s {
	case "", "bar":
		return AlignBar, nil
	case "immediate":
		return AlignImmediate, nil
	default:
		return AlignBar, Invalidf("unknown alignment %q", s)
	}
}

// TransportCommand is a partial update of the transport. A nil field is left
// untouched, which is what lets the maestro change only the tempo.
type TransportCommand struct {
	BPM          *float64
	State        *PlayState
	BeatsPerBar  *int
	StepsPerBeat *int
	Align        Alignment
}

// IsEmpty reports whether the command would change nothing.
func (c TransportCommand) IsEmpty() bool {
	return c.BPM == nil && c.State == nil && c.BeatsPerBar == nil && c.StepsPerBeat == nil
}

// Apply computes the transport that results from a command, together with the
// instant it becomes effective. The current transport is left untouched: the
// caller decides whether to keep the result.
//
// The new anchor always carries the beat computed with the *previous* tempo at
// the effective instant, which is what keeps the phase continuous across a
// tempo change.
func (t Transport) Apply(cmd TransportCommand, nowMs int64) (Transport, int64, error) {
	if cmd.IsEmpty() {
		return t, 0, Invalidf("transport command changes nothing")
	}
	effectiveAt := nowMs
	if cmd.Align == AlignBar {
		effectiveAt = t.NextBarBoundary(nowMs)
	}

	next := t
	next.Anchor = TempoAnchor{
		AtServerMs: effectiveAt,
		AtBeat:     t.BeatAt(effectiveAt),
		BPM:        t.Anchor.BPM,
	}
	if cmd.BPM != nil {
		next.Anchor.BPM = *cmd.BPM
	}
	if cmd.BeatsPerBar != nil {
		next.BeatsPerBar = *cmd.BeatsPerBar
	}
	if cmd.StepsPerBeat != nil {
		next.StepsPerBeat = *cmd.StepsPerBeat
	}
	if cmd.State != nil {
		next.State = *cmd.State
	}
	if err := next.Validate(); err != nil {
		return t, 0, err
	}
	return next, effectiveAt, nil
}
