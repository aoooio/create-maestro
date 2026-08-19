package session

import (
	"cmp"
	"crypto/subtle"
	"slices"
	"sync"
	"time"
)

// SessionID identifies a performance.
type SessionID string

// JoinCode is the short, human-typable code of a session ("MZQ4").
type JoinCode string

// Token is the maestro secret. It is never re-broadcast.
type Token string

// Options configures a new session. Zero values fall back to the defaults of
// the spec: 200 users, two groups HIGH/MID, balanced assignment, 120 BPM.
type Options struct {
	MaxUsers    int
	GroupLabels []string
	Strategy    AssignmentStrategy
	BPM         float64
	NowMs       int64
	CreatedAt   time.Time
}

// DefaultMaxUsers is the per-session cap of musicians (§7).
const DefaultMaxUsers = 200

// DefaultBPM is the tempo a fresh session starts at.
const DefaultBPM = 120.0

// Session is the aggregate root. Every invariant of a performance lives here
// and nowhere else:
//   - exactly one active maestro at a time;
//   - at most maxUsers musicians;
//   - every musician belongs to exactly one group;
//   - only the maestro drives the transport, the parameters and the patterns.
//
// Commands from many connections converge on the same session, so the
// aggregate guards its own state.
type Session struct {
	mu           sync.RWMutex
	id           SessionID
	code         JoinCode
	maestroToken Token
	maestro      *Participant
	participants map[ParticipantID]*Participant
	groups       map[GroupID]*Group
	groupOrder   []GroupID
	transport    Transport
	params       map[ParameterTarget]map[ParameterKey]ParameterValue
	patterns     map[TrackID]Pattern
	strategy     AssignmentStrategy
	maxUsers     int
	generation   uint64
	createdAt    time.Time
	closed       bool
}

// New builds a session with its groups, its default parameters and a stopped
// transport.
func New(id SessionID, code JoinCode, token Token, opts Options) (*Session, error) {
	if id == "" || code == "" || token == "" {
		return nil, Invalidf("session id, join code and maestro token are required")
	}
	if opts.MaxUsers <= 0 {
		opts.MaxUsers = DefaultMaxUsers
	}
	if opts.BPM == 0 {
		opts.BPM = DefaultBPM
	}
	if len(opts.GroupLabels) == 0 {
		opts.GroupLabels = DefaultGroupLabels
	}
	if len(opts.GroupLabels) > 255 {
		return nil, Invalidf("a session cannot hold more than 255 groups")
	}
	if opts.Strategy == nil {
		opts.Strategy = BalancedStrategy{}
	}
	if opts.CreatedAt.IsZero() {
		opts.CreatedAt = time.Now()
	}

	s := &Session{
		id:           id,
		code:         code,
		maestroToken: token,
		participants: make(map[ParticipantID]*Participant),
		groups:       make(map[GroupID]*Group, len(opts.GroupLabels)),
		patterns:     make(map[TrackID]Pattern),
		params:       make(map[ParameterTarget]map[ParameterKey]ParameterValue),
		strategy:     opts.Strategy,
		maxUsers:     opts.MaxUsers,
		createdAt:    opts.CreatedAt,
		transport:    NewTransport(opts.NowMs, opts.BPM),
	}
	if err := s.transport.Validate(); err != nil {
		return nil, err
	}
	for i, label := range opts.GroupLabels {
		gid := GroupID(i + 1)
		s.groups[gid] = newGroup(gid, label)
		s.groupOrder = append(s.groupOrder, gid)
	}
	defaults := make(map[ParameterKey]ParameterValue, len(parameterRegistry))
	for key, spec := range parameterRegistry {
		defaults[key] = spec.DefaultValue()
	}
	s.params[TargetAll()] = defaults
	return s, nil
}

// Immutable identity — safe to read without the lock.

func (s *Session) ID() SessionID        { return s.id }
func (s *Session) Code() JoinCode       { return s.code }
func (s *Session) CreatedAt() time.Time { return s.createdAt }
func (s *Session) MaxUsers() int        { return s.maxUsers }
func (s *Session) StrategyName() string { return s.strategy.Name() }

// AuthenticateMaestro checks a bearer token in constant time.
func (s *Session) AuthenticateMaestro(tok Token) error {
	if subtle.ConstantTimeCompare([]byte(tok), []byte(s.maestroToken)) != 1 {
		return ErrUnauthorized
	}
	return nil
}

// Join registers a participant and, for a musician, assigns its group.
func (s *Session) Join(p *Participant) (ParticipantJoined, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ParticipantJoined{}, ErrSessionClosed
	}
	if p == nil || p.ID == "" {
		return ParticipantJoined{}, Invalidf("participant id is required")
	}
	if _, exists := s.participants[p.ID]; exists {
		return ParticipantJoined{}, Invalidf("participant %s already joined", p.ID)
	}

	if p.Role == RoleMaestro {
		if s.maestro != nil {
			return ParticipantJoined{}, ErrMaestroTaken
		}
		p.Group = NoGroup
		s.maestro = p
	} else {
		if s.musicianCount() >= s.maxUsers {
			return ParticipantJoined{}, ErrSessionFull
		}
		gid := s.strategy.Assign(s.orderedGroups(), p)
		g, ok := s.groups[gid]
		if !ok {
			return ParticipantJoined{}, ErrUnknownGroup
		}
		p.Group = gid
		g.add(p.ID)
	}

	s.participants[p.ID] = p
	s.generation++
	return ParticipantJoined{
		Participant: *p,
		Counts:      s.counts(),
		Generation:  s.generation,
	}, nil
}

// Leave removes a participant. The second result is false when the id was not
// part of the session, which makes a double disconnect harmless.
func (s *Session) Leave(id ParticipantID) (ParticipantLeft, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.participants[id]
	if !ok {
		return ParticipantLeft{}, false
	}
	delete(s.participants, id)
	if g, ok := s.groups[p.Group]; ok {
		g.remove(id)
	}
	if s.maestro != nil && s.maestro.ID == id {
		s.maestro = nil
	}
	s.generation++
	return ParticipantLeft{
		Participant: *p,
		Counts:      s.counts(),
		Generation:  s.generation,
	}, true
}

// ApplyTransport validates a transport command, schedules it on the next bar
// boundary and bumps the generation. Musicians are rejected here, whatever the
// transport layer believed.
func (s *Session) ApplyTransport(cmd TransportCommand, byRole Role, nowMs int64) (TransportChanged, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if byRole != RoleMaestro {
		return TransportChanged{}, ErrForbiddenRole
	}
	if s.closed {
		return TransportChanged{}, ErrSessionClosed
	}
	next, effectiveAt, err := s.transport.Apply(cmd, nowMs)
	if err != nil {
		return TransportChanged{}, err
	}
	s.generation++
	next.Generation = s.generation
	s.transport = next
	return TransportChanged{
		Transport:           next,
		EffectiveAtServerMs: effectiveAt,
		Generation:          s.generation,
	}, nil
}

// SetParameter clamps a value to the bounds of the domain and stores it for
// the given target.
func (s *Session) SetParameter(key ParameterKey, raw float64, target ParameterTarget, byRole Role) (ParameterChanged, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if byRole != RoleMaestro {
		return ParameterChanged{}, ErrForbiddenRole
	}
	if s.closed {
		return ParameterChanged{}, ErrSessionClosed
	}
	spec, err := LookupParameter(key)
	if err != nil {
		return ParameterChanged{}, err
	}
	if !target.IsAll() {
		if _, ok := s.groups[target.Group]; !ok {
			return ParameterChanged{}, ErrUnknownGroup
		}
	}
	value := spec.Value(raw)
	scope, ok := s.params[target]
	if !ok {
		scope = make(map[ParameterKey]ParameterValue)
		s.params[target] = scope
	}
	scope[key] = value
	s.generation++
	return ParameterChanged{
		Entry:      ParameterEntry{Key: key, Value: value, Target: target},
		Generation: s.generation,
	}, nil
}

// SetPattern replaces the grid of a track.
func (s *Session) SetPattern(id TrackID, steps []Step, byRole Role) (PatternChanged, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if byRole != RoleMaestro {
		return PatternChanged{}, ErrForbiddenRole
	}
	if s.closed {
		return PatternChanged{}, ErrSessionClosed
	}
	pattern, err := NewPattern(id, steps)
	if err != nil {
		return PatternChanged{}, err
	}
	if _, exists := s.patterns[id]; !exists && len(s.patterns) >= MaxTracks {
		return PatternChanged{}, Invalidf("a session cannot hold more than %d tracks", MaxTracks)
	}
	s.generation++
	pattern.Generation = s.generation
	s.patterns[id] = pattern
	return PatternChanged{Pattern: pattern.Clone(), Generation: s.generation}, nil
}

// ReassignGroup moves a musician to another group. Hot reassignment is a
// maestro-only operation; it is what makes ManualStrategy usable.
func (s *Session) ReassignGroup(id ParticipantID, gid GroupID, byRole Role, reason string) (GroupAssigned, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if byRole != RoleMaestro {
		return GroupAssigned{}, ErrForbiddenRole
	}
	p, ok := s.participants[id]
	if !ok {
		return GroupAssigned{}, ErrParticipantGone
	}
	if p.Role == RoleMaestro {
		return GroupAssigned{}, Invalidf("the maestro belongs to no group")
	}
	target, ok := s.groups[gid]
	if !ok {
		return GroupAssigned{}, ErrUnknownGroup
	}
	if old, ok := s.groups[p.Group]; ok {
		old.remove(id)
	}
	target.add(id)
	p.Group = gid
	s.generation++
	return GroupAssigned{
		ParticipantID: id,
		Group:         gid,
		Label:         target.Label,
		Reason:        reason,
		Counts:        s.counts(),
		Generation:    s.generation,
	}, nil
}

// Snapshot returns the full state, deep-copied and deterministically ordered.
func (s *Session) Snapshot(nowMs int64) Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	params := make([]ParameterEntry, 0, len(s.params)*4)
	for target, scope := range s.params {
		for key, value := range scope {
			params = append(params, ParameterEntry{Key: key, Value: value, Target: target})
		}
	}
	slices.SortFunc(params, func(a, b ParameterEntry) int {
		if c := cmp.Compare(a.Target.Group, b.Target.Group); c != 0 {
			return c
		}
		return cmp.Compare(a.Key, b.Key)
	})

	patterns := make([]Pattern, 0, len(s.patterns))
	for _, p := range s.patterns {
		patterns = append(patterns, p.Clone())
	}
	slices.SortFunc(patterns, func(a, b Pattern) int { return cmp.Compare(a.TrackID, b.TrackID) })

	return Snapshot{
		Transport:    s.transport,
		Params:       params,
		Patterns:     patterns,
		Counts:       s.counts(),
		Generation:   s.generation,
		ServerTimeMs: nowMs,
	}
}

// Transport returns a copy of the current transport.
func (s *Session) Transport() Transport {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.transport
}

// Participant returns a copy of a participant.
func (s *Session) Participant(id ParticipantID) (Participant, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.participants[id]
	if !ok {
		return Participant{}, false
	}
	return *p, true
}

// HasMaestro reports whether a maestro is currently connected.
func (s *Session) HasMaestro() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.maestro != nil
}

// MaestroID returns the id of the connected maestro, if any.
func (s *Session) MaestroID() (ParticipantID, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.maestro == nil {
		return "", false
	}
	return s.maestro.ID, true
}

// ParticipantCount counts everybody, maestro included.
func (s *Session) ParticipantCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.participants)
}

// MusicianCount counts the audience only — this is what maxUsers caps.
func (s *Session) MusicianCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.musicianCount()
}

// Counts returns the population of every group, in group order.
func (s *Session) Counts() []GroupCount {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.counts()
}

// Generation is the current version of the session state.
func (s *Session) Generation() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.generation
}

// Close marks the session as terminated: no further state change is accepted
// and the maestro token stops being replayable.
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	s.maestroToken = ""
}

// IsClosed reports whether the session has been closed.
func (s *Session) IsClosed() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.closed
}

// --- helpers, called with the lock already held ---

func (s *Session) musicianCount() int {
	n := 0
	for _, p := range s.participants {
		if p.Role == RoleMusician {
			n++
		}
	}
	return n
}

func (s *Session) orderedGroups() []*Group {
	groups := make([]*Group, 0, len(s.groupOrder))
	for _, gid := range s.groupOrder {
		groups = append(groups, s.groups[gid])
	}
	return groups
}

func (s *Session) counts() []GroupCount {
	counts := make([]GroupCount, 0, len(s.groupOrder))
	for _, gid := range s.groupOrder {
		g := s.groups[gid]
		counts = append(counts, GroupCount{ID: g.ID, Label: g.Label, Count: g.Count()})
	}
	return counts
}
