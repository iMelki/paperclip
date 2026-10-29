import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import {
  createGitHubOAuthProviderConfig, GITHUB_OAUTH_PRIVATE_REQUESTED_SCOPES as PRIVATE_REQUESTED_SCOPES,
  GITHUB_OAUTH_REQUESTED_SCOPES as REQUESTED_SCOPES, githubStoredPrivateRepoAccessOptIn,
} from "@paperclipai/shared/github-oauth";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { InlineBanner } from "@/components/InlineBanner";
import { SecretBindingPicker, type SecretBindingValue } from "@/components/SecretBindingPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Setup = { callbackUrl: string; registrationUrl: string; requestedScopes: string[]; privateRepoRequestedScopes: string[] };
/** privateRepoAccess is an explicit opt-in to GitHub's full `repo` scope; default is least access. */
type Draft = { clientId: string; expectedLogin: string; secret: SecretBindingValue | null; privateRepoAccess: boolean };
const EMPTY_DRAFT: Draft = { clientId: "", expectedLogin: "", secret: null, privateRepoAccess: false };

function sameScopes(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((scope) => actual.includes(scope));
}

export function draftScopes(setup: Setup, draft: Pick<Draft, "privateRepoAccess">): string[] {
  return draft.privateRepoAccess ? setup.privateRepoRequestedScopes : setup.requestedScopes;
}
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function validateGitHubOAuthSetup(setup: Setup): void {
  const callback = new URL(setup.callbackUrl);
  if (callback.protocol !== "https:" || callback.username || callback.password ||
      callback.pathname !== "/api/tools/oauth/callback" || callback.search || callback.hash ||
      setup.registrationUrl !== "https://github.com/settings/applications/new" ||
      !sameScopes(setup.requestedScopes, REQUESTED_SCOPES) ||
      !sameScopes(setup.privateRepoRequestedScopes, PRIVATE_REQUESTED_SCOPES)) {
    throw new Error("The server did not provide a valid GitHub OAuth setup. Refresh before connecting.");
  }
}

export function githubOAuthDraft(connection: ToolConnection, companyId: string): Draft | null {
  const config = record(connection.config);
  const oauth = record(config.oauth);
  const secrets = connection.credentialSecretRefs?.filter((ref) => ref.configPath === "oauth.client_secret") ?? [];
  if (connection.companyId !== companyId || connection.transport !== "rest_api" ||
      connection.authKind !== "oauth" || connection.ownership !== "customer" ||
      connection.status === "archived" || config.sourceTemplateKey !== "github" ||
      config.methodKey !== "rest-oauth" || typeof oauth.clientId !== "string" ||
      typeof config.expectedGitHubLogin !== "string" || secrets.length !== 1 || !secrets[0].secretId) return null;
  return {
    clientId: oauth.clientId,
    expectedLogin: config.expectedGitHubLogin,
    secret: { secretId: secrets[0].secretId, version: secrets[0].versionSelector ?? "latest" },
    // Legacy connections saved with full repo scope before the flag existed keep their tier on reconnect.
    privateRepoAccess: githubStoredPrivateRepoAccessOptIn(config),
  };
}

function draftKey(draft: Draft): string {
  return JSON.stringify([draft.clientId.trim(), draft.expectedLogin.trim().toLowerCase(),
    draft.secret?.secretId, draft.secret?.version ?? "latest", draft.privateRepoAccess === true]);
}

export function validateGitHubAuthorizationUrl(raw: string, setup: Setup, draft: Draft): string {
  const url = new URL(raw);
  const params = url.searchParams;
  const fields = ["client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "login"];
  const scopes = (params.get("scope") ?? "").split(/\s+/);
  const expectedScopes = draftScopes(setup, draft);
  if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize" ||
      url.username || url.password || url.hash || fields.some((field) => params.getAll(field).length !== 1) ||
      params.get("client_id") !== draft.clientId.trim() || params.get("redirect_uri") !== setup.callbackUrl ||
      params.get("login")?.toLowerCase() !== draft.expectedLogin.trim().toLowerCase() ||
      !params.get("state")?.trim() || params.get("code_challenge_method") !== "S256" ||
      !/^[a-z\d_-]{43}$/i.test(params.get("code_challenge") ?? "") ||
      !sameScopes(scopes, expectedScopes)) {
    throw new Error("The sign-in link does not match this account, app or callback. Refresh saved connections.");
  }
  return url.toString();
}

function draftError(draft: Draft): { field: keyof Draft; message: string } | null {
  if (!LOGIN.test(draft.expectedLogin.trim()) || draft.expectedLogin.includes("--")) return { field: "expectedLogin", message: "Enter the GitHub login you intend to authorize." };
  try { createGitHubOAuthProviderConfig(draft.clientId); } catch {
    return { field: "clientId", message: "Enter the OAuth App's public client ID, not a token or client secret." };
  }
  if (!draft.secret?.secretId) return { field: "secret", message: "Select a saved client secret from this company." };
  return null;
}

export function GitHubOAuthConnect() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyScope = useRef(selectedCompanyId);
  companyScope.current = selectedCompanyId;
  return selectedCompanyId
    ? <GitHubOAuthCompanySetup key={selectedCompanyId} companyId={selectedCompanyId} companyScope={companyScope} companyName={selectedCompany?.name ?? "Company"} />
    : <p className="p-6 text-sm text-muted-foreground">Select a company to connect GitHub.</p>;
}

function GitHubOAuthCompanySetup({ companyId, companyName, companyScope }: {
  companyId: string; companyName: string; companyScope: RefObject<string | null>;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const custody = useRef({ alive: true, generation: 0, busy: false });
  const unknownCreates = useRef(new Set<string>());
  useLayoutEffect(() => {
    custody.current.alive = true;
    return () => { custody.current.alive = false; custody.current.generation++; };
  }, []);
  const setupQuery = useQuery({
    queryKey: ["tools", "github-oauth-setup", companyId],
    queryFn: () => toolsApi.getGitHubOAuthSetup(companyId), retry: false,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId), retry: false, refetchOnMount: "always",
  });
  let setup: Setup | null = setupQuery.data ?? null;
  try { if (setup) validateGitHubOAuthSetup(setup); } catch { setup = null; }
  const candidates = (connectionsQuery.data?.connections ?? []).filter((connection) => githubOAuthDraft(connection, companyId));
  const selected = candidates.find((connection) => draftKey(githubOAuthDraft(connection, companyId)!) === draftKey(draft));
  const changeDraft = (next: Draft) => {
    // A previously submitted secret dialog can finish while consent setup is pending.
    if (custody.current.busy) return;
    custody.current.generation++;
    setDraft(next); setError(null); setMessage("");
  };

  async function connect() {
    if (custody.current.busy || !setup) return;
    const validation = draftError(draft);
    if (validation) {
      setError(validation.message);
      const field = document.getElementById(`${id}-${validation.field}`);
      (field instanceof HTMLInputElement ? field : field?.querySelector("select"))?.focus();
      return;
    }
    const snapshot = draft;
    const callbackUrl = setup.callbackUrl;
    const generation = ++custody.current.generation;
    const current = () => custody.current.alive && custody.current.generation === generation && companyScope.current === companyId;
    custody.current.busy = true; setBusy(true); setError(null); setMessage("Checking saved setup…");
    try {
      const [freshSetup, freshConnections] = await Promise.all([
        toolsApi.getGitHubOAuthSetup(companyId), toolsApi.listConnections(companyId),
      ]);
      if (!current()) return;
      validateGitHubOAuthSetup(freshSetup);
      if (freshSetup.callbackUrl !== callbackUrl) throw new Error("The callback changed. Refresh setup before connecting.");
      client.setQueryData(queryKeys.tools.connections(companyId), freshConnections);
      const matches = freshConnections.connections.filter((connection) => {
        const saved = githubOAuthDraft(connection, companyId);
        return saved && draftKey(saved) === draftKey(snapshot);
      });
      if (matches.length > 1) throw new Error("More than one saved setup matches. Review connections before reconnecting.");
      let authorizationUrl: string;
      if (matches.length === 1) {
        setMessage("Resuming the matching saved connection…");
        const started = await toolsApi.startOAuth(matches[0].id);
        if (started.connectionId !== matches[0].id || started.provider !== "github") throw new Error("The returned connection does not match this setup.");
        if (!(Date.parse(started.expiresAt) > Date.now())) throw new Error("The sign-in request expired. Refresh saved setup before reconnecting.");
        authorizationUrl = started.authorizationUrl;
      } else {
        if (unknownCreates.current.has(draftKey(snapshot))) throw new Error("The previous save outcome is unknown. No matching saved draft was found; do not create another. Refresh connections or ask for recovery.");
        unknownCreates.current.add(draftKey(snapshot));
        setMessage("Preparing this company's GitHub connection…");
        const result = await toolsApi.connectApp(companyId, {
          galleryKey: "github", methodKey: "rest-oauth", name: "GitHub OAuth",
          credentialValues: { "credentials.clientId": snapshot.clientId.trim() },
          credentialSecretRefs: [{ configPath: "oauth.client_secret", secretId: snapshot.secret!.secretId,
            versionSelector: snapshot.secret!.version ?? "latest", required: true, label: "OAuth client secret" }],
          configValues: snapshot.privateRepoAccess
            ? { expectedGitHubLogin: snapshot.expectedLogin.trim(), githubPrivateRepoAccess: true }
            : { expectedGitHubLogin: snapshot.expectedLogin.trim() },
        });
        const saved = githubOAuthDraft(result.connection, companyId);
        if (!saved || result.connectionId !== result.connection.id || draftKey(saved) !== draftKey(snapshot) || !result.auth?.startUrl) {
          throw new Error("The prepared connection could not be verified. Refresh saved connections; do not create another.");
        }
        authorizationUrl = result.auth.startUrl;
      }
      if (!current()) return;
      const target = validateGitHubAuthorizationUrl(authorizationUrl, freshSetup, snapshot);
      setMessage("Opening GitHub. Review the account and permissions before approving.");
      navigateTopLevel(target);
    } catch (failure) {
      if (current()) {
        setError(failure instanceof Error ? failure.message : "Could not prepare GitHub sign-in. Refresh saved connections.");
        setMessage("");
      }
    } finally {
      if (current()) { custody.current.busy = false; setBusy(false); }
    }
  }

  return (
    <div className="max-w-3xl space-y-6 p-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Connect GitHub to {companyName}</h1>
        <p className="text-sm text-muted-foreground">Use a dedicated OAuth App. GitHub registration and consent remain your final clicks.</p>
      </div>
      <InlineBanner title="Authorization does not run agents">
        This saves a GitHub connection only. It does not install tools, grant agent access, import tasks or start sync.
        By default Paperclip asks only for read-only Projects access and public repositories. Full private-repository
        access (GitHub's broad read/write `repo` scope) is requested only if you opt in below.
      </InlineBanner>
      {setup ? (
        <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby={`${id}-registration`}>
          <h2 id={`${id}-registration`} className="text-lg font-semibold">1. Register your Paperclip OAuth App</h2>
          <p className="text-sm">Use this exact callback; a different hostname or port will not match.</p>
          <Label htmlFor={`${id}-callback`}>Authorization callback URL</Label>
          <Input id={`${id}-callback`} readOnly value={setup.callbackUrl} className="font-mono" />
          <p className="break-words text-sm text-muted-foreground">Requested scopes: {draftScopes(setup, draft).join(", ")}</p>
          <a className="text-sm underline" href={setup.registrationUrl} target="_blank" rel="noopener noreferrer">Open GitHub OAuth App registration</a>
        </section>
      ) : (
        <div role="alert"><InlineBanner tone="warning">{setupQuery.isPending ? "Loading the server's callback…" : "The server's OAuth setup is unavailable or invalid. Refresh before connecting."}</InlineBanner></div>
      )}
      <form className="space-y-4 rounded-xl border border-border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void connect(); }} noValidate>
        <h2 className="text-lg font-semibold">2. Select the account and saved app secret</h2>
        {candidates.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor={`${id}-saved`}>Existing GitHub OAuth setup</Label>
            <select id={`${id}-saved`} className="w-full rounded-md border border-input bg-background p-2 text-sm" disabled={busy}
              value={selected?.id ?? ""} onChange={(event) => {
                const connection = candidates.find((candidate) => candidate.id === event.target.value);
                changeDraft(connection ? githubOAuthDraft(connection, companyId)! : EMPTY_DRAFT);
              }}>
              <option value="">Enter a setup below</option>
              {candidates.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.status ?? "saved"}</option>)}
            </select>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor={`${id}-expectedLogin`}>Expected GitHub login</Label>
          <Input id={`${id}-expectedLogin`} autoComplete="off" disabled={busy} value={draft.expectedLogin}
            onChange={(event) => changeDraft({ ...draft, expectedLogin: event.target.value })} aria-describedby={`${id}-login-help`} />
          <p id={`${id}-login-help`} className="text-sm text-muted-foreground">Paperclip must verify this account after consent. This is your login, not your email address.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-clientId`}>OAuth App public client ID</Label>
          <Input id={`${id}-clientId`} autoComplete="off" disabled={busy} value={draft.clientId}
            onChange={(event) => changeDraft({ ...draft, clientId: event.target.value })} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-privateRepoAccess`} disabled={busy} checked={draft.privateRepoAccess}
              aria-describedby={`${id}-private-help`}
              onCheckedChange={(checked) => changeDraft({ ...draft, privateRepoAccess: checked === true })} />
            <Label htmlFor={`${id}-privateRepoAccess`}>Include private repositories</Label>
          </div>
          <p id={`${id}-private-help`} className="text-sm text-muted-foreground">Off by default. Turning this on requests GitHub's full repo and project scopes, which allow read and write access to every private repository this account can reach. Leave it off to import boards that only use public repositories.</p>
        </div>
        <fieldset id={`${id}-secret`} className="space-y-2">
          <legend className="text-sm font-medium">OAuth client secret</legend>
          <SecretBindingPicker value={draft.secret} onChange={(secret) => changeDraft({ ...draft, secret })}
            label="Saved OAuth client secret" disabled={busy} allowVersionSelector={false} />
          <p className="text-sm text-muted-foreground">Choose a secret saved in this company. Only its reference is used; its value is not displayed or stored in this form.</p>
        </fieldset>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{message}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !setup || connectionsQuery.isPending || connectionsQuery.isError}>{busy ? "Preparing sign-in…" : "Connect GitHub"}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => { void setupQuery.refetch(); void connectionsQuery.refetch(); }}>Refresh saved setup</Button>
          <Button type="button" variant="ghost" onClick={() => navigate("/apps")}>Cancel</Button>
        </div>
        {connectionsQuery.isError && <p role="alert" className="text-sm text-destructive">Saved connections could not be checked. Refresh before creating or reconnecting.</p>}
      </form>
      {selected && <GitHubOAuthSavedSummary connection={selected} />}
    </div>
  );
}

function GitHubOAuthSavedSummary({ connection }: { connection: ToolConnection }) {
  const metadata = record(record(record(connection.config).providerMetadata).githubOAuth);
  const login = typeof metadata.verifiedLogin === "string" ? metadata.verifiedLogin : typeof metadata.login === "string" ? metadata.login : null;
  const scopes = Array.isArray(metadata.grantedScopes) ? metadata.grantedScopes.filter((scope): scope is string => typeof scope === "string") : [];
  return <section className="space-y-2 rounded-xl border border-border p-4" aria-label="Saved GitHub connection">
    <h2 className="text-lg font-semibold">Saved connection</h2>
    <p className="text-sm">{login ? `Last verified GitHub login: ${login}` : "GitHub account has not been verified in this saved setup."}</p>
    <p className="break-words text-sm">Granted scopes: {scopes.length ? scopes.join(", ") : "not verified"}</p>
    <p className="text-sm text-muted-foreground">This screen does not enable agent access, tools or project imports.</p>
  </section>;
}
