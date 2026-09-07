import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CostByProviderModel } from "@paperclipai/shared";
import { ProviderQuotaCard } from "./ProviderQuotaCard";
import { BillerSpendCard } from "./BillerSpendCard";

function row(provider: string, costCents: number): CostByProviderModel {
  return { provider, biller: provider, billingType: "metered_api", model: "test-model", costCents,
    inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, apiRunCount: 1,
    subscriptionRunCount: 0, subscriptionCachedInputTokens: 0, subscriptionInputTokens: 0, subscriptionOutputTokens: 0 };
}

describe("recorded spend without invented allowances", () => {
  it("shows each provider's actual spend and an unallocated budget without weekly quota estimates", () => {
    const small = renderToStaticMarkup(<ProviderQuotaCard provider="openrouter" rows={[row("openrouter", 100)]} weekSpendCents={30} windowRows={[]} />);
    const large = renderToStaticMarkup(<ProviderQuotaCard provider="google" rows={[row("google", 900)]} weekSpendCents={250} windowRows={[]} />);
    expect(small).toContain("$1.00");
    expect(large).toContain("$9.00");
    expect(small).toContain("$0.30");
    expect(large).toContain("$2.50");
    for (const markup of [small, large]) {
      expect(markup).toContain("Provider budget: Unallocated");
      expect(markup).not.toContain("of allocation");
      expect(markup).not.toContain("/wk");
      expect(markup).not.toContain("Period spend");
    }
  });

  it("does not turn the company budget into a biller allowance", () => {
    const provider = row("openrouter", 350);
    const markup = renderToStaticMarkup(<BillerSpendCard row={{ ...provider, providerCount: 1, modelCount: 1 }} weekSpendCents={50} providerRows={[provider]} />);
    expect(markup).toContain("Biller budget: Unallocated");
    expect(markup).toContain("$3.50");
    expect(markup).toContain("$0.50");
    expect(markup).not.toContain("of allocation");
  });

  it("keeps provider-reported quota separate from the unallocated budget", () => {
    const markup = renderToStaticMarkup(<ProviderQuotaCard provider="openai" rows={[row("openai", 100)]}
      weekSpendCents={30} windowRows={[]} quotaSource="provider-api" quotaWindows={[
        { label: "Weekly quota", usedPercent: 73, resetsAt: "2026-09-10T12:00:00Z", valueLabel: null, detail: "Provider-reported" },
      ]} />);
    expect(markup).toContain("Provider budget: Unallocated");
    expect(markup).toContain("73%");
    expect(markup).toContain("Weekly quota");
  });
});
