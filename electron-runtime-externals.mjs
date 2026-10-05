import { builtinModules } from "node:module";

// Keep native / installer-managed packages external so Vite does not try to
// bundle them into the Electron main entry. Pure TypeScript workspace modules
// (including @ambient/shared) are bundled — the industry-standard Electron +
// Vite approach, matching @ambient/app.
export const electronRuntimePackageExternals = [
  "electron",
  "electron-updater",
  "tinfoil",
];

export const electronRuntimeExternals = [
  ...electronRuntimePackageExternals,
  ...builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
];
