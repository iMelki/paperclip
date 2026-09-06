# Paperclip #53 maintainability receipt

- `server/src/services/coordination-v2.ts`: 371 source lines after the change;
  the file did not exist before this slice.
- Largest function: `projectView` is approximately 75 lines. It intentionally
  keeps the schema-shaped projection assembly in one cohesive boundary so the
  final Ajv validation is visibly adjacent to every field that can become an
  operational claim. The smaller mapping, evidence, and participant helpers
  keep data-shape decisions separately testable.
- No generated, vendored, or fixture logic is counted as ordinary source;
  `server/src/contracts/task-coordination.v2.json` is a vendored contract
  snapshot, not executable logic.
- Focused validation: server/db typechecks, the DB migration checks, v2 and v1
  projector tests, route tests, real HTTP company-isolation tests, and the
  caller-shaped negative-proof receipts all passed after restoration.
- Extraction decision: no further split is warranted in this narrow producer;
  the next independent review should revisit the exception if delivery,
  controls, or additional evidence authorities are added.
