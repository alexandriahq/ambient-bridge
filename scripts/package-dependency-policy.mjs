export const bridgePackagedDependencyPolicy = Object.freeze({
  // Electron main/preload runtime roots that must be present in app.asar.
  // Pure workspace TypeScript (@ambient/shared) and bundleable JS (effect, zod)
  // are compiled into dist/electron/main.js by Vite; only packages that stay
  // external at bundle time belong here. Transitive dependencies are traversed
  // unless the package is listed in nonTraversedPackageRoots below.
  runtimeDependencyRoots: Object.freeze([
    "electron-updater",
    "tinfoil",
  ]),

  // Electron-main source and renderer dependencies are compiled into dist by
  // Vite. They belong in devDependencies so electron-builder does not copy
  // their complete production graphs into app.asar a second time.
  bundledDependencyRoots: Object.freeze([
    "@alexandria/cloud-contract",
    "@alexandria/inference-contract",
    "@ambient/shared",
    "@lucide/svelte",
    "effect",
    "mode-watcher",
    "svelte",
  ]),

  // This is deliberately generous relative to the current ~20 MiB archive. It
  // catches a dependency-graph regression before a release returns to 200+ MiB.
  maxAsarBytes: 64 * 1024 * 1024,
  nonTraversedPackageRoots: Object.freeze([]),
});
