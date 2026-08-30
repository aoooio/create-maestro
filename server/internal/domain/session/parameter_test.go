package session

import "testing"

func TestParameterClamping(t *testing.T) {
	spec, err := LookupParameter(ParamCutoff)
	if err != nil {
		t.Fatalf("LookupParameter: %v", err)
	}
	tests := []struct {
		raw  float64
		want float64
	}{
		{-3, 0},
		{0, 0},
		{0.42, 0.42},
		{1, 1},
		{17, 1},
	}
	for _, tc := range tests {
		if got := spec.Value(tc.raw); got.Number != tc.want {
			t.Fatalf("Value(%v) = %v, want %v", tc.raw, got.Number, tc.want)
		}
	}
	if v := spec.DefaultValue(); v.Number != spec.Default {
		t.Fatalf("DefaultValue = %v, want %v", v.Number, spec.Default)
	}
}

func TestBooleanParameter(t *testing.T) {
	spec, err := LookupParameter(ParamMute)
	if err != nil {
		t.Fatalf("LookupParameter: %v", err)
	}
	if v := spec.Value(0); v.Bool || v.Any() != false {
		t.Fatalf("0 must read as false, got %+v", v)
	}
	if v := spec.Value(1); !v.Bool || v.Any() != true {
		t.Fatalf("1 must read as true, got %+v", v)
	}
	if v := spec.Value(0.5); !v.Bool {
		t.Fatal("any non-zero value must read as true")
	}
}

func TestUnknownParameterIsRejected(t *testing.T) {
	if _, err := LookupParameter("teleport"); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
}

func TestContinuousParameterRendersAsNumber(t *testing.T) {
	spec, _ := LookupParameter(ParamGain)
	if _, ok := spec.Value(0.5).Any().(float64); !ok {
		t.Fatal("a continuous parameter must reach the wire as a number")
	}
}

// The group synth is the first family of keys whose bounds are neither 0..1
// nor unsigned, so the clamp is worth pinning down: a waveform is an index
// into an enumeration, and an octave runs either side of zero.
func TestGroupSynthParameterBounds(t *testing.T) {
	tests := []struct {
		key      ParameterKey
		min, max float64
		def      float64
	}{
		{ParamSynthWave, 0, 3, 0},
		{ParamSynthSpread, 0, 1, 0.4},
		{ParamSynthAttack, 0, 1, 0.05},
		{ParamSynthRelease, 0, 1, 0.35},
		{ParamSynthBrightness, 0, 1, 0.5},
		{ParamSynthOctave, -2, 2, 0},
	}
	for _, tc := range tests {
		spec, err := LookupParameter(tc.key)
		if err != nil {
			t.Fatalf("LookupParameter(%s): %v", tc.key, err)
		}
		if spec.Min != tc.min || spec.Max != tc.max || spec.Default != tc.def {
			t.Fatalf("%s = [%v..%v] default %v, want [%v..%v] default %v",
				tc.key, spec.Min, spec.Max, spec.Default, tc.min, tc.max, tc.def)
		}
		if got := spec.Value(tc.min - 100); got.Number != tc.min {
			t.Fatalf("%s clamped low = %v, want %v", tc.key, got.Number, tc.min)
		}
		if got := spec.Value(tc.max + 100); got.Number != tc.max {
			t.Fatalf("%s clamped high = %v, want %v", tc.key, got.Number, tc.max)
		}
		if got := spec.DefaultValue(); got.Number != tc.def {
			t.Fatalf("%s default = %v, want %v", tc.key, got.Number, tc.def)
		}
	}
}

// A signed minimum is exactly where a clamp written as "if raw < 0" would
// pass every other test and still be wrong.
func TestSynthOctaveKeepsNegativeValues(t *testing.T) {
	spec, _ := LookupParameter(ParamSynthOctave)
	if got := spec.Value(-1); got.Number != -1 {
		t.Fatalf("Value(-1) = %v, want -1", got.Number)
	}
}
