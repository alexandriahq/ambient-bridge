// electron-builder afterPack hook: closes the packaged dependency graph and
// adds platform-native branding before Electron Builder signs the result.

const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Base name of the Icon Composer package (Bridge.icon) and the icon name baked
// into Assets.car — CFBundleIconName must match this exactly.
const ICON_NAME = "Bridge";
const ICON_SOURCE_REL = "resources/Bridge.icon";
const WINDOWS_ICON_REL = "resources/bridge-icon.ico";

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  await pruneRuntimeArchive(context);
  if (electronPlatformName === "win32" && packager.config.win?.signAndEditExecutable === false) {
    await brandLocalWindowsExecutable(appOutDir, packager);
    return;
  }
  if (electronPlatformName !== "darwin") return;

  const installMacosAppIcon = require("@ambient/shared/macos-app-icon");
  installMacosAppIcon({
    appOutDir,
    projectDir: packager.projectDir,
    productFilename: packager.appInfo.productFilename,
    iconName: ICON_NAME,
    iconSourceRelativePath: ICON_SOURCE_REL,
    missingOutput: "warn",
  });
};

async function pruneRuntimeArchive({ appOutDir, electronPlatformName, packager }) {
  const appName = packager.appInfo.productFilename;
  const resourcesDir = electronPlatformName === "darwin"
    ? path.join(appOutDir, `${appName}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");
  const archive = path.join(resourcesDir, "app.asar");
  if (!existsSync(archive)) {
    throw new Error(`[bridge-package] missing packaged archive: ${archive}`);
  }

  const policyUrl = pathToFileURL(path.join(__dirname, "package-dependency-policy.mjs")).href;
  const prunerUrl = pathToFileURL(path.join(__dirname, "prune-packaged-app.mjs")).href;
  const [{ bridgePackagedDependencyPolicy }, { prunePackagedApp }] = await Promise.all([
    import(policyUrl),
    import(prunerUrl),
  ]);
  const result = await prunePackagedApp({
    archive,
    dependencyResolutionRoot: findPnpmResolutionRoot(packager.projectDir),
    dependencySourceRoot: packager.projectDir,
    runtimeDependencyRoots: bridgePackagedDependencyPolicy.runtimeDependencyRoots,
  });
  console.log(
    `[bridge-package] pruned app.asar to ${(result.archiveBytes / 1024 / 1024).toFixed(1)} MiB ` +
      `(${result.packages.length} runtime packages)`,
  );
}

function findPnpmResolutionRoot(projectDir) {
  let cursor = projectDir;
  while (true) {
    if (existsSync(path.join(cursor, "pnpm-lock.yaml"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return projectDir;
    cursor = parent;
  }
}

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
