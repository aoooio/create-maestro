// Package idgen mints the public identifiers and the maestro secret.
package idgen

import (
	"crypto/rand"
	"encoding/base64"

	"github.com/oklog/ulid/v2"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// joinCodeAlphabet drops the characters people confuse when reading a code off
// a screen at the back of a room: I/L/1, O/0, S/5.
const joinCodeAlphabet = "ABCDEFGHJKMNPQRTUVWXYZ2346789"

// JoinCodeLen is the length of a short join code.
const JoinCodeLen = 4

// TokenBytes is the size of the maestro secret (§3.5).
const TokenBytes = 32

// Generator implements port.IDGenerator and port.TokenGenerator. ULIDs are
// used for ids because they sort by creation time, which makes logs readable.
type Generator struct{}

// New returns the generator. It is stateless and safe for concurrent use.
func New() Generator { return Generator{} }

// NewSessionID mints a session identifier.
func (Generator) NewSessionID() session.SessionID {
	return session.SessionID(ulid.Make().String())
}

// NewParticipantID mints a participant identifier.
func (Generator) NewParticipantID() session.ParticipantID {
	return session.ParticipantID(ulid.Make().String())
}

// NewMessageID mints a protocol message identifier.
func (Generator) NewMessageID() string { return ulid.Make().String() }

// NewJoinCode mints a short code. Collisions are expected and resolved by the
// caller, which retries. The modulo below carries a slight bias, which does
// not matter: a join code is a convenience, not a secret — the maestro token
// is what protects the session.
func (Generator) NewJoinCode() session.JoinCode {
	buf := make([]byte, JoinCodeLen)
	// crypto/rand.Read never fails on the platforms we target: since Go 1.24
	// it panics instead of returning an error.
	rand.Read(buf)
	for i, b := range buf {
		buf[i] = joinCodeAlphabet[int(b)%len(joinCodeAlphabet)]
	}
	return session.JoinCode(buf)
}

// NewToken mints the maestro secret: 32 random bytes, base64url encoded.
func (Generator) NewToken() (session.Token, error) {
	buf := make([]byte, TokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", session.Internalf("cannot read random bytes: %v", err)
	}
	return session.Token(base64.RawURLEncoding.EncodeToString(buf)), nil
}
