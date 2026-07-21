import { describe, expect, test } from "vitest";
import { buildBridgeMock } from "./bridge-mock";

describe("bridge browser mock", () => {
  test("renders Windows-shaped data when the browser preview runs on Windows", async () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "Win32" },
    });

    try {
      const mock = buildBridgeMock();

      await expect(mock.getStatus()).resolves.toMatchObject({
        appVersion: "1.42.0-mock-win",
        pairedClientList: expect.arrayContaining([
          expect.objectContaining({
            id: "client-win",
            name: "Ambient (this Windows PC)",
          }),
        ]),
      });
      await expect(mock.listExperimentalBuilds()).resolves.toMatchObject({
        platform: "win32",
        arch: "x64",
      });
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    }
  });
});
