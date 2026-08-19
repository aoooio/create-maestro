package session

import (
	"strings"
	"unicode"
)

// ParticipantID identifies a participant inside a session.
type ParticipantID string

// Role decides what a participant is allowed to do. There are only two, and
// the role is fixed for the whole lifetime of a connection.
type Role uint8

const (
	RoleMusician Role = iota
	RoleMaestro
)

func (r Role) String() string {
	if r == RoleMaestro {
		return "maestro"
	}
	return "musician"
}

// MaxNameRunes is the hard cap on a nickname (§3.5: no personal data, free
// nickname, truncated).
const MaxNameRunes = 24

// SanitizeName trims a user-supplied nickname down to something safe to store
// and to broadcast: no control characters, no leading/trailing space, capped
// length. Rendering-side escaping remains the client's responsibility.
func SanitizeName(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, raw)
	cleaned = strings.TrimSpace(cleaned)
	runes := []rune(cleaned)
	if len(runes) > MaxNameRunes {
		cleaned = string(runes[:MaxNameRunes])
	}
	return cleaned
}

// Participant is a connected human: the maestro, or a musician in a group.
type Participant struct {
	ID       ParticipantID
	Name     string
	Role     Role
	Group    GroupID
	JoinedAt int64
}

// NewParticipant builds a participant with a sanitized name. The group is left
// unset: it is the session aggregate that assigns it.
func NewParticipant(id ParticipantID, name string, role Role, joinedAtMs int64) *Participant {
	return &Participant{
		ID:       id,
		Name:     SanitizeName(name),
		Role:     role,
		JoinedAt: joinedAtMs,
	}
}
