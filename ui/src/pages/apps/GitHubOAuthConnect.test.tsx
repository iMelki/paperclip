// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubOAuthConnect, githubOAuthDraft, validateGitHubAuthorizationUrl, validateGitHubOAuthSetup } from "./GitHubOAuthConnect";

const api = vi.hoisted(() => ({ setup: vi.fn(), list: vi.fn(), connect: vi.fn(), start: vi.fn(), finish: vi.fn(), install: vi.fn() }));
const nav = vi.hoisted(() => ({ top: vi.fn(), route: vi.fn() }));
const company = vi.hoisted(() => ({ id: "company-1" as string | null }));
const picker = vi.hoisted(() => ({ change: null as null | ((value: unknown) => void) }));
vi.mock("@/api/tools", () => ({ toolsApi: {
  getGitHubOAuthSetup: (id: string) => api.setup(id), listConnections: (id: string) => api.list(id),
  connectApp: (id: string, input: unknown) => api.connect(id, input), startOAuth: (id: string) => api.start(id),
  finishApp: (...args: unknown[]) => api.finish(...args), putConnectionInstalls: (...args: unknown[]) => api.install(...args),
} }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: company.id, selectedCompany: { name: "Fixture company" } }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => nav.route }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: (url: string) => nav.top(url) }));
// Secret values never enter this fixture; this models the incumbent metadata-only selection contract.
vi.mock("@/components/SecretBindingPicker", () => ({ SecretBindingPicker: ({ value, onChange, disabled, label }: {
  value: { secretId: string } | null; onChange: (value: unknown) => void; disabled: boolean; label: string;
}) => { picker.change = onChange; return <select aria-label={label} disabled={disabled} value={value?.secretId ?? ""}
  onChange={(event) => onChange(event.target.value ? { secretId: event.target.value, version: "latest" } : null)}>
  <option value="">Select secret</option><option value="secret-1">Saved fixture secret</option>
</select>; } }));

const SETUP = { callbackUrl: "https://paperclip.fixture.test:5113/api/tools/oauth/callback", registrationUrl: "https://github.com/settings/applications/new", requestedScopes: ["repo", "project", "offline_access"] };
const DRAFT = { clientId: "public-client-123", expectedLogin: "fixture-user", secret: { secretId: "secret-1", version: "latest" as const } };
function connection(overrides: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id: "conn-1", companyId: "company-1", transport: "rest_api", authKind: "oauth", ownership: "customer",
    name: "GitHub OAuth", status: "draft", config: { sourceTemplateKey: "github", methodKey: "rest-oauth", oauth: { clientId: DRAFT.clientId }, expectedGitHubLogin: DRAFT.expectedLogin },
    credentialSecretRefs: [{ configPath: "oauth.client_secret", secretId: "secret-1", versionSelector: "latest", required: true }],
    ...overrides,
  } as ToolConnection;
}
function authorization(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({ client_id: DRAFT.clientId, redirect_uri: SETUP.callbackUrl,
    login: DRAFT.expectedLogin, scope: SETUP.requestedScopes.join(" "), state: "opaque-fixture-state",
    code_challenge: "a".repeat(43), code_challenge_method: "S256", ...overrides });
  return `https://github.com/login/oauth/authorize?${params}`;
}
function prepared() { return { connectionId: "conn-1", connection: connection(), auth: { kind: "oauth", startUrl: authorization() } }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GitHub customer OAuth discriminators", () => {
  it("accepts exactly the native HTTPS callback and scopes", () => {
    expect(() => validateGitHubOAuthSetup(SETUP)).not.toThrow();
    for (const callbackUrl of ["http://paperclip.fixture.test/api/tools/oauth/callback", "https://paperclip.fixture.test/other", `${SETUP.callbackUrl}?token=x`, `https://user:pass@paperclip.fixture.test/api/tools/oauth/callback`]) {
      expect(() => validateGitHubOAuthSetup({ ...SETUP, callbackUrl })).toThrow();
    }
    expect(() => validateGitHubOAuthSetup({ ...SETUP, requestedScopes: ["repo", "project", "delete_repo"] })).toThrow();
  });
  it("requires company, customer REST method and exactly one secret reference", () => {
    expect(githubOAuthDraft(connection(), "company-1")).toEqual(DRAFT);
    for (const candidate of [connection({ companyId: "company-2" }), connection({ transport: "mcp_remote" }),
      connection({ status: "archived" }), connection({ ownership: "platform_shared" }),
      connection({ credentialSecretRefs: [] }), connection({ config: { sourceTemplateKey: "github", methodKey: "mcp-key" } })]) {
      expect(githubOAuthDraft(candidate, "company-1")).toBeNull();
    }
  });
  it("accepts only the matching GitHub PKCE consent URL", () => {
    expect(validateGitHubAuthorizationUrl(authorization(), SETUP, DRAFT)).toBe(authorization());
    for (const overrides of [{ client_id: "other-client" }, { redirect_uri: SETUP.callbackUrl.replace(":5113", ":8443") },
      { login: "other-user" }, { scope: "repo" }, { scope: "repo project offline_access delete_repo" },
      { state: "" }, { code_challenge: "short" }, { code_challenge_method: "plain" }]) {
      expect(() => validateGitHubAuthorizationUrl(authorization(overrides), SETUP, DRAFT)).toThrow();
    }
    expect(() => validateGitHubAuthorizationUrl(authorization().replace("github.com", "github.com.example.test"), SETUP, DRAFT)).toThrow();
    expect(() => validateGitHubAuthorizationUrl(`${authorization()}&client_id=other`, SETUP, DRAFT)).toThrow();
  });
});

describe("dedicated GitHub OAuth setup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks(); company.id = "company-1";
    api.setup.mockResolvedValue(SETUP); api.list.mockResolvedValue({ connections: [] });
    api.connect.mockResolvedValue(prepared());
    api.start.mockResolvedValue({ connectionId: "conn-1", provider: "github", authorizationUrl: authorization(), expiresAt: "2099-01-01T00:00:00.000Z" });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); client.clear(); container.remove();
  });
  async function flush() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><GitHubOAuthConnect /></QueryClientProvider>));
    await flush();
  }
  function button(text: string) {
    const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
    expect(found).toBeTruthy(); return found!;
  }
  async function click(text: string) {
    await act(async () => button(text).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
  }
  async function fill() {
    for (const [suffix, value] of [["expectedLogin", DRAFT.expectedLogin], ["clientId", DRAFT.clientId]]) {
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Saved OAuth client secret"]')!;
      select.value = "secret-1"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function chooseSaved() {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[id$="-saved"]')!;
      select.value = "conn-1"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("loads metadata only on mount and exposes native callback registration", async () => {
    await render();
    expect(api.connect).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); expect(nav.top).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[id$="-callback"]')?.value).toBe(SETUP.callbackUrl);
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://github.com/settings/applications/new"]')?.rel).toContain("noopener");
    expect(api.finish).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
  });
  it("sends only public client ID and a scoped secret reference on explicit Connect", async () => {
    await render(); await fill(); await click("Connect GitHub");
    expect(api.connect).toHaveBeenCalledExactlyOnceWith("company-1", {
      galleryKey: "github", methodKey: "rest-oauth", name: "GitHub OAuth",
      credentialValues: { "credentials.clientId": DRAFT.clientId },
      credentialSecretRefs: [{ configPath: "oauth.client_secret", secretId: "secret-1", versionSelector: "latest", required: true, label: "OAuth client secret" }],
      configValues: { expectedGitHubLogin: DRAFT.expectedLogin },
    });
    expect(nav.top).toHaveBeenCalledExactlyOnceWith(authorization());
    expect(api.finish).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it("validates required login and focuses its named input before any mutation", async () => {
    await render(); await click("Connect GitHub");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter the GitHub login");
    expect(document.activeElement?.id.endsWith("-expectedLogin")).toBe(true); expect(api.connect).not.toHaveBeenCalled();
    const label = container.querySelector<HTMLLabelElement>('label[for$="-expectedLogin"]');
    expect(label?.control).toBe(document.activeElement);
  });
  it("does not invalidate or lock Connect when a previously submitted secret dialog binds late", async () => {
    const pending = deferred<ReturnType<typeof prepared>>();
    api.connect.mockReturnValueOnce(pending.promise);
    await render(); await fill(); await click("Connect GitHub");
    await act(async () => { picker.change?.({ secretId: "late-secret", version: "latest" }); });
    pending.resolve(prepared()); await flush(); await flush();
    expect(nav.top).toHaveBeenCalledExactlyOnceWith(authorization());
    expect(button("Connect GitHub").disabled).toBe(false);
    expect(api.connect).toHaveBeenCalledTimes(1);
  });
  it.each(["public.client", "c".repeat(129), "github_pat_synthetic", "gho_synthetic"])(
    "rejects a noncanonical client ID before a save or unknown-outcome hold", async (clientId) => {
      await render(); await fill();
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>('input[id$="-clientId"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, clientId);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Connect GitHub");
      expect(api.connect).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("public client ID");
    },
  );
  it("resumes an exact current-company REST draft rather than creating one", async () => {
    api.list.mockResolvedValue({ connections: [connection()] });
    await render(); await chooseSaved(); await click("Connect GitHub");
    expect(api.connect).not.toHaveBeenCalled(); expect(api.start).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(nav.top).toHaveBeenCalledExactlyOnceWith(authorization());
  });
  it("recovers a response-lost create by reading saved drafts before retry", async () => {
    api.connect.mockRejectedValueOnce(new Error("Fixture response lost"));
    await render(); await fill(); await click("Connect GitHub");
    expect(nav.top).not.toHaveBeenCalled();
    api.list.mockResolvedValue({ connections: [connection()] });
    await click("Connect GitHub");
    expect(api.connect).toHaveBeenCalledTimes(1); expect(api.start).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(nav.top).toHaveBeenCalledExactlyOnceWith(authorization());
  });
  it("holds unknown save without a matching draft; never blindly creates again", async () => {
    api.connect.mockRejectedValueOnce(new Error("Fixture response lost"));
    await render(); await fill(); await click("Connect GitHub"); await click("Connect GitHub");
    expect(api.connect).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled();
    expect(container.textContent).toContain("previous save outcome is unknown"); expect(nav.top).not.toHaveBeenCalled();
  });
  it("rejects ambiguous matching drafts instead of choosing an arbitrary one", async () => {
    api.list.mockResolvedValue({ connections: [connection(), connection({ id: "conn-2" })] });
    await render(); await fill(); await click("Connect GitHub");
    expect(container.textContent).toContain("More than one saved setup matches");
    expect(api.connect).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
  });
  it("discards an old company's pending response after a company switch", async () => {
    const pending = deferred<ReturnType<typeof prepared>>(); api.connect.mockReturnValueOnce(pending.promise);
    await render(); await fill(); await click("Connect GitHub");
    company.id = "company-2"; await render();
    await act(async () => pending.resolve(prepared())); await flush();
    expect(nav.top).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[id$="-clientId"]')?.value).toBe("");
  });
  it("refuses callback drift before preparing a connection", async () => {
    await render(); await fill();
    api.setup.mockResolvedValueOnce({ ...SETUP, callbackUrl: SETUP.callbackUrl.replace(":5113", ":8443") });
    await click("Connect GitHub"); expect(container.textContent).toContain("callback changed");
    expect(api.connect).not.toHaveBeenCalled(); expect(nav.top).not.toHaveBeenCalled();
  });
  it("refuses a wrong-company preparation and a wrong-account redirect", async () => {
    api.connect.mockResolvedValueOnce({ ...prepared(), connection: connection({ companyId: "company-2" }) });
    await render(); await fill(); await click("Connect GitHub"); expect(nav.top).not.toHaveBeenCalled();
    api.list.mockResolvedValue({ connections: [connection()] });
    api.start.mockResolvedValueOnce({ connectionId: "conn-1", provider: "github", authorizationUrl: authorization({ login: "other-user" }), expiresAt: "2099-01-01T00:00:00.000Z" });
    await click("Connect GitHub"); expect(nav.top).not.toHaveBeenCalled();
    expect(container.textContent).toContain("does not match this account");
  });
  it("disables Connect if saved connections or native setup cannot be checked", async () => {
    api.list.mockRejectedValue(new Error("Fixture read failed")); await render();
    expect(button("Connect GitHub").disabled).toBe(true); expect(api.connect).not.toHaveBeenCalled();
  });
  it("does not follow an expired recovered sign-in request", async () => {
    api.list.mockResolvedValue({ connections: [connection()] });
    api.start.mockResolvedValueOnce({ connectionId: "conn-1", provider: "github", authorizationUrl: authorization(), expiresAt: "2000-01-01T00:00:00.000Z" });
    await render(); await chooseSaved(); await click("Connect GitHub");
    expect(container.textContent).toContain("sign-in request expired"); expect(nav.top).not.toHaveBeenCalled();
  });
  it("allows only one preparation while an explicit click is pending", async () => {
    const pending = deferred<ReturnType<typeof prepared>>(); api.connect.mockReturnValueOnce(pending.promise);
    await render(); await fill(); await click("Connect GitHub");
    await act(async () => button("Preparing sign-in…").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(api.connect).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(prepared())); await flush();
    expect(nav.top).toHaveBeenCalledTimes(1);
  });
  it("shows verified readback without claiming tool installation", async () => {
    api.list.mockResolvedValue({ connections: [connection({ config: { ...connection().config,
      providerMetadata: { githubOAuth: { login: "fixture-user", verifiedAccountId: 12, grantedScopes: ["repo", "project"] } } } })] });
    await render(); await chooseSaved();
    expect(container.textContent).toContain("Last verified GitHub login: fixture-user");
    expect(container.textContent).toContain("Granted scopes: repo, project"); expect(api.finish).not.toHaveBeenCalled();
  });
});
