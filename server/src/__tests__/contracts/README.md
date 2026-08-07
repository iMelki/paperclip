# Coordination contract fixtures

`task-coordination.v1.schema.json` is a semantic pin of the canonical schema at:

`projects-ops/docs/schemas/task-coordination.v1.json`

- Source repository revision: `iMelki/projects-ops@0c449a3`
- Source file SHA-256: `d73f8082eb09cbdfa19d8abb51db7b8995c80ebb5eef9c4abd715c0dd2e15c65`

When the authority publishes a new schema version, update this pin and the
service contract test together. Do not silently consume a mutable workspace
path in CI; Paperclip must review and pin each contract revision.
