package session

import "testing"

func TestPatternClampsNoteIntoTheMidiRange(t *testing.T) {
	p, err := NewPattern("bass", []Step{
		{On: true, Note: -12},
		{On: true, Note: 36},
		{On: true, Note: 900},
	})
	if err != nil {
		t.Fatalf("NewPattern: %v", err)
	}
	want := []int{MinNote, 36, MaxNote}
	for i, w := range want {
		if p.Steps[i].Note != w {
			t.Fatalf("step %d note = %d, want %d", i, p.Steps[i].Note, w)
		}
	}
}

func TestPatternKeepsNoteOnInactiveSteps(t *testing.T) {
	// An off step still remembers its pitch: switching a cell back on must not
	// lose the note the maestro dialled in.
	p, err := NewPattern("bass", []Step{{On: false, Note: 41}})
	if err != nil {
		t.Fatalf("NewPattern: %v", err)
	}
	if p.Steps[0].Note != 41 {
		t.Fatalf("note = %d, want 41", p.Steps[0].Note)
	}
}

func TestClonedPatternCarriesTheNotes(t *testing.T) {
	p, err := NewPattern("bass", []Step{{On: true, Note: 43}})
	if err != nil {
		t.Fatalf("NewPattern: %v", err)
	}
	clone := p.Clone()
	clone.Steps[0].Note = 60
	if p.Steps[0].Note != 43 {
		t.Fatal("Clone must not share the step slice")
	}
}

func TestAcidBassParametersAreRegistered(t *testing.T) {
	// The client refuses to send a key the server does not know, and the server
	// refuses to store one it does not know: the two registries are one
	// contract, and this is the half that can be tested here.
	for _, key := range []ParameterKey{
		ParamBassCutoff, ParamBassResonance, ParamBassEnvMod,
		ParamBassDecay, ParamBassAccent, ParamBassRoot,
	} {
		if _, err := LookupParameter(key); err != nil {
			t.Fatalf("LookupParameter(%q): %v", key, err)
		}
	}

	root, err := LookupParameter(ParamBassRoot)
	if err != nil {
		t.Fatalf("LookupParameter: %v", err)
	}
	// ROOT is a transposition in semitones, not a 0..1 dial.
	if got := root.Value(11).Number; got != 11 {
		t.Fatalf("bassRoot(11) = %v, want 11", got)
	}
	if got := root.Value(12).Number; got != 11 {
		t.Fatalf("bassRoot(12) = %v, want it clamped to 11", got)
	}
}
