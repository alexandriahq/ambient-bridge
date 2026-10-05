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

      const status = await mock.getStatus();
      expect(status).toMatchObject({
        appVersion: "1.42.0-mock-win",
        pairedClientList: expect.arrayContaining([
          expect.objectContaining({
            id: "client-win",
            name: "Ambient (this Windows PC)",
          }),
        ]),
      });
      expect(status).not.toHaveProperty("activity");
      expect(status.inference).not.toHaveProperty("requests");
      await expect(mock.getRequestLog()).resolves.toMatchObject({
        revision: 1,
        requests: expect.arrayContaining([
          expect.objectContaining({ requestId: "req-1" }),
        ]),
      });
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    }
  });
});
