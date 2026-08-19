package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/application/service"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// SetTransportInput is a maestro transport command.
type SetTransportInput struct {
	SessionID session.SessionID
	Role      session.Role
	Command   session.TransportCommand
}

// SetTransport validates a transport change, schedules it on the next bar
// boundary and publishes it to the whole session. The change is never applied
// "now": clients receive the instant it becomes effective and re-plan their
// audio graph around it (§5.4).
func (u *Usecases) SetTransport(ctx context.Context, in SetTransportInput) (application.OutboundMessage, error) {
	if err := u.auth.Authorize(in.Role, service.ActionSetTransport); err != nil {
		return application.OutboundMessage{}, err
	}
	s, err := u.load(ctx, in.SessionID)
	if err != nil {
		return application.OutboundMessage{}, err
	}
	changed, err := s.ApplyTransport(in.Command, in.Role, u.clock.NowMs())
	if err != nil {
		return application.OutboundMessage{}, err
	}
	if err := u.repo.Save(ctx, s); err != nil {
		return application.OutboundMessage{}, err
	}
	msg := application.NewMessage(application.MsgTransportUpdated, application.TransportUpdated{
		Transport:           changed.Transport,
		EffectiveAtServerMs: changed.EffectiveAtServerMs,
		Generation:          changed.Generation,
	})
	u.bus.ToSession(in.SessionID, msg)
	return msg, nil
}
