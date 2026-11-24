import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseGitHubProjectBoardUrl } from "./github-oauth-project-page.js";

export interface GitHubBoardRegistrationRequest {
  companyId: string;
  paperclipProjectId: string;
  userId: string;
  connectionId: string;
  projectId: string;
  projectUrl: string;
}

interface IssuerAuthority {
  /** The verified OAuth authorizing user's ID, supplied by the host's issuer. */
  oauthUserId: string;
  accountId: number;
  login: string;
  authorizationRevision: string;
  connectionId: string;
}

export type GitHubBoardReadRegistration = GitHubBoardRegistrationRequest & {
  version: 1;
  grantId: string;
  accountId: number;
  login: string;
  authorizationRevision: string;
};

type CatalogScope = Pick<GitHubBoardRegistrationRequest, "companyId" | "paperclipProjectId" | "userId">;
export type GitHubBoardReadCatalog = CatalogScope & { version: 1; projectIds: string[] };

interface RegistrationTransaction {
  currentAuthority(input: GitHubBoardRegistrationRequest): Promise<IssuerAuthority | null>;
  /** Scope lock covers the grant record and the catalog as one transaction. */
  lockCatalog(scope: CatalogScope): Promise<void>;
  readGrant(input: GitHubBoardRegistrationRequest): Promise<GitHubBoardReadRegistration | null>;
  readCatalog(scope: CatalogScope): Promise<GitHubBoardReadCatalog | null>;
  saveGrant(value: GitHubBoardReadRegistration): Promise<void>;
  saveCatalog(value: GitHubBoardReadCatalog): Promise<void>;
}

interface RegistrationHost {
  currentAuthority(input: GitHubBoardRegistrationRequest): Promise<IssuerAuthority | null>;
  probeBoard(input: GitHubBoardRegistrationRequest, authority: IssuerAuthority): Promise<{
    projectId: string; projectUrl: string; accountId: number; login: string; authorizationRevision: string;
  }>;
  withTransaction<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T>;
}

export class GitHubBoardRegistrationRefused extends Error {}

function eligible(input: GitHubBoardRegistrationRequest, authority: IssuerAuthority | null): authority is IssuerAuthority {
  return !!authority && authority.oauthUserId === input.userId && authority.connectionId === input.connectionId
    && Number.isSafeInteger(authority.accountId) && authority.accountId > 0 && !!authority.login
    && /^[a-f0-9]{64}$/.test(authority.authorizationRevision);
}

/** Host-only, user-specific read registration. No import or writeback interface. */
export async function registerGitHubBoardRead(input: GitHubBoardRegistrationRequest, host: RegistrationHost) {
  if (!/^[A-Za-z0-9_=-]{1,256}$/.test(input.projectId)) throw new GitHubBoardRegistrationRefused("Invalid Project identity");
  parseGitHubProjectBoardUrl(input.projectUrl);
  const authority = await host.currentAuthority(input);
  if (!eligible(input, authority)) throw new GitHubBoardRegistrationRefused("Verified personal GitHub authorization is required");
  const pinned = { ...authority };
  const read = await host.probeBoard(input, pinned);
  if (read.projectId !== input.projectId || read.projectUrl !== input.projectUrl || read.accountId !== pinned.accountId
    || read.login.toLowerCase() !== pinned.login.toLowerCase() || read.authorizationRevision !== pinned.authorizationRevision) {
    throw new GitHubBoardRegistrationRefused("GitHub Project or authorization changed");
  }
  const { companyId, paperclipProjectId, userId } = input;
  const scope = { companyId, paperclipProjectId, userId };
  return await host.withTransaction(async tx => {
    await tx.lockCatalog(scope);
    const current = await tx.currentAuthority(input);
    if (!eligible(input, current) || !isDeepStrictEqual(pinned, current)) {
      throw new GitHubBoardRegistrationRefused("GitHub authorization changed before saving");
    }
    const previous = await tx.readGrant(input);
    const grant: GitHubBoardReadRegistration = { ...scope, connectionId: input.connectionId, projectId: input.projectId,
      projectUrl: input.projectUrl, version: 1, grantId: previous?.grantId ?? randomUUID(), accountId: current.accountId,
      login: current.login, authorizationRevision: current.authorizationRevision };
    if (previous && !isDeepStrictEqual(previous, grant)) {
      throw new GitHubBoardRegistrationRefused("A different read grant is retained");
    }
    const previousCatalog = await tx.readCatalog(scope);
    if (previousCatalog && (previousCatalog.companyId !== companyId || previousCatalog.paperclipProjectId !== paperclipProjectId
      || previousCatalog.userId !== userId)) throw new GitHubBoardRegistrationRefused("Read catalog scope changed");
    const projectIds = [...new Set([...(previousCatalog?.projectIds ?? []), input.projectId])];
    if (projectIds.length > 20) throw new GitHubBoardRegistrationRefused("Read catalog limit reached");
    const catalog: GitHubBoardReadCatalog = { ...scope, version: 1, projectIds };
    if (!previous) await tx.saveGrant(grant);
    if (!isDeepStrictEqual(previousCatalog, catalog)) await tx.saveCatalog(catalog);
    if (!isDeepStrictEqual(await tx.readGrant(input), grant) || !isDeepStrictEqual(await tx.readCatalog(scope), catalog)) {
      throw new GitHubBoardRegistrationRefused("Read registration could not be verified");
    }
    return { projectId: input.projectId, grantId: grant.grantId };
  });
}

export type GitHubBoardRevocationRequest = CatalogScope & { projectId: string; expectedGrantId: string };
interface RevocationTransaction {
  lockCatalog(scope: CatalogScope): Promise<void>;
  assertIssueAccess(): Promise<void>;
  readGrant(input: GitHubBoardRevocationRequest): Promise<GitHubBoardReadRegistration | null>;
  readCatalog(scope: CatalogScope): Promise<GitHubBoardReadCatalog | null>;
  removeGrant(input: GitHubBoardRevocationRequest): Promise<void>;
  saveCatalog(value: GitHubBoardReadCatalog): Promise<void>;
}
export async function revokeGitHubBoardRead(input: GitHubBoardRevocationRequest, tx: RevocationTransaction) {
  const { companyId, paperclipProjectId, userId } = input;
  const scope = { companyId, paperclipProjectId, userId };
  await tx.lockCatalog(scope);
  await tx.assertIssueAccess();
  const grant = await tx.readGrant(input);
  const catalog = await tx.readCatalog(scope);
  if (!grant || !catalog || grant.companyId !== companyId || grant.paperclipProjectId !== paperclipProjectId
    || grant.userId !== userId || grant.projectId !== input.projectId || grant.grantId !== input.expectedGrantId
    || catalog.companyId !== companyId || catalog.paperclipProjectId !== paperclipProjectId || catalog.userId !== userId
    || !catalog.projectIds.includes(input.projectId)) {
    throw new GitHubBoardRegistrationRefused("Read access changed. Refresh before removing it.");
  }
  const remaining = { ...catalog, projectIds: catalog.projectIds.filter(projectId => projectId !== input.projectId) };
  await tx.removeGrant(input);
  await tx.saveCatalog(remaining);
  if (await tx.readGrant(input) || !isDeepStrictEqual(await tx.readCatalog(scope), remaining)) {
    throw new GitHubBoardRegistrationRefused("Removal could not be verified");
  }
  return { projectId: input.projectId, grantId: grant.grantId };
}
