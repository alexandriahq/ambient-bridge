// electron-builder afterPack hook: adds a macOS 26/Tahoe "Liquid Glass" app icon.
//
// The legacy `mac.icon` .icns only carries a single flat rendition, so on macOS
// 26+ the app can't participate in the system icon theming (Default / Dark /
// Clear / Tinted) and looks inconsistent next to modern apps. Icon Composer's
// `.icon` package compiles (via `actool`) to an `Assets.car` that the system
// composites per appearance. We drop that alongside the .icns and point
// `CFBundleIconName` at it; macOS < 26 keeps falling back to the .icns.
//
// Runs before code-signing, so the injected files are covered by the signature.
// No-ops (with a warning) when not building for macOS or when `actool` is
// unavailable, so builds on non-Tahoe machines still succeed.

const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, copyFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

// Base name of the Icon Composer package (Bridge.icon) and the icon name baked
// into Assets.car — CFBundleIconName must match this exactly.
const ICON_NAME = "Bridge";
const ICON_SOURCE_REL = "resources/Bridge.icon";
const WINDOWS_ICON_REL = "resources/bridge-icon.ico";

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName === "win32" && packager.config.win?.signAndEditExecutable === false) {
    await brandLocalWindowsExecutable(appOutDir, packager);
    return;
  }
  if (electronPlatformName !== "darwin") return;

  const iconSource = path.join(packager.projectDir, ICON_SOURCE_REL);
  if (!existsSync(iconSource)) {
    console.warn(`[tahoe-icon] ${ICON_SOURCE_REL} not found; skipping`);
    return;
  }

  let actoolFound = true;
  try {
    execFileSync("xcrun", ["--find", "actool"], { stdio: "ignore" });
  } catch {
    actoolFound = false;
  }
  if (!actoolFound) {
    console.warn(
      "[tahoe-icon] `xcrun actool` unavailable (needs Xcode 26+); " +
        "keeping legacy .icns only.",
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const contentsDir = path.join(appOutDir, `${appName}.app`, "Contents");
  const resourcesDir = path.join(contentsDir, "Resources");
  const infoPlist = path.join(contentsDir, "Info.plist");
  if (!existsSync(resourcesDir) || !existsSync(infoPlist)) {
    console.warn(`[tahoe-icon] ${appName}.app layout unexpected; skipping`);
    return;
  }

  const outDir = mkdtempSync(path.join(tmpdir(), "tahoe-icon-"));
  try {
    execFileSync(
      "xcrun",
      [
        "actool",
        iconSource,
        "--compile",
        outDir,
        "--app-icon",
        ICON_NAME,
        "--include-all-app-icons",
        "--output-partial-info-plist",
        path.join(outDir, "partial.plist"),
        "--target-device",
        "mac",
        "--minimum-deployment-target",
        "26.0",
        "--platform",
        "macosx",
        "--output-format",
        "human-readable-text",
      ],
      { stdio: "inherit" },
    );

    const carSrc = path.join(outDir, "Assets.car");
    if (!existsSync(carSrc)) {
      // Old-Xcode actool (< 26) exits 0 for .icon inputs without emitting
      // Assets.car; treat it like actool-unavailable and keep the legacy
      // .icns instead of failing the whole release build.
      console.warn(
        "[tahoe-icon] actool did not produce Assets.car (Xcode < 26?); keeping legacy .icns only.",
      );
      return;
    }
    copyFileSync(carSrc, path.join(resourcesDir, "Assets.car"));

    // Idempotent add/replace so macOS 26+ resolves the icon from Assets.car.
    execFileSync(
      "plutil",
      ["-replace", "CFBundleIconName", "-string", ICON_NAME, infoPlist],
      { stdio: "inherit" },
    );

    console.log(`[tahoe-icon] injected Assets.car + CFBundleIconName into ${appName}.app`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};

async function brandLocalWindowsExecutable(appOutDir, packager) {
  // Local Windows builds disable electron-builder's cross-platform signing
  // archive, so apply the same executable resources with Windows-only rcedit.
  const { rcedit } = require("rcedit");
  const appName = packager.appInfo.productFilename;
  const executable = path.join(appOutDir, `${appName}.exe`);
  const icon = path.join(packager.projectDir, WINDOWS_ICON_REL);
  if (!existsSync(executable) || !existsSync(icon)) {
    throw new Error(`[windows-branding] missing executable or icon: ${executable}, ${icon}`);
  }

  const productVersion = packager.appInfo.version;
  const numeric = productVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!numeric) throw new Error(`[windows-branding] unsupported app version: ${productVersion}`);
  const fileVersion = `${numeric[1]}.${numeric[2]}.${numeric[3]}.0`;
  await rcedit(executable, {
    icon,
    "file-version": fileVersion,
    "product-version": fileVersion,
    "version-string": {
      CompanyName: "Ambient",
      FileDescription: appName,
      InternalName: appName,
      OriginalFilename: `${appName}.exe`,
      ProductName: appName,
      ProductVersion: productVersion,
    },
    "requested-execution-level": "asInvoker",
  });
  console.log(
    `[windows-branding] embedded ${WINDOWS_ICON_REL} and ${productVersion} metadata into ${appName}.exe`,
  );
}
