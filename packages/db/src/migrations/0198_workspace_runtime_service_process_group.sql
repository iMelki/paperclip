ALTER TABLE "workspace_runtime_services"
  ADD COLUMN IF NOT EXISTS "process_group_id" integer;

-- Historical provider_ref values are wrapper PIDs. They do not prove that the
-- launcher created a POSIX process group, and the rows carry no platform or
-- launch-custody provenance. Leave legacy process_group_id values null rather
-- than manufacture a group identity from an ambiguous PID observation.
