import { sanitizeFeatureFlagSlugs } from "@ambient/shared/feature-flags";
import {
  parseUsageApiError,
  parseUsageBillingSetupIntent,
  parseUsageBillingState,
  parseUsageModelBreakdown,
  parseUsagePricingCatalog,
  parseUsageReservationResponse,
  parseUsageSummary,
  parseUsageTopupCheckoutResponse,
  usageTopupCheckoutRequestSchema,
  type UsageTopupCheckoutRequest,
  parseUsageTopupOptions,
  type UsageApiErrorBody,
  type UsageBillingMode,
  type UsageBillingSetupIntent,
  type UsageBillingState,
  type UsageSpendingLimit,
  type UsageErrorCode,
  type UsageModelBreakdown,
  type UsagePricingCatalog,
  type UsageReservationRequest,
  type UsageReservationResponse,
  type UsageSummary,
  type UsageTopupCheckoutResponse,
  type UsageTopupOptions,
} from "@ambient/shared/usage";
import {
  parseInferenceModelAssignment,
  type InferenceModelAssignment,
} from "@ambient/shared/inference-models";
import {
  accountPlansResponseSchema,
  planCheckoutRequestSchema,
  planCheckoutResponseSchema,
  planPortalResponseSchema,
  type AccountPlansResponse,
  type PlanCheckoutResponse,
  type PlanPortalResponse,
} from "@alexandria/cloud-contract/plans";
import {
  parseAppAnnouncementsDocument,
  type AppAnnouncementsDocument,
} from "@ambient/shared/announcements";
import { workOsSessionExpiresAtSeconds } from "../workos/session.js";

export type AuthBrokerUser = {
  id: string;
  email: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
};

export type AuthBrokerSessionResponse = {
  sessionToken: string;
  user: AuthBrokerUser;
  /** JWT `exp`: Unix seconds. */
  expiresAt: number;
  organizationId: string | null;
  featureFlags: string[];
};

export type AuthOrganization = {
  id: string;
  name: string;
};

export type AuthOrganizationFeatureFlags = {
  organizationId: string;
  featureFlags: string[];
};

export type AuthOrganizationsResponse = {
  organizations: AuthOrganization[];
  featureFlagsByOrganization: AuthOrganizationFeatureFlags[];
  organizationId: string | null;
  // Present when validating the session rotated the WorkOS refresh token; the
  // caller must persist this session or the stored one becomes unrefreshable.
  session: AuthBrokerSessionResponse | null;
};

export type DelegatedIntegrationTokenResponse = {
  token: string;
  expiresAt: number;
  scope: "integrations";
  serverBaseUrl: string;
  // Present when validating the session rotated the WorkOS refresh token; the
  // caller must persist this session or the stored one becomes unrefreshable.
  session: AuthBrokerSessionResponse | null;
};

type ServerDelegatedIntegrationTokenResponse = Omit<DelegatedIntegrationTokenResponse, "serverBaseUrl">;

export type InferencePlanFetchResult =
  | { readonly kind: "not_modified" }
  | { readonly kind: "not_found" }
  | { readonly kind: "ok"; readonly etag: string | null; readonly body: unknown };

export type AuthServerClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export type AuthServerHealthOptions = {
  timeoutMs?: number;
};

export type AuthServerHealthResult = {
  readonly reachable: boolean;
  readonly reason: "ok" | "offline" | "dns_failure" | "timeout" | "server_error" | "network_error";
  readonly message: string;
  readonly httpStatus?: number | null;
};

export class AuthServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage?: string,
  ) {
    super(typeof serverMessage === "string" ? `Server request failed: ${serverMessage}` : `Server request failed: ${status}`);
    this.name = "AuthServerRequestError";
  }
}

export class AuthServerUsageError extends Error {
  constructor(
    readonly status: number,
    readonly code: UsageErrorCode,
    readonly serverMessage: string,
    readonly summary?: UsageSummary,
  ) {
    super(`Usage request failed: ${serverMessage}`);
    this.name = "AuthServerUsageError";
  }
}

/** A `/v1/plans*` refusal: `{ error: { code, message } }` (ADR-0324). */
export class AuthServerPlansError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serverMessage: string,
  ) {
    super(serverMessage);
    this.name = "AuthServerPlansError";
  }
}

export class AuthServerTimeoutError extends Error {
  readonly _tag = "AuthServerTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Ambient auth server request timed out after ${timeoutMs} ms.`);
    this.name = "AuthServerTimeoutError";
  }
}

export type BridgeAuthCallback =
  | { kind: "success"; ticket: string; clientState: string }
  | { kind: "error"; error: string; errorDescription?: string; clientState: string };

export const BRIDGE_RETURN_URI = "ambient-bridge://auth/callback";

export class AuthServerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: AuthServerClientOptions) {
    this.baseUrl = normalizeAuthServerBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  createLoginUrl(clientState: string, returnUri = BRIDGE_RETURN_URI, organizationId?: string): string {
    return createAuthLoginUrl({
      baseUrl: this.baseUrl,
      clientState,
      returnUri,
      organizationId,
    });
  }

  redeemTicket(ticket: string): Promise<AuthBrokerSessionResponse> {
    return this.postJson("/auth/redeem", { ticket }, parseSessionResponse);
  }

  validateSession(
    sessionToken: string,
    options: { readonly forceRefresh?: boolean; readonly organizationId?: string } = {},
  ): Promise<AuthBrokerSessionResponse> {
    return this.postJson("/auth/session", {
      ...(options.forceRefresh ? { forceRefresh: true } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      sessionToken,
    }, parseSessionResponse);
  }

  switchOrganization(sessionToken: string, organizationId: string): Promise<AuthBrokerSessionResponse> {
    return this.validateSession(sessionToken, { organizationId });
  }

  listOrganizations(
    sessionToken: string,
    options: { readonly includeFeatureFlags?: boolean } = {},
  ): Promise<AuthOrganizationsResponse> {
    return this.postJson(
      "/auth/organizations",
      {
        ...(options.includeFeatureFlags ? { includeFeatureFlags: true } : {}),
        sessionToken,
      },
      parseOrganizationsResponse,
    );
  }

  async createIntegrationToken(sessionToken: string): Promise<DelegatedIntegrationTokenResponse> {
    const delegated = await this.postJson(
      "/auth/delegate",
      { scope: "integrations", sessionToken },
      parseDelegatedIntegrationTokenResponse,
    );
    return { ...delegated, serverBaseUrl: this.baseUrl };
  }

  usageSummary(sessionToken: string): Promise<UsageSummary> {
    return this.usageJson("/usage/summary", sessionToken, { method: "GET" }, parseUsageSummary);
  }

  usagePricing(sessionToken: string): Promise<UsagePricingCatalog> {
    return this.usageJson("/usage/pricing", sessionToken, { method: "GET" }, parseUsagePricingCatalog);
  }

  usageModelBreakdown(sessionToken: string): Promise<UsageModelBreakdown> {
    return this.usageJson("/usage/breakdown", sessionToken, { method: "GET" }, parseUsageModelBreakdown);
  }

  inferenceModels(sessionToken: string): Promise<InferenceModelAssignment> {
    return this.sessionJson("/inference/models", sessionToken, parseInferenceModelAssignment);
  }

  /**
   * `GET /v1/org-policy` with If-None-Match (ADR-0295). The body is validated
   * by the Bridge org policy cache, which also owns the organization check.
   */
  async orgPolicy(
    sessionToken: string,
    etag: string | null,
  ): Promise<{ readonly kind: "not_modified" } | { readonly kind: "ok"; readonly etag: string | null; readonly body: unknown }> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/v1/org-policy", this.baseUrl), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionToken}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        method: "GET",
        signal: timeoutSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted || isAbortError(error) || isTimeoutError(error)) {
        throw new AuthServerTimeoutError(this.requestTimeoutMs);
      }
      throw error;
    }
    if (response.status === 304) return { kind: "not_modified" };
    let body: unknown = {};
    try {
      body = await response.json();
    } catch (error) {
      if (timeoutSignal.aborted || isTimeoutError(error)) throw new AuthServerTimeoutError(this.requestTimeoutMs);
    }
    if (!response.ok) throw authRequestError(response.status, body);
    return { kind: "ok", etag: response.headers.get("etag"), body };
  }

  /**
   * `GET /v1/inference/plan` with If-None-Match (ADR-0297). Clouds released
   * before the plan answer 404 (`not_found`); the body is validated by the
   * Bridge plan cache.
   */
  async inferencePlan(sessionToken: string, etag: string | null): Promise<InferencePlanFetchResult> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/v1/inference/plan", this.baseUrl), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionToken}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        method: "GET",
        signal: timeoutSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted || isAbortError(error) || isTimeoutError(error)) {
        throw new AuthServerTimeoutError(this.requestTimeoutMs);
      }
      throw error;
    }
    if (response.status === 304) return { kind: "not_modified" };
    if (response.status === 404) return { kind: "not_found" };
    let body: unknown = {};
    try {
      body = await response.json();
    } catch (error) {
      if (timeoutSignal.aborted || isTimeoutError(error)) throw new AuthServerTimeoutError(this.requestTimeoutMs);
    }
    if (!response.ok) throw authRequestError(response.status, body);
    return { kind: "ok", etag: response.headers.get("etag"), body };
  }

  announcements(options: { readonly organizationId?: string | null } = {}): Promise<AppAnnouncementsDocument> {
    const organizationId = options.organizationId?.trim();
    const path = organizationId
      ? `/announcements?organizationId=${encodeURIComponent(organizationId)}`
      : "/announcements";
    return this.publicJson(path, parseAppAnnouncementsDocument);
  }

  usageTopupOptions(sessionToken: string, customAmounts = false): Promise<UsageTopupOptions> {
    return this.usageJson(customAmounts ? "/usage/topups?customAmounts=true" : "/usage/topups", sessionToken, { method: "GET" }, parseUsageTopupOptions);
  }

  createUsageTopupCheckout(sessionToken: string, input: string | UsageTopupCheckoutRequest): Promise<UsageTopupCheckoutResponse> {
    return this.usageJson(
      "/usage/topups/checkout",
      sessionToken,
      { method: "POST", body: JSON.stringify(usageTopupCheckoutRequestSchema.parse(typeof input === "string" ? { packageId: input } : input)) },
      parseUsageTopupCheckoutResponse,
    );
  }

  /** `GET /v1/plans` (ADR-0324). Unknown fields are dropped, so a newer Cloud still parses. */
  accountPlans(sessionToken: string): Promise<AccountPlansResponse> {
    return this.plansJson("/v1/plans", sessionToken, { method: "GET" }, (value) => accountPlansResponseSchema.parse(value));
  }

  /** `POST /v1/plans/checkout`: a Stripe Checkout URL for a subscription. */
  async createPlanCheckout(sessionToken: string, planId: string): Promise<PlanCheckoutResponse> {
    return this.plansJson(
      "/v1/plans/checkout",
      sessionToken,
      { method: "POST", body: JSON.stringify(planCheckoutRequestSchema.parse({ planId })) },
      (value) => planCheckoutResponseSchema.parse(value),
    );
  }

  /** `POST /v1/plans/portal`: the Stripe customer portal (change plan, cancel, card, invoices). */
  createPlanPortal(sessionToken: string): Promise<PlanPortalResponse> {
    return this.plansJson("/v1/plans/portal", sessionToken, { method: "POST", body: "{}" }, (value) => planPortalResponseSchema.parse(value));
  }

  usageBillingState(sessionToken: string): Promise<UsageBillingState> {
    return this.usageJson("/usage/billing", sessionToken, { method: "GET" }, parseUsageBillingState);
  }

  createUsageBillingSetupIntent(sessionToken: string): Promise<UsageBillingSetupIntent> {
    return this.usageJson("/usage/billing/setup-intent", sessionToken, { method: "POST", body: "{}" }, parseUsageBillingSetupIntent);
  }

  attachUsageBillingPaymentMethod(sessionToken: string, setupIntentId: string): Promise<UsageBillingState> {
    return this.usageJson(
      "/usage/billing/payment-method",
      sessionToken,
      { method: "PUT", body: JSON.stringify({ setupIntentId }) },
      parseUsageBillingState,
    );
  }

  removeUsageBillingPaymentMethod(sessionToken: string): Promise<UsageBillingState> {
    return this.usageJson("/usage/billing/payment-method", sessionToken, { method: "DELETE" }, parseUsageBillingState);
  }

  setUsageSpendingLimit(sessionToken: string, limit: UsageSpendingLimit | null): Promise<UsageBillingState> {
    return this.usageJson(
      "/usage/billing/spending-limit",
      sessionToken,
      { method: "PUT", body: JSON.stringify({ limit }) },
      parseUsageBillingState,
    );
  }

  setUsageBillingMode(sessionToken: string, mode: UsageBillingMode): Promise<UsageBillingState> {
    return this.usageJson(
      "/usage/billing/mode",
      sessionToken,
      { method: "PUT", body: JSON.stringify({ mode }) },
      parseUsageBillingState,
    );
  }

  reserveUsage(sessionToken: string, request: UsageReservationRequest): Promise<UsageReservationResponse> {
    return this.usageJson(
      "/usage/reservations",
      sessionToken,
      { method: "POST", body: JSON.stringify(request) },
      parseUsageReservationResponse,
    );
  }

  releaseUsage(sessionToken: string, reservationId: string): Promise<UsageSummary> {
    if (!/^crr_[A-Za-z0-9_-]{8,160}$/.test(reservationId)) {
      return Promise.reject(new Error("Inference reservation identity is invalid."));
    }
    return this.usageJson(
      `/usage/reservations/${encodeURIComponent(reservationId)}`,
      sessionToken,
      { method: "DELETE" },
      parseUsageSummary,
    );
  }

  async checkHealth(options: AuthServerHealthOptions = {}): Promise<boolean> {
    return (await this.checkHealthDetailed(options)).reachable;
  }

  async checkHealthDetailed(options: AuthServerHealthOptions = {}): Promise<AuthServerHealthResult> {
    const timeoutMs = options.timeoutMs ?? 2_500;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(new URL("/healthz", this.baseUrl), {
        headers: { Accept: "application/json" },
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok) {
        return {
          httpStatus: response.status,
          message: "Ambient server is reachable.",
          reachable: true,
          reason: "ok",
        };
      }
      return {
        httpStatus: response.status,
        message: `Ambient server health check returned HTTP ${response.status}.`,
        reachable: false,
        reason: "server_error",
      };
    } catch (error) {
      return healthResultFromError(error);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async createLogoutUrl(sessionToken: string): Promise<string> {
    const body = await this.postJson("/auth/logout", { sessionToken }, asRecord);
    const logoutUrl = body.logoutUrl;
    if (typeof logoutUrl !== "string") {
      throw new Error("Server logout response was incomplete.");
    }
    return logoutUrl;
  }

  private postJson<T>(
    path: string,
    body: Record<string, unknown>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    return this.requestJson(path, () => ({
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }), parse);
  }

  private publicJson<T>(path: string, parse: (value: unknown) => T): Promise<T> {
    return this.requestJson(path, () => ({
      headers: { Accept: "application/json" },
      method: "GET",
    }), parse);
  }

  private sessionJson<T>(
    path: string,
    sessionToken: string,
    parse: (value: unknown) => T,
  ): Promise<T> {
    return this.requestJson(path, () => ({
      headers: { Accept: "application/json", Authorization: `Bearer ${sessionToken}` },
      method: "GET",
    }), parse);
  }

  private usageJson<T>(
    path: string,
    sessionToken: string,
    init: { readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly body?: string },
    parse: (value: unknown) => T,
  ): Promise<T> {
    return this.requestJson(path, () => ({
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method: init.method,
    }), parse, usageRequestError);
  }

  private plansJson<T>(
    path: string,
    sessionToken: string,
    init: { readonly method: "GET" | "POST"; readonly body?: string },
    parse: (value: unknown) => T,
  ): Promise<T> {
    return this.requestJson(path, () => ({
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method: init.method,
    }), parse, plansRequestError);
  }

  private async requestJson<T>(
    path: string,
    init: () => RequestInit,
    parse: (value: unknown) => T,
    requestError: (status: number, body: unknown) => Error = authRequestError,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      // Auth serialization belongs inside this deadline/error boundary.
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init(),
        signal: timeoutSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted || isAbortError(error) || isTimeoutError(error)) {
        throw new AuthServerTimeoutError(this.requestTimeoutMs);
      }
      throw error;
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (error) {
      if (timeoutSignal.aborted || isTimeoutError(error)) {
        throw new AuthServerTimeoutError(this.requestTimeoutMs);
      }
      responseBody = {};
    }
    if (!response.ok) throw requestError(response.status, responseBody);
    return parse(responseBody);
  }
}

function authRequestError(status: number, value: unknown): AuthServerRequestError {
  const message = asRecord(value).error;
  return new AuthServerRequestError(status, typeof message === "string" ? message : undefined);
}

function usageRequestError(status: number, value: unknown): Error {
  const parsed: UsageApiErrorBody | null = parseUsageApiError(value);
  if (parsed) {
    return new AuthServerUsageError(status, parsed.error.code, parsed.error.message, parsed.summary);
  }
  return new AuthServerRequestError(status, "Usage response was unavailable.");
}

function plansRequestError(status: number, value: unknown): Error {
  const error = asRecord(asRecord(value).error);
  if (typeof error.code === "string" && typeof error.message === "string" && error.message.trim()) {
    return new AuthServerPlansError(status, error.code.slice(0, 80), error.message.trim().slice(0, 300));
  }
  return new AuthServerRequestError(status, status === 404 ? "Plans are not available on this server." : "Plans could not be loaded.");
}

export function createAuthLoginUrl(input: {
  baseUrl: string;
  returnUri: string;
  clientState: string;
  organizationId?: string;
}): string {
  const url = new URL("/auth/login", normalizeAuthServerBaseUrl(input.baseUrl));
  url.searchParams.set("return_uri", input.returnUri);
  url.searchParams.set("client_state", input.clientState);
  if (input.organizationId) {
    url.searchParams.set("organization_id", input.organizationId);
  }
  return url.toString();
}

export function normalizeAuthServerBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function healthResultFromError(error: unknown): AuthServerHealthResult {
  if (isAbortError(error)) {
    return {
      message: "Ambient server health check timed out.",
      reachable: false,
      reason: "timeout",
    };
  }

  const code = errorCode(error);
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENETDOWN") {
    return {
      message: "No internet route is available for Ambient Bridge.",
      reachable: false,
      reason: "offline",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      message: "DNS lookup for the Ambient server failed.",
      reachable: false,
      reason: "dns_failure",
    };
  }
  if (code === "ETIMEDOUT") {
    return {
      message: "Ambient server health check timed out.",
      reachable: false,
      reason: "timeout",
    };
  }

  return {
    message: "Ambient Bridge could not reach the Ambient server.",
    reachable: false,
    reason: "network_error",
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function errorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const record = error as { readonly code?: unknown; readonly cause?: unknown };
  if (typeof record.code === "string" && record.code) return record.code;
  return errorCode(record.cause, depth + 1);
}

export function parseBridgeAuthCallback(rawValue: string, expectedClientState?: string): BridgeAuthCallback {
  const url = new URL(rawValue);
  if (url.protocol !== "ambient-bridge:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new Error("Invalid Bridge auth callback URL.");
  }

  const clientState = url.searchParams.get("client_state") ?? "";
  if (!clientState) {
    throw new Error("Bridge auth callback is missing client state.");
  }
  if (expectedClientState && clientState !== expectedClientState) {
    throw new Error("Bridge auth callback state did not match the pending login.");
  }

  const error = url.searchParams.get("error");
  if (error) {
    return {
      clientState,
      error,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
      kind: "error",
    };
  }

  const ticket = url.searchParams.get("ticket");
  if (!ticket) {
    throw new Error("Bridge auth callback is missing an auth ticket.");
  }
  return { clientState, kind: "success", ticket };
}

function parseSessionResponse(value: unknown): AuthBrokerSessionResponse {
  const body = asRecord(value);
  const sessionToken = body.sessionToken;
  const expiresAt = workOsSessionExpiresAtSeconds(expectNumber(body.expiresAt, "expiresAt"));
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Server response returned an invalid expiresAt.");
  }
  return {
    expiresAt,
    featureFlags: sanitizeFeatureFlagSlugs(body.featureFlags),
    organizationId: expectOptionalNullableString(body.organizationId),
    sessionToken: expectString(sessionToken, "sessionToken"),
    user: parseUser(body.user),
  };
}

function parseDelegatedIntegrationTokenResponse(value: unknown): ServerDelegatedIntegrationTokenResponse {
  const body = asRecord(value);
  const scope = expectString(body.scope, "scope");
  if (scope !== "integrations") {
    throw new Error("Server response returned an unsupported delegated token scope.");
  }
  return {
    expiresAt: expectNumber(body.expiresAt, "expiresAt"),
    scope,
    session: body.session ? parseSessionResponse(body.session) : null,
    token: expectString(body.token, "token"),
  };
}

function parseUser(value: unknown): AuthBrokerUser {
  const body = asRecord(value);
  return {
    email: expectNullableString(body.email, "user.email"),
    id: expectString(body.id, "user.id"),
    name: expectNullableString(body.name, "user.name"),
    firstName: expectOptionalNullableString(body.firstName),
    lastName: expectOptionalNullableString(body.lastName),
    profilePictureUrl: expectOptionalNullableString(body.profilePictureUrl),
  };
}

function parseOrganizationsResponse(value: unknown): AuthOrganizationsResponse {
  const body = asRecord(value);
  const rawList = Array.isArray(body.organizations) ? body.organizations : [];
  const organizations: AuthOrganization[] = [];
  for (const entry of rawList) {
    const organization = asRecord(entry);
    const id = typeof organization.id === "string" && organization.id ? organization.id : null;
    if (!id) continue;
    const name = typeof organization.name === "string" && organization.name ? organization.name : id;
    organizations.push({ id, name });
  }
  return {
    featureFlagsByOrganization: parseFeatureFlagsByOrganization(body.featureFlagsByOrganization),
    organizations,
    organizationId: expectOptionalNullableString(body.organizationId),
    session: body.session ? parseSessionResponse(body.session) : null,
  };
}

function parseFeatureFlagsByOrganization(value: unknown): AuthOrganizationFeatureFlags[] {
  if (!Array.isArray(value)) return [];
  const entries: AuthOrganizationFeatureFlags[] = [];
  for (const item of value) {
    const entry = asRecord(item);
    const organizationId = typeof entry.organizationId === "string" && entry.organizationId
      ? entry.organizationId
      : null;
    if (!organizationId) continue;
    entries.push({
      featureFlags: sanitizeFeatureFlagSlugs(entry.featureFlags),
      organizationId,
    });
  }
  return entries.sort((a, b) => a.organizationId.localeCompare(b.organizationId));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Server response was missing ${field}.`);
  }
  return value;
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Server response was missing ${field}.`);
  }
  return value;
}

function expectOptionalNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Server response was missing ${field}.`);
  }
  return value;
}
