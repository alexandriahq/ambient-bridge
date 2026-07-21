<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import Kbd from '../ui/Kbd.svelte';

	const FOCUSABLE_SELECTOR = [
		'a[href]',
		'button:not([disabled])',
		'input:not([disabled])',
		'select:not([disabled])',
		'textarea:not([disabled])',
		'[contenteditable="true"]',
		'[tabindex]:not([tabindex="-1"])'
	].join(',');

	type Section = {
		id: string;
		label: string;
	};
	type Props = {
		open?: boolean;
		sections?: readonly Section[];
		section?: string;
		onClose?: (e?: Event) => void;
		children?: Snippet<[string | undefined]>;
	};

	let {
		open = false,
		sections = [],
		section = $bindable(sections[0]?.id),
		onClose = () => {},
		children
	}: Props = $props();

	const titleId = $props.id();
	let dialog = $state<HTMLDivElement>();
	let wasOpen = false;
	let opener: HTMLElement | null = null;

	$effect(() => {
		if (open && !wasOpen) {
			opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
				? document.activeElement
				: null;
			if (dialog?.isConnected) {
				const selectedSection = dialog.querySelector<HTMLElement>('[aria-current="page"]');
				(selectedSection ?? focusableElements()[0] ?? dialog).focus();
			}
		} else if (!open && wasOpen) {
			restoreOpener();
		}
		wasOpen = open;
	});

	onDestroy(() => {
		if (wasOpen) restoreOpener();
	});

	function restoreOpener(): void {
		const target = opener;
		opener = null;
		if (target?.isConnected && !target.hasAttribute('disabled')) target.focus();
	}

	function focusableElements(): HTMLElement[] {
		const dialogElement = dialog;
		if (!dialogElement) return [];
		return Array.from(dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
			const tabIndex = element.getAttribute('tabindex');
			if (tabIndex !== null && Number(tabIndex) < 0) return false;
			if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;

			let current: HTMLElement | null = element;
			while (current && current !== dialogElement.parentElement) {
				const style = window.getComputedStyle(current);
				if (style.display === 'none' || style.visibility === 'hidden') return false;
				current = current.parentElement;
			}
			return true;
		});
	}

	function onkey(event: KeyboardEvent): void {
		if (!open || !dialog) return;

		const eventTarget = event.target instanceof Element ? event.target : null;
		const targetDialog = eventTarget?.closest('[role="dialog"]');
		if (targetDialog && targetDialog !== dialog) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose?.(event);
			return;
		}

		if (event.key !== 'Tab') return;
		const focusable = focusableElements();
		if (focusable.length === 0) {
			event.preventDefault();
			dialog.focus();
			return;
		}

		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (!dialog.contains(document.activeElement)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
		} else if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function onfocusin(event: FocusEvent): void {
		if (!open || !dialog) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (!target || dialog.contains(target)) return;
		// A nested portal dialog owns its own focus while it is open.
		if (target.closest('[role="dialog"]')) return;
		(dialog.querySelector<HTMLElement>('[aria-current="page"]') ?? focusableElements()[0] ?? dialog).focus();
	}
</script>

<svelte:window onkeydown={onkey} onfocusin={onfocusin} />

{#if open}
	<div
		bind:this={dialog}
		class="fixed inset-0 z-[80] flex flex-col text-ink"
		style="background: hsl(var(--bg)); animation: rise 0.28s var(--ease-out-quint) both"
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
		tabindex="-1"
	>
		<!-- Top bar -->
		<header class="drag flex h-[46px] shrink-0 items-center gap-3 border-b border-line px-5 pl-[88px]">
			<h1 id={titleId} class="text-sm font-medium text-ink">Settings</h1>
			<div class="flex-1"></div>
			<button
				type="button"
				onclick={onClose}
				aria-label="Close settings"
				class="no-drag flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-sm font-medium text-ink-tertiary transition-colors hover:bg-ink/[0.05] hover:text-ink cursor-pointer"
			>
				Done <Kbd>ESC</Kbd>
			</button>
		</header>

		<div class="flex min-h-0 flex-1">
			<!-- Section rail -->
			<nav aria-label="Settings sections" class="w-[220px] shrink-0 space-y-0.5 border-r border-line p-3">
				{#each sections as s (s.id)}
					<button
						type="button"
						onclick={() => (section = s.id)}
						aria-current={section === s.id ? 'page' : undefined}
						class="flex h-9 w-full items-center rounded-[var(--radius-md)] px-3 text-base font-medium transition-colors cursor-pointer {section ===
						s.id
							? 'bg-ink/[0.06] text-ink'
							: 'text-ink-secondary hover:bg-ink/[0.04] hover:text-ink'}"
					>
						{s.label}
					</button>
				{/each}
			</nav>

			<!-- Content -->
			<div class="scroll-area min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
				<div class="mx-auto max-w-[640px] px-10 py-9">
					{@render children?.(section)}
				</div>
			</div>
		</div>
	</div>
{/if}
