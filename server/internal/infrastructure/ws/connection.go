package ws

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"

	"github.com/aoooio/create-maestro/server/internal/application"
	"github.com/aoooio/create-maestro/server/internal/application/usecase"
	"github.com/aoooio/create-maestro/server/internal/domain/session"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/observability"
)

// Timings of §3.6. The write deadline is per frame; the read deadline is
// pushed back by every pong, so a silent client is dropped after pongWait.
// They are variables rather than constants so that tests can compress them;
// nothing at runtime changes them.
var (
	pingPeriod   = 15 * time.Second
	pongWait     = 30 * time.Second
	writeWait    = 10 * time.Second
	helloTimeout = 5 * time.Second
	// drainWait bounds how long a closing connection keeps flushing what is
	// already queued before it sends its close frame.
	drainWait = 2 * time.Second
)

const (
	outBuffer      = 256
	maxRateStrikes = 3
)

// fatal marks an error that ends the connection rather than being reported
// and forgotten: a failed join, a hello that never came.
type fatal struct{ error }

// Unwrap keeps the domain code reachable through the wrapper, so a fatal
// error still reaches the client with its real code.
func (f fatal) Unwrap() error { return f.error }

func isFatal(err error) bool {
	_, ok := err.(fatal)
	return ok
}

// Connection is one WebSocket client: a read pump, a write pump and a
// buffered outbound channel between them.
type Connection struct {
	ws    *websocket.Conn
	hub   *Hub
	codec *Codec
	uc    *usecase.Usecases
	log   *slog.Logger

	sessionID     session.SessionID
	participantID session.ParticipantID
	group         session.GroupID
	role          session.Role
	token         session.Token
	queryName     string

	readLimit int64
	out       chan frame
	closing   chan struct{}
	closeOnce sync.Once
	goingAway atomic.Bool
	joined    atomic.Bool

	limiter *rate.Limiter
	strikes int
}

// send queues an encoded frame. It never blocks the hub: when a client cannot
// keep up, an ephemeral message is dropped and a critical one costs the
// connection — a client that missed a transport change would be playing
// something nobody else is playing.
func (c *Connection) send(f frame) {
	select {
	case c.out <- f:
	default:
		if f.class == application.Ephemeral {
			c.log.Debug("dropped an ephemeral message, client is behind")
			return
		}
		c.log.Warn("closing a connection that cannot receive a critical message")
		c.close()
	}
}

func (c *Connection) sendMessage(msg application.OutboundMessage) {
	data, err := c.codec.Encode(msg)
	if err != nil {
		c.log.Error("cannot encode message", slog.String("type", msg.Type), slog.Any("error", err))
		return
	}
	c.send(frame{class: msg.Class, data: data})
}

func (c *Connection) sendError(err error, ackID string) {
	c.sendMessage(application.NewError(err).WithAck(ackID))
}

// close makes both pumps wind down. It is safe to call repeatedly.
func (c *Connection) close() {
	c.closeOnce.Do(func() { close(c.closing) })
}

// closeGoingAway is the shutdown path: the client is told the server is
// leaving, which is its cue to reconnect rather than to give up.
func (c *Connection) closeGoingAway() {
	c.goingAway.Store(true)
	c.close()
}

// serve runs the connection until either pump gives up, then leaves the
// session. It returns when everything is cleaned up.
func (c *Connection) serve(ctx context.Context) {
	var wg sync.WaitGroup
	writeDone := make(chan struct{})
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer close(writeDone)
		c.writePump()
	}()
	go func() {
		defer wg.Done()
		// Once the write pump has put its close frame on the wire, closing the
		// socket is what unblocks a read parked in ReadMessage — and the only
		// safe way to do it: gorilla forbids calling SetReadDeadline while a
		// read is in flight, and waiting for the deadline instead would stall
		// every shutdown for a full pongWait.
		<-writeDone
		_ = c.ws.Close()
	}()

	c.readPump(ctx)
	c.close()
	wg.Wait()
	_ = c.ws.Close()

	c.hub.Unregister(c)
	if c.joined.Load() {
		// Leaving is the last thing this connection owes the room, so it must
		// happen even if the context is already on its way out.
		if err := c.uc.LeaveSession(context.WithoutCancel(ctx), c.sessionID, c.participantID); err != nil {
			c.log.Warn("cannot leave session", slog.Any("error", err))
		}
	}
	c.log.Info("connection closed")
}

// readPump consumes client frames. Every message is timestamped as early as
// possible: that reading is what a time.ping round trip is measured against.
func (c *Connection) readPump(ctx context.Context) {
	c.ws.SetReadLimit(c.readLimit)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})

	hello := time.AfterFunc(helloTimeout, func() {
		if !c.joined.Load() {
			c.log.Info("no hello within the deadline, closing")
			c.sendError(session.ErrHelloRequired, "")
			c.close()
		}
	})
	defer hello.Stop()

	for {
		select {
		case <-c.closing:
			return
		default:
		}

		_, data, err := c.ws.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				c.log.Info("read ended", slog.Any("error", err))
			}
			return
		}
		recvMs := c.uc.NowMs()

		if !c.limiter.Allow() {
			c.strikes++
			c.sendError(session.ErrRateLimited, "")
			if c.strikes >= maxRateStrikes {
				c.log.Warn("rate limit exceeded too often, closing", slog.Int("strikes", c.strikes))
				c.close()
				return
			}
			continue
		}

		msg, err := c.codec.Decode(data)
		if err != nil {
			c.sendError(err, "")
			continue
		}
		if err := c.handle(ctx, msg, recvMs); err != nil {
			c.sendError(err, msg.ID)
			if isFatal(err) {
				c.close()
				return
			}
		}
	}
}

// writePump owns the socket for writing: every frame, every ping and the
// close frame go through this single goroutine.
func (c *Connection) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case f := <-c.out:
			if !c.write(f) {
				return
			}
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.closing:
			c.drainAndClose()
			return
		}
	}
}

func (c *Connection) write(f frame) bool {
	_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.ws.WriteMessage(websocket.TextMessage, f.data); err != nil {
		c.log.Debug("write failed", slog.Any("error", err))
		c.close()
		return false
	}
	return true
}

// drainAndClose flushes what is already queued, then sends the close frame.
func (c *Connection) drainAndClose() {
	deadline := time.After(drainWait)
	for {
		select {
		case f := <-c.out:
			if !c.write(f) {
				return
			}
		case <-deadline:
			return
		default:
			code := websocket.CloseNormalClosure
			if c.goingAway.Load() {
				code = websocket.CloseGoingAway
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			_ = c.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""))
			return
		}
	}
}

// handle routes one decoded message to its use case.
func (c *Connection) handle(ctx context.Context, msg inbound, recvMs int64) error {
	if msg.Type == TypeHello {
		if c.joined.Load() {
			return session.Invalidf("hello was already sent")
		}
		return c.join(ctx, msg)
	}
	if !c.joined.Load() {
		return fatal{session.ErrHelloRequired}
	}

	switch payload := msg.Payload.(type) {
	case timePingDTO:
		c.sendMessage(c.uc.SyncTime(payload.ClientSendMs, recvMs).WithAck(msg.ID))
		return nil

	case transportSetDTO:
		cmd, err := payload.toCommand()
		if err != nil {
			return err
		}
		_, err = c.uc.SetTransport(ctx, usecase.SetTransportInput{
			SessionID: c.sessionID, Role: c.role, Command: cmd,
		})
		return err

	case paramSetDTO:
		value, err := payload.toValue()
		if err != nil {
			return err
		}
		target, err := session.ParseTarget(payload.Target)
		if err != nil {
			return err
		}
		_, err = c.uc.SetParameter(ctx, usecase.SetParameterInput{
			SessionID: c.sessionID, Role: c.role,
			Key: session.ParameterKey(payload.Key), Value: value, Target: target,
		})
		return err

	case patternSetDTO:
		steps, err := payload.toSteps()
		if err != nil {
			return err
		}
		_, err = c.uc.SetPattern(ctx, usecase.SetPatternInput{
			SessionID: c.sessionID, Role: c.role,
			TrackID: session.TrackID(payload.TrackID), Steps: steps,
		})
		return err

	case triggerDTO:
		return c.uc.TriggerEvent(ctx, usecase.TriggerEventInput{
			SessionID: c.sessionID, ParticipantID: c.participantID, Role: c.role,
			Kind: payload.Kind, Intensity: payload.Intensity, AtBeat: payload.AtBeat,
		})

	default: // state.request
		snapshot, err := c.uc.GetSnapshot(ctx, c.sessionID)
		if err != nil {
			return err
		}
		c.sendMessage(snapshot.WithAck(msg.ID))
		return nil
	}
}

// join runs the handshake: the participant is created, the connection is
// registered, and only then is anything announced — otherwise the newcomer
// would miss its own welcome.
func (c *Connection) join(ctx context.Context, msg inbound) error {
	hello, _ := msg.Payload.(helloDTO)
	name := c.queryName
	if hello.Name != "" {
		name = hello.Name
	}

	out, err := c.uc.JoinSession(ctx, usecase.JoinSessionInput{
		SessionID: c.sessionID,
		Role:      c.role,
		Token:     c.token,
		Name:      name,
	})
	if err != nil {
		return fatal{err}
	}

	c.participantID = out.Participant.ID
	c.group = out.Participant.Group
	c.log = observability.Participant(c.log, c.participantID)
	c.joined.Store(true)

	c.hub.Register(c)
	c.sendMessage(out.Welcome.WithAck(msg.ID))
	c.sendMessage(out.Snapshot)
	if c.role == session.RoleMusician {
		c.sendMessage(out.Group)
	}
	c.hub.ToSession(c.sessionID, out.Announce)

	c.log.Info("participant joined",
		slog.Int("group", int(c.group)),
		slog.String("clientVersion", hello.ClientVersion))
	return nil
}
