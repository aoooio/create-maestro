package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/application/service"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// MaxTriggerKindLen bounds the free-form kind of a trigger.
const MaxTriggerKindLen = 32

// TriggerEventInput is a one-shot gesture from a musician.
type TriggerEventInput struct {
	SessionID     session.SessionID
	ParticipantID session.ParticipantID
	Role          session.Role
	Kind          string
	Intensity     float64
	AtBeat        *float64
}

// TriggerEvent relays a gesture to the maestro — and to the musician's own
// group when echo is enabled. It changes no state, so it never bumps the
// generation, and it travels as an ephemeral message: under backpressure a
// trigger is worth dropping, a transport change is not.
func (u *Usecases) TriggerEvent(ctx context.Context, in TriggerEventInput) error {
	if err := u.auth.Authorize(in.Role, service.ActionTrigger); err != nil {
		return err
	}
	if in.Kind == "" {
		return session.Invalidf("trigger kind is required")
	}
	if len(in.Kind) > MaxTriggerKindLen {
		return session.Invalidf("trigger kind is longer than %d bytes", MaxTriggerKindLen)
	}
	switch {
	case in.Intensity < 0:
		in.Intensity = 0
	case in.Intensity > 1:
		in.Intensity = 1
	}

	s, err := u.load(ctx, in.SessionID)
	if err != nil {
		return err
	}
	participant, ok := s.Participant(in.ParticipantID)
	if !ok {
		return session.ErrParticipantGone
	}

	msg := application.NewEphemeral(application.MsgParticipantTrigger, application.ParticipantTrigger{
		ParticipantID: participant.ID,
		GroupID:       participant.Group,
		Kind:          in.Kind,
		Intensity:     in.Intensity,
		AtBeat:        in.AtBeat,
	})
	u.bus.ToMaestro(in.SessionID, msg)
	if u.opts.TriggerEcho {
		u.bus.ToGroup(in.SessionID, participant.Group, msg)
	}
	return nil
}
