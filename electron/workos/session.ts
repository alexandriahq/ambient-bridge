export type WorkOsOrganization = {
  id: string;
  name: string;
};

export type WorkOsFeatureFlagsByOrganization = Record<string, readonly string[]>;

export type WorkOsSession =
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      sessionToken: string;
      /** JWT `exp` / server `defaultExpiresAt`: Unix seconds, never milliseconds. */
      expiresAt: number;
      user: {
        id: string;
        email: string | null;
        name: string | null;
        firstName?: string | null;
        lastName?: string | null;
        profilePictureUrl?: string | null;
      };
      email: string;
      organizationId?: string | null;
      organizationName?: string;
      organizations?: WorkOsOrganization[];
      featureFlags?: string[];
      featureFlagsByOrganization?: WorkOsFeatureFlagsByOrganization;
    };

export type SignedInWorkOsSession = Extract<WorkOsSession, { kind: "signed_in" }>;

export const WORKOS_SESSION_REFRESH_SKEW_SECONDS = 5 * 60;

/** Values at or above this look like `Date.now()`, not JWT `exp`. Fold them
 * back to seconds at persist/parse so a millisecond clock never lands on disk. */
const UNIX_MS_EXPIRES_AT_THRESHOLD = 1e12;

export function workOsSessionExpiresAtSeconds(expiresAt: number): number {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return Number.NaN;
  return expiresAt >= UNIX_MS_EXPIRES_AT_THRESHOLD ? Math.floor(expiresAt / 1_000) : expiresAt;
}

export function shouldRefreshWorkOsSession(
  session: SignedInWorkOsSession,
  nowMs = Date.now(),
  skewSeconds = WORKOS_SESSION_REFRESH_SKEW_SECONDS,
): boolean {
  const expiresAt = session.expiresAt;
  return !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt * 1_000 <= nowMs + skewSeconds * 1_000;
}
