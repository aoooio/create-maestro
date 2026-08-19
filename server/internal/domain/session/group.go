package session

import (
	"fmt"
	"strconv"
	"strings"
)

// GroupID identifies a musical register inside a session. Groups are numbered
// from 1, matching the wire spelling "group:1".
type GroupID uint8

// NoGroup is the zero value: the maestro belongs to no group.
const NoGroup GroupID = 0

func (g GroupID) String() string { return strconv.Itoa(int(g)) }

// DefaultGroupLabels is the two-register setup of the spec. The domain itself
// handles N groups; only this default is fixed at two.
var DefaultGroupLabels = []string{"HIGH", "MID"}

// Group is a set of musicians sharing a musical role.
type Group struct {
	ID      GroupID
	Label   string
	members map[ParticipantID]struct{}
}

func newGroup(id GroupID, label string) *Group {
	return &Group{ID: id, Label: label, members: make(map[ParticipantID]struct{})}
}

// Count is the number of musicians currently in the group.
func (g *Group) Count() int { return len(g.members) }

func (g *Group) add(id ParticipantID)    { g.members[id] = struct{}{} }
func (g *Group) remove(id ParticipantID) { delete(g.members, id) }

// AssignmentStrategy decides which group a joining musician lands in. It is an
// interface of the domain so that the policy is chosen at session creation and
// never leaks into the transport layer.
type AssignmentStrategy interface {
	Name() string
	// Assign receives the groups in stable ID order and returns the target.
	Assign(groups []*Group, p *Participant) GroupID
}

// BalancedStrategy fills the least populated group, ties broken by group ID
// (i.e. by arrival order of the groups themselves). This is the default.
type BalancedStrategy struct{}

func (BalancedStrategy) Name() string { return "balanced" }

func (BalancedStrategy) Assign(groups []*Group, _ *Participant) GroupID {
	best := groups[0]
	for _, g := range groups[1:] {
		if g.Count() < best.Count() {
			best = g
		}
	}
	return best.ID
}

// RoundRobinStrategy alternates strictly, ignoring departures. Mutation is
// safe: strategies are only ever called under the session lock.
type RoundRobinStrategy struct{ next int }

func (*RoundRobinStrategy) Name() string { return "round_robin" }

func (s *RoundRobinStrategy) Assign(groups []*Group, _ *Participant) GroupID {
	g := groups[s.next%len(groups)]
	s.next++
	return g.ID
}

// ManualStrategy parks every newcomer in a fixed group; the maestro then moves
// people around with Session.ReassignGroup.
type ManualStrategy struct{ Default GroupID }

func (ManualStrategy) Name() string { return "manual" }

func (s ManualStrategy) Assign(groups []*Group, _ *Participant) GroupID {
	for _, g := range groups {
		if g.ID == s.Default {
			return g.ID
		}
	}
	return groups[0].ID
}

// StrategyByName resolves the wire spelling of an assignment policy.
func StrategyByName(name string) (AssignmentStrategy, error) {
	switch name {
	case "", "balanced":
		return BalancedStrategy{}, nil
	case "round_robin":
		return &RoundRobinStrategy{}, nil
	case "manual":
		return ManualStrategy{Default: 1}, nil
	default:
		return nil, Invalidf("unknown group strategy %q", name)
	}
}

// ParameterTarget is the audience of a parameter: everyone, or one group.
type ParameterTarget struct {
	Group GroupID // NoGroup means "all"
}

// TargetAll targets every participant of the session.
func TargetAll() ParameterTarget { return ParameterTarget{Group: NoGroup} }

// TargetGroup targets a single group.
func TargetGroup(g GroupID) ParameterTarget { return ParameterTarget{Group: g} }

// IsAll reports whether the target is the whole session.
func (t ParameterTarget) IsAll() bool { return t.Group == NoGroup }

func (t ParameterTarget) String() string {
	if t.IsAll() {
		return "all"
	}
	return fmt.Sprintf("group:%d", t.Group)
}

// ParseTarget reads the canonical textual form of a target ("all", "group:2").
func ParseTarget(s string) (ParameterTarget, error) {
	if s == "" || s == "all" {
		return TargetAll(), nil
	}
	num, ok := strings.CutPrefix(s, "group:")
	if !ok {
		return ParameterTarget{}, Invalidf("unknown parameter target %q", s)
	}
	id, err := strconv.Atoi(num)
	if err != nil || id < 1 || id > 255 {
		return ParameterTarget{}, Invalidf("unknown parameter target %q", s)
	}
	return TargetGroup(GroupID(id)), nil
}
