export function isMissingAppleAgreementError(output) {
  return /required agreement/i.test(output) && /missing|expired/i.test(output);
}

export function summarizeNotaryOutput(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}
