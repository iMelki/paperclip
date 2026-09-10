ALTER TABLE "mutation_leases" ADD COLUMN IF NOT EXISTS "lease_token_hash" text;
--> statement-breakpoint
UPDATE "mutation_leases"
SET "lease_token_hash" = encode(sha256(convert_to("lease_token", 'UTF8')), 'hex')
WHERE "lease_token_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "mutation_leases" ALTER COLUMN "lease_token_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "mutation_leases" ADD CONSTRAINT "mutation_leases_token_hash_format_check"
  CHECK ("lease_token_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "mutation_leases" DROP CONSTRAINT IF EXISTS "mutation_leases_lease_token_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "mutation_leases_token_idx";
--> statement-breakpoint
ALTER TABLE "mutation_leases" DROP COLUMN IF EXISTS "lease_token";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mutation_leases_token_hash_uq"
  ON "mutation_leases" USING btree ("lease_token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coordination_claim_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "status" text DEFAULT 'processing' NOT NULL,
  "mutation_lease_id" uuid REFERENCES "mutation_leases"("id") ON DELETE SET NULL,
  "task_participation_id" uuid REFERENCES "task_participations"("id") ON DELETE SET NULL,
  "response_status" integer,
  "response_body" jsonb,
  "locked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone DEFAULT now() + interval '72 hours' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coordination_claim_idempotency_keys_request_hash_format_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coordination_claim_idempotency_keys_company_key_uq"
  ON "coordination_claim_idempotency_keys" USING btree ("company_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coordination_claim_idempotency_keys_expires_at_idx"
  ON "coordination_claim_idempotency_keys" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coordination_claim_idempotency_keys_lease_idx"
  ON "coordination_claim_idempotency_keys" USING btree ("mutation_lease_id");
