ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "coordination_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues"
  ALTER COLUMN "coordination_generation" SET DEFAULT 1;
--> statement-breakpoint
UPDATE "issues"
SET "coordination_generation" = 1
WHERE "coordination_generation" IS NULL;
--> statement-breakpoint
ALTER TABLE "issues"
  ALTER COLUMN "coordination_generation" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issues"
    ADD CONSTRAINT "issues_coordination_generation_positive_ck"
    CHECK ("coordination_generation" > 0);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
