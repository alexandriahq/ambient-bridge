<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../cn";
  import {
    accountDisplayName,
    accountInitials,
    type SharedAuthAccount,
    type SharedSignedInAccount,
  } from "../../auth.js";

  let {
    account,
    busy = false,
    placement = "down",
    align = "start",
    contained = false,
    compact = false,
    menuSize = compact ? "compact" : "default",
    unavailableMessage = null,
    onSignIn,
    onRestartSignIn,
    onSignOut,
    onOpenSettings,
    signedInMenuDetail,
  }: {
    /** Current account state pushed from the auth broker; null = unknown/unreachable. */
    account: SharedAuthAccount | null;
    busy?: boolean;
    /** "overlay" is retained for old callers and maps to a top-side portal menu. */
    placement?: "down" | "up" | "overlay";
    align?: "start" | "end";
    /** Keeps the menu at the trigger width instead of portalling it outside its parent. */
    contained?: boolean;
    /** Avatar-only trigger for dense surfaces like top bars. */
    compact?: boolean;
    /** Keeps account menus proportional on dense surfaces without changing the trigger. */
    menuSize?: "default" | "compact";
    unavailableMessage?: string | null;
    onSignIn?: () => void;
    onRestartSignIn?: () => void;
    onSignOut?: () => void;
    onOpenSettings?: () => void;
    /** Optional product-specific control shown only inside the open signed-in menu. */
    signedInMenuDetail?: Snippet<[onSelect: () => void]>;
  } = $props();

  let open = $state(false);
  let rootElement = $state<HTMLDivElement | null>(null);

  let menuEl = $state<HTMLElement | null>(null);
  let menuStyle = $state("");

  function computeMenuStyle(): string {
    if (!rootElement || typeof window === "undefined") return "";
    const r = rootElement.getBoundingClientRect();
    const gap = 8;
    const up = placement === "up" || placement === "overlay";
    const vert = up
      ? `bottom:${Math.round(window.innerHeight - r.top + gap)}px;`
      : `top:${Math.round(r.bottom + gap)}px;`;
    const horiz = align === "end"
      ? `right:${Math.round(Math.max(8, window.innerWidth - r.right))}px;`
      : `left:${Math.round(Math.max(8, r.left))}px;`;
    return `position:fixed;${vert}${horiz}`;
  }

  function toggleMenu(): void {
    open = !open;
    if (open && !contained) menuStyle = computeMenuStyle();
  }

  // Uncontained menus portal to <body> so they escape a parent's clipping boundary.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  const TRIGGER_BASE =
    "flex min-w-0 items-center border-0 bg-transparent text-left font-sans text-sm text-ink transition-colors duration-150";
  const TRIGGER_INTERACTIVE =
    "cursor-pointer hover:bg-ink/[0.055] active:bg-ink/[0.08] disabled:pointer-events-none disabled:cursor-default disabled:opacity-70";
  const triggerLayout = $derived(compact
    ? "w-auto gap-1 rounded-full px-1.5 py-1"
    : "w-full gap-2.5 rounded-[var(--radius-lg)] px-2.5 py-2");

  const PLACEHOLDER_BASE = "grid size-7 flex-none place-items-center rounded-full border";
  const PLACEHOLDER_INERT = "border-dashed border-line text-ink-secondary";
  const PLACEHOLDER_SIGN_IN = "border-solid border-line bg-surface-2 text-ink";

  const IDENTITY = "flex min-w-0 flex-1 flex-col gap-px";
  const NAME = "truncate font-[620]";
  const DETAIL = "truncate text-xs text-ink-secondary";
  const menuLayout = $derived(contained ? "inset-x-0 w-full" : menuSize === "compact" ? "w-[280px]" : "w-[320px]");
  const containedMenuPosition = $derived(placement === "down" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]");
  const MENU_PANEL =
    "card elevate-md z-[60] box-border max-w-[calc(100vw-16px)] rounded-[var(--radius-lg)] border border-line bg-elevated p-2 text-ink";
  const MENU_ITEM_BASE =
    "flex min-h-9 w-full min-w-0 items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-ink/[0.045] disabled:pointer-events-none disabled:opacity-55";
  const MENU_ICON = "size-4 shrink-0 text-ink-secondary";

  $effect(() => {
    if (!open || typeof window === "undefined") return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && (rootElement?.contains(target) || menuEl?.contains(target))) return;
      open = false;
    }

    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === "Escape") open = false;
    }

    function reposition(): void {
      if (!contained) menuStyle = computeMenuStyle();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  });

  function selectSettings(): void {
    open = false;
    onOpenSettings?.();
  }

  function closeMenu(): void {
    open = false;
  }

  function selectSignIn(): void {
    onSignIn?.();
  }

  function selectRestartSignIn(): void {
    (onRestartSignIn ?? onSignIn)?.();
  }

  function selectSignOut(): void {
    open = false;
    onSignOut?.();
  }
</script>

{#snippet spinner(className: string = "size-3")}
  <span class={cn("inline-block animate-spin rounded-full border-[1.5px] border-current border-r-transparent", className)}></span>
{/snippet}

{#snippet userIcon(className: string = "size-3.5")}
  <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
{/snippet}

{#snippet accountAvatar(acct: SharedSignedInAccount, size: number)}
  <div
    class="relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-primary font-bold leading-none tracking-wide text-on-primary select-none"
    style="width: {size}px; height: {size}px; font-size: {Math.max(10, Math.round(size * 0.38))}px;"
    aria-hidden="true"
  >
    <span>{accountInitials(acct)}</span>
    {#if acct.profilePictureUrl}
      <img src={acct.profilePictureUrl} alt="" class="absolute inset-0 size-full rounded-full object-cover" />
    {/if}
  </div>
{/snippet}

{#snippet accountMenu(acct: SharedSignedInAccount)}
  <div class="flex min-w-0 items-center gap-2.5 px-2 py-1.5">
    {@render accountAvatar(acct, 32)}
    <div class="flex min-w-0 flex-1 flex-col gap-px">
      <span class={NAME}>{accountDisplayName(acct)}</span>
      {#if acct.email}
        <span class={DETAIL}>{acct.email}</span>
      {/if}
    </div>
  </div>

  {#if signedInMenuDetail}
    {@render signedInMenuDetail(closeMenu)}
  {:else}
    <div class="my-1 h-px bg-line"></div>
  {/if}
  {#if onOpenSettings}
    <button type="button" class={MENU_ITEM_BASE} role="menuitem" onclick={selectSettings}>
      <svg class={MENU_ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
      <span>Settings</span>
    </button>
  {/if}
  <button type="button" class={cn(MENU_ITEM_BASE, "group")} role="menuitem" onclick={selectSignOut} disabled={busy}>
    <svg class="size-4 shrink-0 text-ink-secondary group-hover:text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
    <span>Sign out</span>
  </button>
{/snippet}

<div bind:this={rootElement} class={cn("relative block min-w-0 text-sm text-ink", !compact && "w-full")}>
  {#if !account}
    <div class={cn(TRIGGER_BASE, triggerLayout, "cursor-default")} title={unavailableMessage ?? undefined}>
      <span class={cn(PLACEHOLDER_BASE, PLACEHOLDER_INERT)} aria-hidden="true">
        {@render userIcon()}
      </span>
      {#if !compact}
        <span class={IDENTITY}>
          <span class="truncate font-medium text-ink-secondary">{unavailableMessage ?? "Account unavailable"}</span>
        </span>
      {/if}
    </div>
  {:else if account.kind === "signed_out"}
    <button type="button" class={cn(TRIGGER_BASE, triggerLayout, TRIGGER_INTERACTIVE)} onclick={selectSignIn} disabled={busy}>
      <span class={cn(PLACEHOLDER_BASE, PLACEHOLDER_SIGN_IN)} aria-hidden="true">
        {#if busy}
          {@render spinner()}
        {:else}
          {@render userIcon()}
        {/if}
      </span>
      {#if !compact}
        <span class={IDENTITY}>
          <span class={NAME}>Sign in</span>
          <span class={DETAIL}>Use your Ambient account</span>
        </span>
      {/if}
    </button>
  {:else if account.kind === "login_pending"}
    <button
      type="button"
      class={cn(TRIGGER_BASE, triggerLayout, TRIGGER_INTERACTIVE)}
      onclick={selectRestartSignIn}
      disabled={busy}
      aria-label="Restart sign-in"
      aria-live="polite"
    >
      <span class={cn(PLACEHOLDER_BASE, PLACEHOLDER_SIGN_IN)} aria-hidden="true">{@render spinner()}</span>
      {#if !compact}
        <span class={IDENTITY}>
          <span class={NAME}>Waiting for browser...</span>
          <span class={DETAIL}>Restart sign-in</span>
        </span>
      {/if}
    </button>
  {:else}
    <button
      type="button"
      class={cn(TRIGGER_BASE, triggerLayout, TRIGGER_INTERACTIVE)}
      onclick={toggleMenu}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`${accountDisplayName(account)} ${account.email ?? ""}`.trim()}
    >
      {@render accountAvatar(account, compact ? 26 : 32)}
      {#if !compact}
        <span class={IDENTITY}>
          <span class={NAME}>{accountDisplayName(account)}</span>
          {#if account.email}
            <span class={DETAIL}>{account.email}</span>
          {/if}
        </span>
      {/if}
    </button>

    {#if open}
      {#if contained}
        <div bind:this={menuEl} class={cn(MENU_PANEL, menuLayout, containedMenuPosition, "absolute")} role="menu">
          {@render accountMenu(account)}
        </div>
      {:else}
        <div use:portal bind:this={menuEl} class={cn(MENU_PANEL, menuLayout, "fixed")} style={menuStyle} role="menu">
          {@render accountMenu(account)}
        </div>
      {/if}
    {/if}
  {/if}
</div>
