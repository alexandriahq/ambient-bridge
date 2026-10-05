import { toast, type ExternalToast } from "svelte-sonner";
import ActionToast from "./action-toast.svelte";
import type { AmbientToastAction, AmbientToastVariant } from "./types.js";
export { default as AmbientToaster } from "./ambient-toaster.svelte";
export { default as AmbientUpdateCard } from "./update-card.svelte";
export { default as AmbientUpdateProgress } from "./update-progress.svelte";
export { toast as ambientToast } from "svelte-sonner";
export type { AmbientToastAction, AmbientToastVariant } from "./types.js";
export {
  createUpdateNotificationsController,
  type AmbientUpdateControllerApi,
  type AmbientUpdateControllerConfig,
  type AmbientUpdateControllerStatus,
  type AmbientUpdateControllerUi,
} from "./update-controller.js";

export type AmbientUpdateToastStatus = {
  readonly backgroundCheck?: boolean;
  readonly channel: string;
  readonly checking: boolean;
  readonly currentVersion: string;
  readonly downloaded: boolean;
  readonly downloading: boolean;
  readonly enabled: boolean;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly updateError?: string;
  readonly downloadPercent?: number | null;
  /** Renderer-local: the user started install/restart and the process is still here. */
  readonly installing?: boolean;
};

export type AmbientUpdateProgressView = {
  readonly percent: number | null;
  readonly label: string;
};

export type AmbientUpdateToastActions = {
  readonly install?: () => void | Promise<void>;
  readonly retry?: () => void | Promise<void>;
  readonly remindLater?: () => void | Promise<void>;
  readonly viewReleaseNotes?: () => void | Promise<void>;
};

export type AmbientPermissionToastStatus = {
  readonly missingCount: number;
  readonly deniedCount?: number;
  readonly replacedAppSuspected?: boolean;
  readonly summary?: string | null;
};

export type AmbientPermissionToastActions = {
  readonly review?: () => void | Promise<void>;
  readonly retry?: () => void | Promise<void>;
  readonly openDiagnostics?: () => void | Promise<void>;
};

export type AmbientActionToastInput = {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly detail?: string | null;
  readonly variant?: AmbientToastVariant;
  readonly actions?: readonly AmbientToastAction[];
  readonly durationMs?: number;
  readonly important?: boolean;
  readonly progress?: AmbientUpdateProgressView | null;
};

export function showAmbientActionToast(input: AmbientActionToastInput): string | number {
  return toast.custom(ActionToast, toastOptions(input));
}

// Update content is presentation-agnostic. The App renders it in the docked
// sidebar card while retaining the same action and progress contracts.
export function ambientUpdateToastContent(
  status: AmbientUpdateToastStatus,
  actions: AmbientUpdateToastActions = {},
  options: { readonly id?: string; readonly productName?: string; readonly stableLabel?: string } = {},
): AmbientActionToastInput | null {
  if (!status.enabled && !status.updateError) return null;
  const productName = options.productName ?? "Ambient";
  const stableLabel = options.stableLabel ?? status.channel;
  const version = status.latestVersion && status.latestVersion !== status.currentVersion
    ? status.latestVersion
    : null;
  const id = options.id ?? `ambient-update:${productName}:${status.channel}:${version ?? status.currentVersion}`;

  if (status.updateError) {
    return {
      id,
      title: `${productName} update check failed`,
      description: "You can keep using the app, or retry before continuing setup.",
      detail: boundedDetail(status.updateError),
      variant: "error",
      durationMs: 16_000,
      actions: compactActions([
        actions.retry ? { label: "Retry", tone: "primary", onClick: actions.retry } : null,
        actions.remindLater ? { label: "Dismiss", tone: "ghost", onClick: actions.remindLater } : null,
      ]),
    };
  }

  if (status.installing) {
    return {
      id,
      title: `Installing ${productName}…`,
      description: version
        ? `Version ${version} is being installed.`
        : `The ${stableLabel} channel update is being installed.`,
      detail: "Ambient will restart to finish the update.",
      variant: "loading",
      durationMs: 60_000,
      important: true,
      progress: ambientUpdateProgress(status),
    };
  }

  if (status.downloaded) {
    return {
      id,
      title: `${productName} update ready`,
      description: version
        ? `Version ${version} has downloaded from the ${stableLabel} channel.`
        : `A ${stableLabel} channel update has downloaded.`,
      detail: "Restart to install it now, or continue working and install later.",
      variant: "success",
      durationMs: 60_000,
      important: true,
      actions: compactActions([
        actions.install ? { label: "Install & restart", tone: "primary", onClick: actions.install } : null,
        actions.viewReleaseNotes ? { label: "Release notes", tone: "secondary", onClick: actions.viewReleaseNotes } : null,
        actions.remindLater ? { label: "Remind later", tone: "ghost", onClick: actions.remindLater } : null,
      ]),
    };
  }

  if (status.downloading || status.checking) {
    const progress = ambientUpdateProgress(status);
    return {
      id,
      title: status.downloading ? `Downloading ${productName}…` : `Checking ${productName} updates`,
      description: status.downloading
        ? (version ? `Version ${version}` : "Downloading the update in the background.")
        : `Looking for a newer ${stableLabel} channel build.`,
      variant: "loading",
      durationMs: status.downloading ? 60_000 : 8_000,
      important: status.downloading,
      progress,
      actions: compactActions([
        actions.viewReleaseNotes ? { label: "Release notes", tone: "ghost", onClick: actions.viewReleaseNotes } : null,
      ]),
    };
  }

  if (status.updateAvailable) {
    return {
      id,
      title: `New ${productName} update available`,
      description: version
        ? `Version ${version} is available on the ${stableLabel} channel.`
        : `A newer ${stableLabel} channel build is available.`,
      detail: "Ambient will download it in the background when possible.",
      variant: "info",
      durationMs: 30_000,
      important: true,
      actions: compactActions([
        actions.retry ? { label: "Check again", tone: "primary", onClick: actions.retry } : null,
        actions.viewReleaseNotes ? { label: "Release notes", tone: "secondary", onClick: actions.viewReleaseNotes } : null,
        actions.remindLater ? { label: "Remind later", tone: "ghost", onClick: actions.remindLater } : null,
      ]),
    };
  }

  return null;
}

export function showAmbientPermissionRecoveryToast(
  status: AmbientPermissionToastStatus,
  actions: AmbientPermissionToastActions = {},
  options: { readonly id?: string; readonly productName?: string } = {},
): string | number | null {
  if (status.missingCount <= 0 && !status.replacedAppSuspected) return null;
  const productName = options.productName ?? "Ambient";
  const title = status.replacedAppSuspected
    ? `${productName} permissions may point at an older app`
    : `${productName} needs system access`;
  const description = status.summary
    ?? (status.missingCount === 1
      ? "One required permission is missing before capture can start."
      : `${status.missingCount} required permissions are missing before capture can start.`);
  const detail = status.deniedCount && status.deniedCount > 0
    ? "Denied macOS permissions may need reset or a fresh grant after replacing the app."
    : "Review permissions and retry when System Settings shows Ambient enabled.";

  return showAmbientActionToast({
    id: options.id ?? `ambient-permissions:${status.missingCount}:${status.deniedCount ?? 0}:${status.replacedAppSuspected === true}`,
    title,
    description,
    detail,
    variant: status.replacedAppSuspected || (status.deniedCount ?? 0) > 0 ? "warning" : "info",
    durationMs: 20_000,
    important: true,
    actions: compactActions([
      actions.review ? { label: "Review permissions", tone: "primary", onClick: actions.review } : null,
      actions.retry ? { label: "Re-check", tone: "secondary", onClick: actions.retry } : null,
      actions.openDiagnostics ? { label: "Diagnostics", tone: "ghost", onClick: actions.openDiagnostics } : null,
    ]),
  });
}

function toastOptions(input: AmbientActionToastInput): ExternalToast<typeof ActionToast> {
  return {
    id: input.id,
    componentProps: {
      title: input.title,
      description: input.description ?? null,
      detail: input.detail ?? null,
      variant: input.variant ?? "info",
      actions: input.actions ?? [],
      progress: input.progress ?? null,
    },
    duration: input.durationMs ?? 10_000,
    important: input.important ?? false,
    unstyled: true,
  } satisfies ExternalToast<typeof ActionToast>;
}

export function ambientUpdateProgress(
  status: Pick<
    AmbientUpdateToastStatus,
    "checking" | "downloaded" | "downloadPercent" | "downloading" | "installing"
  >,
): AmbientUpdateProgressView | null {
  if (status.installing) {
    return { percent: null, label: "Installing…" };
  }
  if (status.downloaded) {
    return { percent: 100, label: "Ready to install" };
  }
  if (status.downloading) {
    const percent = roundedDownloadPercent(status.downloadPercent);
    return {
      percent,
      label: percent === null ? "Downloading…" : `Downloading… ${percent}%`,
    };
  }
  if (status.checking) {
    return { percent: null, label: "Checking for updates…" };
  }
  return null;
}

function compactActions(
  actions: readonly (AmbientToastAction | null | undefined)[],
): readonly AmbientToastAction[] {
  return actions.filter((action): action is AmbientToastAction => Boolean(action));
}

function roundedDownloadPercent(percent: number | null | undefined): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.round(Math.max(0, Math.min(100, percent)));
}

function boundedDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 220) return trimmed;
  return `${trimmed.slice(0, 217)}…`;
}
