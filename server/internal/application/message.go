// Package application holds the use cases of the server and the messages they
// produce. Messages here are plain Go values: turning them into JSON is the
// job of the infrastructure codec, never of a use case.
package application

import "github.com/aoooio/create-maestro/server/internal/domain/session"

// Message types of the server → client protocol (§4.3).
const (
	MsgWelcome            = "welcome"
	MsgStateSnapshot      = "state.snapshot"
	MsgTimePong           = "time.pong"
	MsgTransportUpdated   = "transport.updated"
	MsgParamUpdated       = "param.updated"
	MsgPatternUpdated     = "pattern.updated"
	MsgGroupAssigned      = "group.assigned"
	MsgParticipantJoined  = "participant.joined"
	MsgParticipantLeft    = "participant.left"
	MsgParticipantTrigger = "participant.trigger"
	MsgError              = "error"
)

// Class decides what happens to a message when a client cannot keep up
// (§3.6). An ephemeral message is dropped under backpressure; failing to
// deliver a critical one closes the connection, because the client would
// otherwise carry a state nobody can repair.
type Class uint8

const (
	Critical Class = iota
	Ephemeral
)

// OutboundMessage is one message on its way to one or more clients.
type OutboundMessage struct {
	Type    string
	Class   Class
	Ack     string // id of the client message this answers, when there is one
	Payload any
}

// --- payloads ---

// Welcome answers a successful join. It is the only message that tells a
// client who it is.
type Welcome struct {
	ParticipantID session.ParticipantID
	SessionID     session.SessionID
	Role          session.Role
	GroupID       session.GroupID
	ServerTimeMs  int64
}

// StateSnapshot is the full state a client applies wholesale.
type StateSnapshot struct {
	Snapshot session.Snapshot
}

// TimePong answers a time.ping. ServerSendMs is stamped by the codec at
// serialization time, as late as possible, to keep the estimate honest.
type TimePong struct {
	ClientSendMs int64
	ServerRecvMs int64
}

// TransportUpdated publishes a scheduled transport change.
type TransportUpdated struct {
	Transport           session.Transport
	EffectiveAtServerMs int64
	Generation          uint64
}

// ParamUpdated publishes an accepted, clamped parameter.
type ParamUpdated struct {
	Entry      session.ParameterEntry
	Generation uint64
}

// PatternUpdated publishes a new step grid.
type PatternUpdated struct {
	Pattern    session.Pattern
	Generation uint64
}

// GroupAssigned tells a musician which register it plays.
type GroupAssigned struct {
	GroupID session.GroupID
	Label   string
	Reason  string
}

// ParticipantPresence backs both participant.joined and participant.left.
type ParticipantPresence struct {
	ParticipantID session.ParticipantID
	Name          string
	Role          session.Role
	GroupID       session.GroupID
	Counts        []session.GroupCount
}

// ParticipantTrigger relays a musician gesture.
type ParticipantTrigger struct {
	ParticipantID session.ParticipantID
	GroupID       session.GroupID
	Kind          string
	Intensity     float64
	AtBeat        *float64
}

// Error is the protocol error payload.
type Error struct {
	Code      session.Code
	Message   string
	Retryable bool
}

// --- constructors ---

// NewMessage builds a critical message.
func NewMessage(msgType string, payload any) OutboundMessage {
	return OutboundMessage{Type: msgType, Class: Critical, Payload: payload}
}

// NewEphemeral builds a droppable message.
func NewEphemeral(msgType string, payload any) OutboundMessage {
	return OutboundMessage{Type: msgType, Class: Ephemeral, Payload: payload}
}

// WithAck marks a message as the answer to a given client message.
func (m OutboundMessage) WithAck(id string) OutboundMessage {
	m.Ack = id
	return m
}

// NewError turns any error into a protocol error message. Errors that are not
// domain errors are reported as "internal" and never leak their text.
func NewError(err error) OutboundMessage {
	return NewMessage(MsgError, Error{
		Code:      session.CodeOf(err),
		Message:   session.MessageOf(err),
		Retryable: session.IsRetryable(err),
	})
}
