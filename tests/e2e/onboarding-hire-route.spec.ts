import { expect, test } from "@playwright/test";

import { withAutomaticHeartbeatWakesDisabled } from "./onboarding-hire-route";

test("preserves the submitted hire payload and only suppresses heartbeat wakes", () => {
  const submitted = {
    name: "Chief of staff",
    role: "chief_of_staff",
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-5",
      cwd: "S:/workspace/company",
    },
    runtimeConfig: {
      mode: "managed",
      heartbeat: {
        intervalSeconds: 300,
        enabled: true,
        wakeOnDemand: true,
      },
    },
    metadata: { source: "onboarding" },
  };

  const forwarded = withAutomaticHeartbeatWakesDisabled(submitted);

  expect(forwarded).toEqual({
    ...submitted,
    runtimeConfig: {
      ...submitted.runtimeConfig,
      heartbeat: {
        ...submitted.runtimeConfig.heartbeat,
        enabled: false,
        wakeOnDemand: false,
      },
    },
  });
  expect(submitted.runtimeConfig.heartbeat).toEqual({
    intervalSeconds: 300,
    enabled: true,
    wakeOnDemand: true,
  });
});

test("rejects a non-object hire payload instead of silently replacing it", () => {
  expect(() => withAutomaticHeartbeatWakesDisabled(null)).toThrow(
    /onboarding hire request body to be a JSON object/,
  );
});
