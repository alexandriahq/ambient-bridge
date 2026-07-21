import { describe, expect, it } from "vitest";

describe("Apple notary preflight", () => {
  it("classifies missing or expired Apple agreements", async () => {
    const { isMissingAppleAgreementError } = await import("../scripts/notary-preflight-core.mjs");

    expect(isMissingAppleAgreementError(
      "HTTP status code: 403. A required agreement is missing or has expired."
    )).toBe(true);
    expect(isMissingAppleAgreementError("HTTP status code: 401. Unauthorized.")).toBe(false);
  });

  it("summarizes bounded notarytool output", async () => {
    const { summarizeNotaryOutput } = await import("../scripts/notary-preflight-core.mjs");

    expect(summarizeNotaryOutput("\n first \n\n second\nthird\nfourth\nfifth\n"))
      .toBe("first second third fourth");
  });
});
