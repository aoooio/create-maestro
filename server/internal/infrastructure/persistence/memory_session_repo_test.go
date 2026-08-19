package persistence

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func newSession(t *testing.T, id session.SessionID, code session.JoinCode, createdAt time.Time) *session.Session {
	t.Helper()
	s, err := session.New(id, code, "tok", session.Options{CreatedAt: createdAt})
	if err != nil {
		t.Fatalf("session.New: %v", err)
	}
	return s
}

func TestSaveAndFind(t *testing.T) {
	ctx := context.Background()
	repo := NewMemorySessionRepo()
	s := newSession(t, "id-1", "CODE", time.Now())

	if err := repo.Save(ctx, s); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if found, err := repo.FindByID(ctx, "id-1"); err != nil || found != s {
		t.Fatalf("FindByID = %v, %v", found, err)
	}
	if found, err := repo.FindByCode(ctx, "CODE"); err != nil || found != s {
		t.Fatalf("FindByCode = %v, %v", found, err)
	}
	if repo.Len() != 1 {
		t.Fatalf("Len = %d", repo.Len())
	}

	if _, err := repo.FindByID(ctx, "ghost"); !errors.Is(err, session.ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
	if _, err := repo.FindByCode(ctx, "ZZZZ"); !errors.Is(err, session.ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
	if err := repo.Save(ctx, nil); err == nil {
		t.Fatal("saving nil must be refused")
	}
}

func TestDeleteClearsBothIndexes(t *testing.T) {
	ctx := context.Background()
	repo := NewMemorySessionRepo()
	if err := repo.Save(ctx, newSession(t, "id-1", "CODE", time.Now())); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := repo.Delete(ctx, "id-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := repo.FindByCode(ctx, "CODE"); !errors.Is(err, session.ErrSessionNotFound) {
		t.Fatalf("the join code must be released, got %v", err)
	}
	// Deleting twice is harmless.
	if err := repo.Delete(ctx, "id-1"); err != nil {
		t.Fatalf("second Delete: %v", err)
	}
}

func TestPurgeDropsClosedAndAbandonedSessions(t *testing.T) {
	ctx := context.Background()
	repo := NewMemorySessionRepo()
	now := time.Now()

	fresh := newSession(t, "fresh", "AAAA", now)
	old := newSession(t, "old", "BBBB", now.Add(-2*time.Hour))
	closed := newSession(t, "closed", "CCCC", now)
	closed.Close()
	populated := newSession(t, "populated", "DDDD", now.Add(-2*time.Hour))
	if _, err := populated.Join(session.NewParticipant("p1", "amelie", session.RoleMusician, 0)); err != nil {
		t.Fatalf("Join: %v", err)
	}

	for _, s := range []*session.Session{fresh, old, closed, populated} {
		if err := repo.Save(ctx, s); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}

	if dropped := repo.Purge(now, time.Hour); dropped != 2 {
		t.Fatalf("purged %d sessions, want 2 (the old empty one and the closed one)", dropped)
	}
	if _, err := repo.FindByID(ctx, "fresh"); err != nil {
		t.Fatal("a recent session must survive")
	}
	if _, err := repo.FindByID(ctx, "populated"); err != nil {
		t.Fatal("a session with people in it must survive, however old")
	}
	if _, err := repo.FindByID(ctx, "old"); !errors.Is(err, session.ErrSessionNotFound) {
		t.Fatal("an abandoned session must be dropped")
	}
}

func TestJanitorRunsUntilTheContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	repo := NewMemorySessionRepo()
	if err := repo.Save(context.Background(), newSession(t, "old", "AAAA", time.Now().Add(-time.Hour))); err != nil {
		t.Fatalf("Save: %v", err)
	}

	purged := make(chan int, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		repo.StartJanitor(ctx, time.Millisecond, time.Minute, func(n int) {
			select {
			case purged <- n:
			default:
			}
		})
	}()

	select {
	case n := <-purged:
		if n != 1 {
			t.Fatalf("purged %d, want 1", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the janitor never ran")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the janitor ignored the cancellation")
	}
}
