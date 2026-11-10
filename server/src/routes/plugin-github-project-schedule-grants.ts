import type { Request, Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { pluginGitHubProjectBoardService, GITHUB_PROJECT_IMPORTER_KEY } from "../services/plugin-github-project-board.js";
import { pluginGitHubProjectScheduleGrants } from "../services/plugin-github-project-schedule-grants.js";
import { createScheduleGrantSchema, parseScheduleGrantInput, revokeScheduleGrantSchema } from "../services/github-project-schedule-grant-contract.js";

const pathSchema = z.object({ pluginId: z.string().uuid(), companyId: z.string().uuid(), projectId: z.string().uuid() }).strict();
const createBody = createScheduleGrantSchema.omit({ companyId: true, projectId: true });
const revokeBody = revokeScheduleGrantSchema.omit({ companyId: true, projectId: true });
const empty = z.object({}).strict();

function trustedScope(req: Request) {
  assertBoard(req);
  const actor = getActorInfo(req);
  const boundCredential = (req.actor.source === "session" && typeof req.actor.sessionId === "string" && Boolean(req.actor.sessionId.trim()))
    || (req.actor.source === "board_key" && typeof req.actor.keyId === "string" && Boolean(req.actor.keyId.trim()));
  if (!boundCredential || actor.actorType !== "user"
    || typeof req.actor.userId !== "string" || !req.actor.userId.trim()
    || req.actor.userId !== req.actor.userId.trim() || req.actor.userId.length > 256) {
    throw forbidden("A real authenticated user is required to manage board schedule grants");
  }
  const scope = parseScheduleGrantInput(pathSchema, req.params);
  // Same 404 for a missing company and a company this caller cannot access.
  if (!hasCompanyAccess(req, scope.companyId)) throw notFound("Company not found");
  assertCompanyAccess(req, scope.companyId);
  const membership = req.actor.memberships?.find(row => row.companyId === scope.companyId);
  if (!membership || membership.status !== "active" || membership.membershipRole === "viewer") {
    throw forbidden("Active non-viewer company membership required for board schedule grants");
  }
  parseScheduleGrantInput(empty, req.query);
  return { scope, context: { companyId: scope.companyId, actor: { type: "user" as const, userId: actor.actorId } } };
}

/** Native HTTP composition only. Never add these operations to plugin worker RPC. */
export function registerGitHubProjectScheduleGrantRoutes(router: Router, db: Db) {
  const services = (pluginId: string) => {
    const identity = { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY };
    // Grant management uses verified metadata only. Even accidental page reads must fail closed here.
    const boards = pluginGitHubProjectBoardService(db, identity, async () => {
      throw forbidden("Board page reads are not available to grant management");
    });
    return pluginGitHubProjectScheduleGrants(db, identity, boards);
  };
  router.get("/plugins/:pluginId/companies/:companyId/projects/:projectId/github-board/schedule-grant", async (req, res) => {
    const { scope, context } = trustedScope(req);
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)
      || Object.keys(req.body).length !== 0)) throw unprocessable("Grant reads do not accept a request body");
    const result = await services(scope.pluginId).read(context, { companyId: scope.companyId, projectId: scope.projectId });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });
  router.post("/plugins/:pluginId/companies/:companyId/projects/:projectId/github-board/schedule-grant", async (req, res) => {
    const { scope, context } = trustedScope(req);
    const input = parseScheduleGrantInput(createBody, req.body);
    const result = await services(scope.pluginId).create(context, { ...input, companyId: scope.companyId, projectId: scope.projectId });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(result);
  });
  router.post("/plugins/:pluginId/companies/:companyId/projects/:projectId/github-board/schedule-grant/revoke", async (req, res) => {
    const { scope, context } = trustedScope(req);
    const input = parseScheduleGrantInput(revokeBody, req.body);
    const result = await services(scope.pluginId).revoke(context, { ...input, companyId: scope.companyId, projectId: scope.projectId });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });
}
