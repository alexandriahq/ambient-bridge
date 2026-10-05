<script lang="ts">
  import { Button } from "@ambient/shared/ui/button";
  import * as Dialog from "@ambient/shared/ui/dialog";
  import type { BridgeUpdateStatus } from "../bridge-api";
  import bridgeIcon from "../../../resources/bridge-icon-source.png";

  let {
    appVersion,
    updateStatus,
  }: {
    appVersion: string;
    updateStatus: BridgeUpdateStatus;
  } = $props();

  let uninstallOpen = $state(false);
  let uninstallBusy = $state(false);
  let uninstallError = $state<string | null>(null);
  let uninstallAvailability = $state<{
    available: boolean;
    reason: string | null;
    method: "trash" | "pkexec" | "nsis" | null;
  } | null>(null);

  async function openUninstall(): Promise<void> {
    uninstallError = null;
    try {
      uninstallAvailability = await window.ambientBridge?.getUninstallAvailability()
        ?? { available: false, reason: "The Bridge runtime API is unavailable.", method: null };
    } catch (error) {
      uninstallAvailability = {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        method: null,
      };
    }
    uninstallOpen = true;
  }

  async function uninstall(): Promise<void> {
    uninstallBusy = true;
    uninstallError = null;
    try {
      const api = window.ambientBridge;
      if (!api) throw new Error("The Bridge runtime API is unavailable.");
      await api.uninstall();
    } catch (error) {
      uninstallError = error instanceof Error ? error.message : String(error);
      uninstallBusy = false;
    }
  }
</script>

<section class="mx-auto w-full max-w-[760px]" aria-labelledby="bridge-about-heading">
  <h1 id="bridge-about-heading" class="text-2xl font-semibold tracking-tight text-ink">About</h1>

  <div class="mt-8 flex items-center gap-4">
    <div class="grid size-16 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-lg)] border border-line bg-white shadow-sm">
      <img src={bridgeIcon} alt="" class="size-full object-cover" />
    </div>
    <div class="min-w-0">
      <p class="text-lg font-semibold text-ink">Ambient Bridge</p>
      <p class="mt-0.5 truncate text-sm text-ink-tertiary">Secure local inference gateway</p>
    </div>
  </div>

  <dl class="card mt-6 overflow-hidden text-sm" aria-label="Bridge identity">
    <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 px-4 py-3">
      <dt class="font-medium text-ink-tertiary">Version</dt>
      <dd class="min-w-0 break-words text-ink-secondary">{updateStatus.currentVersion ?? appVersion}</dd>
    </div>
    <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 border-t border-line px-4 py-3">
      <dt class="font-medium text-ink-tertiary">Channel</dt>
      <dd class="min-w-0 break-words text-ink-secondary">{updateStatus.channel}</dd>
    </div>
  </dl>

  <p class="mt-4 text-sm leading-relaxed text-ink-tertiary">Ambient installs matching Experimental App and Bridge builds from Ambient Settings → Dev. Experimental builds are not installed from Bridge.</p>

  <div class="mt-8 border-t border-line pt-5" role="region" aria-labelledby="bridge-application-actions-heading">
    <h2 id="bridge-application-actions-heading" class="mb-3 text-sm font-medium text-ink">Application</h2>
    <Button variant="danger" size="sm" class="no-drag" onclick={() => void openUninstall()}>Uninstall Ambient Bridge</Button>
  </div>
</section>

<Dialog.Root bind:open={uninstallOpen}>
  <Dialog.Content class="card elevate-lg max-w-[460px] bg-surface p-0">
    <Dialog.Header class="border-b border-line px-5 py-4 pr-12">
      <Dialog.Title class="text-md font-semibold text-ink">Uninstall Ambient Bridge?</Dialog.Title>
    </Dialog.Header>
    <div class="space-y-3 px-5 py-4 text-sm text-ink-secondary">
      {#if uninstallAvailability?.method === "pkexec"}
        <p>Bridge will stop and the package will be uninstalled. You will be asked for your administrator password. Ambient features that require Bridge will remain unavailable until it is installed again.</p>
        <p>Your Bridge account and local settings will remain on this computer.</p>
      {:else if uninstallAvailability?.method === "nsis"}
        <p>Bridge will stop and Windows will uninstall the application. Ambient features that require Bridge will remain unavailable until it is installed again.</p>
        <p>Your Bridge account and local settings will remain on this PC.</p>
      {:else}
        <p>Bridge will stop and the application will move to Trash. Ambient features that require Bridge will remain unavailable until it is installed again.</p>
        <p>Your Bridge account and local settings will remain on this Mac.</p>
      {/if}
      {#if uninstallAvailability?.reason}
        <p class="text-warning" role="status">{uninstallAvailability.reason}</p>
      {/if}
      {#if uninstallError}
        <p class="text-danger" role="alert">{uninstallError}</p>
      {/if}
    </div>
    <Dialog.Footer class="border-t border-line px-5 py-4">
      <Button variant="secondary" size="sm" disabled={uninstallBusy} onclick={() => uninstallOpen = false}>Cancel</Button>
      <Button variant="danger" size="sm" disabled={uninstallBusy || !uninstallAvailability?.available} onclick={() => void uninstall()}>
        {uninstallBusy ? "Uninstalling…" : uninstallAvailability?.method === "pkexec" || uninstallAvailability?.method === "nsis" ? "Uninstall and quit" : "Move to Trash and quit"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
