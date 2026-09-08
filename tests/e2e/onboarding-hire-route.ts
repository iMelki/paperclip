import type { Page } from "@playwright/test";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withAutomaticHeartbeatWakesDisabled(
  payload: unknown,
): JsonObject {
  if (!isJsonObject(payload)) {
    throw new TypeError("Expected the onboarding hire request body to be a JSON object");
  }

  const runtimeConfig = isJsonObject(payload.runtimeConfig) ? payload.runtimeConfig : {};
  const heartbeat = isJsonObject(runtimeConfig.heartbeat) ? runtimeConfig.heartbeat : {};

  return {
    ...payload,
    runtimeConfig: {
      ...runtimeConfig,
      heartbeat: {
        ...heartbeat,
        enabled: false,
        wakeOnDemand: false,
      },
    },
  };
}

/**
 * Keep onboarding's real hire endpoint and submitted adapter configuration,
 * while preventing the throwaway E2E agent from waking automatically.
 */
export async function installOnboardingHireHeartbeatSuppression(
  page: Page,
): Promise<void> {
  await page.route("**/agent-hires", async (route) => {
    const payload = withAutomaticHeartbeatWakesDisabled(route.request().postDataJSON());
    const response = await route.fetch({ postData: payload });
    await route.fulfill({ response });
  });
}
