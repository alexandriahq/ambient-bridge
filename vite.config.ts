import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const libRoot = fileURLToPath(new URL("./src/lib", import.meta.url));
const svelteSourcePackages = ["@ambient/shared"];

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), svelte()],
  root: ".",
  resolve: {
    alias: {
      $lib: libRoot,
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
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    fs: {
      // `@ambient/shared/theme.css` lives in ../shared, outside root.
      // Fontsource packages (Inter, Noto Serif, JetBrains Mono) are hoisted to
      // the workspace-root node_modules, also outside this app's root.
      allow: [".", "./shared", "./node_modules"],
    },
  },
});
