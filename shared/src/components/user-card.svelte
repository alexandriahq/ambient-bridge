<script lang="ts">
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import UserRoundIcon from "@lucide/svelte/icons/user-round";
  import type { Snippet } from "svelte";
  import {
    accountDisplayName,
    accountInitials,
    type SharedAuthAccount,
    type SharedSignedInAccount,
  } from "@ambient/shared";
  import * as Avatar from "@ambient/shared/ui/avatar";
  import { Button } from "@ambient/shared/ui/button";
  import * as DropdownMenu from "@ambient/shared/ui/dropdown-menu";
  import { cn } from "@ambient/shared/utils";

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
    settingsLabel = "Settings",
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
    /** `sidebar`: the width of a sidebar notice card (sidebar minus its 12px gutters). */
    menuSize?: "default" | "compact" | "sidebar";
    unavailableMessage?: string | null;
    onSignIn?: () => void;
    onRestartSignIn?: () => void;
    onSignOut?: () => void;
    onOpenSettings?: () => void;
    /** Product-specific label when the callback opens a settings destination rather than a settings shell. */
    settingsLabel?: string;
    /** Optional product-specific control shown only inside the open signed-in menu. */
    signedInMenuDetail?: Snippet<[onSelect: () => void]>;
  } = $props();

  let open = $state(false);

  const TRIGGER_BASE =
    "h-auto min-w-0 justify-start border-0 bg-transparent text-left font-sans text-sm text-ink shadow-none transition-colors duration-150 active:scale-100";
  const TRIGGER_INTERACTIVE =
    "hover:bg-ink/[0.055] active:bg-ink/[0.08] disabled:cursor-default disabled:opacity-70";
  const triggerLayout = $derived(compact
    ? "size-8 justify-center rounded-full p-0"
    : "w-full gap-2.5 rounded-[var(--radius-lg)] px-2.5 py-2");

  const PLACEHOLDER_BASE = "grid size-7 flex-none place-items-center rounded-full border";
  const PLACEHOLDER_INERT = "border-dashed border-line text-ink-secondary";
  const PLACEHOLDER_SIGN_IN = "border-solid border-line bg-surface-2 text-ink";

  const IDENTITY = "flex min-w-0 flex-1 flex-col gap-px";
  const NAME = "truncate font-[620]";
  const DETAIL = "truncate text-xs text-ink-secondary";
  const menuLayout = $derived(contained
    ? "w-(--bits-dropdown-menu-anchor-width)"
    : menuSize === "sidebar"
      ? "w-[220px]"
      : menuSize === "compact"
        ? "w-[280px]"
        : "w-[320px]");
  const MENU_PANEL =
    "card elevate-md z-[60] box-border max-w-[calc(100vw-16px)] rounded-[var(--radius-lg)] border border-line bg-elevated p-2 text-ink shadow-none ring-0";
  const MENU_ITEM_BASE =
    "min-h-9 gap-3 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-ink transition-colors focus:bg-ink/[0.045] focus:text-ink";
  const MENU_ICON = "size-4 shrink-0 text-ink-secondary";

  function closeMenu(): void {
    open = false;
  }

  function selectSignIn(): void {
    onSignIn?.();
  }


  function selectSettings(): void {
    onOpenSettings?.();
  }

  function selectSignOut(): void {
    onSignOut?.();
  }
</script>

{#snippet accountAvatar(account: SharedSignedInAccount, compactAvatar = false)}
  <Avatar.Root
    class={cn(
      "bg-primary font-bold leading-none tracking-wide text-primary-foreground after:border-0",
      compactAvatar ? "size-[26px]" : "size-8",
    )}
  >
    {#if account.profilePictureUrl}
      <Avatar.Image src={account.profilePictureUrl} alt="" />
    {/if}
    <Avatar.Fallback class="bg-primary text-primary-foreground">
      {accountInitials(account)}
    </Avatar.Fallback>
  </Avatar.Root>
{/snippet}

{#snippet accountMenu(account: SharedSignedInAccount)}
  <DropdownMenu.Label class="flex min-w-0 items-center gap-2.5 px-2 py-1.5 text-sm font-normal text-ink">
    {@render accountAvatar(account)}
    <span class="flex min-w-0 flex-1 flex-col gap-px">
      <span class={NAME}>{accountDisplayName(account)}</span>
      {#if account.email}
        <span class={DETAIL}>{account.email}</span>
      {/if}
    </span>
  </DropdownMenu.Label>

  {#if signedInMenuDetail}
    {@render signedInMenuDetail(closeMenu)}
  {:else}
    <DropdownMenu.Separator class="mx-0 bg-line" />
  {/if}
  {#if onOpenSettings}
    <DropdownMenu.Item class={MENU_ITEM_BASE} onSelect={selectSettings}>
      <SettingsIcon class={MENU_ICON} aria-hidden="true" />
      <span>{settingsLabel}</span>
    </DropdownMenu.Item>
  {/if}
  <DropdownMenu.Item
    class={cn(MENU_ITEM_BASE, "group")}
    variant="destructive"
    onSelect={selectSignOut}
    disabled={busy}
  >
    <LogOutIcon class="size-4 shrink-0 text-ink-secondary group-focus:text-danger" aria-hidden="true" />
    <span>Sign out</span>
  </DropdownMenu.Item>
{/snippet}

<div class={cn("relative block min-w-0 text-sm text-ink", !compact && "w-full")}>
  {#if !account}
    <div class={cn(TRIGGER_BASE, triggerLayout, "flex cursor-default items-center")} title={unavailableMessage ?? undefined}>
      <span class={cn(PLACEHOLDER_BASE, PLACEHOLDER_INERT)} aria-hidden="true">
        <UserRoundIcon class="size-3.5" />
      </span>
      {#if !compact}
        <span class={IDENTITY}>
          <span class="truncate font-medium text-ink-secondary">{unavailableMessage ?? "Account unavailable"}</span>
        </span>
      {/if}
    </div>
  {:else if account.kind === "signed_out"}
    <Button
      variant="ghost"
      class={cn(TRIGGER_BASE, triggerLayout, TRIGGER_INTERACTIVE)}
      onclick={selectSignIn}
      disabled={busy}
    >
      <span class={cn(PLACEHOLDER_BASE, PLACEHOLDER_SIGN_IN)} aria-hidden="true">
        {#if busy}
          <LoaderCircleIcon class="size-3 animate-spin" />
        {:else}
          <UserRoundIcon class="size-3.5" />
        {/if}
      </span>
      {#if !compact}
        <span class={IDENTITY}>
          <span class={NAME}>Sign in</span>
          <span class={DETAIL}>Use your Ambient account</span>
        </span>
      {/if}
    </Button>
  {:else if account.kind === "login_pending"}
    <DropdownMenu.Root bind:open>
      <DropdownMenu.Trigger disabled={busy} aria-label="Sign-in options" class={cn(TRIGGER_BASE, triggerLayout, TRIGGER_INTERACTIVE)}>
        <span class={cn(PLACEHOLDER_BASE, PLACEHOLDER_SIGN_IN)} aria-hidden="true"><LoaderCircleIcon class="size-3 animate-spin" /></span>
        {#if !compact}<span class={IDENTITY}><span class={NAME}>Waiting for browser…</span><span class={DETAIL}>Finish signing in in your browser</span></span>{/if}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class={MENU_PANEL} {align}>
        <DropdownMenu.Item onclick={selectSignIn}>Reopen sign-in page</DropdownMenu.Item>
        {#if onRestartSignIn}
          <DropdownMenu.Item onclick={() => onRestartSignIn?.()}>Restart sign-in</DropdownMenu.Item>
          <p class="px-2.5 py-2 text-xs text-ink-secondary">Restarting expires earlier sign-in tabs.</p>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {:else}
    <DropdownMenu.Root bind:open>
      <DropdownMenu.Trigger disabled={busy}>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            class={cn(TRIGGER_BASE, triggerLayout, TRIGGER_INTERACTIVE)}
            aria-label={`${accountDisplayName(account)} ${account.email ?? ""}`.trim()}
          >
            {@render accountAvatar(account, compact)}
            {#if !compact}
              <span class={IDENTITY}>
                <span class={NAME}>{accountDisplayName(account)}</span>
                {#if account.email}
                  <span class={DETAIL}>{account.email}</span>
                {/if}
              </span>
            {/if}
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      {#if open}
        <DropdownMenu.Content
          side={placement === "down" ? "bottom" : "top"}
          {align}
          sideOffset={8}
          collisionPadding={8}
          portalProps={{ disabled: contained }}
          class={cn(MENU_PANEL, menuLayout)}
        >
          {@render accountMenu(account)}
        </DropdownMenu.Content>
      {/if}
    </DropdownMenu.Root>
  {/if}
</div>
