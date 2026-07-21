import {
  ambientToast,
  createUpdateNotificationsController,
  showAmbientUpdateToast,
} from "@ambient/shared/notifications";
import type { BridgeUpdateStatus } from "./bridge-api";

// Thin adapter over the shared update-notifications controller: Ambient App
// and Ambient Bridge share the startup check, periodic re-check, dedupe, and
// remind-later behavior; only the IPC surface and product labels differ here.
export function startBridgeUpdateNotifications(
  onStatus: (status: BridgeUpdateStatus) => void,
): () => void {
  const api = window.ambientBridge;
  if (!api?.getUpdateStatus) return () => {};

  // Channel isolation: the automatic startup/periodic check runs the build's
  // OWN channel (`checkForUpdates`), never the cross-channel stable check.
  // `checkForStableUpdates` targets the default (alpha) feed with
  // allowDowngrade=true, which on an installed experimental build (semver-higher
  // than alpha, since "experimental" > "alpha") would force a silent downgrade
  // onto the older prod build. `checkForUpdates` uses allowDowngrade=false, so
  // electron-updater only offers genuinely-newer releases and refuses
  // downgrades. Returning to the stable release stays an explicit user action.
  const check = api.checkForUpdates ?? api.checkForStableUpdates;
  return createUpdateNotificationsController({
    api: {
      getStatus: () => api.getUpdateStatus(),
      check: check ? () => check.call(api) : undefined,
      install: api.installUpdate ? () => api.installUpdate() : undefined,
      viewReleaseNotes: api.viewUpdateReleaseNotes ? () => api.viewUpdateReleaseNotes() : undefined,
      onStatusChanged: api.onUpdateStatusChanged ? (callback) => api.onUpdateStatusChanged(callback) : undefined,
    },
    ui: {
      showUpdateToast: showAmbientUpdateToast,
      dismissToast: (id) => ambientToast.dismiss(id),
    },
    config: {
      toastId: "ambient-bridge-update",
      productName: "Ambient Bridge",
      reminderStoragePrefix: "ambient-bridge",
      stableLabelForChannel: (channel) => (channel === "alpha" ? "stable" : channel),
      onStatus: (status) => onStatus(status as BridgeUpdateStatus),
    },
  });
}
