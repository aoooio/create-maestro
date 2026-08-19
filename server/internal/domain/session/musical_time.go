package session

import "math"

// msPerMinute is the only unit conversion constant the domain needs: every
// musical duration derives from beats per minute.
const msPerMinute = 60000.0

// BeatsToMs converts a beat count into milliseconds at the given tempo.
func BeatsToMs(beats, bpm float64) float64 { return beats * msPerMinute / bpm }

// MsToBeats converts a duration in milliseconds into beats at the given tempo.
func MsToBeats(ms, bpm float64) float64 { return ms * bpm / msPerMinute }

// StepDurationMs is the wall duration of one sequencer step.
func StepDurationMs(bpm float64, stepsPerBeat int) float64 {
	return BeatsToMs(1, bpm) / float64(stepsPerBeat)
}

// Position is a musical position, expressed in the grid of a transport.
// Bar and Beat are zero-based, matching the beat axis used everywhere else.
type Position struct {
	Bar       int64
	BeatInBar int
	StepInBar int
	Beat      float64
}

// PositionAt projects an absolute beat onto a bar/beat/step grid.
func PositionAt(beat float64, beatsPerBar, stepsPerBeat int) Position {
	bars := math.Floor(beat / float64(beatsPerBar))
	inBar := beat - bars*float64(beatsPerBar)
	return Position{
		Bar:       int64(bars),
		BeatInBar: int(math.Floor(inBar)),
		StepInBar: int(math.Floor(inBar * float64(stepsPerBeat))),
		Beat:      beat,
	}
}

// StepsPerBar is the number of sequencer steps in one bar.
func StepsPerBar(beatsPerBar, stepsPerBeat int) int { return beatsPerBar * stepsPerBeat }
