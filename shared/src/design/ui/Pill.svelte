<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import Icon from '../Icon.svelte';

	type Tone = 'soft' | 'solid' | 'outline';
	type Size = 'sm' | 'md';
	type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'class'> & {
		tone?: Tone;
		icon?: string | null;
		dot?: boolean;
		/** Override the leading dot's classes — e.g. a functional status color like `bg-success ring-[3px] ring-success/20`. */
		dotClass?: string;
		size?: Size;
		class?: string;
		children?: Snippet;
	};

	let { tone = 'soft', icon = null, dot = false, dotClass = '', size = 'md', class: cls = '', children, ...rest }: Props = $props();

	// Monochrome only. Tone shifts weight/contrast, never hue.
	const tones: Record<Tone, string> = {
		soft: 'bg-ink/[0.06] text-ink-secondary',
		solid: 'bg-primary text-on-primary',
		outline: 'border border-line-strong text-ink-secondary'
	};
	const sizes: Record<Size, string> = {
		sm: 'h-5 px-1.5 text-2xs gap-1 rounded-[var(--radius-xs)]',
		md: 'h-[22px] px-2 text-xs gap-1.5 rounded-[var(--radius-sm)]'
	};
</script>

<span class="inline-flex items-center font-medium tracking-tight {tones[tone]} {sizes[size]} {cls}" {...rest}>
	{#if dot}<span class="size-1.5 rounded-full {dotClass || 'bg-current opacity-70'}"></span>{/if}
	{#if icon}<Icon name={icon} size={12} />{/if}
	{@render children?.()}
</span>
