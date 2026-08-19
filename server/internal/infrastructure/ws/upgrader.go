package ws

import (
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
)

// newUpgrader builds the WebSocket upgrader. Origin checking happens here,
// before a single byte of connection state is allocated (§3.5).
func newUpgrader(cfg config.Config) websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 4096,
		// Compression would cost CPU on every small control message for no
		// gain: our frames are already tiny.
		EnableCompression: false,
		CheckOrigin: func(r *http.Request) bool {
			return cfg.OriginAllowed(r.Header.Get("Origin"))
		},
	}
}
