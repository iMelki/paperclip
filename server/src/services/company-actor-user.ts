import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** Sentinel stored by built-in bundle provisioning. It is not a company member. */
export const BUILT_IN_BUNDLE_ACTOR_USER_ID = "built-in-bundles";

const CONFIGURED_ACTOR_ENV = "PAPERCLIP_BUILT_IN_ACTOR_USER_ID";

const log = logger.child({ service: "company-actor-user" });

export function isBuiltInBundleActorUserId(userId: string | null | undefined): boolean {
  return (userId ?? "").trim() === BUILT_IN_BUNDLE_ACTOR_USER_ID;
}

/** The user row must already exist. This does not insert one. */
export async function userRowExists(db: Db, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

/** Active company membership is the access check. Instance admin is not a substitute. */
export async function userHasActiveCompanyAccess(
  db: Db,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

async function activeOwnerUserId(db: Db, companyId: string): Promise<string | null> {
  const owner = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
    ))
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return owner?.userId ?? null;
}

/**
 * User a built-in routine or recovery wake may run as.
 * A configured user is used only when that user already exists and has company access.
 * Otherwise the company's active owner is used, and only when that owner row exists.
 * Nobody is created.
 */
export async function resolveEligibleCompanyActorUserId(
  db: Db,
  companyId: string,
  options?: { configuredUserId?: string | null },
): Promise<string | null> {
  const configured = (options?.configuredUserId ?? process.env[CONFIGURED_ACTOR_ENV] ?? "").trim();
  if (configured && !isBuiltInBundleActorUserId(configured)) {
    if (
      await userRowExists(db, configured)
      && await userHasActiveCompanyAccess(db, companyId, configured)
    ) {
      return configured;
    }
    log.warn(
      { companyId },
      "configured built-in actor user is missing or has no access to this company; that user will not be used",
    );
  }

  const ownerId = await activeOwnerUserId(db, companyId);
  if (
    ownerId
    && await userRowExists(db, ownerId)
    && await userHasActiveCompanyAccess(db, companyId, ownerId)
  ) {
    return ownerId;
  }

  log.error(
    { companyId },
    "no eligible company user for a built-in routine or recovery wake; the run will not start",
  );
  return null;
}

/**
 * User id safe to store in a column that references the user table.
 * The built-in sentinel is replaced by an existing company member.
 * Any other id is kept only when that user row already exists.
 * A missing id returns null. This function does not insert a user.
 */
export async function resolveStoredResponsibleUserId(
  db: Db,
  companyId: string,
  userId: string | null | undefined,
): Promise<string | null> {
  const candidate = (userId ?? "").trim();
  if (!candidate) return null;
  if (isBuiltInBundleActorUserId(candidate)) {
    return resolveEligibleCompanyActorUserId(db, companyId);
  }
  if (await userRowExists(db, candidate)) return candidate;
  log.error(
    { companyId },
    "responsible user is not an existing user; the write will not continue",
  );
  return null;
}
