ALTER TABLE "cost_events" ADD COLUMN "source_system" text;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "source_account_id" text;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "source_event_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_company_source_event_uq" ON "cost_events" USING btree ("company_id","source_system","source_account_id","source_event_id");
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_source_identity_complete_ck" CHECK (
      ("cost_events"."source_system" IS NULL AND "cost_events"."source_account_id" IS NULL AND "cost_events"."source_event_id" IS NULL)
      OR (length(trim("cost_events"."source_system")) > 0 AND "cost_events"."source_system" IS NOT NULL
        AND length(trim("cost_events"."source_account_id")) > 0 AND "cost_events"."source_account_id" IS NOT NULL
        AND length(trim("cost_events"."source_event_id")) > 0 AND "cost_events"."source_event_id" IS NOT NULL)
    );
