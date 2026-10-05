import { describe, expect, it } from "vitest";
import { activitySessionSchema, globalDashboardSchema, orgDashboardSchema } from "./org-commercial-api.js";

const dashboard = {
  generatedAt: "2026-10-01T12:00:00.000Z",
  people: { liveNow: 0, activeToday: 0, activeWeek: 0, members: 0, seats: null },
  requests: { lastHour: 0, today: 0, week: 0, failedToday: 0 },
  spend: { todayMicros: "0", weekMicros: "0", monthMicros: "0" },
  hourly: [],
  topMembers: [],
  topModels: [],
  billing: { plan: "contract", blockedReason: null },
};

const session = {
  id: "ses_1", workosUserId: "user_a", label: "a@acme.test", email: "a@acme.test", installationId: "inst_1",
  startedAt: "2026-10-01T11:00:00.000Z", endedAt: null, lastRequestAt: "2026-10-01T11:58:00.000Z", durationMs: 3_480_000,
  requests: 4, failed: 0, costMicros: "1000", models: [{ model: "glm", requests: 4 }], appVersion: null,
};

describe("org commercial activity wire shapes", () => {
  it("reads a dashboard from a Cloud that predates attributionSince", () => {
    expect(orgDashboardSchema.parse(dashboard).attributionSince).toBeUndefined();
    expect(orgDashboardSchema.parse({ ...dashboard, attributionSince: "2026-09-12T08:00:00.000Z" }).attributionSince).toBe("2026-09-12T08:00:00.000Z");
  });

  it("caps session models at three and rejects unknown keys", () => {
    expect(activitySessionSchema.safeParse(session).success).toBe(true);
    const four = Array.from({ length: 4 }, (_, index) => ({ model: `m${index}`, requests: 1 }));
    expect(activitySessionSchema.safeParse({ ...session, models: four }).success).toBe(false);
    expect(activitySessionSchema.safeParse({ ...session, prompt: "x" }).success).toBe(false);
  });
});

describe("global dashboard wire shape", () => {
  const global = {
    generatedAt: "2026-10-01T12:00:00.000Z", range: "24h", from: "2026-09-30T13:00:00.000Z", to: "2026-10-01T12:00:00.000Z", bucket: "hour",
    people: { liveNow: 1, activeToday: 2, activeWeek: 3 },
    organizations: { total: 3, active: 1, liveNow: 1 },
    requests: { window: 4, lastHour: 1, failed: 1, failureRate: 0.25 },
    spend: { windowMicros: "100", lastHourMicros: "10", monthMicros: "500" },
    cognitiveCompute: { requests: 2, costMicros: "50", requestShare: 0.5, costShare: 0.5 },
    seriesKeys: [{ key: "org_acme", label: "Acme", orgId: "org_acme" }, { key: "other", label: "Other organizations", orgId: null }],
    series: [{ at: "2026-10-01T11:00:00.000Z", requests: 4, failed: 1, costMicros: "100", people: 2, requestsByKey: [3, 1], costByKey: ["90", "10"] }],
    byOrganization: [], byModel: [], byProvider: [], failures: [], topPeople: [], attributionSince: null,
  };

  it("requires series values aligned with the series keys", () => {
    expect(globalDashboardSchema.safeParse(global).success).toBe(true);
    const misaligned = { ...global, series: [{ ...global.series[0], requestsByKey: [4] }] };
    expect(globalDashboardSchema.safeParse(misaligned).success).toBe(false);
  });

  it("rejects rates outside 0..1 and unknown ranges", () => {
    expect(globalDashboardSchema.safeParse({ ...global, requests: { ...global.requests, failureRate: 1.5 } }).success).toBe(false);
    expect(globalDashboardSchema.safeParse({ ...global, range: "90d" }).success).toBe(false);
  });
});
