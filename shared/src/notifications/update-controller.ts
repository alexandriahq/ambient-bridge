import type { AmbientUpdateToastActions, AmbientUpdateToastStatus } from "./index.js";

// Update-notification lifecycle for Ambient App: startup check, periodic
// re-check, status dedupe, and remind-later handling. Bridge stays stealth and
// does not use this controller.
// The toast layer and the product update API are injected so each renderer
// stays a thin adapter and the behavior is testable without a DOM app shell.

export type AmbientUpdateControllerStatus = AmbientUpdateToastStatus & {
  readonly feedUrl?: string | null;
  readonly releaseNotesUrl?: string | null;
};

export type AmbientUpdateControllerApi = {
  readonly getStatus: () => Promise<AmbientUpdateControllerStatus>;
  readonly check?: () => Promise<AmbientUpdateControllerStatus>;
  readonly retry?: () => Promise<AmbientUpdateControllerStatus>;
  readonly install?: () => Promise<unknown>;
  readonly viewReleaseNotes?: () => Promise<unknown>;
  readonly onStatusChanged?: (
    callback: (status: AmbientUpdateControllerStatus) => void,
  ) => () => void;
};

export type AmbientUpdateControllerUi = {
  readonly showUpdateToast: (
    status: AmbientUpdateToastStatus,
    actions: AmbientUpdateToastActions,
    options: { readonly id: string; readonly productName: string; readonly stableLabel: string },
  ) => unknown;
  readonly dismissToast: (id: string) => void;
};

export type AmbientUpdateControllerConfig = {
  readonly toastId: string;
  readonly productName: string;
  /** localStorage namespace for remind-later keys, e.g. "ambient" or "ambient-bridge". */
  readonly reminderStoragePrefix: string;
  readonly stableLabelForChannel?: (channel: string) => string;
  /** Skip the startup/periodic check (e.g. while onboarding owns updates). */
  readonly shouldSkipCheck?: () => Promise<boolean>;
  /** Disable renderer timers when Electron main owns background checks. */
  readonly scheduleAutomaticChecks?: boolean;
  /** Forwarded on every status change (Bridge mirrors status into its UI). */
  readonly onStatus?: (status: AmbientUpdateControllerStatus) => void;
};

const REMIND_LATER_MS = 4 * 60 * 60 * 1_000;
const STARTUP_CHECK_DELAY_MS = 1_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

export function createUpdateNotificationsController(input: {
  readonly api: AmbientUpdateControllerApi;
  readonly ui: AmbientUpdateControllerUi;
  readonly config: AmbientUpdateControllerConfig;
}): () => void {
  const { api, ui, config } = input;
  let disposed = false;
  let lastSignature: string | null = null;

  const handleStatus = (status: AmbientUpdateControllerStatus): void => {
    if (disposed) return;
    config.onStatus?.(status);
    const signature = updateToastSignature(status);
    if (signature === lastSignature) return;
    lastSignature = signature;
    renderUpdateToast(status);
  };

  const runCheck = async (options: { readonly surfaceErrors: boolean }): Promise<void> => {
    if (await config.shouldSkipCheck?.() === true || disposed || !api.check) return;
    try {
      handleStatus(await api.check());
    } catch (error) {
      if (!options.surfaceErrors) return;
      handleStatus({
        channel: "unknown",
        checking: false,
        currentVersion: "unknown",
        downloaded: false,
        downloading: false,
        enabled: true,
        updateAvailable: false,
        updateError: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const unsubscribe = api.onStatusChanged?.(handleStatus) ?? (() => {});
  void api.getStatus().then(handleStatus).catch(() => undefined);
  const startupCheck = config.scheduleAutomaticChecks === false
    ? null
    : window.setTimeout(() => {
        void runCheck({ surfaceErrors: true });
      }, STARTUP_CHECK_DELAY_MS);
  // Long-running sessions still learn about new releases; failures here stay
  // quiet — the startup check already surfaces actionable errors.
  const periodicCheck = config.scheduleAutomaticChecks === false
    ? null
    : window.setInterval(() => {
        void runCheck({ surfaceErrors: false });
      }, PERIODIC_CHECK_INTERVAL_MS);

  function renderUpdateToast(status: AmbientUpdateControllerStatus): void {
    if (!shouldShowUpdateToast(status) || reminderActive(status)) {
      ui.dismissToast(config.toastId);
      return;
    }

    ui.showUpdateToast(status, {
      install: api.install
        ? async () => {
            await api.install?.();
          }
        : undefined,
      retry: (api.retry ?? api.check)
        ? async () => {
            await (api.retry ?? api.check)?.().then(handleStatus).catch(() => undefined);
          }
        : undefined,
      remindLater: () => {
        rememberLater(status);
      },
      viewReleaseNotes: status.releaseNotesUrl && api.viewReleaseNotes
        ? async () => {
            await api.viewReleaseNotes?.();
          }
        : undefined,
    }, {
      id: config.toastId,
      productName: config.productName,
      stableLabel: config.stableLabelForChannel?.(status.channel) ?? status.channel,
    });
  }

  function reminderActive(status: AmbientUpdateControllerStatus): boolean {
    const key = reminderKey(status);
    if (!key) return false;
    const until = Number(window.localStorage.getItem(key) ?? 0);
    return Number.isFinite(until) && until > Date.now();
  }

  function rememberLater(status: AmbientUpdateControllerStatus): void {
    const key = reminderKey(status);
    if (!key) return;
    window.localStorage.setItem(key, String(Date.now() + REMIND_LATER_MS));
  }

  function reminderKey(status: AmbientUpdateControllerStatus): string | null {
    const version = status.latestVersion ?? status.currentVersion;
    if (!version) return null;
    return `${config.reminderStoragePrefix}:update-reminder:${status.channel}:${version}`;
  }

  return () => {
    disposed = true;
    if (startupCheck !== null) window.clearTimeout(startupCheck);
    if (periodicCheck !== null) window.clearInterval(periodicCheck);
    unsubscribe();
  };
}

function shouldShowUpdateToast(status: AmbientUpdateControllerStatus): boolean {
  if (!status.enabled && !status.updateError) return false;
  return Boolean(
    status.downloaded
    || status.downloading
    || status.installing
    || status.updateAvailable
    || status.updateError,
  );
}

function updateToastSignature(status: AmbientUpdateControllerStatus): string {
  const roundedPercent = typeof status.downloadPercent === "number"
    ? Math.round(status.downloadPercent / 5) * 5
    : "";
  return [
    status.channel,
    status.backgroundCheck === true,
    status.currentVersion,
    status.latestVersion ?? "",
    status.downloaded,
    status.downloading,
    status.installing === true,
    status.updateAvailable,
    status.updateError ?? "",
    roundedPercent,
  ].join("|");
}
