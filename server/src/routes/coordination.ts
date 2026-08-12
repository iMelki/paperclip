import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  getCompanyCoordinationTasks,
  getIssueCoordination,
  getIssueCoordinationRootScope,
} from "../services/coordination.js";
import { assertAuthenticated, assertCompanyAccess, getAccessibleResource } from "./authz.js";

export function coordinationRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/coordination/tasks", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const tasks = await getCompanyCoordinationTasks(db, companyId);
      res.json(tasks);
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:rootIssueId/coordination", async (req, res, next) => {
    try {
      const rootIssueId = req.params.rootIssueId as string;
      // Reject anonymous callers before looking up even the root scope. For
      // authenticated callers, getAccessibleResource deliberately returns the
      // same 404 for a missing root and a foreign-company root, avoiding an
      // existence oracle before the detailed coordination read.
      assertAuthenticated(req);
      const root = await getAccessibleResource(
        req,
        res,
        getIssueCoordinationRootScope(db, rootIssueId),
        "Root issue not found",
      );
      if (!root) return;

      const view = await getIssueCoordination(db, rootIssueId, root.companyId);
      if (!view) {
        res.status(404).json({ error: "Root issue not found" });
        return;
      }
      res.json(view);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
