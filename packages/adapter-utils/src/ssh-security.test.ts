import { describe, expect, it } from "vitest";
import {
  buildSshDestinationArgs,
  buildSshSpawnTarget,
  createSshCommandManagedRuntimeRunner,
} from "./ssh.js";

const safeSpec = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

describe("SSH command construction safety", () => {
  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
        spec: safeSpec,
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("rejects invalid environment variable keys in the managed SSH command runner", async () => {
    const runner = createSshCommandManagedRuntimeRunner({ spec: safeSpec });

    await expect(
      runner.execute({
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("terminates SSH option parsing before an option-shaped destination", () => {
    expect(
      buildSshDestinationArgs(
        {
          host: "ssh.example.test",
          port: 22,
          username: "-oProxyCommand=malicious",
        },
        "true",
      ),
    ).toEqual([
      "-p",
      "22",
      "--",
      "-oProxyCommand=malicious@ssh.example.test",
      "true",
    ]);
  });
});
