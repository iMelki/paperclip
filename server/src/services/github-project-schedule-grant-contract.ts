import { z } from "zod";
import { conflict, unprocessable } from "../errors.js";

export const GITHUB_PROJECT_BOARD_JOB_KEY = "sync.github-project-board";
export const GITHUB_PROJECT_GRANT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const grantScopeSchema = z.object({ companyId: uuid, projectId: uuid }).strict();
export const createScheduleGrantSchema = grantScopeSchema.extend({
  expectedRevision: revision, jobId: uuid,
  enabled: z.boolean().default(false), maxItems: z.number().int().min(1).max(20),
  expiresAt: z.string().datetime(),
}).strict();
export const revokeScheduleGrantSchema = grantScopeSchema.extend({ expectedRevision: revision }).strict();
const userId = z.string().min(1).max(256).refine(value => value.trim() === value);
export const scheduleGrantSchema = grantScopeSchema.extend({
  version: z.literal(1), pluginId: uuid, grantId: uuid, revision: revision.refine(value => value > 0),
  jobId: uuid, jobKey: z.literal(GITHUB_PROJECT_BOARD_JOB_KEY),
  enabled: z.boolean(), maxItems: z.number().int().min(1).max(20),
  boardId: z.string().min(1).max(256), boardUrl: z.string().url().max(2048),
  connectionId: uuid, accountId: z.number().int().positive().safe(), login: z.string().min(1).max(39),
  bindingDigest: digest, authorizationDigest: digest,
  grantedByUserId: userId, grantedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(), revokedByUserId: userId.nullable(),
  importOnly: z.literal(true), noDispatch: z.literal(true),
}).strict().superRefine((value, context) => {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.grantedAt);
  if (duration <= 0 || duration > GITHUB_PROJECT_GRANT_MAX_AGE_MS
    || (value.revokedAt === null) !== (value.revokedByUserId === null)
    || (value.revokedAt !== null && value.enabled)) {
    context.addIssue({ code: "custom", message: "Invalid retained grant lifetime or revocation" });
  }
});
export type GitHubProjectScheduleGrant = z.infer<typeof scheduleGrantSchema>;
export function parseScheduleGrantInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unprocessable("Invalid bounded GitHub board schedule grant request");
  return result.data;
}
export function assertScheduleGrantRevision(previous: GitHubProjectScheduleGrant | null, expected: number) {
  if ((previous?.revision ?? 0) !== expected || expected >= Number.MAX_SAFE_INTEGER) {
    throw conflict("GitHub board schedule grant revision changed; reread before retrying");
  }
}
