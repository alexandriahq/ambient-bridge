import { defineConfig } from "vite";
import { electronRuntimeExternals } from "./electron-runtime-externals.mjs";

const mainEntry = "electron/main.ts";

// Electron main is bundled with Vite (same approach as @ambient/app). Workspace
// TypeScript — including @ambient/shared — is compiled into dist/electron/main.js
// so packaged Node never has to load .ts from node_modules.
export default defineConfig({
  resolve: {
    // Electron main runs in Node; avoid Vite's default `browser` condition.
    conditions: ["node"],
  },
  build: {
    license: { fileName: "MAIN_THIRD_PARTY_LICENSES.md" },
    outDir: "dist/electron",
    // Keep false so parallel/watch preload emits are not wiped (same as
    // ambient-app). Production `build:electron` cleans dist/electron first.
    emptyOutDir: false,
    // Keep readable names for crash stacks and packaged-smoke symbol checks.
    minify: false,
    sourcemap: true,
    lib: {
      formats: ["es"],
      entry: mainEntry,
      fileName: "main",
    },
    rollupOptions: {
      external: [...electronRuntimeExternals],
      output: {
        banner:
          "import { createRequire as __ambientCreateRequire } from 'node:module';\nconst require = __ambientCreateRequire(import.meta.url);",
      },
    },
  },
});
