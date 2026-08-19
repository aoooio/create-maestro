/**
 * The WebSocket connection and its resilience rules (§6.5).
 *
 * Three things happen here that nothing else in the client should have to
 * think about:
 *
 *  - **reconnection** with exponential backoff and jitter, replaying the
 *    handshake every time (`hello` → `state.request`), because the server
 *    closes a connection that has not said hello within 5 s;
 *  - **staying under the server's rate limit**: 10 msg/s sustained, and a
 *    connection is closed on its third strike. A slider dragged across the
 *    screen would blow through that in a second, so outbound traffic goes
 *    through a token bucket that coalesces by key — only the latest value of
 *    a given control is ever sent;
 *  - **surfacing the connection state** so the UI can say "offline" while the
 *    audio keeps playing on the last known transport.
 */

import { DecodeError, ProtocolVersionError, decode, encode } from "./codec";
import type { ClientMessage, ServerMessage } from "./codec";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** Minimal shape of a WebSocket, so tests can drive a fake one. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface WsClientOptions {
  /** Full endpoint, query included: the role lives in the URL (§3.5). */
  url: string;
  hello: Extract<ClientMessage, { t: "hello" }>["d"];
  onMessage: (message: ServerMessage) => void;
  onStateChange?: (state: ConnectionState, detail?: { attempt: number }) => void;
  /** Fired on every (re)connection, once the handshake is on the wire: the cue
   * to run a clock resync burst. */
  onHandshake?: () => void;
  /** Fired when the connection cannot be recovered by retrying. */
  onFatal?: (reason: FatalReason, message: string) => void;
  now?: () => number;
  random?: () => number;
  socketFactory?: SocketFactory;
}

export type FatalReason = "protocol_version" | "unauthorized" | "session_not_found" | "closed_by_server";

/** Errors that retrying cannot fix: reconnecting would only hammer the server. */
const FATAL_CODES = new Set(["protocol_version", "unauthorized", "session_not_found"]);

/** Reconnection: 500ms × 2^n capped at 10 s, jitter ±20 % (§6.5). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
const BACKOFF_JITTER = 0.2;

/** Outbound budget, deliberately below the server's 10 msg/s sustained. */
const SEND_RATE_PER_SEC = 8;
const SEND_BURST = 8;
/** Beyond this, the oldest queued message is dropped: a stale trigger is worth
 * less than a fresh one, and the queue must not grow without bound. */
const MAX_QUEUE = 32;

interface Queued {
  key?: string;
  message: ClientMessage;
}

export class WsClient {
  private socket: SocketLike | null = null;
  private state: ConnectionState = "idle";
  private attempt = 0;
  private manualClose = false;
  private fatal = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Queued[] = [];
  private tokens = SEND_BURST;
  private lastRefillMs: number;
  private disconnectedSinceMs: number | null = null;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly makeSocket: SocketFactory;

  constructor(private readonly options: WsClientOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.makeSocket =
      options.socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this.lastRefillMs = this.now();
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** How long the client has been without a live connection, in ms; null when
   * connected. Drives the "offline" banner and the 30 s fade-out. */
  offlineForMs(): number | null {
    if (this.disconnectedSinceMs === null) return null;
    return this.now() - this.disconnectedSinceMs;
  }

  connect(): void {
    if (this.fatal || this.socket) return;
    this.manualClose = false;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

    let socket: SocketLike;
    try {
      socket = this.makeSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.disconnectedSinceMs = null;
      this.setState("open");
      // The handshake bypasses the bucket: it is two messages, and the server
      // drops a connection that has not said hello within 5 s.
      this.write({ t: "hello", d: this.options.hello });
      this.write({ t: "state.request", d: {} });
      this.options.onHandshake?.();
      this.flush();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = decode(event.data);
      } catch (error) {
        if (error instanceof ProtocolVersionError) {
          this.die("protocol_version", error.message);
          return;
        }
        if (error instanceof DecodeError) {
          // A frame we cannot read is dropped, never applied half-way.
          console.warn("[ws] dropped an unreadable frame:", error.message);
          return;
        }
        throw error;
      }

      if (message.type === "error" && FATAL_CODES.has(message.data.code)) {
        this.die(message.data.code as FatalReason, message.data.message);
        return;
      }
      this.options.onMessage(message);
    };

    socket.onerror = () => {
      // `onclose` always follows; the reconnection is driven from there so it
      // cannot be scheduled twice.
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.manualClose || this.fatal) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Closes for good: no reconnection, no queued message survives. */
  close(): void {
    this.manualClose = true;
    this.clearTimers();
    this.queue = [];
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client closed");
    this.setState("closed");
  }

  /**
   * Queues a message under the outbound budget. `coalesceKey` makes a message
   * replace the pending one that carries the same key — a slider being dragged
   * only ever sends its latest value.
   */
  send(message: ClientMessage, coalesceKey?: string): void {
    if (this.fatal) return;
    if (coalesceKey !== undefined) {
      const existing = this.queue.findIndex((item) => item.key === coalesceKey);
      if (existing >= 0) {
        this.queue[existing] = { key: coalesceKey, message };
        this.flush();
        return;
      }
    }
    this.queue.push({ key: coalesceKey, message });
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.flush();
  }

  /** Number of messages waiting for budget — shown on the maestro's health line. */
  pending(): number {
    return this.queue.length;
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.state !== "open" || this.socket === null) return;

    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      const next = this.queue.shift()!;
      this.tokens -= 1;
      this.write(next.message);
    }
    if (this.queue.length > 0) {
      const waitMs = Math.ceil(((1 - this.tokens) / SEND_RATE_PER_SEC) * 1000);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, Math.max(waitMs, 10));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedSec = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(SEND_BURST, this.tokens + elapsedSec * SEND_RATE_PER_SEC);
    this.lastRefillMs = now;
  }

  private write(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(encode(message, this.now()).frame);
    } catch {
      // The socket died between the check and the write; `onclose` will pick
      // the reconnection up.
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.disconnectedSinceMs === null) this.disconnectedSinceMs = this.now();

    const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const jitter = 1 - BACKOFF_JITTER + this.random() * BACKOFF_JITTER * 2;
    const delay = Math.round(exponential * jitter);
    this.attempt += 1;
    this.setState("reconnecting", { attempt: this.attempt });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private die(reason: FatalReason, message: string): void {
    this.fatal = true;
    this.clearTimers();
    this.queue = [];
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, reason);
    this.setState("closed");
    this.options.onFatal?.(reason, message);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.reconnectTimer = null;
    this.flushTimer = null;
  }

  private setState(state: ConnectionState, detail?: { attempt: number }): void {
    if (this.state === state && detail === undefined) return;
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}

/** Builds the maestro endpoint: the role comes from the path, never a flag. */
export function maestroUrl(base: string, sessionId: string, token: string): string {
  const url = new URL("/ws/v1/maestro", base);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Builds the musician endpoint. */
export function performUrl(base: string, sessionId: string, name: string): string {
  const url = new URL("/ws/v1/perform", base);
  url.searchParams.set("session", sessionId);
  if (name) url.searchParams.set("name", name);
  return url.toString();
}
