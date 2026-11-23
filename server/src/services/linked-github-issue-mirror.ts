import { and, eq } from "drizzle-orm";
import { externalObjectMentions, externalObjects, issues, plugins, type Db } from "@paperclipai/db";
import type { GitHubIssueIdentity, GitHubMirrorRead } from "@paperclipai/shared/github-issue-project-mirror";
import { notFound } from "../errors.js";
import { GITHUB_PROJECT_IMPORTER_KEY, pluginGitHubProjectBoardService } from "./plugin-github-project-board.js";
import { toolAccessService } from "./tool-access.js";

export function findLinkedGitHubMirrorIssue(
  groups: readonly { object: Pick<typeof externalObjects.$inferSelect,
    "id" | "companyId" | "providerKey" | "objectType" | "data" | "sanitizedCanonicalUrl" | "liveness"> | null }[],
  objectId: string, companyId: string,
): GitHubIssueIdentity | null {
  const object = groups.find(group => group.object?.id === objectId)?.object;
  if (!object || object.companyId !== companyId || object.providerKey !== "github" || object.objectType !== "issue") return null;
  const { nodeId, issueTitle, state } = object.data;
  const url = object.sanitizedCanonicalUrl;
  if (typeof nodeId !== "string" || !/^[A-Za-z0-9_=-]{1,256}$/.test(nodeId)
    || typeof issueTitle !== "string" || !issueTitle || issueTitle.length > 4096
    || typeof url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(url)
    || (state !== "open" && state !== "closed") || ["auth_required", "unreachable"].includes(object.liveness)) return null;
  return { nodeId, title: issueTitle, url, state: state === "open" ? "OPEN" : "CLOSED" };
}

/** One result for the bound board and the boards the user registered. */
export function mergeBoundAndRegisteredMirrors(bound: GitHubMirrorRead, registered: GitHubMirrorRead): GitHubMirrorRead {
  const boundCards = bound.state === "denied" ? [] : bound.mirror.projects;
  const projects = [...boundCards, ...registered.mirror.projects.filter(card =>
    !boundCards.some(boundCard => boundCard.projectId === card.projectId))];
  const boundBoard = boundCards[0]?.projectId;
  const boundBoardState = bound.state === "fresh" || bound.state === "partial" || bound.state === "stale"
    || bound.state === "unavailable" ? bound.state : null;
  const boardReadStates = [
    ...(boundBoard && boundBoardState ? [{ projectId: boundBoard, state: boundBoardState }] : []),
    ...(registered.boardReadStates ?? []).filter(row => row.projectId !== boundBoard),
  ];
  const state = bound.state === "fresh" || bound.state === "denied" ? registered.state
    : registered.state === "fresh" ? bound.state : "partial";
  return {
    state, coverage: "registered_projects", mirror: { issue: registered.mirror.issue, projects },
    accessRequired: !!registered.accessRequired || bound.state === "denied", boardReadStates,
    ...(bound.checkedProject ? { checkedProject: bound.checkedProject } : {}),
  };
}

export type LinkedIssueBoardAccessAction = { op: "list" } | { op: "saved" }
  | { op: "register"; boardUrl: string; connectionId: string }
  | { op: "revoke"; projectId: string; expectedGrantId: string };

export function linkedGitHubIssueMirrorService(db: Db) {
  const access = toolAccessService(db);
  return {
    async refresh(input: { companyId: string; projectId: string; issueId: string; objectId: string; userId: string; issue: GitHubIssueIdentity; requestedProjectId?: string; accessAction?: LinkedIssueBoardAccessAction; canRead: (issue: typeof issues.$inferSelect, executor: Db) => Promise<boolean> }) {
      const rows = await db.select({ id: plugins.id }).from(plugins)
        .where(eq(plugins.pluginKey, GITHUB_PROJECT_IMPORTER_KEY)).limit(2);
      if (rows.length !== 1) throw notFound("Native GitHub Project connector unavailable");
      const project = pluginGitHubProjectBoardService(db,
        { pluginId: rows[0].id, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, access.readVerifiedGitHubProjectPage);
      const assertCurrentIssue = async (executor: Db) => {
        const [current] = await executor.select().from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
            eq(issues.projectId, input.projectId))).for("share").limit(1);
        const links = await executor.select({ object: externalObjects }).from(externalObjectMentions)
          .innerJoin(externalObjects, eq(externalObjectMentions.objectId, externalObjects.id))
          .where(and(eq(externalObjectMentions.companyId, input.companyId),
            eq(externalObjectMentions.sourceIssueId, input.issueId), eq(externalObjects.companyId, input.companyId),
            eq(externalObjects.id, input.objectId))).limit(1).for("share");
        const linked = links[0]?.object;
        return Boolean(current && linked && linked.providerKey === "github" && linked.objectType === "issue"
          && linked.sanitizedCanonicalUrl === input.issue.url && linked.data.nodeId === input.issue.nodeId
          && linked.liveness !== "auth_required" && linked.liveness !== "unreachable" && await input.canRead(current, executor));
      };
      const context = { companyId: input.companyId, actor: { type: "user" as const, userId: input.userId } };
      const scope = { companyId: input.companyId, paperclipProjectId: input.projectId,
        paperclipIssueId: input.issueId, objectId: input.objectId, userId: input.userId };
      if (input.accessAction?.op === "saved") return project.listSavedLinkedIssueBoardAccess(context, scope, assertCurrentIssue);
      if (input.accessAction?.op === "list") {
        const target = { companyId: input.companyId, projectId: input.projectId };
        const listed = await project.listConnections(context, target);
        const connections = await db.transaction(async tx => {
          const executor = tx as unknown as Db;
          if (!(await assertCurrentIssue(executor))) throw notFound("Linked GitHub issue is no longer readable");
          const options = [];
          for (const connection of listed.connections) {
            const authority = await project.readMirrorRegistrationAuthority(executor, context,
              { ...target, connectionId: connection.connectionId });
            if (authority) options.push({ connectionId: connection.connectionId, name: connection.name });
          }
          return options;
        }, { isolationLevel: "repeatable read" });
        return { connections };
      }
      if (input.accessAction) return project.changeLinkedIssueBoardAccess(context, scope, assertCurrentIssue, input.accessAction);
      if (!input.requestedProjectId) {
        const registered = await project.refreshRegisteredIssueMirrors(context, { scope, issue: input.issue, assertCurrentIssue });
        if (registered) {
          // The bound board stays visible next to the registered ones, also after the last grant is revoked.
          const boundRead = await project.refreshLinkedIssueMirror(context, { ...input, assertCurrentIssue });
          return mergeBoundAndRegisteredMirrors(boundRead, registered);
        }
      }
      const bound = await project.refreshLinkedIssueMirror(context, { ...input, assertCurrentIssue });
      return input.requestedProjectId ? bound : { ...bound, additionalAccessRequired: true };
    },
  };
}
