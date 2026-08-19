import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WsClient,
  maestroUrl,
  performUrl,
  type SocketLike,
  type WsClientOptions,
} from "./client";
import type { ServerMessage } from "./codec";

/** A socket we drive by hand, so the resilience rules can be tested without a
 * server and without waiting in real time. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  drop(): void {
    this.onclose?.({ code: 1006, reason: "gone" });
  }

  deliver(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, t: type, id: "s1", ts: 0, d: data }) });
  }

  types(): string[] {
    return this.sent.map((frame) => JSON.parse(frame).t as string);
  }

  payloads(type: string): unknown[] {
    return this.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.t === type)
      .map((frame) => frame.d);
  }
}

type Overrides = Partial<Omit<WsClientOptions, "url" | "hello" | "onMessage" | "socketFactory">>;

function build(overrides: Overrides = {}) {
  const sockets: FakeSocket[] = [];
  const messages: ServerMessage[] = [];
  const client = new WsClient({
    url: "ws://localhost:8080/ws/v1/perform?session=s1",
    hello: { clientVersion: "test", capabilities: { webaudio: true, webgl: true } },
    // A fixed jitter draw keeps the backoff assertions exact.
    random: () => 0.5,
    now: () => Date.now(),
    ...overrides,
    onMessage: (message) => messages.push(message),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets, messages };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handshake", () => {
  it("says hello then asks for the state, in that order", () => {
    const { client, sockets } = build();
    client.connect();
    sockets[0]!.open();

    expect(sockets[0]!.types()).toEqual(["hello", "state.request"]);
    expect(client.getState()).toBe("open");
  });

  it("replays the handshake on every reconnection", () => {
    const onHandshake = vi.fn();
    const { client, sockets } = build({ onHandshake });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.drop();

    vi.advanceTimersByTime(10_000);
    sockets[1]!.open();

    expect(sockets[1]!.types()).toEqual(["hello", "state.request"]);
    expect(onHandshake).toHaveBeenCalledTimes(2);
  });
});

describe("reconnection (§6.5)", () => {
  it("backs off exponentially, capped at 10 s", () => {
    const { client, sockets } = build();
    client.connect();
    sockets[0]!.open();

    // With random() = 0.5 the jitter factor is exactly 1, so the delays are
    // the bare 500 × 2^n sequence. The sockets are never opened after the
    // first drop: an attempt that fails to connect is what escalates.
    const expected = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];
    for (let attempt = 0; attempt < expected.length; attempt++) {
      sockets[attempt]!.drop();
      expect(client.getState()).toBe("reconnecting");

      vi.advanceTimersByTime(expected[attempt]! - 1);
      expect(sockets).toHaveLength(attempt + 1);

      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(attempt + 2);
    }
  });

  it("keeps the jitter inside ±20 %", () => {
    for (const draw of [0, 1]) {
      const { client, sockets } = build({ random: () => draw });
      client.connect();
      sockets[0]!.open();
      sockets[0]!.drop();

      vi.advanceTimersByTime(500 * (draw === 0 ? 0.8 : 1.2) - 1);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
    }
  });

  it("resets the backoff after a successful connection", () => {
    const { client, sockets } = build();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.drop();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    sockets[1]!.drop();

    // Back to the first step rather than continuing to 1000 ms.
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(3);
  });

  it("reports how long it has been offline", () => {
    const { client, sockets } = build();
    client.connect();
    sockets[0]!.open();
    expect(client.offlineForMs()).toBeNull();

    sockets[0]!.drop();
    vi.advanceTimersByTime(2000);
    expect(client.offlineForMs()).toBeGreaterThanOrEqual(2000);
  });

  it("does not reconnect after an explicit close", () => {
    const { client, sockets } = build();
    client.connect();
    sockets[0]!.open();
    client.close();

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.getState()).toBe("closed");
  });
});

describe("outbound budget", () => {
  it("sends up to the burst immediately, then paces the rest", () => {
    const { client, sockets } = build({ now: () => vi.getMockedSystemTime()?.getTime() ?? 0 });
    client.connect();
    const socket = sockets[0]!;
    socket.open();

    for (let i = 0; i < 12; i++) {
      client.send({ t: "trigger", d: { kind: "pad", intensity: i / 12 } });
    }

    // Eight tokens are available at once; the rest waits for refill.
    expect(socket.payloads("trigger")).toHaveLength(8);
    expect(client.pending()).toBe(4);

    vi.advanceTimersByTime(1000);
    expect(socket.payloads("trigger")).toHaveLength(12);
    expect(client.pending()).toBe(0);
  });

  it("coalesces by key so a dragged slider sends only its latest value", () => {
    const { client, sockets } = build({ now: () => vi.getMockedSystemTime()?.getTime() ?? 0 });
    client.connect();
    const socket = sockets[0]!;
    socket.open();

    // Exhaust the burst on something else, so the slider has to queue.
    for (let i = 0; i < 8; i++) client.send({ t: "trigger", d: { kind: "pad", intensity: 1 } });

    for (const value of [0.1, 0.2, 0.3, 0.9]) {
      client.send({ t: "param.set", d: { key: "cutoff", value, target: "all" } }, "param:cutoff:all");
    }
    expect(client.pending()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(socket.payloads("param.set")).toEqual([
      { key: "cutoff", value: 0.9, target: "all" },
    ]);
  });

  it("drops the oldest queued message rather than growing without bound", () => {
    const { client, sockets } = build({ now: () => 0 });
    client.connect();
    sockets[0]!.open();

    for (let i = 0; i < 100; i++) {
      client.send({ t: "trigger", d: { kind: "pad", intensity: 1 } });
    }
    expect(client.pending()).toBeLessThanOrEqual(32);
  });
});

describe("inbound frames", () => {
  it("hands decoded messages to the application", () => {
    const { client, sockets, messages } = build();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver("group.assigned", { groupId: 2, label: "MID", reason: "balanced" });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("group.assigned");
  });

  it("drops an unreadable frame instead of applying it half-way", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, sockets, messages } = build();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.onmessage?.({ data: "{not json" });

    expect(messages).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(client.getState()).toBe("open");
    warn.mockRestore();
  });

  it("gives up on an error that retrying cannot fix", () => {
    const onFatal = vi.fn();
    const { client, sockets, messages } = build({ onFatal });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver("error", {
      code: "unauthorized",
      message: "bad token",
      retryable: false,
    });

    expect(onFatal).toHaveBeenCalledWith("unauthorized", "bad token");
    expect(messages).toHaveLength(0);
    expect(client.getState()).toBe("closed");

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("stops on a protocol version it cannot read", () => {
    const onFatal = vi.fn();
    const { client, sockets } = build({ onFatal });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ v: 2, t: "welcome", d: {} }) });

    expect(onFatal).toHaveBeenCalledWith("protocol_version", expect.stringContaining("version 2"));
  });

  it("keeps a per-command role refusal alive: it is not fatal", () => {
    const onFatal = vi.fn();
    const { client, sockets, messages } = build({ onFatal });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver("error", {
      code: "forbidden_role",
      message: "musicians do not drive the transport",
      retryable: false,
    });

    expect(onFatal).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(client.getState()).toBe("open");
  });
});

describe("endpoints", () => {
  it("puts the role in the URL, never in a flag", () => {
    expect(maestroUrl("ws://host:8080", "s1", "tok/en+")).toBe(
      "ws://host:8080/ws/v1/maestro?session=s1&token=tok%2Fen%2B",
    );
    expect(performUrl("ws://host:8080", "s1", "Zoé")).toBe(
      "ws://host:8080/ws/v1/perform?session=s1&name=Zo%C3%A9",
    );
    expect(performUrl("ws://host:8080", "s1", "")).toBe(
      "ws://host:8080/ws/v1/perform?session=s1",
    );
  });
});
