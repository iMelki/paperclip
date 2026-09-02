import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import { queryKeys } from "../lib/queryKeys";
import { composeCeoInstructions } from "../lib/ceo-instructions";

export type OnboardingWizardStep = 0 | 1 | 2 | 3 | 4 | 5;

export interface OnboardingHeartbeatContext {
  createdCompanyId: string | null;
  createdAgentId: string | null;
  agentName: string;
  adapterType: string;
  model: string;
  modelTouched: boolean;
  urlTouched: boolean;
  adapterModels?: Array<{ id: string }> | null;
  adapterModelsLoading: boolean;
  adapterModelsFetching: boolean;
  adapterModelsError: unknown;
  companyName: string;
  companyGoal: string;
  onboardingPath: "create" | "grow" | null;
  growWorkflows: string;
  growPainPoints: string;
  growAutomate: string;
  q1: string;
  q2: string;
  q3: string;
  q4: string;
  buildAdapterConfig: () => Record<string, unknown>;
  buildNewAgentRuntimeConfig: () => Record<string, unknown>;
  verifyAdapterEnvironmentForSave: (config: Record<string, unknown>) => Promise<boolean>;
  persistOnboardingAgentConfig: (params: {
    companyId: string;
    agentId: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    intent: { model: boolean; url: boolean };
    verifyEffectiveAdapterConfig: (config: Record<string, unknown>) => Promise<boolean>;
  }) => Promise<{ expectedAdapterConfig: Record<string, unknown> } | null>;
  setCreatedAgentId: (id: string) => void;
  setPersistedAdapterConfigExpectation: (expectation: Record<string, unknown> | null) => void;
  setStep: (step: OnboardingWizardStep) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export function useOnboardingHeartbeatCoordinator() {
  const queryClient = useQueryClient();

  return useCallback(async (ctx: OnboardingHeartbeatContext): Promise<void> => {
    const {
      createdCompanyId,
      createdAgentId,
      agentName,
      adapterType,
      model,
      modelTouched,
      urlTouched,
      adapterModels,
      adapterModelsLoading,
      adapterModelsFetching,
      adapterModelsError,
      companyName,
      companyGoal,
      onboardingPath,
      growWorkflows,
      growPainPoints,
      growAutomate,
      q1,
      q2,
      q3,
      q4,
      buildAdapterConfig,
      buildNewAgentRuntimeConfig,
      verifyAdapterEnvironmentForSave,
      persistOnboardingAgentConfig,
      setCreatedAgentId,
      setPersistedAdapterConfigExpectation,
      setStep,
      setError,
      setLoading,
    } = ctx;

    if (!createdCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        const selectedModelId = model.trim();
        if (!isValidOpenCodeModelId(selectedModelId)) {
          setError("OpenCode requires an explicit model in provider/model format.");
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : "Failed to load OpenCode models.",
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError("OpenCode models are still loading. Please wait and try again.");
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
              : `Configured OpenCode model is unavailable: ${selectedModelId}`,
          );
          return;
        }
      }

      const adapterConfig = buildAdapterConfig();

      if (createdAgentId) {
        const persisted = await persistOnboardingAgentConfig({
          companyId: createdCompanyId,
          agentId: createdAgentId,
          adapterType,
          adapterConfig,
          intent: {
            model: modelTouched,
            url: urlTouched,
          },
          verifyEffectiveAdapterConfig: verifyAdapterEnvironmentForSave,
        });
        if (!persisted) return;
        setPersistedAdapterConfigExpectation(persisted.expectedAdapterConfig);
        setStep(5);
        return;
      }

      if (!(await verifyAdapterEnvironmentForSave(adapterConfig))) return;

      const hire = await agentsApi.hire(createdCompanyId, {
        name: agentName.trim(),
        role: "ceo",
        adapterType,
        adapterConfig,
        runtimeConfig: buildNewAgentRuntimeConfig(),
      });
      if (hire.approval) {
        await approvalsApi.approve(
          hire.approval.id,
          "Approved during onboarding first-agent setup.",
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(createdCompanyId),
        });
      }
      const agent = hire.agent;
      setCreatedAgentId(agent.id);
      setPersistedAdapterConfigExpectation(agent.adapterConfig);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });

      // Seed the CEO's agent instructions file so the agent always has
      // company context + a hiring-plan output format rule. Non-fatal on
      // failure — the agent can still function with adapter defaults.
      try {
        const bundle = await agentsApi.instructionsBundle(agent.id, createdCompanyId);
        await agentsApi.saveInstructionsFile(
          agent.id,
          {
            path: bundle.entryFile,
            content: composeCeoInstructions({
              companyName,
              companyGoal,
              growPath: onboardingPath === "grow",
              growWorkflows,
              growPainPoints,
              growAutomate,
              q1,
              q2,
              q3,
              q4,
            }),
          },
          createdCompanyId,
        );
      } catch (err) {
        console.warn("Failed to seed CEO instructions:", err);
      }

      // Advance to the Review step — the lead is now online.
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }, [queryClient]);
}
