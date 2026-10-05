import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const finderScript = `on run argv
  tell application "Finder"
    delete (POSIX file (item 1 of argv) as alias)
  end tell
end run`;

/** Main-process only: callers supply their validated, packaged application bundle. */
export async function trashMacAppBundle(
  bundlePath: string,
  trashItem: (target: string) => Promise<void>,
  runFinder: (target: string) => Promise<void> = trashWithFinder,
): Promise<void> {
  if (!path.posix.isAbsolute(bundlePath) || path.posix.extname(bundlePath) !== ".app") {
    throw new Error("The application bundle could not be located.");
  }
  try {
    await trashItem(bundlePath);
    return;
  } catch {
    // Electron can return a generic error for an administrator-owned bundle.
    // Finder owns both Trash semantics and any macOS authorization dialog.
  }
  await runFinder(bundlePath);
}

async function trashWithFinder(bundlePath: string): Promise<void> {
  try {
    // The path is an argument, never interpolated into AppleScript or a shell.
    await execFileAsync("/usr/bin/osascript", ["-e", finderScript, bundlePath], {
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("(-128)")) {
      throw new Error("Uninstall was cancelled. The application was not moved to Trash.", { cause: error });
    }
    if (detail.includes("(-1743)")) {
      throw new Error("Allow this app to control Finder in System Settings → Privacy & Security → Automation, then retry uninstall. You can also move the app to Trash in Finder.", { cause: error });
    }
    throw new Error("The application could not be moved to Trash. Try moving it to Trash in Finder and enter administrator credentials if asked.", { cause: error });
  }
}
