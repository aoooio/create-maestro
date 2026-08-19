package usecase

import (
	"context"
	"errors"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// CreateSessionInput is the REST creation payload, already parsed.
type CreateSessionInput struct {
	MaxUsers    int
	BPM         float64
	GroupLabels []string
	Strategy    string
}

// CreateSessionOutput carries the only copy of the maestro token the system
// ever hands out.
type CreateSessionOutput struct {
	SessionID    session.SessionID
	JoinCode     session.JoinCode
	MaestroToken session.Token
	MaxUsers     int
	Groups       []session.GroupCount
}

// joinCodeAttempts bounds the retry loop on join-code collisions. With a
// 4-character alphabet-based code the odds of ten collisions in a row are
// negligible; exceeding it means the generator is broken.
const joinCodeAttempts = 10

// CreateSession mints a session and its maestro token.
func (u *Usecases) CreateSession(ctx context.Context, in CreateSessionInput) (CreateSessionOutput, error) {
	strategy, err := session.StrategyByName(in.Strategy)
	if err != nil {
		return CreateSessionOutput{}, err
	}
	if in.MaxUsers <= 0 {
		in.MaxUsers = u.opts.DefaultMaxUsers
	}
	if in.BPM == 0 {
		in.BPM = u.opts.DefaultBPM
	}
	if len(in.GroupLabels) == 0 {
		in.GroupLabels = u.opts.GroupLabels
	}

	code, err := u.freeJoinCode(ctx)
	if err != nil {
		return CreateSessionOutput{}, err
	}
	token, err := u.tokens.NewToken()
	if err != nil {
		return CreateSessionOutput{}, err
	}

	now := u.clock.NowMs()
	s, err := session.New(u.ids.NewSessionID(), code, token, session.Options{
		MaxUsers:    in.MaxUsers,
		GroupLabels: in.GroupLabels,
		Strategy:    strategy,
		BPM:         in.BPM,
		NowMs:       now,
	})
	if err != nil {
		return CreateSessionOutput{}, err
	}
	if err := u.repo.Save(ctx, s); err != nil {
		return CreateSessionOutput{}, err
	}

	return CreateSessionOutput{
		SessionID:    s.ID(),
		JoinCode:     s.Code(),
		MaestroToken: token,
		MaxUsers:     s.MaxUsers(),
		Groups:       s.Counts(),
	}, nil
}

func (u *Usecases) freeJoinCode(ctx context.Context) (session.JoinCode, error) {
	for range joinCodeAttempts {
		code := u.ids.NewJoinCode()
		_, err := u.repo.FindByCode(ctx, code)
		if errors.Is(err, session.ErrSessionNotFound) {
			return code, nil
		}
		if err != nil {
			return "", err
		}
	}
	return "", session.Internalf("no free join code after %d attempts", joinCodeAttempts)
}
