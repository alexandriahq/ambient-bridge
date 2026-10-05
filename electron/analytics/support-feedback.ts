import type { AuditSink } from "../diagnostics/audit.js";
import type { JsonValue } from "../ipc-server/protocol.js";
import { shouldRefreshWorkOsSession, type SignedInWorkOsSession, type WorkOsSession } from "../workos/session.js";
import { errorMessage } from "../error-message.js";

export const SUPPORT_FEEDBACK_PATH = "/v1/feedback";
export const SUPPORT_FEEDBACK_BRIDGE_METHOD = "support.feedback";

export type SupportFeedbackForwardResult = {
  ok: boolean;
  id: string | null;
  attachments: "none" | "uploaded" | "failed" | null;
  /** Server code (`feedback_not_configured`, `feedback_rate_limited`, …) or a Bridge-side code. */
  code: string | null;
  status: number | null;
  error: string | null;
};

export type SupportFeedbackForwarderOptions = {
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
 * Forwards Help & feedback to Alexandria Cloud `POST /v1/feedback`, which
 * relays it to Slack (ADR-0229). The app has already validated and bounded the
 * payload; Bridge only adds the WorkOS session. Neither the message, the
 * attachments nor the session token reach the audit trail — only status.
 */
export async function forwardSupportFeedback(
  requestId: string,
  payload: JsonValue | undefined,
  options: SupportFeedbackForwarderOptions,
): Promise<SupportFeedbackForwardResult> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failure("invalid_payload", null, "Feedback payload must be a JSON object.");
  }

  const session = await signedInSession(options);
  if (!session) {
    options.audit.record("analytics.support_feedback_rejected", { reason: "signed_out", requestId });
    return failure("signed_out", null, "Sign in to Ambient Bridge before sending feedback.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(new URL(SUPPORT_FEEDBACK_PATH, options.serverBaseUrl), {
      body: JSON.stringify(payload),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
        "Content-Type": "application/json",
        "x-ambient-request-id": requestId,
      },
      method: "POST",
      signal: timeoutSignal,
    });
    await options.onResponse?.(response);
    let body: Record<string, unknown> | null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      if (timeoutSignal.aborted) throw new Error(`Feedback request timed out after ${timeoutMs} ms.`);
      body = null;
    }

    if (!response.ok) {
      const code = body && typeof body.code === "string" ? safeCode(body.code) : null;
      options.audit.record("analytics.support_feedback_failed", { requestId, status: response.status, code });
      if (response.status === 401) {
        await options.onUnauthorized("support feedback request returned 401", session);
      }
      const serverError = body && typeof body.error === "string" ? body.error : null;
      return failure(
        code ?? `http_${response.status}`,
        response.status,
        serverError ?? `Feedback request failed with status ${response.status}.`,
      );
    }

    const attachments = body?.attachments === "uploaded" || body?.attachments === "failed" || body?.attachments === "none"
      ? body.attachments
      : null;
    options.audit.record("analytics.support_feedback_complete", { requestId, status: response.status, attachments });
    return {
      ok: true,
      id: body && typeof body.id === "string" ? body.id : null,
      attachments,
      code: null,
      status: response.status,
      error: null,
    };
  } catch (error) {
    const message = safeMessage(errorMessage(error));
    options.audit.record("analytics.support_feedback_failed", { message, requestId });
    return failure("network_error", null, message);
  }
}

function failure(code: string, status: number | null, error: string): SupportFeedbackForwardResult {
  return { ok: false, id: null, attachments: null, code, status, error: safeMessage(error) };
}

async function signedInSession(options: SupportFeedbackForwarderOptions): Promise<SignedInWorkOsSession | null> {
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

function safeCode(value: string): string | null {
  return /^[a-z0-9_]{1,60}$/.test(value) ? value : null;
}

function safeMessage(value: string): string {
  return value.slice(0, 220);
}
