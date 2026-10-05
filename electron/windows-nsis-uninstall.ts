import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED_PRODUCT_NAMES = new Set([
  "Ambient Bridge",
  "Ambient Bridge Local",
]);

export type WindowsNsisUninstallOptions = {
  readonly copyFile?: typeof copyFileSync;
  readonly pathExists?: (target: string) => boolean;
  readonly spawnImpl?: (
    command: string,
    args: readonly string[],
    options: { readonly detached?: boolean; readonly stdio?: "ignore"; readonly windowsHide?: boolean },
  ) => ChildProcess;
  readonly tempDir?: string;
};

export function windowsNsisUninstallerPath(input: {
  readonly productName: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly homeDir?: string;
}): string {
  assertAllowedProductName(input.productName);
  const win = path.win32;
  if (input.execPath?.trim()) {
    const installDir = win.dirname(win.normalize(input.execPath));
    const beside = win.join(installDir, `Uninstall ${input.productName}.exe`);
    assertSafeWindowsNsisUninstaller(beside, input.productName);
    return beside;
  }
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();
  const localAppData = env.LOCALAPPDATA?.trim() || win.join(homeDir, "AppData", "Local");
  const uninstaller = win.join(localAppData, "Programs", input.productName, `Uninstall ${input.productName}.exe`);
  assertSafeWindowsNsisUninstaller(uninstaller, input.productName);
  return uninstaller;
}

export function assertSafeWindowsNsisUninstaller(uninstallerPath: string, productName: string): void {
  assertAllowedProductName(productName);
  const win = path.win32;
  const resolved = win.normalize(uninstallerPath);
  if (win.basename(resolved) !== `Uninstall ${productName}.exe`) {
    throw new Error("Windows uninstaller path does not match this Ambient Bridge product.");
  }
  const installDir = win.dirname(resolved);
  if (win.basename(installDir) !== productName) {
    throw new Error("Windows uninstaller is not in this Ambient Bridge product directory.");
  }
  if (win.basename(win.dirname(installDir)) !== "Programs") {
    throw new Error("Windows uninstaller is not under a per-user Programs install.");
  }
}

function assertAllowedProductName(productName: string): void {
  if (!ALLOWED_PRODUCT_NAMES.has(productName)) {
    throw new Error("Windows in-app uninstall is only available for Ambient Bridge installs.");
  }
}

export async function runWindowsNsisUninstaller(
  uninstallerPath: string,
  productName: string,
  options: WindowsNsisUninstallOptions = {},
): Promise<void> {
  assertSafeWindowsNsisUninstaller(uninstallerPath, productName);
  const exists = options.pathExists ?? existsSync;
  if (!exists(uninstallerPath)) {
    throw new Error(`The ${productName} uninstaller was not found.`);
  }
  const copyFile = options.copyFile ?? copyFileSync;
  const staging = path.join(
    options.tempDir ?? os.tmpdir(),
    `ambient-bridge-uninstall-${productName.replace(/\s+/g, "-").toLowerCase()}-${process.pid}.exe`,
  );
  copyFile(uninstallerPath, staging);
  const child = (options.spawnImpl ?? spawn)(staging, ["/S"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
}
