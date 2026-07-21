import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import { errorMessage } from "../error-message.js";
import { shouldRefreshWorkOsSession, type SignedInWorkOsSession, type WorkOsSession } from "../workos/session.js";

export const TELEMETRY_ANALYTICS_PATH = "/analytics/telemetry";

export type TelemetryForwardResult = {
  ok: boolean;
  accepted: number;
  dropped: number;
  error: string | null;
};

export type TelemetryForwarderOptions = {
  serverBaseUrl: string;
  audit: AuditSink;
  readSession: () => Promise<WorkOsSession>;
  refreshSession: (session: SignedInWorkOsSession) => Promise<WorkOsSession>;
  onUnauthorized: (reason: string, session: SignedInWorkOsSession) => Promise<boolean>;
  onResponse?: (response: Response) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Forwards sanitized Ambient telemetry to the server. This is metadata-only
 * remote diagnostics, not inference traffic. The payload and bearer token are
 * intentionally absent from audit fields, and failures resolve ok=false so app
 * diagnostics never block product work.
 */
export async function forwardTelemetryBatch(
  requestId: string,
  payload: JsonValue | undefined,
  options: TelemetryForwarderOptions,
): Promise<TelemetryForwardResult> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, accepted: 0, dropped: 0, error: "Telemetry payload must be a JSON object." };
  }

  const session = await signedInSession(options);
  if (!session) {
    options.audit.record("analytics.telemetry_rejected", { reason: "signed_out", requestId });
    return { ok: false, accepted: 0, dropped: 0, error: "Sign in to Ambient Bridge before uploading telemetry." };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(new URL(TELEMETRY_ANALYTICS_PATH, options.serverBaseUrl), {
      body: JSON.stringify(payload),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: timeoutSignal,
    });
    await options.onResponse?.(response);
    let body: Record<string, unknown> | null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      if (timeoutSignal.aborted) {
        throw new Error(`Ambient telemetry request timed out after ${timeoutMs} ms.`);
      }
      body = null;
    }

    if (!response.ok) {
      options.audit.record("analytics.telemetry_failed", { requestId, status: response.status });
      if (response.status === 401) {
        await options.onUnauthorized("analytics telemetry request returned 401", session);
      }
      const serverError = body && typeof body.error === "string" ? body.error : null;
      return {
        ok: false,
        accepted: 0,
        dropped: 0,
        error: safeMessage(serverError ?? `Ambient telemetry request failed with status ${response.status}.`),
      };
    }

    const accepted = boundedCount(body?.accepted);
    const dropped = boundedCount(body?.dropped);
    options.audit.record("analytics.telemetry_complete", { accepted, dropped, requestId, status: response.status });
    return { ok: true, accepted, dropped, error: null };
  } catch (error) {
    const message = safeMessage(errorMessage(error));
    options.audit.record("analytics.telemetry_failed", { message, requestId });
    return { ok: false, accepted: 0, dropped: 0, error: message };
  }
}

async function signedInSession(options: TelemetryForwarderOptions): Promise<SignedInWorkOsSession | null> {
  const session = await options.readSession();
  if (session.kind !== "signed_in") return null;
  if (!shouldRefreshWorkOsSession(session)) return session;
  try {
    const refreshed = await options.refreshSession(session);
    return refreshed.kind === "signed_in" ? refreshed : null;
  } catch {
    return null;
  }
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeMessage(value: string): string {
  return value.slice(0, 220);
}
