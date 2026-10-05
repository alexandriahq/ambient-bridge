import { z } from "zod";

export const nodeWebCodeExchangeSchema = z.object({
  code: z.string().regex(/^anc_[A-Za-z0-9_-]{43}$/),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.string().url().max(2048),
}).strict();

export const nodeWebSessionTokenSchema = z.string().regex(/^ans_[A-Za-z0-9_-]{43}$/);

export const nodeWebSessionResponseSchema = z.object({
  installationId: z.string().min(1).max(200),
  sessionToken: nodeWebSessionTokenSchema,
  inferenceIdentityToken: z.string().min(1).max(32768).optional(),
  expiresAt: z.string().datetime(),
  operator: z.object({
    workosUserId: z.string().min(1).max(200),
    workosOrganizationId: z.string().min(1).max(200),
    workosOrganizationName: z.string().min(1).max(200),
    // Local Node roles remain authoritative; browser authentication grants no Admin role.
    workosOrganizationRole: z.literal("member"),
    email: z.string().email().max(320).nullable(),
    displayName: z.string().min(1).max(500),
  }).strict(),
}).strict();

export type NodeWebSessionResponse = z.infer<typeof nodeWebSessionResponseSchema>;
