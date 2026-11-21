import type { Request, Response } from "express";

export function apiRouteNotFound(req: Request, res: Response) {
  const issueRoute = /^\/(?:issues(?:\/|$)|companies\/[^/]+\/issues(?:\/|$))/.test(req.path);
  res.status(404).json({
    error: issueRoute
      ? "API route not found. Create a child with POST /api/issues/:issueId/children, or use POST /api/companies/:companyId/issues with parentId."
      : "API route not found",
  });
}
