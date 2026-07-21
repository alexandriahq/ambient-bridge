import { contextBridge, ipcRenderer } from "electron";
import type {
  BridgeCopyWirePayloadResult,
  BridgeWireCaptureResult,
} from "./bridge-ui-contract.js";

type BridgeUiApi = {
  checkForUpdates(): Promise<unknown>;
  checkForStableUpdates(): Promise<unknown>;
  copyWirePayload(requestId: string): Promise<BridgeCopyWirePayloadResult>;
  getStatus(): Promise<unknown>;
  getUpdateStatus(): Promise<unknown>;
  getWireCapture(requestId: string): Promise<BridgeWireCaptureResult>;
  installUpdate(): Promise<unknown>;
  retryReachability(): Promise<unknown>;
  viewUpdateReleaseNotes(): Promise<unknown>;
  listExperimentalBuilds(): Promise<unknown>;
  installExperimentalBuild(version: string): Promise<unknown>;
  onStatusChanged(callback: () => void): () => void;
  onUpdateStatusChanged(callback: (status: unknown) => void): () => void;
  completePairing(requestId: string, approved: boolean): Promise<unknown>;
  revokeClient(clientId: string): Promise<unknown>;
  signOut(): Promise<unknown>;
  startLogin(): Promise<unknown>;
  switchOrganization(organizationId: string): Promise<unknown>;
};

const api: BridgeUiApi = {
  checkForUpdates: () => ipcRenderer.invoke("bridge:check-for-updates"),
  checkForStableUpdates: () => ipcRenderer.invoke("bridge:check-stable-updates"),
  copyWirePayload: (requestId) => ipcRenderer.invoke("bridge:copy-wire-payload", requestId),
  getStatus: () => ipcRenderer.invoke("bridge:get-status"),
  getUpdateStatus: () => ipcRenderer.invoke("bridge:get-update-status"),
  getWireCapture: (requestId) => ipcRenderer.invoke("bridge:get-wire-capture", requestId),
  installUpdate: () => ipcRenderer.invoke("bridge:install-update"),
  retryReachability: () => ipcRenderer.invoke("bridge:retry-reachability"),
  viewUpdateReleaseNotes: () => ipcRenderer.invoke("bridge:view-update-release-notes"),
  listExperimentalBuilds: () => ipcRenderer.invoke("bridge:experimental-builds"),
  installExperimentalBuild: (version) => ipcRenderer.invoke("bridge:install-experimental", version),
  onStatusChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("bridge:status-changed", listener);
    return () => ipcRenderer.off("bridge:status-changed", listener);
  },
  onUpdateStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("bridge:update-status-changed", listener);
    return () => ipcRenderer.off("bridge:update-status-changed", listener);
  },
  completePairing: (requestId, approved) => ipcRenderer.invoke("bridge:complete-pairing", requestId, approved),
  revokeClient: (clientId) => ipcRenderer.invoke("bridge:revoke-client", clientId),
  signOut: () => ipcRenderer.invoke("bridge:sign-out"),
  startLogin: () => ipcRenderer.invoke("bridge:start-login"),
  switchOrganization: (organizationId) => ipcRenderer.invoke("bridge:switch-organization", organizationId),
};

contextBridge.exposeInMainWorld("ambientBridge", api);
