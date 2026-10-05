import type { UsagePricingCatalog } from "@ambient/shared/usage";
import { SessionOwnerCache } from "./session-owner-cache.js";

/** Short-lived public pricing catalog, isolated by the current session owner. */
export class BridgePricingCache extends SessionOwnerCache<UsagePricingCatalog, UsagePricingCatalog> {
  constructor(freshTtlMs = 300_000, nowMs: () => number = Date.now) {
    super(freshTtlMs, nowMs, {
      signedOut: () => Promise.reject(new Error("Sign in to load inference pricing.")),
      retired: () => { throw new Error("Inference pricing owner changed while loading."); },
      ready: (cached) => cached.value,
    });
  }
}
