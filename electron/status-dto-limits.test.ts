import { describe, expect, it } from "vitest";
import { NetworkRequestHistory } from "./inference/network-log.js";
import { BRIDGE_STATUS_REQUEST_LIMIT } from "./status-dto-limits.js";

describe("Bridge request log list limit", () => {
  it("keeps the hydrate page well under the in-memory ring buffer", () => {
    expect(BRIDGE_STATUS_REQUEST_LIMIT).toBeLessThanOrEqual(50);
  });

  it("slices network history to the request-log budget", () => {
    const history = new NetworkRequestHistory(100);
    for (let index = 0; index < 80; index += 1) {
      history.start({
        feature: "inference.chatCompletions",
        model: "gpt",
        path: "/v1/chat/completions",
        requestId: `req_${index}`,
        startedAt: index,
      });
    }
    expect(history.list().length).toBe(80);
    expect(history.list(BRIDGE_STATUS_REQUEST_LIMIT)).toHaveLength(BRIDGE_STATUS_REQUEST_LIMIT);
    expect(history.list(BRIDGE_STATUS_REQUEST_LIMIT)[0]?.requestId).toBe("req_79");
  });
});
