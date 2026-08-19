/**
 * Server-side half of the REST proxy (§6.1). The browser only ever calls this
 * app's own routes; this is the only place that knows where the Go server is,
 * which also means CORS never comes up for REST.
 */

const DEFAULT_SERVER = "http://localhost:8080";

export function serverBaseUrl(): string {
  return (process.env.MAESTRO_SERVER_URL ?? DEFAULT_SERVER).replace(/\/$/, "");
}

/** Forwards a request and passes the server's answer back untouched — status
 * and error body included, so the client keeps the protocol's error codes. */
export async function forward(path: string, init?: RequestInit): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${serverBaseUrl()}${path}`, {
      ...init,
      // A session's state is live; a cached answer would be worse than none.
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { code: "internal", message: "le serveur Maestro est injoignable", retryable: true },
      { status: 502 },
    );
  }

  const body = await upstream.text();
  return new Response(body || null, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
