/**
 * The REST surface, as seen from the browser. Everything goes through this
 * app's route handlers, which forward to the Go server — so the browser only
 * ever talks to its own origin for REST.
 */

import type { ProtocolError } from "@/domain/types";

export interface GroupView {
  id: number;
  label: string;
  count: number;
}

export interface CreatedSession {
  sessionId: string;
  joinCode: string;
  maestroToken: string;
  maestroUrl: string;
  joinUrl: string;
  maxUsers: number;
  groups: GroupView[];
}

export interface PublicState {
  sessionId: string;
  joinCode: string;
  state: "playing" | "stopped";
  bpm: number;
  participants: number;
  maxUsers: number;
  groups: GroupView[];
  generation: number;
  serverTimeMs: number;
}

export interface ResolvedCode {
  sessionId: string;
  joinCode: string;
  joinUrl: string;
}

/** A refusal from the server, carrying its protocol code so the UI can say
 * something better than "something went wrong". */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CreateSessionInput {
  maxUsers?: number;
  bpm?: number;
  groupLabels?: string[];
  strategy?: "balanced" | "round_robin" | "manual";
}

export async function createSession(input: CreateSessionInput = {}): Promise<CreatedSession> {
  return request<CreatedSession>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function resolveJoinCode(code: string): Promise<ResolvedCode> {
  return request<ResolvedCode>(`/api/sessions/by-code/${encodeURIComponent(code.toUpperCase())}`);
}

export async function publicState(sessionId: string): Promise<PublicState> {
  return request<PublicState>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError("internal", "le serveur est injoignable", true);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as Partial<ProtocolError> | null;
    throw new ApiError(
      error?.code ?? "internal",
      error?.message ?? `HTTP ${response.status}`,
      error?.retryable ?? response.status >= 500,
    );
  }
  return body as T;
}

/** Human wording for the protocol's error codes, for the landing and entry
 * screens. Anything unmapped falls back to the server's own message. */
export const ERROR_LABEL: Record<string, string> = {
  session_not_found: "session introuvable — vérifiez le code",
  session_full: "la session est pleine",
  unauthorized: "jeton maestro invalide",
  forbidden_role: "action réservée au maestro",
  rate_limited: "trop de requêtes, patientez un instant",
  protocol_version: "client trop ancien — rafraîchissez la page",
  invalid_payload: "requête invalide",
  internal: "le serveur est injoignable",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_LABEL[error.code] ?? error.message;
  return "erreur inattendue";
}
