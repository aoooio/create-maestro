// Package observability wires the structured logger. Metrics are a lot-5
// concern and deliberately absent for now.
package observability

import (
	"log/slog"
	"os"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// NewLogger builds the process logger. "json" is the default because these
// logs are meant to be shipped; "text" stays available for a local run.
func NewLogger(level slog.Level, format string) *slog.Logger {
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if format == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}

// Session returns a logger tagged with a session, the unit every operational
// question is asked about.
func Session(l *slog.Logger, id session.SessionID) *slog.Logger {
	return l.With(slog.String("sessionId", string(id)))
}

// Role tags a logger with the role of a connection, which is known before the
// participant itself exists.
func Role(l *slog.Logger, role session.Role) *slog.Logger {
	return l.With(slog.String("role", role.String()))
}

// Participant adds the participant to an already session-tagged logger. It is
// deliberately additive: tagging the same key twice would emit it twice.
func Participant(l *slog.Logger, pid session.ParticipantID) *slog.Logger {
	return l.With(slog.String("participantId", string(pid)))
}
