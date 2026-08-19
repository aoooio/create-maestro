/**
 * Where the Go server lives.
 *
 * REST goes through this app's own route handlers (`app/api/sessions/…`), so
 * the browser never needs the server's origin and CORS never enters the
 * picture. The WebSocket cannot be proxied that way, so its base URL is the
 * one thing the client has to know.
 */

/** Base URL of the WebSocket endpoints, e.g. `ws://localhost:8080`. */
export function wsBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_MAESTRO_WS_URL;
  if (configured) return configured.replace(/\/$/, "");

  // Development default: the Go server on its usual port, same host as the
  // page — which is also what makes testing from a phone on the venue Wi-Fi
  // work without configuring anything.
  if (typeof window === "undefined") return "ws://localhost:8080";
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.hostname}:8080`;
}

/** Version string sent in `hello`, so server logs can tell builds apart. */
export const CLIENT_VERSION = "maestro-client/0.1.0";
