package usecase

import (
	"context"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// JoinSessionInput describes a connection asking to enter a session. The
// maestro token is checked here and never travels any further.
type JoinSessionInput struct {
	SessionID session.SessionID
	Role      session.Role
	Token     session.Token
	Name      string
}

// JoinSessionOutput returns the messages to deliver rather than sending them:
// the caller must register the connection before anything is broadcast, so
// delivery order belongs to the transport layer.
type JoinSessionOutput struct {
	Participant session.Participant
	// Welcome and Snapshot go to the newcomer, in that order.
	Welcome  application.OutboundMessage
	Snapshot application.OutboundMessage
	// Group tells the newcomer which register it plays.
	Group application.OutboundMessage
	// Announce goes to the whole session.
	Announce application.OutboundMessage
}

// JoinSession registers a participant and assigns its group.
func (u *Usecases) JoinSession(ctx context.Context, in JoinSessionInput) (JoinSessionOutput, error) {
	s, err := u.load(ctx, in.SessionID)
	if err != nil {
		return JoinSessionOutput{}, err
	}
	if in.Role == session.RoleMaestro {
		if err := s.AuthenticateMaestro(in.Token); err != nil {
			return JoinSessionOutput{}, err
		}
	}

	now := u.clock.NowMs()
	participant := session.NewParticipant(u.ids.NewParticipantID(), in.Name, in.Role, now)
	joined, err := s.Join(participant)
	if err != nil {
		return JoinSessionOutput{}, err
	}
	if err := u.repo.Save(ctx, s); err != nil {
		return JoinSessionOutput{}, err
	}

	label := ""
	for _, c := range joined.Counts {
		if c.ID == joined.Participant.Group {
			label = c.Label
		}
	}

	return JoinSessionOutput{
		Participant: joined.Participant,
		Welcome: application.NewMessage(application.MsgWelcome, application.Welcome{
			ParticipantID: joined.Participant.ID,
			SessionID:     s.ID(),
			Role:          joined.Participant.Role,
			GroupID:       joined.Participant.Group,
			ServerTimeMs:  now,
		}),
		Snapshot: application.NewMessage(application.MsgStateSnapshot, application.StateSnapshot{
			Snapshot: s.Snapshot(now),
		}),
		Group: application.NewMessage(application.MsgGroupAssigned, application.GroupAssigned{
			GroupID: joined.Participant.Group,
			Label:   label,
			Reason:  s.StrategyName(),
		}),
		Announce: application.NewEphemeral(application.MsgParticipantJoined, application.ParticipantPresence{
			ParticipantID: joined.Participant.ID,
			Name:          joined.Participant.Name,
			Role:          joined.Participant.Role,
			GroupID:       joined.Participant.Group,
			Counts:        joined.Counts,
		}),
	}, nil
}

// ResolveByCode maps a short join code to a session id.
func (u *Usecases) ResolveByCode(ctx context.Context, code session.JoinCode) (session.SessionID, error) {
	s, err := u.repo.FindByCode(ctx, code)
	if err != nil {
		return "", err
	}
	if s.IsClosed() {
		return "", session.ErrSessionNotFound
	}
	return s.ID(), nil
}
