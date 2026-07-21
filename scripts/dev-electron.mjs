import { execFileSync, spawn } from "node:child_process";
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
const children = new Set();
const packageManager = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
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
let tscOutputBuffer = "";
let tscRebuildPending = false;
let resolveRendererUrl;
const rendererUrlReady = portConfig.strict
  ? Promise.resolve(initialUrl)
  : new Promise((resolve) => {
    resolveRendererUrl = resolve;
  });

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => devLock.release());

await assertDevRendererPortReady(portConfig, "Bridge renderer");

// electron/generated/build-config.ts is gitignored and required for tsc; make
// sure it exists before the watch build starts. There is no runtime server-URL
// override, so dev uses the same production API default as packaged releases.
// Set AMBIENT_BRIDGE_BUILD_SERVER_URL to deliberately bake a staging or local
// target (the `stack` flow sets it to the local server).
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

const tsc = start("tsc", [
  "exec",
  "tsc",
  "-p",
  "tsconfig.electron.json",
  "--watch",
  "--preserveWatchOutput",
], {
  onOutput: inspectTscOutput,
  readyPattern: /Found 0 errors|Watching for file changes/,
});

void waitForDevReady().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bridge dev] ${message}`);
  shutdown(1);
});

async function waitForDevReady() {
  const activeRendererUrl = await rendererUrlReady;
  await Promise.all([vite.ready, tsc.ready]);
  await waitForFile("dist/electron/main.js");
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

function start(label, args, options = {}) {
  const packageManagerArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm", ...args]
    : args;
  const child = spawn(packageManager, packageManagerArgs, {
    cwd: bridgeRoot,
    env: options.env ?? process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.add(child);

  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const markReady = once(() => readyResolve());

  child.stdout.on("data", (data) => {
    const text = data.toString();
    prefix(label, text, false);
    options.onOutput?.(text);
    if (options.readyPattern?.test(text)) markReady();
  });

  child.stderr.on("data", (data) => {
    const text = data.toString();
    prefix(label, text, true);
    options.onOutput?.(text);
    if (options.readyPattern?.test(text)) markReady();
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    console.log(`[${label}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    const exitHandled = options.onExit?.(code, signal) === true;
    if (!exitHandled && (options.exitEndsSession || (!shuttingDown && code !== 0))) {
      shutdown(code ?? (signal ? 1 : 0));
    }
  });

  return { child, ready };
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

function inspectTscOutput(text) {
  tscOutputBuffer = `${tscOutputBuffer}${text}`;
  const lines = tscOutputBuffer.split(/\r?\n/);
  tscOutputBuffer = lines.pop() ?? "";

  for (const line of lines) {
    if (line.includes("File change detected")) {
      tscRebuildPending = true;
      continue;
    }
    if (tscRebuildPending && line.includes("Found 0 errors")) {
      tscRebuildPending = false;
      // A branch switch can change both Electron source and the script that
      // generates the baked server target. Compile that generated update before
      // replacing main so the restarted process cannot keep an old realm.
      if (refreshBuildConfigAfterStartup()) continue;
      scheduleElectronRestart();
    }
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
    if (!terminateChild(electronChild)) {
      restartAfterElectronExit = false;
      console.error("[electron] could not stop the stale main process after rebuild");
    }
  }, 150);
}

function terminateChild(child) {
  if (process.platform !== "win32") return child.kill("SIGTERM");
  if (!child.pid) return false;
  try {
    // The Windows launcher is cmd.exe -> pnpm -> Electron. Terminating only the
    // wrapper orphans Electron and leaves the Bridge single-instance lock held.
    execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return true;
  } catch {
    return child.exitCode !== null || child.signalCode !== null;
  }
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

function prefix(label, text, isError) {
  const stream = isError ? process.stderr : process.stdout;
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[${label}] ${line}\n`);
  }
}

function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(electronRestartTimer);
  restartAfterElectronExit = false;
  unwatchFile(buildConfigGeneratorPath);
  for (const child of children) {
    terminateChild(child);
  }
  setTimeout(() => {
    devLock.release();
    process.exit(code);
  }, 100).unref();
}
