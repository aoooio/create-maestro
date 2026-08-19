package application

import (
	"errors"
	"testing"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func TestMessageConstructors(t *testing.T) {
	msg := NewMessage(MsgWelcome, Welcome{})
	if msg.Class != Critical || msg.Type != MsgWelcome || msg.Ack != "" {
		t.Fatalf("unexpected message: %+v", msg)
	}
	if got := msg.WithAck("01J"); got.Ack != "01J" || msg.Ack != "" {
		t.Fatal("WithAck must return a copy, leaving the original untouched")
	}
	if NewEphemeral(MsgParticipantTrigger, nil).Class != Ephemeral {
		t.Fatal("NewEphemeral must produce a droppable message")
	}
}

func TestNewError(t *testing.T) {
	msg := NewError(session.ErrSessionFull)
	payload := msg.Payload.(Error)
	if payload.Code != session.CodeSessionFull || !payload.Retryable {
		t.Fatalf("unexpected error payload: %+v", payload)
	}
	if msg.Class != Critical {
		t.Fatal("an error must never be dropped silently")
	}

	// A failure that is not a domain error must not leak its text.
	payload = NewError(errors.New("dial tcp 10.0.0.1:5432: refused")).Payload.(Error)
	if payload.Code != session.CodeInternal || payload.Message != "internal error" {
		t.Fatalf("internal details leaked: %+v", payload)
	}
}
