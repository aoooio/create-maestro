package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/application/service"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// SetPatternInput replaces the step grid of one track.
type SetPatternInput struct {
	SessionID session.SessionID
	Role      session.Role
	TrackID   session.TrackID
	Steps     []session.Step
}

// SetPattern stores a validated grid and publishes it to the session.
func (u *Usecases) SetPattern(ctx context.Context, in SetPatternInput) (application.OutboundMessage, error) {
	if err := u.auth.Authorize(in.Role, service.ActionSetPattern); err != nil {
		return application.OutboundMessage{}, err
	}
	s, err := u.load(ctx, in.SessionID)
	if err != nil {
		return application.OutboundMessage{}, err
	}
	changed, err := s.SetPattern(in.TrackID, in.Steps, in.Role)
	if err != nil {
		return application.OutboundMessage{}, err
	}
	if err := u.repo.Save(ctx, s); err != nil {
		return application.OutboundMessage{}, err
	}
	msg := application.NewMessage(application.MsgPatternUpdated, application.PatternUpdated{
		Pattern:    changed.Pattern,
		Generation: changed.Generation,
	})
	u.bus.ToSession(in.SessionID, msg)
	return msg, nil
}
