import { createDevProcessGroup, terminateDevProcess } from "./dev-processes.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquireDevProductLock,
  assertDevRendererPortReady,
  extractViteLocalUrl,
  rendererVitePortArgs,
  resolveDevRendererPort,
} from "./dev-renderer.mjs";

const bridgeRoot = new URL("..", import.meta.url);
const repoRoot = new URL("..", bridgeRoot);
const buildConfigGeneratorPath = fileURLToPath(new URL("./generate-build-config.mjs", import.meta.url));
const generatedBuildConfigPath = fileURLToPath(new URL("../electron/generated/build-config.ts", import.meta.url));
const portConfig = resolveDevRendererPort({
  defaultPort: 5174,
  env: process.env,
  envName: "AMBIENT_BRIDGE_DEV_PORT",
});
const initialUrl = portConfig.url;
// Source-backed Bridge runs must use the `.dev` AppUserModelID, never the
// bare production identity shared with installed Ambient Bridge (#520).
process.env.AMBIENT_DESKTOP_VARIANT = "dev";
const devLock = acquireDevProductLock({
  lockName: "ambient-bridge",
  productName: "Ambient Bridge",
  repoRoot,
});

let electronChild;
let electronRestartTimer;
let restartAfterElectronExit = false;
let shuttingDown = false;
let rendererUrl = initialUrl;
let rendererUrlResolved = portConfig.strict;
let rendererOutputBuffer = "";
let mainRebuildPending = false;
let resolveRendererUrl;
const rendererUrlReady = portConfig.strict
  ? Promise.resolve(initialUrl)
  : new Promise((resolve) => {
    resolveRendererUrl = resolve;
  });

const processes = createDevProcessGroup({
  cwd: bridgeRoot,
  env: process.env,
  onFailure: (label, error) => {
    console.error(`[${label}] failed to start: ${error.message}`);
    shutdown(1);
  },
  onExit: (code, signal, exitEndsSession) => {
    if (exitEndsSession || (!shuttingDown && code !== 0)) shutdown(code ?? (signal ? 1 : 0));
  },
});
const start = processes.start;

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => devLock.release());

await assertDevRendererPortReady(portConfig, "Bridge renderer");

// electron/generated/build-config.ts is gitignored and imported by the Vite
// main bundle. There is no runtime server-URL override. Dev bakes staging
// unless AMBIENT_SERVER_TARGET or AMBIENT_BRIDGE_BUILD_SERVER_URL is set
// (the `stack` flow sets the latter to the local server).
refreshBuildConfig({ alwaysLog: true });
watchFile(buildConfigGeneratorPath, { interval: 500 }, (current, previous) => {
  if (shuttingDown || current.mtimeMs === previous.mtimeMs) return;
  refreshBuildConfigAfterStartup();
});

const vite = start("vite", [
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  ...rendererVitePortArgs(portConfig),
], {
  onOutput: inspectRendererOutput,
  readyPattern: /ready in|Local:\s+http:\/\/127\.0\.0\.1:/,
});

const main = start("main", [
  "exec",
  "vite",
  "build",
  "--config",
  "vite.main.config.ts",
  "--watch",
], {
  onOutput: inspectMainOutput,
  // Do not treat Vite's initial "watching" banner as a completed build.
  readyPattern: /built in/i,
});

const preload = start("preload", [
  "exec",
  "vite",
  "build",
  "--config",
  "vite.preload.config.ts",
  "--watch",
], {
  readyPattern: /built in/i,
});

void waitForDevReady().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bridge dev] ${message}`);
  shutdown(1);
});

async function waitForDevReady() {
  const activeRendererUrl = await rendererUrlReady;
  await Promise.all([vite.ready, main.ready, preload.ready]);
  await waitForFile("dist/electron/main.js");
  await waitForFile("dist/electron/preload.cjs");
  await waitForHttp(activeRendererUrl);
  startElectron(activeRendererUrl);
}

function startElectron(activeRendererUrl) {
  if (electronChild || shuttingDown) return;
  // Expose the Chrome DevTools Protocol on a fixed localhost port so tools like
  // the Claude Code preview can attach and drive the renderer while all the
  // normal Electron IPC keeps working. Uses a different port from the Ambient
  // app (9222) so both can run at once. Override with
  // AMBIENT_BRIDGE_DEVTOOLS_PORT, or set it to 0 to disable.
  const devtoolsPort = process.env.AMBIENT_BRIDGE_DEVTOOLS_PORT ?? "9223";
  const devtoolsArgs = devtoolsPort === "0"
    ? []
    : [`--remote-debugging-port=${devtoolsPort}`, "--remote-allow-origins=*"];
  if (devtoolsArgs.length > 0) {
    console.log(`[electron] Chrome DevTools Protocol on http://127.0.0.1:${devtoolsPort}`);
  }
  let launched;
  launched = start("electron", ["exec", "electron", ".", ...devtoolsArgs], {
    env: {
      ...process.env,
      AMBIENT_BRIDGE_OPEN_DEVTOOLS: process.env.AMBIENT_BRIDGE_OPEN_DEVTOOLS ?? "0",
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_ENABLE_STACK_DUMPING: "1",
      VITE_DEV_SERVER_URL: activeRendererUrl,
    },
    exitEndsSession: true,
    onExit: () => {
      if (electronChild === launched.child) electronChild = undefined;
      if (!restartAfterElectronExit || shuttingDown) return false;
      restartAfterElectronExit = false;
      startElectron(rendererUrl);
      return true;
    },
  });
  electronChild = launched.child;
}

function inspectRendererOutput(text) {
  if (rendererUrlResolved) return;
  rendererOutputBuffer = `${rendererOutputBuffer}${text}`.slice(-4_000);
  const detectedUrl = extractViteLocalUrl(rendererOutputBuffer);
  if (!detectedUrl) return;
  rendererUrl = detectedUrl;
  rendererUrlResolved = true;
  if (rendererUrl !== initialUrl) {
    console.log(`[vite] default port ${portConfig.port} unavailable; using ${rendererUrl}`);
  }
  resolveRendererUrl(rendererUrl);
}

function inspectMainOutput(text) {
  // Vite watch rebuilds print "built in …" after each successful emit. Restart
  // Electron so preload/IPC/baked config changes are never left stale.
  if (/built in/i.test(text)) {
    if (!mainRebuildPending) {
      mainRebuildPending = true;
      return;
    }
    if (refreshBuildConfigAfterStartup()) return;
    scheduleElectronRestart();
  }
}

function refreshBuildConfig({ alwaysLog = false } = {}) {
  const previous = readOptionalFile(generatedBuildConfigPath);
  const output = execFileSync(process.execPath, [buildConfigGeneratorPath], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const changed = previous !== readOptionalFile(generatedBuildConfigPath);
  if ((alwaysLog || changed) && output) process.stdout.write(output);
  return changed;
}

function refreshBuildConfigAfterStartup() {
  try {
    return refreshBuildConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bridge dev] could not refresh baked build config: ${message}`);
    shutdown(1);
    return true;
  }
}

function readOptionalFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function scheduleElectronRestart() {
  if (!electronChild || shuttingDown) return;
  clearTimeout(electronRestartTimer);
  electronRestartTimer = setTimeout(() => {
    electronRestartTimer = undefined;
    if (!electronChild || shuttingDown) return;
    console.log("[electron] main-process build changed; restarting Electron");
    restartAfterElectronExit = true;
    if (!terminateDevProcess(electronChild)) {
      restartAfterElectronExit = false;
      console.error("[electron] could not stop the stale main process after rebuild");
    }
  }, 150);
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(new URL(`../${path}`, import.meta.url))) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForHttp(target) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch {
      // Vite is still warming up.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${target}`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(electronRestartTimer);
  restartAfterElectronExit = false;
  unwatchFile(buildConfigGeneratorPath);
  processes.stop();
  setTimeout(() => {
    devLock.release();
    process.exit(code);
  }, 100).unref();
}
