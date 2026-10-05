// Install Icon Composer assets before signing. macOS 26+ uses the named
// Assets.car rendition; older systems retain the product's legacy .icns.
// Missing tooling is optional. The host chooses whether missing output fails.
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, copyFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

module.exports = function installMacosAppIcon({
  appOutDir,
  projectDir,
  productFilename,
  iconName,
  iconSourceRelativePath,
  missingOutput,
}) {
  const iconSource = path.join(projectDir, iconSourceRelativePath);
  if (!existsSync(iconSource)) {
    console.warn(`[tahoe-icon] ${iconSourceRelativePath} not found; skipping`);
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

  const appName = productFilename;
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
        iconName,
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
      if (missingOutput === "warn") {
        // Older actool versions can accept .icon input without producing a car.
        console.warn(
          "[tahoe-icon] actool did not produce Assets.car (Xcode < 26?); keeping legacy .icns only.",
        );
        return;
      }
      throw new Error("actool did not produce Assets.car");
    }
    copyFileSync(carSrc, path.join(resourcesDir, "Assets.car"));

    // Idempotent add/replace so macOS 26+ resolves the icon from Assets.car.
    execFileSync(
      "plutil",
      ["-replace", "CFBundleIconName", "-string", iconName, infoPlist],
      { stdio: "inherit" },
    );

    console.log(`[tahoe-icon] injected Assets.car + CFBundleIconName into ${appName}.app`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};
