import { describe, expect, it } from "vitest";
import { bindGitHubOAuthState, isBoundGitHubOAuthState, verifyGitHubOAuthState } from "../services/github-oauth-state.js";

const binding = {
  verifier: "v".repeat(64), clientId: "test-client",
  redirectUri: "https://paperclip.example.test:5113/api/tools/oauth/callback",
  expectedLogin: "test-operator", scopes: ["repo", "project", "offline_access"],
};
describe("GitHub OAuth server state binding", () => {
  it("discriminates native state even when its binding is malformed, without treating legacy state as native", () => {
    expect(isBoundGitHubOAuthState(bindGitHubOAuthState(binding))).toBe(true);
    expect(isBoundGitHubOAuthState("github-bound-v1:{")).toBe(true);
    expect(isBoundGitHubOAuthState("legacy-verifier")).toBe(false);
  });
  it("roundtrips the verifier with the exact client callback account and scope request", () => {
    expect(verifyGitHubOAuthState(bindGitHubOAuthState(binding), binding)).toBe(binding.verifier);
  });
  it.each([
    { clientId: "another-client" }, { redirectUri: binding.redirectUri.replace("5113", "8443") },
    { expectedLogin: "another-user" }, { scopes: ["repo"] },
  ])("rejects changed binding %j", (changed) => {
    expect(() => verifyGitHubOAuthState(bindGitHubOAuthState(binding), { ...binding, ...changed }))
      .toThrow("GitHub setup changed");
  });
  it.each(["legacy-verifier", "github-bound-v1:{", "github-bound-v1:null", "github-bound-v1:[]"])(
    "rejects a missing or malformed binding", (stored) => {
      expect(() => verifyGitHubOAuthState(stored, binding)).toThrow();
    },
  );
});
