import { test, expect } from "@playwright/test";

import { installOnboardingHireHeartbeatSuppression } from "./onboarding-hire-route";

/**
 * E2E: post-wizard onboarding launch.
 *
 * Completing the onboarding wizard now creates the first assigned task and
 * lands the user on the company dashboard. The chat intro still has unit
 * coverage in BoardChat tests; the wizard handoff no longer routes there.
 */

const COMPANY_NAME = `E2E-TypingIntro-${Date.now()}`;
const MISSION = "Verify the dashboard launch survives the wizard handoff.";
const FIRST_TASK_TITLE = "Hire your first engineer and create a hiring plan";

test.describe("Dashboard launch after onboarding wizard", () => {
  test("creates the first task and opens the dashboard", async ({ page }) => {
    // Intercept env-test → instant pass (avoid running a real CLI check).
    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "pass", checks: [] }),
      }),
    );

    await installOnboardingHireHeartbeatSuppression(page);

    await page.goto("/onboarding");

    // Launcher card path (existing companies) — enter the wizard if the
    // route shows a launcher instead of opening the wizard directly.
    const startBtn = page.getByRole("button", { name: /Start Onboarding/i });
    if (await startBtn.count()) await startBtn.first().click();

    // Step 0: front door (skipped when the wizard opens on the create path).
    const frontDoor = page.getByText("Build a new company");
    if (await frontDoor.count()) await frontDoor.first().click();

    // Step 1: company name.
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 2: mission (direct path default).
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill(MISSION);
    await page.getByRole("button", { name: /Confirm mission/ }).click();

    // Step 3: lead name (prefilled) → Next.
    await page.waitForSelector('input[placeholder="Chief of staff"]', {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 4: adapter (claude_local default); heartbeat is intercepted.
    await page.getByRole("button", { name: /Give it a heartbeat/ }).click();

    // Step 5: Review proves the authoritative saved adapter/model before
    // Get started creates the first task and opens the dashboard.
    const savedConfiguration = page
      .getByText("Saved configuration", { exact: true })
      .locator("..")
      .locator("..");
    await expect(savedConfiguration).toContainText("Verified", {
      timeout: 20_000,
    });
    await expect(savedConfiguration).toContainText("Claude Code");
    await expect(savedConfiguration).toContainText("Adapter default");
    const getStarted = page.getByRole("button", { name: /Get started/ });
    await expect(getStarted).toBeEnabled();
    await getStarted.click();

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    const companiesRes = await page.request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find((candidate: { name: string }) => candidate.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const issuesRes = await page.request.get(`/api/companies/${company.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const firstTask = issues.find((candidate: { title: string }) => candidate.title === FIRST_TASK_TITLE);
    expect(firstTask).toBeTruthy();
    await expect(page.getByText(FIRST_TASK_TITLE).first()).toBeVisible({ timeout: 15_000 });
  });
});
