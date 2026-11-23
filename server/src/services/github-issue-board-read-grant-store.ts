import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { pluginState, type Db } from "@paperclipai/db";
import { z } from "zod";
import type { GitHubIssueIdentity } from "@paperclipai/shared/github-issue-project-mirror";
import { parseGitHubProjectBoardUrl } from "./github-oauth-project-page.js";
import type { GitHubBoardReadGrant, GitHubMirrorReadScope } from "./github-issue-board-read-grants.js";

const projectNodeId = z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/);
export const githubBoardReadGrantSchema = z.object({
  version: z.literal(1),
  grantId: z.string().uuid(),
  companyId: z.string().uuid(),
  paperclipProjectId: z.string().uuid(),
  userId: z.string().min(1).max(256),
  projectId: projectNodeId,
  projectUrl: z.string().max(2048),
  connectionId: z.string().uuid(),
  accountId: z.number().int().positive().safe(),
  login: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  authorizationRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type RegisteredGrant = z.infer<typeof githubBoardReadGrantSchema>;

export function githubIssueBoardReadGrantKey(scope: GitHubMirrorReadScope, projectId: string) {
  return "issue-read-grant-v1:" + createHash("sha256").update(JSON.stringify(
    [scope.companyId, scope.paperclipProjectId, scope.userId, projectId],
  )).digest("hex");
}

interface GrantAuthority {
  canReadIssue(tx: Db, scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity): Promise<boolean>;
  verifyRegisteredConnection(tx: Db, scope: GitHubMirrorReadScope, grant: RegisteredGrant): Promise<boolean>;
}

export function githubIssueBoardReadGrantStore(db: Db, owner: { pluginId: string; namespace: string }, authority: GrantAuthority) {
  async function snapshot(scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity, projectIds: readonly string[]) {
    return db.transaction(async session => {
      const tx = session as unknown as Db;
      const grants = new Map<string, GitHubBoardReadGrant>();
      const issueReadable = await authority.canReadIssue(tx, scope, issue);
      const targets = [...new Set(projectIds)].filter(id => projectNodeId.safeParse(id).success);
      if (!issueReadable || !targets.length || targets.length > 20) return { issueReadable, grants };

      const keys = new Map(targets.map(id => [githubIssueBoardReadGrantKey(scope, id), id]));
      const rows = await tx.select({ key: pluginState.stateKey, value: pluginState.valueJson }).from(pluginState)
        .where(and(eq(pluginState.pluginId, owner.pluginId), eq(pluginState.scopeKind, "company"),
          eq(pluginState.scopeId, scope.companyId), eq(pluginState.namespace, owner.namespace),
          inArray(pluginState.stateKey, [...keys.keys()]))).for("share");
      for (const row of rows) {
        const parsed = githubBoardReadGrantSchema.safeParse(row.value);
        if (!parsed.success) continue;
        const grant = parsed.data;
        if (grant.companyId !== scope.companyId || grant.paperclipProjectId !== scope.paperclipProjectId
          || grant.userId !== scope.userId || keys.get(row.key) !== grant.projectId) continue;
        try {
          parseGitHubProjectBoardUrl(grant.projectUrl);
        } catch {
          continue;
        }
        if (await authority.verifyRegisteredConnection(tx, scope, grant)) grants.set(grant.projectId, grant);
      }
      return { issueReadable, grants };
    }, { isolationLevel: "repeatable read" });
  }

  return { finalAuthorization: snapshot };
}
