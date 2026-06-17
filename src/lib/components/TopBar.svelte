<script lang="ts">
  import { Download, ListTree, RefreshCw, SlidersHorizontal } from "@lucide/svelte";
  import { UserCard } from "@ambient/shared";
  import type { BridgeStatus, BridgeUpdateStatus, BridgeView } from "../bridge-api";
  import { connectionLabel } from "../format";

  let {
    status,
    updateStatus,
    view,
    authBusy,
    switchingOrganizationId = null,
    updateBusy,
    onSelectView,
    onSignOut,
    onSwitchOrganization,
    onCheckForUpdates,
    onInstallUpdate,
  }: {
    status: BridgeStatus;
    updateStatus: BridgeUpdateStatus;
    view: BridgeView;
    authBusy: boolean;
    switchingOrganizationId?: string | null;
    updateBusy: boolean;
    onSelectView: (view: BridgeView) => void;
    onSignOut: () => void;
    onSwitchOrganization: (organizationId: string) => void;
    onCheckForUpdates: () => void;
    onInstallUpdate: () => void;
  } = $props();

  const tabs: { id: BridgeView; label: string; icon: typeof ListTree }[] = [
    { icon: ListTree, id: "network", label: "Network Logs" },
    { icon: SlidersHorizontal, id: "overview", label: "Overview" },
  ];

  function updateState(): "checking" | "current" | "disabled" | "failed" | "ready" {
    if (updateStatus.updateError) return "failed";
    if (updateStatus.downloaded || updateStatus.updateAvailable) return "ready";
    if (updateStatus.checking || updateStatus.downloading || updateBusy) return "checking";
    if (!updateStatus.enabled) return "disabled";
    return "current";
  }

  function updateLabel(): string {
    if (updateStatus.downloaded) return "Update ready";
    if (updateStatus.downloading) return "Downloading";
    if (updateStatus.checking || updateBusy) return "Checking";
    if (updateStatus.updateAvailable) return "Update available";
    if (!updateStatus.enabled) return "Updates off";
    return "Current";
  }
</script>

<header class="top-bar">
  <div class="top-bar-brand">
    <div class="brand-mark" aria-hidden="true">A</div>
    <div class="top-bar-titles">
      <strong>Ambient Bridge</strong>
      <span>{status.appVersion}</span>
    </div>
  </div>

  <nav class="view-tabs" aria-label="Bridge views">
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        class="view-tab"
        data-active={view === tab.id}
        aria-pressed={view === tab.id}
        onclick={() => onSelectView(tab.id)}
      >
        <tab.icon size={15} aria-hidden="true" />
        <span>{tab.label}</span>
      </button>
    {/each}
  </nav>

  <div class="top-bar-actions">
    <span class="connection-chip" data-state={status.connection}>
      <span class="status-dot" data-state={status.connection} aria-hidden="true"></span>
      <span>{connectionLabel(status.connection)}</span>
    </span>
    {#if updateStatus.enabled}
      <button
        class="icon-button compact-action"
        type="button"
        title={updateLabel()}
        aria-label={updateLabel()}
        data-state={updateState()}
        onclick={updateStatus.downloaded ? onInstallUpdate : onCheckForUpdates}
        disabled={updateStatus.checking || updateStatus.downloading || updateBusy}
      >
        {#if updateStatus.downloaded}
          <Download size={14} aria-hidden="true" />
        {:else}
          <span class:spin={updateStatus.checking || updateStatus.downloading || updateBusy}>
            <RefreshCw size={14} aria-hidden="true" />
          </span>
        {/if}
      </button>
    {/if}
    <UserCard
      account={status.account}
      compact
      align="end"
      busy={authBusy}
      switchingOrganizationId={switchingOrganizationId}
      onSignOut={onSignOut}
      onSwitchOrganization={onSwitchOrganization}
    />
  </div>
</header>
