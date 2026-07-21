import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const designRoot = fileURLToPath(new URL("./shared/src/design", import.meta.url));
const svelteSourcePackages = ["@ambient/shared", "@iconify/svelte"];

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), svelte()],
  root: ".",
  resolve: {
    // The shadcn-svelte primitives in @ambient/shared/design import each other
    // via the `$design` alias; resolve it to the shared package source.
    alias: {
      $design: designRoot,
    },
  },
  optimizeDeps: {
    // These packages ship raw .svelte/.ts source; esbuild prebundling has no
    // svelte loader, so they must be compiled by vite-plugin-svelte instead.
    exclude: svelteSourcePackages,
  },
  ssr: {
    noExternal: svelteSourcePackages,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    fs: {
      // `@ambient/shared/design/tokens.css` lives in ../shared, outside root.
      // Fontsource packages (Inter, Noto Serif, JetBrains Mono) are hoisted to
      // the workspace-root node_modules, also outside this app's root.
      allow: [".", "./shared", "./node_modules"],
    },
  },
});
