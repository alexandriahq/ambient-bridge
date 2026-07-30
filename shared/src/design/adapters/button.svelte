<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Icon from '../icon.svelte';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
	type Size = 'sm' | 'md' | 'lg' | 'icon';
	type Props = Omit<HTMLButtonAttributes, 'class' | 'size'> & {
		variant?: Variant;
		size?: Size;
		icon?: string | null;
		iconRight?: string | null;
		full?: boolean;
		class?: string;
	};

	let {
		variant = 'secondary',
		size = 'md',
		icon = null,
		iconRight = null,
		full = false,
		class: cls = '',
		children,
		...rest
	}: Props = $props();

	const base =
		'no-drag relative inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none transition-all duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40 cursor-pointer';

	const variants: Record<Variant, string> = {
		primary: 'bg-primary text-on-primary hover:opacity-90',
		secondary:
			'bg-surface text-ink border border-line-strong hover:bg-surface-2',
		ghost: 'text-ink-secondary hover:text-ink hover:bg-ink/[0.05]',
		danger: 'text-ink border border-line-strong hover:bg-ink/[0.05]'
	};

	const sizes: Record<Size, string> = {
		sm: 'h-8 px-3 text-sm rounded-[var(--radius-md)]',
		md: 'h-9 px-3.5 text-base rounded-[var(--radius-md)]',
		lg: 'h-11 px-5 text-md rounded-[var(--radius-lg)]',
		icon: 'h-9 w-9 shrink-0 rounded-[var(--radius-md)]'
	};
</script>

<button
	class="{base} {variants[variant]} {sizes[size]} {full ? 'w-full' : ''} {cls}"
	{...rest}
>
	{#if icon}<Icon name={icon} size={size === 'lg' ? 18 : 16} />{/if}
	{@render children?.()}
	{#if iconRight}<Icon name={iconRight} size={size === 'lg' ? 18 : 16} />{/if}
</button>
