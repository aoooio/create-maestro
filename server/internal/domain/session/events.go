package session

// The aggregate returns these events instead of broadcasting anything itself:
// deciding who receives what is the job of the use cases, deciding what
// happened is the job of the domain.

// GroupCount is the population of one group, as published to clients.
type GroupCount struct {
	ID    GroupID
	Label string
	Count int
}

// ParticipantJoined is emitted when a participant enters the session.
type ParticipantJoined struct {
	Participant Participant
	Counts      []GroupCount
	Generation  uint64
}

// ParticipantLeft is emitted when a participant leaves the session.
type ParticipantLeft struct {
	Participant Participant
	Counts      []GroupCount
	Generation  uint64
}

// TransportChanged carries the new transport and the instant it applies.
type TransportChanged struct {
	Transport           Transport
	EffectiveAtServerMs int64
	Generation          uint64
}

// ParameterChanged carries one accepted, clamped parameter.
type ParameterChanged struct {
	Entry      ParameterEntry
	Generation uint64
}

// PatternChanged carries the new grid of one track.
type PatternChanged struct {
	Pattern    Pattern
	Generation uint64
}

// GroupAssigned is emitted on join and on a maestro-driven reassignment.
type GroupAssigned struct {
	ParticipantID ParticipantID
	Group         GroupID
	Label         string
	Reason        string
	Counts        []GroupCount
	Generation    uint64
}

// Snapshot is the complete replayable state of a session: a client that
// receives it replaces its local state wholesale (§4.4).
type Snapshot struct {
	Transport    Transport
	Params       []ParameterEntry
	Patterns     []Pattern
	Counts       []GroupCount
	Generation   uint64
	ServerTimeMs int64
}
