export const bundledCliNpmDependencies = new Set([
  "acpx",
  "embedded-postgres",
  // patches/postgres@3.4.9.patch (COPY error after CopyDone) must reach npm installs.
  "postgres",
]);
