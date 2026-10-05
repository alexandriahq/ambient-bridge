import type { BridgeUpdateStatus } from "./bridge-api";

// Status watch only. Ambient App owns Bridge install and version
// reconciliation; this renderer must not check a feed or show an update toast.
export function startBridgeUpdateNotifications(
  onStatus: (status: BridgeUpdateStatus) => void,
): () => void {
  const api = window.ambientBridge;
  if (!api?.getUpdateStatus) return () => {};

  let disposed = false;
  const handleStatus = (status: BridgeUpdateStatus): void => {
    if (disposed) return;
    onStatus(status);
  };

  void api.getUpdateStatus().then(handleStatus).catch(() => undefined);
  const unsubscribe = api.onUpdateStatusChanged
    ? api.onUpdateStatusChanged((status) => handleStatus(status as BridgeUpdateStatus))
    : () => {};

  return () => {
    disposed = true;
    unsubscribe();
  };
}
