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

  it("preserves hidden same-adapter settings through PATCH and authoritative readback", async () => {
    saveWizardState(4);
    const privateConfigSentinel = "PRIVATE-CONFIG-MUST-STAY-IN-MEMORY";
    const preservedConfig = {
      model: "claude-sonnet-4-6",
      paperclipSkillSync: { desiredSkillEntries: ["planning"] },
      cwd: "C:/operator-work",
      command: "claude-custom",
      args: ["--resume", "session-1"],
      url: "https://operator.example",
      engine: "acp",
      agentCommand: "claude-acp",
      stateDir: "C:/claude-state",
      configProfile: "operator-owned",
      extraArgs: ["--resume"],
      workspaceStrategy: { type: "git_worktree", baseRef: "dev" },
      workspaceRuntime: { services: [{ name: "api", command: "pnpm dev" }] },
      timeoutSec: 91,
      graceSec: 27,
      devicePrivateKeyPem: privateConfigSentinel,
    };
    const existingAgent = makeAgent({ adapterConfig: preservedConfig });
    const savedAgent = makeAgent({ adapterConfig: preservedConfig });
    agentsApiMock.get
      .mockResolvedValueOnce(existingAgent)
      .mockResolvedValue(savedAgent);
    agentsApiMock.update.mockResolvedValue(savedAgent);

    await renderWizard();
    click(findButton("Give it a heartbeat")!);
    await flushReact();

    expect(agentsApiMock.update).toHaveBeenCalledWith(
      "agent-1",
      {},
      "company-1",
    );
    expect(agentsApiMock.testEnvironment).toHaveBeenCalledWith(
      "company-1",
      "claude_local",
      { adapterConfig: preservedConfig },
    );
    expect(agentsApiMock.get).toHaveBeenNthCalledWith(2, "agent-1", "company-1");
    expect(agentsApiMock.hire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Saved configuration");
    expect(findButton("Get started")?.disabled).toBe(false);
    expect(window.localStorage.getItem("paperclip-onboarding-state")).not.toContain(
      privateConfigSentinel,
    );
    expect(document.body.textContent).not.toContain(privateConfigSentinel);
  });

  it("does not PATCH when the effective preserved configuration fails its environment check", async () => {
    saveWizardState(4);
    const existingAgent = makeAgent({
      adapterConfig: {
        model: "claude-sonnet-4-6",
        cwd: "C:/operator-work",
        command: "claude-custom",
        args: ["--resume", "session-1"],
        env: { API_KEY: { type: "secret_ref", secretId: "secret-1" } },
      },
    });
    agentsApiMock.get.mockResolvedValue(existingAgent);
    agentsApiMock.testEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "fail",
      checks: [{ code: "command_missing", status: "fail" }],
      testedAt: "2026-09-01T00:00:00.000Z",
    });

    await renderWizard();
    click(findButton("Give it a heartbeat")!);
    await flushReact();

    expect(agentsApiMock.testEnvironment).toHaveBeenCalledWith(
      "company-1",
      "claude_local",
      { adapterConfig: existingAgent.adapterConfig },
    );
    expect(agentsApiMock.update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Adapter environment check failed",
    );
    expect(findButton("Get started")).toBeUndefined();
  });

  it("verifies the server-normalized Codex save without exposing private fields", async () => {
    saveWizardState(4);
    const privateConfigSentinel = "SERVER-NORMALIZED-PRIVATE-CONFIG";
    const existingAgent = makeAgent();
    let savedAgent = makeAgent();
    agentsApiMock.get
      .mockResolvedValueOnce(existingAgent)
      .mockImplementation(() => Promise.resolve(savedAgent));
    agentsApiMock.update.mockImplementation(
      async (_agentId: string, patch: Record<string, unknown>) => {
        savedAgent = makeAgent({
          adapterType: "codex_local",
          adapterConfig: {
            ...(patch.adapterConfig as Record<string, unknown>),
            devicePrivateKeyPem: privateConfigSentinel,
          },
        });
        return savedAgent;
      },
    );

    await renderWizard();
    click(findButton("Codex")!);
    await flushReact();
    click(findButton("Give it a heartbeat")!);
    await flushReact();

    expect(agentsApiMock.testEnvironment).toHaveBeenCalledWith(
      "company-1",
      "codex_local",
      { adapterConfig: expect.any(Object) },
    );
    const testedConfig = agentsApiMock.testEnvironment.mock.calls[0]![2]
      .adapterConfig as Record<string, unknown>;
    expect(testedConfig).not.toHaveProperty("model");
    expect(agentsApiMock.get).toHaveBeenNthCalledWith(
      1,
      "agent-1",
      "company-1",
    );
    expect(agentsApiMock.get).toHaveBeenNthCalledWith(
      2,
      "agent-1",
      "company-1",
    );
    expect(agentsApiMock.update).toHaveBeenCalledWith(
      "agent-1",
      {
        adapterType: "codex_local",
        adapterConfig: {
          ...testedConfig,
          paperclipSkillSync: { desiredSkillEntries: ["planning"] },
        },
        replaceAdapterConfig: true,
      },
      "company-1",
    );
    expect(agentsApiMock.hire).not.toHaveBeenCalled();
    expect(agentsApiMock.instructionsBundle).not.toHaveBeenCalled();
    expect(agentsApiMock.saveInstructionsFile).not.toHaveBeenCalled();
    expect(findButton("Get started")?.disabled).toBe(false);
    expect(window.localStorage.getItem("paperclip-onboarding-state")).not.toContain(
      privateConfigSentinel,
    );
    expect(document.body.textContent).not.toContain(privateConfigSentinel);
  });

  it("keeps the returning flow on configuration when the PATCH fails", async () => {
    saveWizardState(4);
    agentsApiMock.get.mockResolvedValue(makeAgent());
    agentsApiMock.update.mockRejectedValue(new Error("PATCH was rejected"));

    await renderWizard();
    click(findButton("Codex")!);
    await flushReact();
    click(findButton("Give it a heartbeat")!);
    await flushReact();

    expect(document.body.textContent).toContain("PATCH was rejected");
    expect(findButton("Give it a heartbeat")).toBeTruthy();
    expect(findButton("Get started")).toBeUndefined();
    expect(agentsApiMock.hire).not.toHaveBeenCalled();
    expect(agentsApiMock.instructionsBundle).not.toHaveBeenCalled();
  });

  it("blocks Get started when the authoritative readback mismatches the normalized save", async () => {
    saveWizardState(4);
    const existingAgent = makeAgent();
    agentsApiMock.get
      .mockResolvedValueOnce(existingAgent)
      .mockResolvedValue(makeAgent({ adapterConfig: { model: "mismatched" } }));
    agentsApiMock.update.mockResolvedValue(existingAgent);

    await renderWizard();
    click(findButton("Give it a heartbeat")!);
    await flushReact();

    const alert = document.body.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("does not match");
    expect(findButton("Get started")?.disabled).toBe(true);
  });

  it("blocks Get started when the authoritative readback fails", async () => {
    saveWizardState(4);
    const existingAgent = makeAgent();
    agentsApiMock.get
      .mockResolvedValueOnce(existingAgent)
      .mockRejectedValueOnce(new Error("Readback unavailable"));
    agentsApiMock.update.mockResolvedValue(existingAgent);

    await renderWizard();
    click(findButton("Give it a heartbeat")!);
    await flushReact();

    const alert = document.body.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Readback unavailable");
    expect(findButton("Get started")?.disabled).toBe(true);
  });

  it("blocks Get started after reload when the exact save expectation is unavailable", async () => {
    saveWizardState(5);

    await renderWizard();

    const alert = document.body.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Return to configuration and save again");
    expect(findButton("Get started")?.disabled).toBe(true);
    expect(agentsApiMock.get).not.toHaveBeenCalled();
  });
});
