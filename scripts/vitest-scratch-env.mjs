import path from "node:path";

/** Build the environment for one isolated Vitest invocation. */
export function createVitestScratchEnvironment({
  baseEnv,
  testRoot,
  invocationId,
  noAutoFixture = "true",
  pathApi = path,
}) {
  const tempRoot = pathApi.join(testRoot, "t");
  return {
    ...baseEnv,
    NODE_ENV: "test",
    PAPERCLIP_HOME: pathApi.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: invocationId,
    PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE:
      baseEnv.PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE ?? noAutoFixture,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
  };
}
