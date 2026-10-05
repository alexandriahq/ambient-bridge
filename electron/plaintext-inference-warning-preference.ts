import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLAINTEXT_INFERENCE_WARNING_PREFERENCE_FILENAME =
  "plaintext-inference-warning.json";

export function plaintextInferenceWarningPreferencePath(userDataDir: string): string {
  return join(userDataDir, PLAINTEXT_INFERENCE_WARNING_PREFERENCE_FILENAME);
}

export function loadPlaintextInferenceWarningHidden(userDataDir: string): boolean {
  try {
    const raw = readFileSync(plaintextInferenceWarningPreferencePath(userDataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return (parsed as { hidden?: unknown }).hidden === true;
  } catch {
    return false;
  }
}

export function persistPlaintextInferenceWarningHidden(
  userDataDir: string,
  hidden: boolean,
): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    plaintextInferenceWarningPreferencePath(userDataDir),
    `${JSON.stringify({ hidden })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
