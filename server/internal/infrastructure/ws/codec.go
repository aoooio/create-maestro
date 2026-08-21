package ws

import (
	"encoding/json"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/application/port"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// Codec is the only place where the protocol meets JSON. Nothing above this
// file knows the wire format, and nothing in it knows the business rules.
type Codec struct {
	ids   port.IDGenerator
	clock port.Clock
}

// NewCodec builds a codec. It is stateless and safe for concurrent use.
func NewCodec(ids port.IDGenerator, clock port.Clock) *Codec {
	return &Codec{ids: ids, clock: clock}
}

// inbound is a decoded client message: the envelope metadata plus a payload
// whose concrete type is decided by Type.
type inbound struct {
	Type    string
	ID      string
	Payload any
}

// Decode parses one client frame. It validates the protocol version and the
// payload shape, and rejects anything it cannot map to a known command.
func (c *Codec) Decode(data []byte) (inbound, error) {
	var env inboundEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return inbound{}, session.Invalidf("malformed message: %v", err)
	}
	if env.V > ProtocolVersion {
		return inbound{}, &session.Error{
			Code:      session.CodeProtocolVersion,
			Message:   "this server speaks protocol version 1",
			Retryable: false,
		}
	}
	msg := inbound{Type: env.T, ID: env.ID}

	unmarshal := func(target any) error {
		if len(env.D) == 0 {
			return nil // a payload-less message is legitimate (state.request)
		}
		if err := json.Unmarshal(env.D, target); err != nil {
			return session.Invalidf("malformed %s payload: %v", env.T, err)
		}
		return nil
	}

	switch env.T {
	case TypeHello:
		var d helloDTO
		if err := unmarshal(&d); err != nil {
			return inbound{}, err
		}
		msg.Payload = d
	case TypeTimePing:
		var d timePingDTO
		if err := unmarshal(&d); err != nil {
			return inbound{}, err
		}
		msg.Payload = d
	case TypeTransportSet:
		var d transportSetDTO
		if err := unmarshal(&d); err != nil {
			return inbound{}, err
		}
		msg.Payload = d
	case TypePatternSet:
		var d patternSetDTO
		if err := unmarshal(&d); err != nil {
			return inbound{}, err
		}
		msg.Payload = d
	case TypeParamSet:
		var d paramSetDTO
		if err := unmarshal(&d); err != nil {
			return inbound{}, err
		}
		msg.Payload = d
	case TypeTrigger:
		var d triggerDTO
		if err := unmarshal(&d); err != nil {
			return inbound{}, err
		}
		msg.Payload = d
	case TypeStateRequest:
		msg.Payload = struct{}{}
	default:
		return inbound{}, session.Invalidf("unknown message type %q", env.T)
	}
	return msg, nil
}

// Encode serialises an application message into a wire frame. The timestamp
// is read as late as possible, which is what makes time.pong usable as a
// clock sample.
func (c *Codec) Encode(msg application.OutboundMessage) ([]byte, error) {
	now := c.clock.NowMs()
	payload, err := c.encodePayload(msg.Payload, now)
	if err != nil {
		return nil, err
	}
	return json.Marshal(outboundEnvelope{
		V:   ProtocolVersion,
		T:   msg.Type,
		ID:  c.ids.NewMessageID(),
		Ack: msg.Ack,
		TS:  now,
		D:   payload,
	})
}

func (c *Codec) encodePayload(payload any, nowMs int64) (any, error) {
	switch p := payload.(type) {
	case application.Welcome:
		return welcomeDTO{
			ParticipantID:   string(p.ParticipantID),
			SessionID:       string(p.SessionID),
			Role:            p.Role.String(),
			GroupID:         int(p.GroupID),
			ServerTimeMs:    p.ServerTimeMs,
			ProtocolVersion: ProtocolVersion,
		}, nil
	case application.StateSnapshot:
		return snapshotOf(p.Snapshot), nil
	case application.TimePong:
		return timePongDTO{
			ClientSendMs: p.ClientSendMs,
			ServerRecvMs: p.ServerRecvMs,
			ServerSendMs: nowMs,
		}, nil
	case application.TransportUpdated:
		return transportUpdatedDTO{
			Anchor:              anchorOf(p.Transport),
			State:               p.Transport.State.String(),
			BeatsPerBar:         p.Transport.BeatsPerBar,
			StepsPerBeat:        p.Transport.StepsPerBeat,
			EffectiveAtServerMs: p.EffectiveAtServerMs,
			Generation:          p.Generation,
		}, nil
	case application.ParamUpdated:
		return paramUpdatedDTO{
			Key:        string(p.Entry.Key),
			Value:      p.Entry.Value.Any(),
			Target:     p.Entry.Target.String(),
			Generation: p.Generation,
		}, nil
	case application.PatternUpdated:
		return patternOf(p.Pattern), nil
	case application.GroupAssigned:
		return groupAssignedDTO{
			GroupID: int(p.GroupID),
			Label:   p.Label,
			Reason:  p.Reason,
		}, nil
	case application.ParticipantPresence:
		return presenceDTO{
			ParticipantID: string(p.ParticipantID),
			Name:          p.Name,
			Role:          p.Role.String(),
			GroupID:       int(p.GroupID),
			Counts:        countsOf(p.Counts),
		}, nil
	case application.ParticipantTrigger:
		return triggerRelayDTO{
			ParticipantID: string(p.ParticipantID),
			GroupID:       int(p.GroupID),
			Kind:          p.Kind,
			Intensity:     p.Intensity,
			AtBeat:        p.AtBeat,
		}, nil
	case application.Error:
		return errorDTO{
			Code:      string(p.Code),
			Message:   p.Message,
			Retryable: p.Retryable,
		}, nil
	case nil:
		return struct{}{}, nil
	default:
		return nil, session.Internalf("no wire mapping for payload %T", payload)
	}
}

func anchorOf(t session.Transport) anchorDTO {
	return anchorDTO{
		AtServerMs: t.Anchor.AtServerMs,
		AtBeat:     t.Anchor.AtBeat,
		BPM:        t.Anchor.BPM,
	}
}

func transportOf(t session.Transport) transportDTO {
	return transportDTO{
		Anchor:       anchorOf(t),
		State:        t.State.String(),
		BeatsPerBar:  t.BeatsPerBar,
		StepsPerBeat: t.StepsPerBeat,
		Generation:   t.Generation,
	}
}

func patternOf(p session.Pattern) patternDTO {
	steps := make([]bool, len(p.Steps))
	velocity := make([]float64, len(p.Steps))
	note := make([]int, len(p.Steps))
	for i, s := range p.Steps {
		steps[i] = s.On
		velocity[i] = s.Velocity
		note[i] = s.Note
	}
	return patternDTO{
		TrackID:    string(p.TrackID),
		Steps:      steps,
		Velocity:   velocity,
		Note:       note,
		Generation: p.Generation,
	}
}

func countsOf(counts []session.GroupCount) []groupCountDTO {
	out := make([]groupCountDTO, len(counts))
	for i, c := range counts {
		out[i] = groupCountDTO{ID: int(c.ID), Label: c.Label, Count: c.Count}
	}
	return out
}

func snapshotOf(s session.Snapshot) snapshotDTO {
	params := make([]paramDTO, len(s.Params))
	for i, p := range s.Params {
		params[i] = paramDTO{
			Key:    string(p.Key),
			Value:  p.Value.Any(),
			Target: p.Target.String(),
		}
	}
	patterns := make([]patternDTO, len(s.Patterns))
	for i, p := range s.Patterns {
		patterns[i] = patternOf(p)
	}
	return snapshotDTO{
		Transport:    transportOf(s.Transport),
		Params:       params,
		Patterns:     patterns,
		Groups:       countsOf(s.Counts),
		Generation:   s.Generation,
		ServerTimeMs: s.ServerTimeMs,
	}
}
