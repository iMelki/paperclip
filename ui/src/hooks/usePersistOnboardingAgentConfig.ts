import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { agentsApi } from "../api/agents";
import {
  buildOnboardingAgentUpdatePatch,
  type OnboardingAdapterConfigIntent,
} from "../lib/onboarding-agent-config";
import { queryKeys } from "../lib/queryKeys";

interface PersistOnboardingAgentConfigInput {
  companyId: string;
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  intent: OnboardingAdapterConfigIntent;
  verifyEffectiveAdapterConfig?: (
    adapterConfig: Record<string, unknown>,
  ) => Promise<boolean>;
}

/**
 * Cohesion boundary for the oversized onboarding wizard: this hook owns the
 * authoritative GET, custody-preserving PATCH, and related cache refreshes.
 * The wizard owns only the user-visible step transition after this resolves.
 */
export function usePersistOnboardingAgentConfig() {
  const queryClient = useQueryClient();

  return useCallback(
    async ({
      companyId,
      agentId,
      adapterType,
      adapterConfig,
      intent,
      verifyEffectiveAdapterConfig,
    }: PersistOnboardingAgentConfigInput) => {
      const existingAgent = await agentsApi.get(agentId, companyId);
      const patch = buildOnboardingAgentUpdatePatch(
        existingAgent,
        adapterType,
        adapterConfig,
        intent,
      );
      const effectiveAdapterConfig = (
        patch.adapterConfig ?? existingAgent.adapterConfig ?? {}
      ) as Record<string, unknown>;
      if (
        verifyEffectiveAdapterConfig
        && !(await verifyEffectiveAdapterConfig(effectiveAdapterConfig))
      ) {
        return null;
      }
      const updatedAgent = await agentsApi.update(agentId, patch, companyId);

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(agentId),
        }),
      ]);

      return {
        agent: updatedAgent,
        // Keep this server-normalized value ephemeral. It may contain private
        // adapter material and must never be serialized into wizard storage.
        expectedAdapterConfig: updatedAgent.adapterConfig,
      };
    },
    [queryClient],
  );
}
