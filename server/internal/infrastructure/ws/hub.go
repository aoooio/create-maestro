package ws

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// hubQueue is the depth of the command queue. It absorbs a burst of triggers
// without making the producers wait; a producer only blocks when the hub is
// genuinely behind, which is the backpressure we want.
const hubQueue = 4096

// frame is an already-encoded message plus the class that decides its fate
// under backpressure.
type frame struct {
	class application.Class
	data  []byte
}

// Hub owns the connection registry. It runs in a single goroutine driven by a
// command channel: no mutex is ever taken on the connection maps, and message
// ordering inside a session is whatever order the commands arrived in.
type Hub struct {
	codec *Codec
	log   *slog.Logger

	cmds     chan func()
	done     chan struct{}
	stopOnce sync.Once
	active   atomic.Int64

	// Owned exclusively by the run loop.
	byParticipant map[session.ParticipantID]*Connection
	bySession     map[session.SessionID]map[session.ParticipantID]*Connection
	maestros      map[session.SessionID]*Connection
}

// NewHub builds a hub. Run must be called for it to do anything.
func NewHub(codec *Codec, log *slog.Logger) *Hub {
	return &Hub{
		codec:         codec,
		log:           log,
		cmds:          make(chan func(), hubQueue),
		done:          make(chan struct{}),
		byParticipant: make(map[session.ParticipantID]*Connection),
		bySession:     make(map[session.SessionID]map[session.ParticipantID]*Connection),
		maestros:      make(map[session.SessionID]*Connection),
	}
}

// Run drives the hub until the context is cancelled, then closes every
// connection with a "going away" frame.
func (h *Hub) Run(ctx context.Context) {
	defer h.stop()
	for {
		select {
		case fn := <-h.cmds:
			fn()
		case <-ctx.Done():
			h.closeAll()
			return
		}
	}
}

func (h *Hub) stop() {
	h.stopOnce.Do(func() { close(h.done) })
}

// enqueue hands work to the run loop. It blocks while the queue is full,
// which is the intended backpressure, but never after shutdown.
func (h *Hub) enqueue(fn func()) {
	select {
	case h.cmds <- fn:
	case <-h.done:
	}
}

// Register adds a connection to the registry and waits for it to be visible,
// so that the caller can safely announce the newcomer right afterwards.
func (h *Hub) Register(c *Connection) {
	ack := make(chan struct{})
	h.enqueue(func() {
		defer close(ack)
		h.byParticipant[c.participantID] = c
		peers, ok := h.bySession[c.sessionID]
		if !ok {
			peers = make(map[session.ParticipantID]*Connection)
			h.bySession[c.sessionID] = peers
		}
		peers[c.participantID] = c
		if c.role == session.RoleMaestro {
			h.maestros[c.sessionID] = c
		}
		h.active.Add(1)
	})
	select {
	case <-ack:
	case <-h.done:
	}
}

// Unregister removes a connection from the registry.
func (h *Hub) Unregister(c *Connection) {
	h.enqueue(func() {
		if current, ok := h.byParticipant[c.participantID]; !ok || current != c {
			return
		}
		delete(h.byParticipant, c.participantID)
		if peers, ok := h.bySession[c.sessionID]; ok {
			delete(peers, c.participantID)
			if len(peers) == 0 {
				delete(h.bySession, c.sessionID)
			}
		}
		if m, ok := h.maestros[c.sessionID]; ok && m == c {
			delete(h.maestros, c.sessionID)
		}
		h.active.Add(-1)
	})
}

// ToSession fans a message out to every participant of a session.
func (h *Hub) ToSession(id session.SessionID, msg application.OutboundMessage) {
	h.enqueue(func() { h.fanout(h.bySession[id], nil, msg) })
}

// ToGroup fans a message out to one register of a session.
func (h *Hub) ToGroup(id session.SessionID, g session.GroupID, msg application.OutboundMessage) {
	h.enqueue(func() {
		h.fanout(h.bySession[id], func(c *Connection) bool { return c.group == g }, msg)
	})
}

// ToParticipant sends a message to a single connection.
func (h *Hub) ToParticipant(pid session.ParticipantID, msg application.OutboundMessage) {
	h.enqueue(func() {
		if c, ok := h.byParticipant[pid]; ok {
			h.deliver(c, msg)
		}
	})
}

// ToMaestro sends a message to the maestro of a session, if one is connected.
func (h *Hub) ToMaestro(id session.SessionID, msg application.OutboundMessage) {
	h.enqueue(func() {
		if c, ok := h.maestros[id]; ok {
			h.deliver(c, msg)
		}
	})
}

// ActiveConnections is the number of registered connections.
func (h *Hub) ActiveConnections() int64 { return h.active.Load() }

// fanout encodes the message once and hands the same bytes to every matching
// connection: one logical message keeps one message id for everybody.
func (h *Hub) fanout(peers map[session.ParticipantID]*Connection, match func(*Connection) bool, msg application.OutboundMessage) {
	if len(peers) == 0 {
		return
	}
	data, err := h.codec.Encode(msg)
	if err != nil {
		h.log.Error("cannot encode outbound message", slog.String("type", msg.Type), slog.Any("error", err))
		return
	}
	f := frame{class: msg.Class, data: data}
	for _, c := range peers {
		if match == nil || match(c) {
			c.send(f)
		}
	}
}

func (h *Hub) deliver(c *Connection, msg application.OutboundMessage) {
	data, err := h.codec.Encode(msg)
	if err != nil {
		h.log.Error("cannot encode outbound message", slog.String("type", msg.Type), slog.Any("error", err))
		return
	}
	c.send(frame{class: msg.Class, data: data})
}

// closeAll asks every connection to leave cleanly. The connections drain
// their own write pumps; the caller waits on them through the server's
// WaitGroup.
func (h *Hub) closeAll() {
	for _, c := range h.byParticipant {
		c.closeGoingAway()
	}
}
