import { describe, expect, it } from "vitest";

describe("Bridge build configuration", () => {
  it("bakes the release channel and exact source commit into the runtime identity", async () => {
    const {
      resolveBuildCommitSha,
      resolveBuildReleaseChannel,
    } = await import("../scripts/generate-build-config.mjs");

    expect(resolveBuildReleaseChannel({ RELEASE_CHANNEL: " experimental " })).toBe("experimental");
    expect(resolveBuildReleaseChannel({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "alpha" })).toBe("alpha");
    expect(resolveBuildReleaseChannel({})).toBe("alpha");
    expect(resolveBuildCommitSha({
      GIT_COMMIT_SHA: "A301FC27AFA17A51618419E0CE8120C8CBA5D169",
    }, "0000000000000000000000000000000000000000")).toBe(
      "a301fc27afa17a51618419e0ce8120c8cba5d169",
    );
    expect(resolveBuildCommitSha({}, "21f9b0e78c68c83691b90c70a2137d77a1dd40c7")).toBe(
      "21f9b0e78c68c83691b90c70a2137d77a1dd40c7",
    );
  });

  it("keeps every normal release channel on the production account realm", async () => {
    const { PROD_SERVER_URL, resolveBuildServerUrl } = await import("../scripts/generate-build-config.mjs");

    expect(resolveBuildServerUrl({})).toBe(PROD_SERVER_URL);
    expect(resolveBuildServerUrl({ AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental" })).toBe(PROD_SERVER_URL);
    expect(resolveBuildServerUrl({ RELEASE_CHANNEL: "alpha" })).toBe(PROD_SERVER_URL);
  });

  it("allows an explicit build-time server override without leaking trailing slashes", async () => {
    const { resolveBuildServerUrl } = await import("../scripts/generate-build-config.mjs");

    expect(resolveBuildServerUrl({
      AMBIENT_BRIDGE_BUILD_SERVER_URL: "https://ambientserver-staging.up.railway.app///",
      AMBIENT_BRIDGE_RELEASE_CHANNEL: "experimental",
    })).toBe("https://ambientserver-staging.up.railway.app");
  });
});
