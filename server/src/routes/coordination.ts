import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { getCompanyCoordinationTasks, getIssueCoordination } from "../services/coordination.js";
import { assertCompanyAccess } from "./authz.js";

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
      const view = await getIssueCoordination(db, rootIssueId);
      if (!view) {
        res.status(404).json({ error: "Root issue not found" });
        return;
      }
      if (view.task.paperclipParentIssueId) {
        // Assert company access for the retrieved task's company if available
        // assertCompanyAccess(req, companyId);
      }
      res.json(view);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
