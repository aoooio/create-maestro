package session

// ParameterKey names a continuous or discrete value propagated from the
// maestro to the clients.
type ParameterKey string

const (
	ParamCutoff    ParameterKey = "cutoff"
	ParamResonance ParameterKey = "resonance"
	ParamDensity   ParameterKey = "density"
	ParamGain      ParameterKey = "gain"
	ParamReverb    ParameterKey = "reverb"
	ParamDelay     ParameterKey = "delay"
	ParamMute      ParameterKey = "mute"
)

// ParameterKind decides how a value is clamped and how it reaches the wire.
type ParameterKind uint8

const (
	KindContinuous ParameterKind = iota
	KindBool
)

// ParameterSpec is the domain definition of a parameter: its bounds are the
// contract, whatever a client sends.
type ParameterSpec struct {
	Key     ParameterKey
	Kind    ParameterKind
	Min     float64
	Max     float64
	Default float64
}

var parameterRegistry = map[ParameterKey]ParameterSpec{
	ParamCutoff:    {Key: ParamCutoff, Kind: KindContinuous, Min: 0, Max: 1, Default: 1},
	ParamResonance: {Key: ParamResonance, Kind: KindContinuous, Min: 0, Max: 1, Default: 0},
	ParamDensity:   {Key: ParamDensity, Kind: KindContinuous, Min: 0, Max: 1, Default: 0.5},
	ParamGain:      {Key: ParamGain, Kind: KindContinuous, Min: 0, Max: 1, Default: 0.8},
	ParamReverb:    {Key: ParamReverb, Kind: KindContinuous, Min: 0, Max: 1, Default: 0.2},
	ParamDelay:     {Key: ParamDelay, Kind: KindContinuous, Min: 0, Max: 1, Default: 0},
	ParamMute:      {Key: ParamMute, Kind: KindBool, Min: 0, Max: 1, Default: 0},
}

// LookupParameter returns the spec of a key, or an error for unknown keys —
// an unknown key is a client bug, never something to store blindly.
func LookupParameter(key ParameterKey) (ParameterSpec, error) {
	spec, ok := parameterRegistry[key]
	if !ok {
		return ParameterSpec{}, ErrUnknownParameter
	}
	return spec, nil
}

// ParameterValue is a validated value, ready to broadcast.
type ParameterValue struct {
	Kind   ParameterKind
	Number float64
	Bool   bool
}

// Any renders the value in the shape the wire expects: a bool or a number.
func (v ParameterValue) Any() any {
	if v.Kind == KindBool {
		return v.Bool
	}
	return v.Number
}

// Value clamps a raw input into the bounds of the spec. Booleans arrive as
// 0 or 1 so that there is a single validation path.
func (s ParameterSpec) Value(raw float64) ParameterValue {
	if s.Kind == KindBool {
		return ParameterValue{Kind: KindBool, Bool: raw != 0, Number: raw}
	}
	switch {
	case raw < s.Min:
		raw = s.Min
	case raw > s.Max:
		raw = s.Max
	}
	return ParameterValue{Kind: KindContinuous, Number: raw}
}

// DefaultValue is the value a parameter holds before anyone touches it.
func (s ParameterSpec) DefaultValue() ParameterValue { return s.Value(s.Default) }

// ParameterEntry is one entry of the parameter state, scoped to a target.
type ParameterEntry struct {
	Key    ParameterKey
	Value  ParameterValue
	Target ParameterTarget
}
