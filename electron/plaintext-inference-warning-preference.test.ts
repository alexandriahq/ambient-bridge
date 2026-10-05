import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPlaintextInferenceWarningHidden,
  persistPlaintextInferenceWarningHidden,
  plaintextInferenceWarningPreferencePath,
} from "./plaintext-inference-warning-preference.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ambient-plaintext-warning-"));
  tempDirs.push(dir);
  return dir;
}

describe("plaintext inference warning preference", () => {
  it("defaults visible and persists only an explicit hidden boolean", async () => {
    const userDataDir = await tempUserData();
    expect(loadPlaintextInferenceWarningHidden(userDataDir)).toBe(false);

    persistPlaintextInferenceWarningHidden(userDataDir, true);
    expect(loadPlaintextInferenceWarningHidden(userDataDir)).toBe(true);

    persistPlaintextInferenceWarningHidden(userDataDir, false);
    expect(loadPlaintextInferenceWarningHidden(userDataDir)).toBe(false);
  });

  it("fails open to the warning for malformed preference files", async () => {
    const userDataDir = await tempUserData();
    writeFileSync(
      plaintextInferenceWarningPreferencePath(userDataDir),
      JSON.stringify({ hidden: "yes" }),
    );
    expect(loadPlaintextInferenceWarningHidden(userDataDir)).toBe(false);
  });
});
