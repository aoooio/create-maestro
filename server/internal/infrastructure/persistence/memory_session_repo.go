// Package persistence holds the repository implementations. Only an in-memory
// one for now: a single event fits in one process. Surviving a redeploy in the
// middle of a set would mean a Redis-backed repository behind the same port,
// plus a distributed hub — a structural decision, not a drop-in change.
package persistence

import (
	"context"
	"sync"
	"time"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// MemorySessionRepo keeps sessions in two indexes: by id and by join code.
// The aggregate guards its own state, so the lock here only protects the maps.
type MemorySessionRepo struct {
	mu     sync.RWMutex
	byID   map[session.SessionID]*session.Session
	byCode map[session.JoinCode]*session.Session
}

// NewMemorySessionRepo builds an empty repository.
func NewMemorySessionRepo() *MemorySessionRepo {
	return &MemorySessionRepo{
		byID:   make(map[session.SessionID]*session.Session),
		byCode: make(map[session.JoinCode]*session.Session),
	}
}

// Save stores a session under both of its keys.
func (r *MemorySessionRepo) Save(_ context.Context, s *session.Session) error {
	if s == nil {
		return session.Invalidf("cannot save a nil session")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byID[s.ID()] = s
	r.byCode[s.Code()] = s
	return nil
}

// FindByID returns a session, or session.ErrSessionNotFound.
func (r *MemorySessionRepo) FindByID(_ context.Context, id session.SessionID) (*session.Session, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.byID[id]
	if !ok {
		return nil, session.ErrSessionNotFound
	}
	return s, nil
}

// FindByCode resolves a short join code.
func (r *MemorySessionRepo) FindByCode(_ context.Context, code session.JoinCode) (*session.Session, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.byCode[code]
	if !ok {
		return nil, session.ErrSessionNotFound
	}
	return s, nil
}

// Delete removes a session from both indexes.
func (r *MemorySessionRepo) Delete(_ context.Context, id session.SessionID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.byID[id]; ok {
		delete(r.byCode, s.Code())
		delete(r.byID, id)
	}
	return nil
}

// Len is the number of stored sessions, for the readiness probe and the logs.
func (r *MemorySessionRepo) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.byID)
}

// Purge drops sessions that are closed, or empty and older than ttl. It
// returns how many were dropped. Without it, an abandoned session would hold
// its join code forever.
func (r *MemorySessionRepo) Purge(now time.Time, ttl time.Duration) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	dropped := 0
	for id, s := range r.byID {
		expired := s.ParticipantCount() == 0 && now.Sub(s.CreatedAt()) > ttl
		if s.IsClosed() || expired {
			delete(r.byCode, s.Code())
			delete(r.byID, id)
			dropped++
		}
	}
	return dropped
}

// StartJanitor purges expired sessions until the context is cancelled.
func (r *MemorySessionRepo) StartJanitor(ctx context.Context, every, ttl time.Duration, onPurge func(int)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if dropped := r.Purge(now, ttl); dropped > 0 && onPurge != nil {
				onPurge(dropped)
			}
		}
	}
}
