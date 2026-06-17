import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [svelte()],
  root: ".",
  optimizeDeps: {
    // @ambient/shared ships raw .svelte/.ts source; esbuild prebundling has
    // no svelte loader, so it must be compiled by vite-plugin-svelte instead.
    exclude: ["@ambient/shared"],
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
  },
});
