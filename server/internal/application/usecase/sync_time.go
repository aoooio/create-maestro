package usecase

import (
	"github.com/aoooio/create-maestro/server/internal/application"
)

// SyncTime answers a client ping. It touches no session state and takes no
// lock: the whole point is that the round trip stays as short and as jitter
// free as possible (§5.1). ServerSendMs is stamped by the codec, at the last
// possible instant before the bytes leave.
func (u *Usecases) SyncTime(clientSendMs, serverRecvMs int64) application.OutboundMessage {
	return application.NewMessage(application.MsgTimePong, application.TimePong{
		ClientSendMs: clientSendMs,
		ServerRecvMs: serverRecvMs,
	})
}
