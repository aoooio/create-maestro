package port

import "github.com/aoooio/create-maestro/server/internal/domain/session"

// IDGenerator mints the public identifiers of the system.
type IDGenerator interface {
	NewSessionID() session.SessionID
	NewParticipantID() session.ParticipantID
	// NewJoinCode returns a short, human-typable code. Collisions are the
	// caller's problem: it retries.
	NewJoinCode() session.JoinCode
	// NewMessageID identifies one protocol message (ULID).
	NewMessageID() string
}

// TokenGenerator mints the maestro secret. It must be backed by a CSPRNG.
type TokenGenerator interface {
	NewToken() (session.Token, error)
}
