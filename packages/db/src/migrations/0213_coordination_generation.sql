ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "coordination_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issues"
    ADD CONSTRAINT "issues_coordination_generation_positive_ck"
    CHECK ("coordination_generation" > 0);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
