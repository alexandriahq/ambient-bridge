<script lang="ts">
  import { accountInitials, type SharedSignedInAccount } from "./auth.js";

  let {
    account,
    size = 28,
  }: {
    account: SharedSignedInAccount;
    size?: number;
  } = $props();

  let imageFailed = $state(false);
  const imageUrl = $derived(imageFailed ? null : account.profilePictureUrl ?? null);
</script>

<span
  class="shared-avatar"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.max(10, Math.round(size * 0.38))}px"
  aria-hidden="true"
>
  {#if imageUrl}
    <img src={imageUrl} alt="" onerror={() => (imageFailed = true)} />
  {:else}
    {accountInitials(account)}
  {/if}
</span>

<style>
  .shared-avatar {
    --av-bg: var(--ambient-primary, var(--bridge-primary, #0d0d0d));
    --av-fg: var(--ambient-primary-contrast, var(--bridge-primary-contrast, #ffffff));
    --av-border: var(--ambient-border-strong, var(--bridge-border-strong, #d1d1d1));
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    border: 1px solid var(--av-border);
    border-radius: 8px;
    background: var(--av-bg);
    color: var(--av-fg);
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    user-select: none;
  }

  .shared-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
