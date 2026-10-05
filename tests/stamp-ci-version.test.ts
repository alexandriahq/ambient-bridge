import { describe, expect, it } from "vitest";
import {
  formatNightlyDate,
  resolveStampChannel,
  stampCiVersion,
} from "../scripts/stamp-ci-version.mjs";

describe("stamp-ci-version", () => {
  it("stamps a stable core version without a prerelease", () => {
    expect(stampCiVersion({
      channel: "stable",
      currentVersion: "1.0.0-local",
    })).toBe("1.0.0");
    expect(stampCiVersion({
      currentVersion: "1.2.3-alpha.8",
      preid: "stable",
    })).toBe("1.2.3");
  });

  it("stamps Nightly as YYYYMMDD plus the run number", () => {
    expect(formatNightlyDate(new Date("2026-08-22T06:00:12.000Z"))).toBe("20260822");
    expect(stampCiVersion({
      channel: "nightly",
      currentVersion: "1.0.0-local",
      date: "20260822",
      runNumber: "12",
    })).toBe("1.0.0-nightly.20260822.12");
    expect(stampCiVersion({
      currentVersion: "1.0.0-local",
      preid: "alpha",
      runNumber: "61",
    })).toBe("1.0.0-alpha.61");
  });

  it("keeps experimental PR stamps on the experimental preid", () => {
    expect(stampCiVersion({
      currentVersion: "1.0.0-local",
      preid: "experimental",
      prNumber: "725",
      runId: "123456",
    })).toBe("1.0.0-experimental.pr725.123456");
  });

  it("treats an omitted channel as the historical alpha nightly train", () => {
    expect(resolveStampChannel({})).toBe("alpha");
    expect(resolveStampChannel({ channel: "nightly" })).toBe("nightly");
    expect(resolveStampChannel({ parsedPreid: "local" })).toBe("alpha");
  });

  it("stamps the legacy prod release train as alpha from a local package version", () => {
    expect(stampCiVersion({
      channel: "alpha",
      currentVersion: "1.0.0-local",
      runNumber: "104",
    })).toBe("1.0.0-alpha.104");
  });
});
