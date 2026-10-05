import { defineConfig } from "vite";
import { builtinModules } from "node:module";

const preloadEntry = "electron/preload.ts";
const nodeBuiltins = builtinModules.flatMap((moduleName) => [
  moduleName,
  `node:${moduleName}`,
]);

// Sandboxed preload stays a separate CJS bundle beside main.js.
export default defineConfig({
  build: {
    license: { fileName: "PRELOAD_THIRD_PARTY_LICENSES.md" },
    outDir: "dist/electron",
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      formats: ["cjs"],
      entry: preloadEntry,
      fileName: "preload",
    },
    rollupOptions: {
      external: ["electron", ...nodeBuiltins],
    },
  },
});
