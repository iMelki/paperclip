/** Narrow, operator-only board import protocol. The host owns transaction and pause enforcement. */
export type PluginImportedBoardRequest = { companyId: string } & (
  | { op: "capabilities" | "sources" }
  | { op: "readTask"; githubIssueNodeId: string }
  | { op: "readOperation" | "readReceipt"; operationId: string }
  | { op: "begin" | "commit"; intent: unknown }
  | { op: "listProjectConnections" | "readProjectBinding"; projectId: string }
  | { op: "bindProjectBoard"; projectId: string; boardUrl: string; connectionId: string }
  | { op: "readProjectPage"; projectId: string; page: {
      ownerType: "user" | "organization"; owner: string; number: number; after: string | null; first: number;
    } }
);
