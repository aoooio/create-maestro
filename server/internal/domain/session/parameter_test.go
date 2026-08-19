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
