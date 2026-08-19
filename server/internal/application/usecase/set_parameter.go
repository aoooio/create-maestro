package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/application/service"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// SetParameterInput is a maestro parameter change. Value is always a number:
// booleans arrive as 0 or 1 so that clamping has a single path.
type SetParameterInput struct {
	SessionID session.SessionID
	Role      session.Role
	Key       session.ParameterKey
	Value     float64
	Target    session.ParameterTarget
}

// SetParameter clamps a value to the bounds of the domain and publishes it to
// its target audience. A group-scoped change also reaches the maestro, whose
// console needs it to reconcile its optimistic state on `generation`.
func (u *Usecases) SetParameter(ctx context.Context, in SetParameterInput) (application.OutboundMessage, error) {
	if err := u.auth.Authorize(in.Role, service.ActionSetParameter); err != nil {
		return application.OutboundMessage{}, err
	}
	s, err := u.load(ctx, in.SessionID)
	if err != nil {
		return application.OutboundMessage{}, err
	}
	changed, err := s.SetParameter(in.Key, in.Value, in.Target, in.Role)
	if err != nil {
		return application.OutboundMessage{}, err
	}
	if err := u.repo.Save(ctx, s); err != nil {
		return application.OutboundMessage{}, err
	}

	msg := application.NewMessage(application.MsgParamUpdated, application.ParamUpdated{
		Entry:      changed.Entry,
		Generation: changed.Generation,
	})
	if in.Target.IsAll() {
		u.bus.ToSession(in.SessionID, msg)
	} else {
		u.bus.ToGroup(in.SessionID, in.Target.Group, msg)
		u.bus.ToMaestro(in.SessionID, msg)
	}
	return msg, nil
}
