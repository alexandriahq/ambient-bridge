import { z } from "zod";
import { compareProductVersions } from "./product-version.js";

/**
 * Generic server-authored broadcast layer for the Ambient desktop clients.
 *
 * Operators set `APP_ANNOUNCEMENTS_JSON` on ambient-server. Bridge fetches
 * `GET /announcements` (public, no session) and the Ambient app shows the
 * first matching card in the sidebar. Payloads are ordinary notices — title,
 * body, optional HTTPS action — not an update-specific protocol. Today's
 * operator copy is a manual-update nag; the same document can carry
 * maintenance, policy, or other product messages without a client change.
 *
 * Optional `organizationId` scopes a notice to one WorkOS org. Unset means
 * global. Public `GET /announcements` omits org-scoped copy unless the client
 * asks for that org.
 *
 * Keep this schema aligned with `alexandria-cloud/src/control-plane/announcements/catalog.ts`
 * (server does not depend on shared).
 */

export const APP_ANNOUNCEMENT_AUDIENCES = Object.freeze(["app", "bridge", "all"] as const);
export const APP_ANNOUNCEMENT_SEVERITIES = Object.freeze(["info", "warning"] as const);
export const APP_ANNOUNCEMENT_PLATFORMS = Object.freeze(["darwin", "win32", "linux"] as const);

const announcementIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/);
const organizationIdSchema = z.string().regex(/^org_[A-Za-z0-9]{1,80}$/);
const httpsUrlSchema = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "actionUrl must be https");

export const appAnnouncementSchema = z.object({
  id: announcementIdSchema,
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(400),
  severity: z.enum(APP_ANNOUNCEMENT_SEVERITIES).default("info"),
  actionLabel: z.string().min(1).max(40).optional(),
  actionUrl: httpsUrlSchema.optional(),
  dismissible: z.boolean().default(true),
  audience: z.enum(APP_ANNOUNCEMENT_AUDIENCES).default("app"),
  showBelowVersion: versionSchema.optional(),
  platforms: z.array(z.enum(APP_ANNOUNCEMENT_PLATFORMS)).max(3).optional(),
  channels: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/)).max(8).optional(),
  organizationId: organizationIdSchema.optional(),
}).strict().superRefine((announcement, context) => {
  if ((announcement.actionLabel == null) !== (announcement.actionUrl == null)) {
    context.addIssue({
      code: "custom",
      message: "actionLabel and actionUrl must be set together.",
    });
  }
});

export const appAnnouncementsDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  announcements: z.array(appAnnouncementSchema).max(16),
}).strict();

export type AppAnnouncementAudience = (typeof APP_ANNOUNCEMENT_AUDIENCES)[number];
export type AppAnnouncementSeverity = (typeof APP_ANNOUNCEMENT_SEVERITIES)[number];
export type AppAnnouncementPlatform = (typeof APP_ANNOUNCEMENT_PLATFORMS)[number];
export type AppAnnouncement = z.infer<typeof appAnnouncementSchema>;
export type AppAnnouncementsDocument = z.infer<typeof appAnnouncementsDocumentSchema>;
export type AppAnnouncementClient = {
  readonly audience: AppAnnouncementAudience;
  readonly version: string;
  readonly platform: string;
  readonly channel: string;
  readonly organizationId?: string | null;
};

export const EMPTY_APP_ANNOUNCEMENTS_DOCUMENT: AppAnnouncementsDocument = Object.freeze({
  schemaVersion: 1,
  announcements: [],
});

export function parseAppAnnouncementsDocument(value: unknown): AppAnnouncementsDocument {
  return appAnnouncementsDocumentSchema.parse(value);
}

export function emptyAppAnnouncementsDocument(): AppAnnouncementsDocument {
  return EMPTY_APP_ANNOUNCEMENTS_DOCUMENT;
}

export function compareAnnouncementVersions(left: string, right: string): number {
  return compareProductVersions(left, right);
}

export function announcementMatchesClient(
  announcement: AppAnnouncement,
  client: AppAnnouncementClient,
): boolean {
  if (announcement.audience !== "all" && announcement.audience !== client.audience) {
    return false;
  }
  if (announcement.organizationId
    && announcement.organizationId !== client.organizationId) {
    return false;
  }
  if (announcement.showBelowVersion
    && compareAnnouncementVersions(client.version, announcement.showBelowVersion) >= 0) {
    return false;
  }
  if (announcement.platforms && announcement.platforms.length > 0) {
    if (!announcement.platforms.includes(client.platform as AppAnnouncementPlatform)) {
      return false;
    }
  }
  if (announcement.channels && announcement.channels.length > 0) {
    if (!announcement.channels.includes(client.channel)) return false;
  }
  return true;
}

export function visibleAppAnnouncements(
  document: AppAnnouncementsDocument,
  client: AppAnnouncementClient,
): readonly AppAnnouncement[] {
  return document.announcements.filter((announcement) => announcementMatchesClient(announcement, client));
}
