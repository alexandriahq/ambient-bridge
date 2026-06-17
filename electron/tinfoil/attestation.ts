export type AttestationStatus =
  | { kind: "unknown" }
  | { kind: "valid"; verifiedAt: number }
  | { kind: "invalid"; reason: string };

export function refuseInvalidAttestation(status: AttestationStatus): void {
  if (status.kind !== "valid") {
    throw new Error(status.kind === "invalid" ? status.reason : "Tinfoil attestation has not been verified");
  }
}
