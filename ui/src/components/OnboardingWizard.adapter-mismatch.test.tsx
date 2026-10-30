// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingWizard } from "./OnboardingWizard";

const agentsApiMock = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  get: vi.fn(),
  hire: vi.fn(),
  instructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  testEnvironment: vi.fn(),
  update: vi.fn(),
}));
const closeOnboardingMock = vi.hoisted(() => vi.fn());
const setRouteDismissedMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({ agentsApi: agentsApiMock }));
// Setup only: upstream restores a saved draft only after a settled company
// list shows the draft's company is still owned by this account.
vi.mock("../api/companies-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/companies-query")>()),
  useCompanyListQuery: () => ({
    isSuccess: true,
    isFetching: false,
    data: { companies: [{ id: "company-1" }], unauthorized: false },
  }),
}));
// Setup only: upstream's Test now resolves the run environment before it
// probes (fail-closed), so these stubs let it settle on the server default.
vi.mock("../api/environments", () => ({
  environmentsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    get: vi.fn(async () => ({ defaultEnvironmentId: null })),
    getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
  },
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    onboardingOpen: true,
    onboardingOptions: {},
    closeOnboarding: closeOnboardingMock,
    onboardingRouteDismissed: false,
    setOnboardingRouteDismissed: setRouteDismissedMock,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    loading: false,
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/dashboard" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => new Set<string>(),
  // Setup only: upstream's wizard also gates on the adapter registry load.
  useAdapterRegistryLoaded: () => true,
}));

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({ supportsInstructionsBundle: true }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./AgentCapsule", () => ({
  AgentCapsule: () => <div data-testid="agent-capsule" />,
}));
vi.mock("./AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div data-testid="ascii-art" />,
}));
vi.mock("./FrontDoor", () => ({
  FrontDoor: () => <div data-testid="front-door" />,
}));

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Chief of staff",
    role: "ceo",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      paperclipSkillSync: { desiredSkillEntries: ["planning"] },
    },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "chief-of-staff",
    permissions: { canCreateAgents: true },
    metadata: null,
    ...overrides,
  };
}

function saveWizardState(step: 4 | 5) {
  window.localStorage.setItem(
    "paperclip-onboarding-state",
    JSON.stringify({
      step,
      onboardingPath: "create",
      companyName: "Example Co",
      companyGoal: "Ship safely",
      missionPath: "direct",
      missionConfirmed: true,
      agentName: "Chief of staff",
      adapterType: step === 4 ? "claude_local" : "codex_local",
      model: step === 4 ? "claude-sonnet-4-6" : "",
      modelTouched: false,
      command: "",
      args: "",
      url: "",
      urlTouched: false,
      cwd: "",
      createdCompanyId: "company-1",
      createdCompanyPrefix: "EX",
      createdAgentId: "agent-1",
      createdCompanyGoalId: "goal-1",
    }),
  );
}

async function flushReact() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function findButton(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function click(button: HTMLButtonElement) {
  flushSync(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("OnboardingWizard saved adapter persistence", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderWizard() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    vi.clearAllMocks();
    agentsApiMock.adapterModels.mockResolvedValue([]);
    agentsApiMock.testEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: "2026-09-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.localStorage.clear();
  });

  it("warns when the server hires a different adapter than requested", async () => {
    window.localStorage.setItem(
      "paperclip-onboarding-state",
      JSON.stringify({
        step: 4,
        onboardingPath: "create",
        companyName: "Example Co",
        companyGoal: "Ship safely",
        missionPath: "direct",
        missionConfirmed: true,
        agentName: "Chief of staff",
        adapterType: "claude_local",
        model: "claude-sonnet-4-6",
        modelTouched: false,
        command: "",
        args: "",
        url: "",
        urlTouched: false,
        cwd: "",
        createdCompanyId: "company-1",
        createdCompanyPrefix: "EX",
        createdAgentId: null,
        createdCompanyGoalId: "goal-1",
      }),
    );
    const hiredAgent = makeAgent({
      adapterType: "http",
      adapterConfig: { url: "http://127.0.0.1:1/dead" },
    });
    agentsApiMock.hire.mockResolvedValue({ agent: hiredAgent, approval: null });
    agentsApiMock.get.mockResolvedValue(hiredAgent);
    agentsApiMock.instructionsBundle.mockResolvedValue({ entryFile: "AGENTS.md" });
    agentsApiMock.saveInstructionsFile.mockResolvedValue(undefined);

    await renderWizard();
    const connect = findButton("Connect") ?? findButton("Give it a heartbeat");
    expect(connect).toBeDefined();
    click(connect!);
    await flushReact();
    await flushReact();

    expect(agentsApiMock.hire).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ adapterType: "claude_local" }),
    );
    const warning = document.body.querySelector(
      '[data-testid="onboarding-adapter-mismatch-warning"]',
    );
    expect(warning?.getAttribute("role")).toBe("alert");
    expect(warning?.textContent).toContain("Connected with");
    expect(warning?.textContent).toContain("(http)");
    expect(warning?.textContent).toContain("(claude_local)");
  });
  function saveFreshHireState() {
    window.localStorage.setItem(
      "paperclip-onboarding-state",
      JSON.stringify({
        step: 4,
        onboardingPath: "create",
        companyName: "Example Co",
        companyGoal: "Ship safely",
        missionPath: "direct",
        missionConfirmed: true,
        agentName: "Chief of staff",
        adapterType: "claude_local",
        model: "claude-sonnet-4-6",
        modelTouched: false,
        command: "",
        args: "",
        url: "",
        urlTouched: false,
        cwd: "",
        createdCompanyId: "company-1",
        createdCompanyPrefix: "EX",
        createdAgentId: null,
        createdCompanyGoalId: "goal-1",
      }),
    );
    agentsApiMock.instructionsBundle.mockResolvedValue({ entryFile: "AGENTS.md" });
    agentsApiMock.saveInstructionsFile.mockResolvedValue(undefined);
  }

  async function connectFreshHire() {
    await renderWizard();
    const connect = findButton("Connect") ?? findButton("Give it a heartbeat");
    expect(connect).toBeDefined();
    click(connect!);
    await flushReact();
    await flushReact();
  }

  function mismatchWarning() {
    return document.body.querySelector(
      '[data-testid="onboarding-adapter-mismatch-warning"]',
    );
  }

  it("shows no mismatch warning when the hire returns the requested adapter", async () => {
    saveFreshHireState();
    const hiredAgent = makeAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-6" },
    });
    agentsApiMock.hire.mockResolvedValue({ agent: hiredAgent, approval: null });
    agentsApiMock.get.mockResolvedValue(hiredAgent);

    await connectFreshHire();

    expect(agentsApiMock.hire).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ adapterType: "claude_local" }),
    );
    expect(document.body.textContent).toContain("Saved configuration");
    expect(mismatchWarning()).toBeNull();
    expect(findButton("Get started")?.disabled).toBe(false);
  });

  it("shows no mismatch warning and verifies against the requested type when the hire response has no adapter type", async () => {
    saveFreshHireState();
    const hiredAgent = makeAgent({ adapterConfig: { model: "claude-sonnet-4-6" } });
    const hireResponseAgent = { ...hiredAgent, adapterType: undefined } as unknown as typeof hiredAgent;
    agentsApiMock.hire.mockResolvedValue({ agent: hireResponseAgent, approval: null });
    agentsApiMock.get.mockResolvedValue(hiredAgent);

    await connectFreshHire();

    expect(mismatchWarning()).toBeNull();
    // Readback is claude_local, the requested type, so Review verifies.
    expect(findButton("Get started")?.disabled).toBe(false);
  });

  it("blocks Get started when the hire response has no adapter type and the readback differs from the requested type", async () => {
    saveFreshHireState();
    const requested = makeAgent({ adapterConfig: { model: "claude-sonnet-4-6" } });
    const hireResponseAgent = { ...requested, adapterType: undefined } as unknown as typeof requested;
    agentsApiMock.hire.mockResolvedValue({ agent: hireResponseAgent, approval: null });
    agentsApiMock.get.mockResolvedValue(
      makeAgent({ adapterType: "http", adapterConfig: { model: "claude-sonnet-4-6" } }),
    );

    await connectFreshHire();

    expect(mismatchWarning()).toBeNull();
    expect(findButton("Get started")?.disabled).toBe(true);
  });
});
