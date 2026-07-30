<script module lang="ts">
	// Lucide-derived 24×24 glyphs. One stroke language across the whole app. The
	// glyph bodies live in a plain-TS module so non-Svelte consumers (e.g. the
	// Electron main process) can import the same set; re-exported here as `glyphs`.
	import { glyphs } from './icon-glyphs';
	export { glyphs };
</script>

<script lang="ts">
	type Props = {
		name?: string;
		size?: number | string;
		stroke?: number | string;
		class?: string;
	};

	let {
		name,
		size = 18,
		stroke = 1.75,
		class: cls = ''
	}: Props = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	class={cls}
	aria-hidden="true"
>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html glyphs[name as keyof typeof glyphs] ?? ''}
</svg>
