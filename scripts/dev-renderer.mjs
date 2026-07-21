import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const VITE_LOCAL_URL_PATTERN = /\bLocal:\s+(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?)/i;
const DEFAULT_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

export function resolveDevRendererPort(options) {
  const raw = options.env?.[options.envName]?.trim();
  if (!raw) {
    return {
      envName: options.envName,
      port: options.defaultPort,
      strict: false,
      url: devServerUrl(options.defaultPort),
    };
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${options.envName} must be a TCP port between 1 and 65535, got "${raw}".`);
  }

  return {
    envName: options.envName,
    port,
    strict: true,
    url: devServerUrl(port),
  };
}

export function rendererVitePortArgs(portConfig) {
  return portConfig.strict
    ? ["--port", String(portConfig.port), "--strictPort"]
    : ["--port", String(portConfig.port)];
}

export async function assertDevRendererPortReady(portConfig, label) {
  if (!portConfig.strict) return;
  await assertPortAvailable(portConfig.port, label, portConfig.envName);
}

export async function assertPortAvailable(targetPort, label, envName) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`${label} dev port ${targetPort} is already in use. Stop the stale dev server or set ${envName}.`));
        return;
      }
      reject(error);
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(targetPort, "127.0.0.1");
  });
}

export function extractViteLocalUrl(output) {
  const match = stripAnsi(output).match(VITE_LOCAL_URL_PATTERN);
  return match ? normalizeDevServerUrl(match[1]) : null;
}

export function devServerUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function normalizeDevServerUrl(url) {
  return url.replace(/\/$/, "");
}

export function acquireDevProductLock(options) {
  const repoRoot = path.resolve(pathFrom(options.repoRoot));
  const lockRoot = options.lockRoot
    ? path.resolve(pathFrom(options.lockRoot))
    : path.join(os.tmpdir(), "ambient-dev-locks");
  const lockDir = path.join(lockRoot, `${safeSegment(options.lockName)}-${shortHash(repoRoot)}.lock`);
  const ownerPath = path.join(lockDir, "owner.json");
  const ownerId = randomUUID();
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;

  mkdirSync(lockRoot, { recursive: true });

  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerPath, `${JSON.stringify({
        command: process.argv.join(" "),
        lockName: options.lockName,
        ownerId,
        pid: process.pid,
        productName: options.productName,
        repoRoot,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (isStaleLock(lockDir, ownerPath, staleMs)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      const owner = readLockOwner(ownerPath);
      const ownerText = owner?.pid ? `pid ${owner.pid}` : "another process";
      throw new Error(`${options.productName} dev is already running for this worktree (${ownerText}). Stop it before starting another ${options.productName} dev session.`);
    }
  }

  let released = false;
  return {
    lockDir,
    ownerId,
    release() {
      if (released) return;
      released = true;
      const owner = readLockOwner(ownerPath);
      if (owner?.ownerId === ownerId) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    },
  };
}

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function isStaleLock(lockDir, ownerPath, staleMs) {
  const owner = readLockOwner(ownerPath);
  if (owner?.pid && !processIsAlive(owner.pid)) return true;
  if (owner?.pid) return false;
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function readLockOwner(ownerPath) {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pathFrom(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

function safeSegment(value) {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "default";
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
