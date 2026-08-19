package session

// TrackID names one instrument lane of the sequencer ("kick", "hat", …).
type TrackID string

// MaxSteps caps a pattern grid. 64 covers four bars of sixteenth notes, which
// is well beyond what the spec asks for and keeps a message small.
const MaxSteps = 64

// MaxTracks caps the number of lanes a session can hold.
const MaxTracks = 32

// Step is one cell of the grid.
type Step struct {
	On       bool
	Velocity float64
}

// Pattern is the step grid of a track.
type Pattern struct {
	TrackID    TrackID
	Steps      []Step
	Generation uint64
}

// NewPattern validates a grid coming from the outside world.
func NewPattern(id TrackID, steps []Step) (Pattern, error) {
	if id == "" {
		return Pattern{}, Invalidf("trackId is required")
	}
	if len(steps) == 0 {
		return Pattern{}, Invalidf("pattern %q has no step", id)
	}
	if len(steps) > MaxSteps {
		return Pattern{}, Invalidf("pattern %q has %d steps, max is %d", id, len(steps), MaxSteps)
	}
	clamped := make([]Step, len(steps))
	for i, s := range steps {
		switch {
		case s.Velocity < 0:
			s.Velocity = 0
		case s.Velocity > 1:
			s.Velocity = 1
		case s.On && s.Velocity == 0:
			s.Velocity = 1 // an active step with no velocity plays at full level
		}
		clamped[i] = s
	}
	return Pattern{TrackID: id, Steps: clamped}, nil
}

// Clone returns a deep copy, so that a snapshot handed to another goroutine
// can never be mutated from under it.
func (p Pattern) Clone() Pattern {
	steps := make([]Step, len(p.Steps))
	copy(steps, p.Steps)
	return Pattern{TrackID: p.TrackID, Steps: steps, Generation: p.Generation}
}
