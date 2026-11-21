import type { Db } from "@paperclipai/db";
import type { GitHubProjectBinding } from "./plugin-github-project-board.js";
import type { BoardImportIntent, BoardImportReceipt } from "./plugin-imported-issues-contract.js";
import type { GitHubProjectPageInput } from "./github-oauth-project-page.js";

/** Host-only types. No member of this contract is a worker RPC or browser payload. */
export type ScheduledBoardAuthority = Readonly<object>;
export interface ScheduledBoardTarget {
  pluginId: string; companyId: string; projectId: string; jobId: string; jobRunId: string;
}
export interface ScheduledBoardOwner {
  grantId: string; grantRevision: number; preparedByJobRunId: string; ownerEpoch: string;
}
export interface VerifiedScheduledBoard {
  target: Readonly<ScheduledBoardTarget>;
  binding: Readonly<GitHubProjectBinding>;
  authorizationDigest: string;
  owner: Readonly<ScheduledBoardOwner>;
  grantedByUserId: string;
  leaseRevision: number;
  actorId: string;
  maxItems: number;
  deadlineMs: number;
}
export type ScheduledBoardStep = "read-page" | "record-page" | "read-task"
  | "prepare-import" | "commit-import" | "read-operation" | "read-receipt";
/** Supplied only by the native composition closure; the default host service has no access. */
export interface ScheduledBoardAccess {
  inspect(authority: unknown, target: ScheduledBoardTarget): Readonly<VerifiedScheduledBoard>;
  validate(executor: Db, authority: unknown, target: ScheduledBoardTarget,
    step: ScheduledBoardStep): Promise<Readonly<VerifiedScheduledBoard>>;
  notePrepared(authority: unknown, target: ScheduledBoardTarget, operationId: string): void;
  ownsPreparation(authority: unknown, target: ScheduledBoardTarget, operationId: string): boolean;
}
export interface ScheduledImportAccess {
  access: ScheduledBoardAccess;
  validateIntent(executor: Db, authority: unknown, target: ScheduledBoardTarget,
    intent: BoardImportIntent): Promise<Readonly<VerifiedScheduledBoard>>;
}
export interface ScheduledGitHubPageInput {
  authority: unknown; target: ScheduledBoardTarget;
  companyId: string; connectionId: string; page: GitHubProjectPageInput;
  expectedAccountId: number; expectedLogin: string; authorizationDigest: string;
}
export type ScheduledGitHubPageReader = (input: ScheduledGitHubPageInput, access: ScheduledBoardAccess)
  => Promise<{ page: unknown; account: { accountId: number; login: string }; authorizationDigest: string }>;
export type ScheduledBoardBeginResult = { status: "prepared" }
  | { status: "committed"; receipt: BoardImportReceipt }
  | { status: "held"; reason: "preexisting-preparation" };
