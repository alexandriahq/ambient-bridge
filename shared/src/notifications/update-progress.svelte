<script lang="ts">
  // Compact determinate/indeterminate bar for update download + install.
  // Used by the docked sidebar card, action toasts, onboarding modal, and Settings.

  let {
    percent = null,
    label = null,
  }: {
    readonly percent?: number | null;
    readonly label?: string | null;
  } = $props();

  const determinate = $derived(typeof percent === "number" && Number.isFinite(percent));
  const bounded = $derived(determinate ? Math.max(0, Math.min(100, percent ?? 0)) : 0);
  const valueText = $derived(determinate ? `${Math.round(bounded)}%` : "in progress");
</script>

<div class="grid min-w-0 gap-1.5" data-testid="ambient-update-progress">
  {#if label}
    <p class="m-0 text-xs leading-tight text-ink-secondary [overflow-wrap:anywhere]">{label}</p>
  {/if}
  <div
    class="relative h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.1]"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={determinate ? Math.round(bounded) : undefined}
    aria-valuetext={valueText}
    aria-label={label ?? "Update progress"}
    data-state={determinate ? "determinate" : "indeterminate"}
  >
    {#if determinate}
      <span
        class="block h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
        style:width={`${bounded}%`}
        data-testid="ambient-update-progress-fill"
      ></span>
    {:else}
      <span
        class="ambient-update-progress-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-primary"
        data-testid="ambient-update-progress-fill"
      ></span>
    {/if}
  </div>
</div>

<style>
  @keyframes ambient-update-progress-indeterminate {
    0% {
      transform: translateX(-120%);
    }
    100% {
      transform: translateX(320%);
    }
  }

  .ambient-update-progress-indeterminate {
    animation: ambient-update-progress-indeterminate 1.4s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ambient-update-progress-indeterminate {
      animation: none;
      width: 40%;
      left: 30%;
    }
  }
</style>
