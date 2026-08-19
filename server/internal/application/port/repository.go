// Package port declares the outbound interfaces of the application layer.
// Implementations live in infrastructure; nothing here knows about HTTP,
// WebSockets or JSON.
package port

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// SessionRepository stores the live sessions. Implementations must return
// session.ErrSessionNotFound when a lookup misses.
type SessionRepository interface {
	Save(ctx context.Context, s *session.Session) error
	FindByID(ctx context.Context, id session.SessionID) (*session.Session, error)
	FindByCode(ctx context.Context, code session.JoinCode) (*session.Session, error)
	Delete(ctx context.Context, id session.SessionID) error
}
