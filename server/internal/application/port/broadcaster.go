package port

import (
	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// Broadcaster fans a message out to an audience. Implementations must never
// block the caller: a slow client is handled by the backpressure policy of the
// connection, not by stalling the use case that produced the message.
type Broadcaster interface {
	ToSession(id session.SessionID, msg application.OutboundMessage)
	ToGroup(id session.SessionID, g session.GroupID, msg application.OutboundMessage)
	ToParticipant(pid session.ParticipantID, msg application.OutboundMessage)
	ToMaestro(id session.SessionID, msg application.OutboundMessage)
}
