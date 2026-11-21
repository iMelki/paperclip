import { useQuery } from "@tanstack/react-query";

import { agentsApi } from "../api/agents";
import {
  readAdapterModel,
  reviewOnboardingAgentConfig,
} from "../lib/onboarding-agent-config";
import { queryKeys } from "../lib/queryKeys";

interface UseOnboardingAgentConfigReviewOptions {
  companyId: string | null;
  agentId: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  exactAdapterConfig?: boolean;
  enabled: boolean;
}

export function useOnboardingAgentConfigReview({
  companyId,
  agentId,
  adapterType,
  adapterConfig,
  exactAdapterConfig = false,
  enabled,
}: UseOnboardingAgentConfigReviewOptions) {
  const intendedModel = readAdapterModel(adapterConfig);
  const query = useQuery({
    queryKey: [
      ...queryKeys.agents.detail(agentId ?? "none"),
      companyId,
      "onboarding-persisted-config",
      adapterType,
      intendedModel,
    ],
    queryFn: () => agentsApi.get(agentId!, companyId!),
    enabled: Boolean(enabled && companyId && agentId),
    retry: false,
    staleTime: 0,
    // The readback may contain private adapter fields. Retain it only while
    // this review observer is active instead of the default five-minute cache.
    gcTime: 0,
  });
  const review = query.data
    ? reviewOnboardingAgentConfig(
        query.data,
        adapterType,
        adapterConfig,
        exactAdapterConfig,
      )
    : null;
  const pending = enabled && (query.isLoading || query.isFetching);
  const errorMessage = query.error
    ? query.error instanceof Error
      ? query.error.message
      : "Failed to read the saved agent configuration."
    : null;
  const verified =
    enabled && !pending && !query.error && review?.matches === true;

  return { review, pending, errorMessage, verified };
}
