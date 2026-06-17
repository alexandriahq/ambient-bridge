<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import { accountDisplayName, type SharedAuthAccount } from "./auth.js";

  let {
    account,
    busy = false,
    switchingOrganizationId = null,
    placement = "down",
    align = "start",
    compact = false,
    unavailableMessage = null,
    onSignIn,
    onSignOut,
    onSwitchOrganization,
    onOpenSettings,
  }: {
    /** Current account state pushed from the auth broker; null = unknown/unreachable. */
    account: SharedAuthAccount | null;
    busy?: boolean;
    switchingOrganizationId?: string | null;
    /** "overlay" renders the menu fixed over the trigger, escaping clipping ancestors. */
    placement?: "down" | "up" | "overlay";
    align?: "start" | "end";
    /** Avatar-only trigger for dense surfaces like top bars. */
    compact?: boolean;
    unavailableMessage?: string | null;
    onSignIn?: () => void;
    onSignOut?: () => void;
    onSwitchOrganization?: (organizationId: string) => void;
    onOpenSettings?: () => void;
  } = $props();

  let open = $state(false);
  let container = $state<HTMLElement | null>(null);
  let triggerEl = $state<HTMLElement | null>(null);
  let overlayPos = $state<{ top: number; left: number } | null>(null);

  const signedIn = $derived(account?.kind === "signed_in" ? account : null);
  const organizations = $derived(signedIn?.organizations ?? []);
  const currentOrgName = $derived(
    signedIn
      ? signedIn.organizationName
        ?? organizations.find((org) => org.id === signedIn.organizationId)?.name
        ?? null
      : null,
  );

  // Overlay placement: anchor the menu to the trigger with fixed positioning so
  // it can cover the trigger and float above clipping/overflow ancestors
  // (e.g. the app sidebar) instead of being cut off at their edge.
  function placeOverlay(): void {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    overlayPos = {
      top: Math.max(8, rect.top - 4),
      left: Math.max(8, rect.left - 4),
    };
  }

  $effect(() => {
    if (!open || placement !== "overlay") {
      overlayPos = null;
      return;
    }
    placeOverlay();
    window.addEventListener("resize", placeOverlay);
    return () => window.removeEventListener("resize", placeOverlay);
  });

  $effect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        open = false;
      }
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") open = false;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeydown);
    };
  });

  function switchTo(organizationId: string): void {
    if (!signedIn || organizationId === signedIn.organizationId) return;
    if (switchingOrganizationId) return;
    onSwitchOrganization?.(organizationId);
  }

  function organizationDisabled(organizationId: string): boolean {
    if (switchingOrganizationId !== null) return true;
    if (organizationId === signedIn?.organizationId) return true;
    return organizations.length < 2 && Boolean(signedIn?.organizationId);
  }

  function selectSettings(): void {
    open = false;
    onOpenSettings?.();
  }

  function selectSignOut(): void {
    open = false;
    onSignOut?.();
  }
</script>

<div class="user-card" class:compact bind:this={container}>
  {#if !account}
    <div class="trigger inert" title={unavailableMessage ?? undefined}>
      <span class="avatar-placeholder" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
      </span>
      {#if !compact}
        <span class="identity">
          <span class="name muted">{unavailableMessage ?? "Account unavailable"}</span>
        </span>
      {/if}
    </div>
  {:else if account.kind === "signed_out"}
    <button type="button" class="trigger sign-in" onclick={() => onSignIn?.()} disabled={busy}>
      <span class="avatar-placeholder" aria-hidden="true">
        {#if busy}
          <span class="spinner"></span>
        {:else}
          <svg viewBox="0 0 24 24"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
        {/if}
      </span>
      {#if !compact}
        <span class="identity">
          <span class="name">Sign in</span>
          <span class="detail">Use your Ambient account</span>
        </span>
      {/if}
    </button>
  {:else if account.kind === "login_pending"}
    <div class="trigger inert" aria-live="polite">
      <span class="avatar-placeholder" aria-hidden="true"><span class="spinner"></span></span>
      {#if !compact}
        <span class="identity">
          <span class="name">Waiting for browser…</span>
          <span class="detail">Finish signing in to continue</span>
        </span>
      {/if}
    </div>
  {:else}
    <button
      type="button"
      class="trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      bind:this={triggerEl}
      onclick={() => (open = !open)}
    >
      <Avatar account={account} size={compact ? 26 : 28} />
      {#if !compact}
        <span class="identity">
          <span class="name">{accountDisplayName(account)}</span>
          <span class="detail">{currentOrgName ?? account.email ?? ""}</span>
        </span>
      {/if}
      <span class="chevrons" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>
      </span>
    </button>

    {#if open}
      <div
        class="menu"
        class:unplaced={placement === "overlay" && !overlayPos}
        role="menu"
        data-placement={placement}
        data-align={align}
        style={placement === "overlay" && overlayPos ? `top: ${overlayPos.top}px; left: ${overlayPos.left}px;` : undefined}
      >
        <div class="menu-header">
          <Avatar account={account} size={34} />
          <div class="menu-id">
            <span class="name">{accountDisplayName(account)}</span>
            {#if account.email}
              <span class="detail">{account.email}</span>
            {/if}
          </div>
        </div>

        {#if organizations.length > 0}
          <div class="menu-divider" role="separator"></div>
          <p class="menu-label" id="shared-user-card-orgs">Organization</p>
          <div class="menu-orgs" role="group" aria-labelledby="shared-user-card-orgs">
            {#each organizations as org (org.id)}
              {@const active = org.id === account.organizationId}
              {@const switching = org.id === switchingOrganizationId}
              <button
                type="button"
                class="menu-item org"
                role="menuitemradio"
                aria-checked={active}
                disabled={organizationDisabled(org.id)}
                onclick={() => switchTo(org.id)}
              >
                <span class="org-badge" aria-hidden="true">{org.name.slice(0, 1).toUpperCase()}</span>
                <span class="org-name">{org.name}</span>
                {#if switching}
                  <span class="spinner small" aria-hidden="true"></span>
                {:else if active}
                  <svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                {/if}
              </button>
            {/each}
          </div>
        {:else if currentOrgName}
          <div class="menu-divider" role="separator"></div>
          <p class="menu-label">Organization</p>
          <div class="menu-item org inert-row">
            <span class="org-badge" aria-hidden="true">{currentOrgName.slice(0, 1).toUpperCase()}</span>
            <span class="org-name">{currentOrgName}</span>
          </div>
        {/if}

        <div class="menu-divider" role="separator"></div>
        {#if onOpenSettings}
          <button type="button" class="menu-item" role="menuitem" onclick={selectSettings}>
            <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
            <span>Settings</span>
          </button>
        {/if}
        <button type="button" class="menu-item danger" role="menuitem" onclick={selectSignOut} disabled={busy}>
          <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
          <span>Sign out</span>
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .user-card {
    /* Theme bridge: resolves against whichever app's tokens are present. */
    --uc-text: var(--ambient-text, var(--bridge-text, #0d0d0d));
    --uc-muted: var(--ambient-muted, var(--bridge-muted, #5d5d5d));
    --uc-muted-soft: var(--ambient-muted-soft, var(--bridge-muted-soft, #8e8e8e));
    --uc-border: var(--ambient-border, var(--bridge-border, #e5e5e5));
    --uc-border-strong: var(--ambient-border-strong, var(--bridge-border-strong, #d1d1d1));
    --uc-popover: var(--ambient-popover, var(--bridge-panel, #ffffff));
    --uc-hover: var(--ambient-control-hover, var(--bridge-control-hover, #f4f4f4));
    --uc-active: var(--ambient-control-active, var(--bridge-surface-strong, #ececec));
    --uc-primary: var(--ambient-primary, var(--bridge-primary, #0d0d0d));
    --uc-danger: var(--ambient-danger, var(--bridge-danger, #dc2626));
    --uc-shadow: var(--ambient-shadow, var(--bridge-shadow, rgba(0, 0, 0, 0.08)));
    position: relative;
    display: block;
    min-width: 0;
    font-size: 13px;
    color: var(--uc-text);
  }

  .trigger {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .compact .trigger {
    width: auto;
    gap: 4px;
    padding: 4px 6px;
  }

  .trigger:hover:not(:disabled):not(.inert) {
    background: var(--uc-hover);
  }

  .trigger:active:not(:disabled):not(.inert) {
    background: var(--uc-active);
  }

  .trigger:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .trigger.inert {
    cursor: default;
  }

  .identity {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 1px;
  }

  .name {
    overflow: hidden;
    font-weight: 620;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name.muted {
    color: var(--uc-muted);
    font-weight: 500;
  }

  .detail {
    overflow: hidden;
    color: var(--uc-muted);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .avatar-placeholder {
    display: grid;
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    place-items: center;
    border: 1px dashed var(--uc-border-strong);
    border-radius: 8px;
    color: var(--uc-muted);
  }

  .avatar-placeholder svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .sign-in .avatar-placeholder {
    border-style: solid;
    background: color-mix(in srgb, var(--uc-text) 5%, transparent);
    color: var(--uc-text);
  }

  .chevrons {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    color: var(--uc-muted-soft);
  }

  .chevrons svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .menu {
    position: absolute;
    z-index: 60;
    display: flex;
    width: 248px;
    flex-direction: column;
    padding: 6px;
    border: 1px solid var(--uc-border);
    border-radius: 12px;
    background: var(--uc-popover);
    box-shadow: 0 18px 44px -18px var(--uc-shadow), 0 2px 8px -4px var(--uc-shadow);
  }

  .menu[data-placement="down"] {
    top: calc(100% + 6px);
  }

  .menu[data-placement="up"] {
    bottom: calc(100% + 6px);
  }

  /* Fixed so it escapes overflow-hidden ancestors and covers the trigger;
     top/left come from the measured trigger rect via inline style. */
  .menu[data-placement="overlay"] {
    position: fixed;
  }

  .menu.unplaced {
    visibility: hidden;
  }

  .menu[data-align="start"] {
    left: 0;
  }

  .menu[data-align="end"] {
    right: 0;
  }

  .menu-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
  }

  .menu-id {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 1px;
  }

  .menu-divider {
    height: 1px;
    margin: 4px 6px;
    background: var(--uc-border);
  }

  .menu-label {
    margin: 4px 8px 2px;
    color: var(--uc-muted-soft);
    font-size: 10.5px;
    font-weight: 640;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .menu-orgs {
    display: flex;
    flex-direction: column;
  }

  .menu-item {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--uc-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 100ms ease;
  }

  .menu-item:hover:not(:disabled):not(.inert-row) {
    background: var(--uc-hover);
  }

  .menu-item:disabled {
    cursor: default;
  }

  .menu-item.inert-row {
    cursor: default;
  }

  .menu-item.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--uc-danger) 9%, transparent);
    color: var(--uc-danger);
  }

  .item-icon {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
    color: var(--uc-muted);
  }

  .menu-item.danger:hover:not(:disabled) .item-icon {
    color: inherit;
  }

  .org-badge {
    display: grid;
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    place-items: center;
    border: 1px solid var(--uc-border-strong);
    border-radius: 6px;
    background: color-mix(in srgb, var(--uc-text) 6%, transparent);
    font-size: 10px;
    font-weight: 700;
  }

  .org-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    fill: none;
    stroke: var(--uc-primary);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2.4;
  }

  .spinner {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    border: 1.5px solid color-mix(in srgb, var(--uc-text) 22%, transparent);
    border-radius: 999px;
    border-top-color: var(--uc-text);
    animation: shared-user-card-spin 0.8s linear infinite;
  }

  .spinner.small {
    width: 11px;
    height: 11px;
  }

  @keyframes shared-user-card-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
