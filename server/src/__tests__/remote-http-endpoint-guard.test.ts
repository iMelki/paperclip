import { describe, expect, it } from "vitest";
import { assertPublicRemoteHttpEndpoint, parseRemoteHttpEndpoint } from "../services/remote-http-endpoint-guard.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it.each([
    "https://user:password@public.example/mcp",
    "https://public.example/mcp?api_key=secret",
    "https://public.example/mcp?access_token=secret",
    "https://public.example/mcp?X-Amz-Signature=secret",
  ])("rejects credential authority embedded in endpoint URL %s", (url) => {
    expect(() => parseRemoteHttpEndpoint(url, guardError)).toThrowError(
      expect.objectContaining({ code: "mcp_remote_url_sensitive_authority" }),
    );
  });

  it("allows non-sensitive endpoint query configuration", () => {
    expect(parseRemoteHttpEndpoint(
      "https://public.example/mcp?region=eu&version=2",
      guardError,
    ).toString()).toBe("https://public.example/mcp?region=eu&version=2");
  });

  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});
