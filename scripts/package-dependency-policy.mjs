export const bridgePackagedDependencyPolicy = Object.freeze({
  // Electron main/preload runtime roots that must be present in app.asar.
  // Transitive dependencies are traversed unless the package is listed in
  // nonTraversedPackageRoots below.
  runtimeDependencyRoots: Object.freeze([
    "@ambient/shared",
    "effect",
    "electron-updater",
    "tinfoil",
  ]),

  // Renderer dependencies are bundled by Vite into bridge/dist. They are kept
  // classified here so adding a new package dependency requires choosing a
  // release boundary without forcing the asar smoke test to walk styling/UI peer
  // dependency trees that are not loaded by Electron main.
  rendererBundleRoots: Object.freeze([
    "@lucide/svelte",
    "bits-ui",
    "clsx",
    "mode-watcher",
    "svelte",
    "svelte-sonner",
    "tailwind-merge",
    "tailwind-variants",
  ]),

  // Dependencies used by release scripts, not by the packaged app runtime.
  releaseToolingRoots: Object.freeze([
    "semver",
  ]),

  // Declared dependencies that are intentionally not runtime roots today. Keep
  // this list small; removing an entry after deleting/moving the dependency is
  // preferred over expanding packaged runtime verification noise.
  declaredOnlyRoots: Object.freeze([
    "@workos-inc/node",
    "openai",
    "zod",
  ]),

  // @ambient/shared is imported at the compact-auth-window subpath in Electron
  // main. That subpath has no package dependencies; traversing the workspace
  // package root would incorrectly pull renderer/shared UI peers into the Bridge
  // runtime dependency check.
  nonTraversedPackageRoots: Object.freeze([
    "@ambient/shared",
  ]),
});

export function classifyBridgePackageDependencies(dependencies) {
  const declared = new Set(dependencies);
  const classified = allClassifiedDependencyRoots();
  return {
    unclassified: [...declared].filter((dependency) => !classified.has(dependency)).sort(),
    missingFromPackageJson: [...classified].filter((dependency) => !declared.has(dependency)).sort(),
  };
}

export function allClassifiedDependencyRoots() {
  return new Set([
    ...bridgePackagedDependencyPolicy.runtimeDependencyRoots,
    ...bridgePackagedDependencyPolicy.rendererBundleRoots,
    ...bridgePackagedDependencyPolicy.releaseToolingRoots,
    ...bridgePackagedDependencyPolicy.declaredOnlyRoots,
  ]);
}
