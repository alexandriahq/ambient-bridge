import { expect, test } from "vitest";
import { BridgeStatusClock } from "../electron/bridge-status-clock.js";

test("snapshots advance for account and network changes and restart in a new namespace", () => {
  const clock = new BridgeStatusClock();
  const initial = clock.observe(JSON.stringify({ account: "signed_in", network: "ready" }));
  expect(clock.observe(JSON.stringify({ account: "signed_in", network: "ready" }))).toEqual(initial);
  const offline = clock.observe(JSON.stringify({ account: "signed_in", network: "offline" }));
  const logout = clock.observe(JSON.stringify({ account: "signed_out", network: "offline" }));
  expect(offline.revision).toBeGreaterThan(initial.revision);
  expect(logout.revision).toBeGreaterThan(offline.revision);
  expect(logout.bridgeInstanceId).toBe(initial.bridgeInstanceId);
  const restarted = new BridgeStatusClock().observe("signed_out");
  expect(restarted.bridgeInstanceId).not.toBe(initial.bridgeInstanceId);
  expect(restarted.revision).toBe(1);
});
