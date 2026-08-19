// Package usecase implements the use cases of §3.4. Each one takes a
// context, returns typed domain errors, and speaks only through the ports.
package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application/port"
	"github.com/aoooio/create-maestro/server/internal/application/service"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// Options tunes the behaviours the spec leaves open.
type Options struct {
	// TriggerEcho relays a musician trigger back to its own group, not just
	// to the maestro (§3.4). Off by default: it multiplies the fan-out.
	TriggerEcho bool
	// DefaultMaxUsers caps a session when the creator does not say.
	DefaultMaxUsers int
	// DefaultBPM is the tempo of a fresh session.
	DefaultBPM float64
	// GroupLabels is the default register layout.
	GroupLabels []string
}

// Usecases is the single entry point of the application layer. Grouping the
// ports in one place keeps the composition root small; the behaviours stay in
// one file per use case.
type Usecases struct {
	repo   port.SessionRepository
	clock  port.Clock
	bus    port.Broadcaster
	ids    port.IDGenerator
	tokens port.TokenGenerator
	auth   service.Authorizer
	opts   Options
}

// New wires the use cases onto their ports.
func New(repo port.SessionRepository, clock port.Clock, bus port.Broadcaster, ids port.IDGenerator, tokens port.TokenGenerator, opts Options) *Usecases {
	if opts.DefaultMaxUsers <= 0 {
		opts.DefaultMaxUsers = session.DefaultMaxUsers
	}
	if opts.DefaultBPM == 0 {
		opts.DefaultBPM = session.DefaultBPM
	}
	if len(opts.GroupLabels) == 0 {
		opts.GroupLabels = session.DefaultGroupLabels
	}
	return &Usecases{repo: repo, clock: clock, bus: bus, ids: ids, tokens: tokens, opts: opts}
}

// NowMs exposes the server clock to the transport layer, which needs it to
// stamp messages.
func (u *Usecases) NowMs() int64 { return u.clock.NowMs() }

// load fetches a session, mapping a miss to the protocol error.
func (u *Usecases) load(ctx context.Context, id session.SessionID) (*session.Session, error) {
	s, err := u.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.IsClosed() {
		return nil, session.ErrSessionClosed
	}
	return s, nil
}
