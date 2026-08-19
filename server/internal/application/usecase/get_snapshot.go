package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// GetSnapshot returns the full state of a session. Clients call it after a
// reconnection and replace their local state wholesale — no merge (§4.4).
func (u *Usecases) GetSnapshot(ctx context.Context, sid session.SessionID) (application.OutboundMessage, error) {
	s, err := u.load(ctx, sid)
	if err != nil {
		return application.OutboundMessage{}, err
	}
	return application.NewMessage(application.MsgStateSnapshot, application.StateSnapshot{
		Snapshot: s.Snapshot(u.clock.NowMs()),
	}), nil
}

// PublicState is the secret-free view served by the REST API.
type PublicState struct {
	SessionID    session.SessionID
	JoinCode     session.JoinCode
	State        session.PlayState
	BPM          float64
	Participants int
	MaxUsers     int
	Groups       []session.GroupCount
	Generation   uint64
	ServerTimeMs int64
}

// PublicState describes a session to anybody, without leaking the maestro
// token or any participant identity.
func (u *Usecases) PublicState(ctx context.Context, sid session.SessionID) (PublicState, error) {
	s, err := u.load(ctx, sid)
	if err != nil {
		return PublicState{}, err
	}
	transport := s.Transport()
	return PublicState{
		SessionID:    s.ID(),
		JoinCode:     s.Code(),
		State:        transport.State,
		BPM:          transport.Anchor.BPM,
		Participants: s.ParticipantCount(),
		MaxUsers:     s.MaxUsers(),
		Groups:       s.Counts(),
		Generation:   s.Generation(),
		ServerTimeMs: u.clock.NowMs(),
	}, nil
}
