<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '../Icon.svelte';
	import { cn } from '../cn';

	type Props = {
		open?: boolean;
		title?: string;
		onClose?: () => void;
		class?: string;
		bodyClass?: string;
		children?: Snippet;
		footer?: Snippet;
	};

	let {
		open = $bindable(false),
		title = '',
		onClose = () => (open = false),
		class: cls = '',
		bodyClass = '',
		children,
		footer
	}: Props = $props();

	function close() {
		open = false;
		onClose?.();
	}

	function onkey(e: KeyboardEvent) {
		if (open && e.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={onkey} />

{#if open}
	<div
		class="fixed inset-0 z-[90] grid place-items-center bg-scrim/40 p-6"
		onclick={close}
		role="presentation"
	>
		<div
			class={cn('card elevate-lg w-full max-w-[420px] overflow-hidden bg-surface', cls)}
			style="animation: floatIn 0.28s var(--ease-out-quint) both"
			onclick={(e: MouseEvent) => e.stopPropagation()}
			onkeydown={() => {}}
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-label={title}
		>
			{#if title}
				<header class="flex items-center gap-3 border-b border-line px-4 py-3">
					<h2 class="flex-1 text-md font-semibold text-ink">{title}</h2>
					<button
						type="button"
						onclick={close}
						aria-label="Close"
						class="grid size-8 place-items-center rounded-[var(--radius-md)] text-ink-tertiary transition-colors hover:bg-ink/[0.06] hover:text-ink cursor-pointer"
					>
						<Icon name="x" size={16} />
					</button>
				</header>
			{/if}
			<div class={cn('p-4', bodyClass)}>
				{@render children?.()}
			</div>
			{#if footer}
				<footer class="border-t border-line px-4 py-3">
					{@render footer()}
				</footer>
			{/if}
		</div>
	</div>
{/if}
