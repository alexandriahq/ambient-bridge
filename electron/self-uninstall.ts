import { trashMacAppBundle } from "@ambient/shared/macos-trash";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { runWindowsNsisUninstaller, windowsNsisUninstallerPath } from "./windows-nsis-uninstall.js";

const execFileAsync = promisify(execFile);
const LINUX_DPKG_TIMEOUT_MS = 10 * 60_000;
const DEBIAN_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,63}$/i;

export type BridgeUninstallMethod = "trash" | "pkexec" | "nsis";

export type BridgeUninstallAvailability = {
  readonly available: boolean;
  readonly reason: string | null;
  readonly method: BridgeUninstallMethod | null;
};

export type BridgeUninstallResult = {
  readonly status: "uninstalled";
};

export function bridgeAppBundlePath(options: {
  readonly execPath: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
}): string | null {
  if (!options.packaged || options.platform !== "darwin") return null;
  // The path describes the target platform, which can differ from the runner
  // executing a cross-platform test. Always parse a declared macOS path with
  // POSIX semantics so Windows does not rewrite it as `C:\\Applications\\…`.
  let current = path.posix.resolve(options.execPath);
  while (true) {
    if (path.posix.extname(current).toLowerCase() === ".app") {
      return /^Ambient Bridge(?: Local)?\.app$/i.test(path.posix.basename(current)) ? current : null;
    }
    const parent = path.posix.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function bridgeUninstallAvailability(options: {
  readonly execPath: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
}): BridgeUninstallAvailability {
  if (!options.packaged) {
    return { available: false, reason: "Uninstall is available in packaged Bridge builds.", method: null };
  }
  if (options.platform === "linux") {
    return { available: true, reason: null, method: "pkexec" };
  }
  if (options.platform === "win32") {
    return { available: true, reason: null, method: "nsis" };
  }
  if (options.platform !== "darwin") {
    return { available: false, reason: "Use your system app settings to uninstall Ambient Bridge.", method: null };
  }
  if (!bridgeAppBundlePath(options)) {
    return { available: false, reason: "The Ambient Bridge application could not be located.", method: null };
  }
  return { available: true, reason: null, method: "trash" };
}

export async function uninstallPackagedBridge(options: {
  readonly execPath: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly productName?: string;
  readonly trashItem: (target: string) => Promise<void>;
  readonly trashWithFinder?: (target: string) => Promise<void>;
  readonly removeDebOwningPath?: (target: string) => Promise<void>;
  readonly runNsisUninstaller?: (uninstallerPath: string, productName: string) => Promise<void>;
}): Promise<void> {
  const availability = bridgeUninstallAvailability(options);
  if (!availability.available) {
    throw new Error(availability.reason ?? "Ambient Bridge cannot be uninstalled here.");
  }
  if (options.platform === "linux") {
    const remove = options.removeDebOwningPath ?? removeLinuxDebOwningPath;
    await remove(options.execPath);
    return;
  }
  if (options.platform === "win32") {
    const productName = options.productName === "Ambient Bridge Local" ? "Ambient Bridge Local" : "Ambient Bridge";
    const uninstaller = windowsNsisUninstallerPath({
      execPath: options.execPath,
      productName,
    });
    const run = options.runNsisUninstaller ?? runWindowsNsisUninstaller;
    await run(uninstaller, productName);
    return;
  }
  const appBundlePath = bridgeAppBundlePath(options);
  if (!appBundlePath) throw new Error("The Ambient Bridge application could not be located.");
  await trashMacAppBundle(appBundlePath, options.trashItem, options.trashWithFinder);
}

async function removeLinuxDebOwningPath(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  let stdout = "";
  try {
    const result = await execFileAsync("/usr/bin/dpkg-query", ["-S", resolved], {
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    stdout = String(result.stdout ?? "");
  } catch {
    throw new Error("This install was not found as a .deb package. Use your system package manager.");
  }
  const packages = new Set(
    stdout.split("\n")
      .map((line) => line.split(":")[0]?.trim())
      .filter((name): name is string => Boolean(name && DEBIAN_PACKAGE_NAME.test(name))),
  );
  if (packages.size !== 1) {
    throw new Error("This install was not found as a .deb package. Use your system package manager.");
  }
  const packageName = [...packages][0]!;
  try {
    await execFileAsync("/usr/bin/pkexec", ["/usr/bin/dpkg", "--remove", packageName], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: LINUX_DPKG_TIMEOUT_MS,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("PolicyKit (pkexec) is required to uninstall Ambient Bridge.");
    }
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === 126 || code === 127) {
      throw new Error("Authentication was cancelled. Ambient needs administrator permission to uninstall Ambient Bridge.");
    }
    throw new Error("Ambient Bridge package uninstall failed.");
  }
}
