package ws

import (
	"encoding/json"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// ProtocolVersion is the version carried by every envelope (§4.1). Unknown
// fields are ignored on both sides, so adding an optional field is not a
// breaking change; bumping this number is.
const ProtocolVersion = 1

// Client → server message types (§4.2).
const (
	TypeHello        = "hello"
	TypeTimePing     = "time.ping"
	TypeTransportSet = "transport.set"
	TypePatternSet   = "pattern.set"
	TypeParamSet     = "param.set"
	TypeTrigger      = "trigger"
	TypeStateRequest = "state.request"
)

// inboundEnvelope is the wire envelope as received. The payload is kept raw
// until the type is known.
type inboundEnvelope struct {
	V   int             `json:"v"`
	T   string          `json:"t"`
	ID  string          `json:"id"`
	TS  int64           `json:"ts"`
	D   json.RawMessage `json:"d"`
	Ack string          `json:"ack"`
}

// outboundEnvelope is the wire envelope as sent.
type outboundEnvelope struct {
	V   int    `json:"v"`
	T   string `json:"t"`
	ID  string `json:"id"`
	Ack string `json:"ack,omitempty"`
	TS  int64  `json:"ts"`
	D   any    `json:"d"`
}

// --- client → server payloads ---

type helloDTO struct {
	Name          string `json:"name"`
	ClientVersion string `json:"clientVersion"`
	Capabilities  struct {
		WebAudio bool `json:"webaudio"`
		WebGL    bool `json:"webgl"`
	} `json:"capabilities"`
}

type timePingDTO struct {
	ClientSendMs int64 `json:"clientSendMs"`
}

type transportSetDTO struct {
	BPM          *float64 `json:"bpm"`
	State        *string  `json:"state"`
	BeatsPerBar  *int     `json:"beatsPerBar"`
	StepsPerBeat *int     `json:"stepsPerBeat"`
	AlignTo      string   `json:"alignTo"`
}

// toCommand maps the wire shape onto the domain command.
func (d transportSetDTO) toCommand() (session.TransportCommand, error) {
	cmd := session.TransportCommand{
		BPM:          d.BPM,
		BeatsPerBar:  d.BeatsPerBar,
		StepsPerBeat: d.StepsPerBeat,
	}
	if d.State != nil {
		state, err := session.ParsePlayState(*d.State)
		if err != nil {
			return session.TransportCommand{}, err
		}
		cmd.State = &state
	}
	align, err := session.ParseAlignment(d.AlignTo)
	if err != nil {
		return session.TransportCommand{}, err
	}
	cmd.Align = align
	return cmd, nil
}

type patternSetDTO struct {
	TrackID  string    `json:"trackId"`
	Steps    []bool    `json:"steps"`
	Velocity []float64 `json:"velocity"`
}

// toSteps merges the two parallel arrays of the wire format into the domain
// step list. A shorter velocity array is not an error: the missing cells play
// at full level.
func (d patternSetDTO) toSteps() ([]session.Step, error) {
	if len(d.Velocity) != 0 && len(d.Velocity) != len(d.Steps) {
		return nil, session.Invalidf("velocity has %d entries for %d steps", len(d.Velocity), len(d.Steps))
	}
	steps := make([]session.Step, len(d.Steps))
	for i, on := range d.Steps {
		steps[i] = session.Step{On: on}
		if i < len(d.Velocity) {
			steps[i].Velocity = d.Velocity[i]
		}
	}
	return steps, nil
}

type paramSetDTO struct {
	Key    string          `json:"key"`
	Value  json.RawMessage `json:"value"`
	Target string          `json:"target"`
}

// toValue accepts a number or a boolean and normalises both to a float, so
// that the domain has a single clamping path.
func (d paramSetDTO) toValue() (float64, error) {
	var raw any
	if err := json.Unmarshal(d.Value, &raw); err != nil {
		return 0, session.Invalidf("parameter %q has an unreadable value", d.Key)
	}
	switch v := raw.(type) {
	case float64:
		return v, nil
	case bool:
		if v {
			return 1, nil
		}
		return 0, nil
	default:
		return 0, session.Invalidf("parameter %q must be a number or a boolean", d.Key)
	}
}

type triggerDTO struct {
	Kind      string   `json:"kind"`
	Intensity float64  `json:"intensity"`
	AtBeat    *float64 `json:"atBeat"`
}

// --- server → client payloads ---

type welcomeDTO struct {
	ParticipantID   string `json:"participantId"`
	SessionID       string `json:"sessionId"`
	Role            string `json:"role"`
	GroupID         int    `json:"groupId"`
	ServerTimeMs    int64  `json:"serverTimeMs"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type anchorDTO struct {
	AtServerMs int64   `json:"atServerMs"`
	AtBeat     float64 `json:"atBeat"`
	BPM        float64 `json:"bpm"`
}

type transportDTO struct {
	Anchor       anchorDTO `json:"anchor"`
	State        string    `json:"state"`
	BeatsPerBar  int       `json:"beatsPerBar"`
	StepsPerBeat int       `json:"stepsPerBeat"`
	Generation   uint64    `json:"generation"`
}

type transportUpdatedDTO struct {
	Anchor              anchorDTO `json:"anchor"`
	State               string    `json:"state"`
	BeatsPerBar         int       `json:"beatsPerBar"`
	StepsPerBeat        int       `json:"stepsPerBeat"`
	EffectiveAtServerMs int64     `json:"effectiveAtServerMs"`
	Generation          uint64    `json:"generation"`
}

type paramDTO struct {
	Key    string `json:"key"`
	Value  any    `json:"value"`
	Target string `json:"target"`
}

type paramUpdatedDTO struct {
	Key        string `json:"key"`
	Value      any    `json:"value"`
	Target     string `json:"target"`
	Generation uint64 `json:"generation"`
}

type patternDTO struct {
	TrackID    string    `json:"trackId"`
	Steps      []bool    `json:"steps"`
	Velocity   []float64 `json:"velocity"`
	Generation uint64    `json:"generation"`
}

type groupCountDTO struct {
	ID    int    `json:"id"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type snapshotDTO struct {
	Transport    transportDTO    `json:"transport"`
	Params       []paramDTO      `json:"params"`
	Patterns     []patternDTO    `json:"patterns"`
	Groups       []groupCountDTO `json:"groups"`
	Generation   uint64          `json:"generation"`
	ServerTimeMs int64           `json:"serverTimeMs"`
}

type timePongDTO struct {
	ClientSendMs int64 `json:"clientSendMs"`
	ServerRecvMs int64 `json:"serverRecvMs"`
	ServerSendMs int64 `json:"serverSendMs"`
}

type groupAssignedDTO struct {
	GroupID int    `json:"groupId"`
	Label   string `json:"label"`
	Reason  string `json:"reason"`
}

type presenceDTO struct {
	ParticipantID string          `json:"participantId"`
	Name          string          `json:"name"`
	Role          string          `json:"role"`
	GroupID       int             `json:"groupId"`
	Counts        []groupCountDTO `json:"counts"`
}

type triggerRelayDTO struct {
	ParticipantID string   `json:"participantId"`
	GroupID       int      `json:"groupId"`
	Kind          string   `json:"kind"`
	Intensity     float64  `json:"intensity"`
	AtBeat        *float64 `json:"atBeat,omitempty"`
}

type errorDTO struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}
