import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.AMBIENT_BRIDGE_DEV_PORT ?? 5174);
const url = `http://127.0.0.1:${port}`;
const children = new Set();
const packageManager = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";

let electronStarted = false;
let shuttingDown = false;

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const vite = start("vite", [
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
], {
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
  readyPattern: /Found 0 errors|Watching for file changes/,
});

void waitForDevReady();

async function waitForDevReady() {
  await Promise.all([vite.ready, tsc.ready]);
  await waitForFile("dist/electron/main.js");
  await waitForHttp(url);
  startElectron();
}

function startElectron() {
  if (electronStarted) return;
  electronStarted = true;
  start("electron", ["exec", "electron", "."], {
    env: {
      ...process.env,
      AMBIENT_BRIDGE_OPEN_DEVTOOLS: process.env.AMBIENT_BRIDGE_OPEN_DEVTOOLS ?? "0",
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_ENABLE_STACK_DUMPING: "1",
      VITE_DEV_SERVER_URL: url,
    },
    exitEndsSession: true,
  });
}

function start(label, args, options = {}) {
  const packageManagerArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm", ...args]
    : args;
  const child = spawn(packageManager, packageManagerArgs, {
    cwd: new URL("..", import.meta.url),
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
    if (options.readyPattern?.test(text)) markReady();
  });

  child.stderr.on("data", (data) => {
    const text = data.toString();
    prefix(label, text, true);
    if (options.readyPattern?.test(text)) markReady();
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    console.log(`[${label}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (options.exitEndsSession) shutdown(code ?? (signal ? 1 : 0));
  });

  return { child, ready };
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
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 100).unref();
}
