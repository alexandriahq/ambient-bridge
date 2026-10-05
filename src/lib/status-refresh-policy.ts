/** Safety poll while the Bridge window is visible; status-changed push is primary. */
export const BRIDGE_STATUS_SAFETY_POLL_MS = 15_000;

export type BridgeStatusRefreshOptions = {
  readonly background?: boolean;
  readonly reachability?: boolean;
};

/** Interval / push refreshes must not flip the initial-load spinner. */
export function statusRefreshSetsLoading(options: BridgeStatusRefreshOptions = {}): boolean {
  return options.background !== true;
}

export function shouldRunBridgeStatusSafetyPoll(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === "visible";
}
