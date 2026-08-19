package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// LeaveSession removes a participant and tells the room. A disconnect that
// does not match any participant is a no-op, so a double close is harmless.
func (u *Usecases) LeaveSession(ctx context.Context, sid session.SessionID, pid session.ParticipantID) error {
	s, err := u.repo.FindByID(ctx, sid)
	if err != nil {
		return err
	}
	left, ok := s.Leave(pid)
	if !ok {
		return nil
	}
	if err := u.repo.Save(ctx, s); err != nil {
		return err
	}
	u.bus.ToSession(sid, application.NewEphemeral(application.MsgParticipantLeft, application.ParticipantPresence{
		ParticipantID: left.Participant.ID,
		Name:          left.Participant.Name,
		Role:          left.Participant.Role,
		GroupID:       left.Participant.Group,
		Counts:        left.Counts,
	}))
	return nil
}

// CloseSession terminates a session on the maestro's request. The token stops
// being replayable and the session leaves the repository.
func (u *Usecases) CloseSession(ctx context.Context, sid session.SessionID, token session.Token) error {
	s, err := u.repo.FindByID(ctx, sid)
	if err != nil {
		return err
	}
	if err := s.AuthenticateMaestro(token); err != nil {
		return err
	}
	s.Close()
	u.bus.ToSession(sid, application.NewError(session.ErrSessionClosed))
	return u.repo.Delete(ctx, sid)
}
