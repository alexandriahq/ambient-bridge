import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import { shouldRefreshWorkOsSession, type SignedInWorkOsSession, type WorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";

export const HANDOFF_FEEDBACK_ANALYTICS_PATH = "/analytics/handoff-feedback";

export type HandoffFeedbackForwardResult = {
  ok: boolean;
  id: string | null;
  error: string | null;
};

export type HandoffFeedbackForwarderOptions = {
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
 * Forwards labeled handoff feedback to the server analytics endpoint as
 * plaintext JSON authenticated with the stored WorkOS session. This is a
 * deliberate non-Tinfoil path: the payload is a labeled dataset upload, not
 * inference traffic. The request body and session token are never logged or
 * audited; failures resolve as { ok: false } so the caller's local handoff
 * decision is never blocked.
 */
export async function forwardHandoffFeedback(
  requestId: string,
  payload: JsonValue | undefined,
  options: HandoffFeedbackForwarderOptions,
): Promise<HandoffFeedbackForwardResult> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, id: null, error: "Handoff feedback payload must be a JSON object." };
  }

  const session = await signedInSession(options);
  if (!session) {
    options.audit.record("analytics.handoff_feedback_rejected", { reason: "signed_out", requestId });
    return { ok: false, id: null, error: "Sign in to Ambient Bridge before uploading handoff feedback." };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(new URL(HANDOFF_FEEDBACK_ANALYTICS_PATH, options.serverBaseUrl), {
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
        throw new Error(`Ambient analytics request timed out after ${timeoutMs} ms.`);
      }
      body = null;
    }

    if (!response.ok) {
      options.audit.record("analytics.handoff_feedback_failed", { requestId, status: response.status });
      if (response.status === 401) {
        await options.onUnauthorized("analytics handoff feedback request returned 401", session);
      }
      const serverError = body && typeof body.error === "string" ? body.error : null;
      return {
        ok: false,
        id: null,
        error: safeMessage(serverError ?? `Ambient analytics request failed with status ${response.status}.`),
      };
    }

    options.audit.record("analytics.handoff_feedback_complete", { requestId, status: response.status });
    return {
      ok: true,
      id: body && typeof body.id === "string" ? body.id : null,
      error: null,
    };
  } catch (error) {
    const message = safeMessage(errorMessage(error));
    options.audit.record("analytics.handoff_feedback_failed", { message, requestId });
    return { ok: false, id: null, error: message };
  }
}

async function signedInSession(options: HandoffFeedbackForwarderOptions): Promise<SignedInWorkOsSession | null> {
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


function safeMessage(value: string): string {
  return value.slice(0, 220);
}
