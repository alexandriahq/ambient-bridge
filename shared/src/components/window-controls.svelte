<script lang="ts">
	/** In-flow caption controls for browser mocks and Linux custom chrome. */
	type Props = Record<string, never>;
	let {}: Props = $props();

	type WindowControlSurface = { windowControls?: {
			minimize?: () => Promise<boolean>;
			toggleMaximize?: () => Promise<boolean>;
			close?: () => Promise<boolean>;
		} };
	const hostWindow = typeof window !== "undefined"
		? window as Window & { ambient?: WindowControlSurface }
		: undefined;
	const ambient = hostWindow?.ambient;
	const isWeb = typeof window !== "undefined" && !ambient &&
		!(window as Window & { ambientBridge?: unknown }).ambientBridge;
	const platform = typeof document !== "undefined"
		? document.documentElement.getAttribute("data-platform")
		: null;
	const showMockWinCaption = isWeb && platform === "win32";
	const showLinuxCaption = platform === "linux";
</script>

{#if showMockWinCaption || showLinuxCaption}
	<div
		class="no-drag flex h-[46px] w-[138px] shrink-0 items-stretch self-stretch"
		data-window-caption-controls
		data-window-caption-platform={platform}
		aria-label={showLinuxCaption ? "Window controls" : undefined}
		aria-hidden={showMockWinCaption ? "true" : undefined}
	>
		<button
			type="button"
			class="no-drag grid h-full min-h-[46px] flex-1 place-items-center border-0 bg-transparent p-0 text-ink-secondary hover:bg-ink/10"
			title="Minimize"
			aria-label="Minimize"
			disabled={showMockWinCaption}
			onclick={() => void ambient?.windowControls?.minimize?.()}
		>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" stroke-width="1.2" /></svg>
		</button>
		<button
			type="button"
			class="no-drag grid h-full min-h-[46px] flex-1 place-items-center border-0 bg-transparent p-0 text-ink-secondary hover:bg-ink/10"
			title="Maximize"
			aria-label="Maximize"
			disabled={showMockWinCaption}
			onclick={() => void ambient?.windowControls?.toggleMaximize?.()}
		>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><rect x="1.25" y="1.25" width="7.5" height="7.5" stroke="currentColor" stroke-width="1.2" /></svg>
		</button>
		<button
			type="button"
			class="no-drag grid h-full min-h-[46px] flex-1 place-items-center border-0 bg-transparent p-0 text-ink-secondary hover:bg-danger hover:text-white"
			title="Close"
			aria-label="Close"
			disabled={showMockWinCaption}
			onclick={() => void ambient?.windowControls?.close?.()}
		>
			<svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" data-window-close-icon><path d="M2.5 2.5l8 8M10.5 2.5l-8 8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" /></svg>
		</button>
	</div>
{/if}
