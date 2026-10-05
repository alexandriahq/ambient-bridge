<script lang="ts">
	type Props = {
		/** Mock dots' top offset in px; match the window's `trafficLightPosition.y`. */
		top?: number;
	};

	let { top = 18 }: Props = $props();

	// Browser mock (no Electron preload) paints fake chrome. Inside Electron the
	// real OS controls render, so these hide themselves. The app and Bridge
	// preloads expose their native window markers.
	const isWeb =
		typeof window !== "undefined" &&
		!(window as Window & { ambient?: unknown; ambientBridge?: unknown }).ambient &&
		!(window as Window & { ambient?: unknown; ambientBridge?: unknown }).ambientBridge;

	const platform =
		typeof document !== "undefined"
			? document.documentElement.getAttribute("data-platform")
			: null;
	// macOS: OS traffic lights sit on the left. Windows and Linux use the OS
	// title bar, so this row does not reserve a left 70px dead zone or paint
	// Mac dots there.
	const showMockMacLights = isWeb && platform !== "win32" && platform !== "linux";
	const reserveMacTrafficLights = !isWeb && platform !== "win32" && platform !== "linux";
</script>

{#if showMockMacLights}
	<!-- Match Electron `trafficLightPosition` (`top` = its y). The real macOS
	     lights are 14px dots on a 23px pitch; smaller mock dots put the mock's
	     centre 1px above the real one, so chrome aligned to the mock sat high. -->
	<div class="w-[70px] shrink-0" aria-hidden="true"></div>
	<div
		class="pointer-events-none absolute left-[18px] z-40 flex items-center gap-[9px]"
		style:top="{top}px"
		data-traffic-lights="darwin"
		aria-hidden="true"
	>
		<span class="size-3.5 rounded-full bg-[#ff5f57] ring-1 ring-inset ring-black/10"></span>
		<span class="size-3.5 rounded-full bg-[#febc2e] ring-1 ring-inset ring-black/10"></span>
		<span class="size-3.5 rounded-full bg-[#28c840] ring-1 ring-inset ring-black/10"></span>
	</div>
{:else if reserveMacTrafficLights}
	<!-- Electron macOS: the real OS traffic lights render here; reserve their
	     width so whatever follows (e.g. the sidebar toggle) sits beside them. -->
	<div class="w-[70px] shrink-0" data-traffic-lights="darwin-reserve" aria-hidden="true"></div>
{/if}
