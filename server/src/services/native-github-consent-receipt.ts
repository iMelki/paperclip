import { and, desc, eq, isNull } from "drizzle-orm";
import { activityLog, companySecrets, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { githubProjectAuthorizationDigest, githubProjectConsentDigest } from "./github-oauth-project-page.js";

const action = "github_native_oauth.consent_verified";
type Connection = Parameters<typeof githubProjectConsentDigest>[0] & { id: string; companyId: string };
type Revision = Parameters<typeof githubProjectConsentDigest>[1];
type CurrentAccount = { accountId: number; login: string };

export async function recordNativeGitHubConsent(executor: Db, connection: Connection,
  userId: string, account: CurrentAccount, accessSecretId: string) {
  const [secret] = await executor.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets)
    .where(and(eq(companySecrets.id, accessSecretId), eq(companySecrets.companyId, connection.companyId),
      eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt))).for("share").limit(1);
  if (!secret) throw conflict("Verified GitHub consent has no active access credential");
  const revision = { secretId: accessSecretId, latestVersion: secret.latestVersion };
  await executor.insert(activityLog).values({ companyId: connection.companyId, actorType: "user", actorId: userId,
    responsibleUserId: userId, entityType: "tool_connection", entityId: connection.id, action,
    details: { schema: 1, applicationId: connection.applicationId, accountId: account.accountId,
      login: account.login.toLowerCase(), consentRevision: githubProjectConsentDigest(connection, revision) } });
}

/** Scope and actor come from the authenticated host, never a request body or connector metadata. */
export async function verifyNativeGitHubConsent(executor: Db, connection: Connection,
  userId: string, account: CurrentAccount, credential: Revision) {
  const rows = await executor.select({ actorType: activityLog.actorType, actorId: activityLog.actorId,
    responsibleUserId: activityLog.responsibleUserId, details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog).where(and(eq(activityLog.companyId, connection.companyId),
      eq(activityLog.entityType, "tool_connection"), eq(activityLog.entityId, connection.id),
      eq(activityLog.action, action))).orderBy(desc(activityLog.createdAt)).limit(2);
  const [receipt, earlier] = rows;
  if (!receipt || receipt.actorType !== "user" || receipt.actorId !== userId || receipt.responsibleUserId !== userId
    || (earlier && receipt.createdAt.getTime() === earlier.createdAt.getTime())) return null;
  const details = receipt.details;
  if (!details || details.schema !== 1 || details.applicationId !== connection.applicationId
    || details.accountId !== account.accountId || details.login !== account.login.toLowerCase()
    || details.consentRevision !== githubProjectConsentDigest(connection, credential)) return null;
  return { oauthUserId: userId, accountId: account.accountId, login: account.login, connectionId: connection.id,
    authorizationRevision: githubProjectAuthorizationDigest(connection, credential) };
}
