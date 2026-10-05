import { execFileSync, spawn } from "node:child_process";

/** Launch pnpm without a shell on POSIX, through its command wrapper on Windows. */
export function spawnDevProcess(args, options) {
  return process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], options)
    : spawn("pnpm", args, options);
}

export function terminateDevProcess(child) {
  if (process.platform !== "win32") return child.kill("SIGTERM");
  if (!child.pid) return false;
  try {
    // cmd.exe -> pnpm -> Electron must stop together to release the app lock.
    execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return true;
  } catch {
    return child.exitCode !== null || child.signalCode !== null;
  }
}

/** Owns child mechanics; product launchers retain startup, restart and exit policy. */
export function createDevProcessGroup({ cwd, env, onFailure, onExit }) {
  const children = new Set();
  let stopped = false;
  return {
    start(label, args, options = {}) {
      if (stopped) throw new Error("Development process group is stopped");
      let child;
      try {
        child = spawnDevProcess(args, { cwd, env: options.env ?? env, stdio: ["inherit", "pipe", "pipe"] });
      } catch (error) {
        onFailure(label, error);
        throw error;
      }
      children.add(child);
      let resolveReady, rejectReady, resolveExit, rejectExit;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
      // Some watchers start before their readiness promise is awaited.
      ready.catch(() => {});
      exited.catch(() => {});
      const output = (data, stream) => {
        const text = data.toString();
        for (const line of text.split(/\r?\n/)) if (line) stream.write(`[${label}] ${line}\n`);
        options.onOutput?.(text);
        if (options.readyPattern?.test(text)) resolveReady();
      };
      child.stdout.on("data", (data) => output(data, process.stdout));
      child.stderr.on("data", (data) => output(data, process.stderr));
      child.once("error", (error) => {
        children.delete(child);
        rejectReady(error);
        rejectExit(error);
        onFailure(label, error);
      });
      child.once("close", () => children.delete(child));
      child.once("exit", (code, signal) => {
        children.delete(child);
        resolveExit({ code, signal });
        rejectReady(new Error(`${label} exited before becoming ready`));
        console.log(`[${label}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        if (options.onExit?.(code, signal) !== true) onExit(code, signal, options.exitEndsSession === true);
      });
      return { child, ready, exited };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const owned = [...children];
      children.clear();
      for (const child of owned) {
        try { terminateDevProcess(child); }
        catch (error) { onFailure("shutdown", error); }
      }
    },
  };
}
