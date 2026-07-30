export declare const AMBIENT_UPDATE_DEFAULT_BASE_URL: "https://api.alexandria.so";
export declare const AMBIENT_RELEASE_DEFAULT_CHANNEL: "alpha";
export declare const AMBIENT_RELEASE_EXPERIMENTAL_CHANNEL: "experimental";
export declare const AMBIENT_RELEASE_PLATFORM: "darwin";
export declare const AMBIENT_RELEASE_ARCH: "arm64";
export declare const AMBIENT_WINDOWS_RELEASE_PLATFORM: "win32";
export declare const AMBIENT_WINDOWS_RELEASE_ARCH: "x64";

export interface AmbientProductUpdateStatus {
  readonly channel: string;
  readonly checking: boolean;
  readonly currentVersion: string;
  readonly downloaded: boolean;
  readonly downloading: boolean;
  readonly enabled: boolean;
  readonly feedUrl: string | null;
  readonly latestVersion?: string;
  readonly reason?: string;
  readonly releaseNotesUrl?: string | null;
  readonly downloadPercent?: number | null;
  readonly lastCheckedAtMs?: number;
  readonly lastUpdatedAtMs?: number;
  readonly updateAvailable: boolean;
  readonly updateError?: string;
}

export interface AmbientReleaseArtifactSummary {
  readonly kind: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sha512: string | null;
  readonly downloadUrl: string;
  readonly updateUrl: string;
}

export interface AmbientReleaseBuildSummary {
  readonly id: string | null;
  readonly productSlug: string;
  readonly releaseKey: string;
  readonly version: string;
  readonly channel: string;
  readonly platform: string;
  readonly arch: string;
  readonly appId: string;
  readonly commitSha: string;
  readonly notes: string | null;
  readonly releasedAt: string;
  readonly artifacts: readonly AmbientReleaseArtifactSummary[];
}

export interface AmbientReleaseBuildsSnapshot {
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly releasesUrl: string | null;
  readonly builds: readonly AmbientReleaseBuildSummary[];
}

export declare function productUpdateFeedUrl(input: {
  readonly productSlug: string;
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
  readonly version?: string;
}): string;

export declare function productReleaseListUrl(input: {
  readonly productSlug: string;
  readonly baseUrl: string;
  readonly channel?: string;
  readonly arch?: string;
  readonly platform?: NodeJS.Platform;
}): string;

export declare function updaterUnavailableReason(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly localQaBuild?: boolean;
  readonly channel?: string;
  readonly version?: string;
}): string | null;

export declare function normalizeDownloadPercent(value: unknown): number | null;

export declare function isHttpUrl(value: string): boolean;

export declare function sanitizedDiagnosticUrl(value: string | null): { readonly origin: string; readonly pathname: string } | null;

export declare function boundedDiagnosticMessage(value: string): string;

export declare function sanitizedUpdateDiagnostics(status: AmbientProductUpdateStatus): Record<string, string | number | boolean | null | undefined>;

export declare function parseReleaseListResponse(input: {
  readonly productSlug: string;
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly releasesUrl: string;
  readonly body: unknown;
}): AmbientReleaseBuildsSnapshot;

export declare function localReleaseBuildsSnapshot(input: {
  readonly isPackaged: boolean;
  readonly localBuild?: boolean;
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
}): AmbientReleaseBuildsSnapshot | null;
