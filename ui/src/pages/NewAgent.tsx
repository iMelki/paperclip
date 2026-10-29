import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import { AGENT_ROLES, type AdapterEnvironmentTestResult, type AgentPermissions } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Shield } from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels } from "../components/agent-config-primitives";
import {
  AgentConfigForm,
  AdapterEnvironmentResult,
  type CreateConfigValues,
} from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { getUIAdapter, listUIAdapters } from "../adapters";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { isValidAdapterType } from "../adapters/metadata";
import { ReportsToPicker } from "../components/ReportsToPicker";
import { buildNewAgentHirePayload, shouldUnlockHireSubmission } from "../lib/new-agent-hire-payload";
import { TrustPresetSection } from "../components/TrustPresetSection";
import { buildPermissionsForTrustPreset, getTrustPreset } from "../lib/trust-policy-ui";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";

function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  const nextValues: CreateConfigValues = { ...defaults, adapterType };
  if (adapterType === "codex_local") {
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "gemini_local") {
    nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (adapterType === "opencode_local") {
    nextValues.model = DEFAULT_OPENCODE_LOCAL_MODEL;
  }
  return nextValues;
}

export function NewAgent() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetAdapterType = searchParams.get("adapterType");

  const [name, setName] = useState("");
  const [pausedSetup, setPausedSetup] = useState(false);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const frozenSubmission = useRef<{ companyId: string; payload: Record<string, unknown> } | null>(null);
  const [submissionFrozen, setSubmissionFrozen] = useState(false);
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("general");
  const [reportsTo, setReportsTo] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);
  const [permissions, setPermissions] = useState<Partial<AgentPermissions>>(
    buildPermissionsForTrustPreset(null, "standard"),
  );
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [roleOpen, setRoleOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testAgentAction, setTestAgentAction] = useState<(() => void) | null>(null);
  const [testAgentState, setTestAgentState] = useState({ disabled: true, pending: false });
  const [testAgentFeedback, setTestAgentFeedback] = useState<{
    errorMessage: string | null;
    result: AdapterEnvironmentTestResult | null;
  }>({
    errorMessage: null,
    result: null,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const lowTrustSelected = getTrustPreset(permissions) === "low_trust_review";

  const { data: boundaryProjects, isLoading: boundaryProjectsLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "__low-trust-disabled"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && lowTrustSelected),
  });

  const { data: boundaryIssues, isLoading: boundaryIssuesLoading } = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.issues.list(selectedCompanyId), "low-trust-boundary-candidates"]
      : ["issues", "__low-trust-disabled"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 100, sortField: "updated", sortDir: "desc" }),
    enabled: Boolean(selectedCompanyId && lowTrustSelected),
  });

  const isFirstAgent = !agents || agents.length === 0;
  const effectiveRole = isFirstAgent ? "ceo" : role;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "New Agent" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (isFirstAgent) {
      if (!name) setName("CEO");
      if (!title) setTitle("CEO");
    }
  }, [isFirstAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const requested = presetAdapterType;
    if (!requested) return;
    if (!isValidAdapterType(requested)) return;
    setConfigValues((prev) => {
      if (prev.adapterType === requested) return prev;
      return createValuesForAdapterType(requested as CreateConfigValues["adapterType"]);
    });
  }, [presetAdapterType]);

  const createAgent = useMutation({
    mutationFn: (request: { companyId: string; payload: Record<string, unknown> }) =>
      agentsApi.hire(request.companyId, request.payload),
    onSuccess: (result, request) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(request.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(request.companyId) });
      if (selectedCompanyId !== request.companyId) {
        setFormError(`Saved agent ${result.agent.id} in the original company. The saved request remains locked; switch back to view it.`);
        return;
      }
      navigate(agentUrl(result.agent));
    },
    onError: (error) => {
      if (shouldUnlockHireSubmission(error)) {
        frozenSubmission.current = null;
        setSubmissionFrozen(false);
        setSubmissionKey(crypto.randomUUID());
      }
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function buildAdapterConfig() {
    const adapter = getUIAdapter(configValues.adapterType);
    return adapter.buildAdapterConfig(configValues);
  }

  function handleSubmit() {
    if (frozenSubmission.current) {
      createAgent.mutate(frozenSubmission.current);
      return;
    }
    if (!selectedCompanyId || !name.trim()) return;
    setFormError(null);
    if (!pausedSetup && configValues.adapterType === "opencode_local") {
      if (!isValidOpenCodeModelId(configValues.model)) {
        setFormError("OpenCode requires an explicit model in provider/model format.");
        return;
      }
    }
    const payload = buildNewAgentHirePayload({
        name,
        pausedSetup,
        idempotencyKey: submissionKey,
        effectiveRole,
        title,
        reportsTo,
        selectedSkillKeys,
        configValues,
        adapterConfig: buildAdapterConfig(),
        permissions,
      });
    const request = { companyId: selectedCompanyId, payload };
    frozenSubmission.current = request;
    setSubmissionFrozen(true);
    createAgent.mutate(request);
  }

  const availableSkills = (companySkills ?? []).filter((skill) => !skill.key.startsWith("paperclipai/paperclip/"));

  function toggleSkill(key: string, checked: boolean) {
    setSelectedSkillKeys((prev) => {
      if (checked) {
        return prev.includes(key) ? prev : [...prev, key];
      }
      return prev.filter((value) => value !== key);
    });
  }

  const handleTestAgentActionChange = useCallback((fn: (() => void) | null) => {
    setTestAgentAction(() => fn);
  }, []);

  const handleTestAgentStateChange = useCallback((state: { disabled: boolean; pending: boolean }) => {
    setTestAgentState(state);
  }, []);

  const handleTestAgentFeedbackChange = useCallback((feedback: {
    errorMessage: string | null;
    result: AdapterEnvironmentTestResult | null;
  }) => {
    setTestAgentFeedback(feedback);
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">New Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Advanced agent configuration
        </p>
      </div>

      <div className="border border-border">
        <fieldset disabled={submissionFrozen} className="min-w-0">
        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Title */}
        <div className="px-4 pb-2">
          <input
            className="w-full bg-transparent outline-none text-sm text-muted-foreground placeholder:text-muted-foreground/40"
            placeholder="Title (e.g. VP of Engineering)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Property chips: Role + Reports To */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          <Popover open={roleOpen} onOpenChange={setRoleOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                  isFirstAgent && "opacity-60 cursor-not-allowed"
                )}
                disabled={isFirstAgent}
              >
                <Shield className="h-3 w-3 text-muted-foreground" />
                {roleLabels[effectiveRole] ?? effectiveRole}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {AGENT_ROLES.map((r) => (
                <button
                  key={r}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    r === role && "bg-accent"
                  )}
                  onClick={() => { setRole(r); setRoleOpen(false); }}
                >
                  {roleLabels[r] ?? r}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <ReportsToPicker
            agents={agents ?? []}
            value={reportsTo}
            onChange={setReportsTo}
            disabled={isFirstAgent}
          />
        </div>

        {pausedSetup ? (
          <div className="border-t border-border px-4 py-4">
            <p className="text-xs text-muted-foreground">Permissions are not granted while the agent is created paused. Configure them when you finish setup.</p>
          </div>
        ) : <div className="border-t border-border px-4 py-4">
          <TrustPresetSection
            permissions={permissions}
            onChange={setPermissions}
            disabled={createAgent.isPending}
            companyId={selectedCompanyId}
            projectCandidates={(boundaryProjects ?? []).map((project) => ({
              id: project.id,
              label: project.name,
            }))}
            issueCandidates={(boundaryIssues ?? []).map((issue) => ({
              id: issue.id,
              label: `${issue.identifier ?? issue.id.slice(0, 8)} · ${issue.title}`,
            }))}
            candidatesLoading={boundaryProjectsLoading || boundaryIssuesLoading}
          />
        </div>}

        <div className="border-t border-border px-4 py-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox aria-describedby="paused-setup-help" checked={pausedSetup} onCheckedChange={(value) => setPausedSetup(value === true)} />
            Create paused, without a configured runtime
          </label>
          <p id="paused-setup-help" className="mt-1 text-xs text-muted-foreground">No agent runs, automatic wakes, credentials or skills are configured. Required hire approval still applies.</p>
        </div>
        {/* Shared config form */}
        {!pausedSetup && <AgentConfigForm
          mode="create"
          values={configValues}
          onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
          onTestActionChange={handleTestAgentActionChange}
          onTestActionStateChange={handleTestAgentStateChange}
          onTestFeedbackChange={handleTestAgentFeedbackChange}
        />}

        {pausedSetup ? (
          <div className="border-t border-border px-4 py-4">
            <h2 className="text-sm font-medium">Company skills</h2>
            <p className="mt-1 text-xs text-muted-foreground">Skills are not installed while the agent is created paused. Add them when you finish setup.</p>
          </div>
        ) : <div className="border-t border-border px-4 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Company skills</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional skills from the company library. Built-in Paperclip runtime skills are added automatically.
              </p>
            </div>
            {availableSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No optional company skills installed yet.
              </p>
            ) : (
              <div className="space-y-3">
                {availableSkills.map((skill) => {
                  const inputId = `skill-${skill.id}`;
                  const checked = selectedSkillKeys.includes(skill.key);
                  const summaryText = resolveSkillSummaryText(skill, { fallbackKey: true });
                  return (
                    <div key={skill.id} className="flex items-start gap-3">
                      <Checkbox
                        id={inputId}
                        checked={checked}
                        onCheckedChange={(next) => toggleSkill(skill.key, next === true)}
                      />
                      <label htmlFor={inputId} className="grid gap-1 leading-none">
                        <span className="text-sm font-medium">{skill.name}</span>
                        {summaryText ? <span className="text-xs text-muted-foreground">{summaryText}</span> : null}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>}

        {/* Footer */}
        </fieldset>
        <div className="border-t border-border px-4 py-3">
          {isFirstAgent && (
            <p className="text-xs text-muted-foreground mb-2">This will be the CEO</p>
          )}
          {submissionFrozen && <p className="mb-2 text-xs text-muted-foreground">This request is locked to its original company and settings. Retrying uses the same saved request.</p>}
          {pausedSetup && <p id="test-agent-disabled-reason" className="mb-2 text-xs text-muted-foreground">Test Agent is unavailable: a paused agent has no runtime to test.</p>}
          {formError && (
            <p className="text-xs text-destructive mb-2">{formError}</p>
          )}
          <div className="space-y-3">
            {testAgentFeedback.errorMessage && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {testAgentFeedback.errorMessage}
              </div>
            )}
            {testAgentFeedback.result && (
              <AdapterEnvironmentResult result={testAgentFeedback.result} />
            )}
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate("/agents")}>
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pausedSetup || testAgentState.disabled}
                  aria-describedby={pausedSetup ? "test-agent-disabled-reason" : undefined}
                  onClick={() => { if (!pausedSetup) testAgentAction?.(); }}
                >
                  {testAgentState.pending ? "Testing..." : "Test Agent"}
                </Button>
                <Button
                  size="sm"
                  disabled={!name.trim() || createAgent.isPending}
                  onClick={handleSubmit}
                >
                  {createAgent.isPending ? "Creating…" : "Create agent"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
