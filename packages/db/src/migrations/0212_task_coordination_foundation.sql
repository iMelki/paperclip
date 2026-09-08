CREATE TABLE IF NOT EXISTS "host_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"host_id" text NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"runtime" text NOT NULL,
	"reachable_addresses" jsonb,
	"environment" text,
	"system_telemetry" jsonb,
	"status" text DEFAULT 'online' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_nodes_host_id_unique" UNIQUE("host_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"runtime" text NOT NULL,
	"role" text DEFAULT 'worker' NOT NULL,
	"mode" text DEFAULT 'mutate' NOT NULL,
	"enforcement_mode" text DEFAULT 'observe' NOT NULL,
	"host_node_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_participations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_instance_id" uuid,
	"runtime" text NOT NULL,
	"role" text DEFAULT 'worker' NOT NULL,
	"mode" text DEFAULT 'mutate' NOT NULL,
	"enforcement_mode" text DEFAULT 'observe' NOT NULL,
	"run_id" text,
	"session_id" text,
	"current_action" text,
	"progress_note" text,
	"blocker" text,
	"next_action" text,
	"retry_state" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mutation_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"task_participation_id" uuid,
	"lease_token" text NOT NULL,
	"holder_agent_id" text NOT NULL,
	"work_unit_id" text NOT NULL,
	"scope_repositories" jsonb NOT NULL,
	"scope_paths" jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutation_leases_lease_token_unique" UNIQUE("lease_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "control_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"target_work_unit_id" text,
	"target_agent_instance_id" uuid,
	"intent_type" text NOT NULL,
	"payload" jsonb,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_nodes" ADD CONSTRAINT "host_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_host_node_id_host_nodes_id_fk" FOREIGN KEY ("host_node_id") REFERENCES "public"."host_nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_participations" ADD CONSTRAINT "task_participations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_participations" ADD CONSTRAINT "task_participations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_participations" ADD CONSTRAINT "task_participations_agent_instance_id_agent_instances_id_fk" FOREIGN KEY ("agent_instance_id") REFERENCES "public"."agent_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mutation_leases" ADD CONSTRAINT "mutation_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mutation_leases" ADD CONSTRAINT "mutation_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mutation_leases" ADD CONSTRAINT "mutation_leases_task_participation_id_task_participations_id_fk" FOREIGN KEY ("task_participation_id") REFERENCES "public"."task_participations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "control_intents" ADD CONSTRAINT "control_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "control_intents" ADD CONSTRAINT "control_intents_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "control_intents" ADD CONSTRAINT "control_intents_target_agent_instance_id_agent_instances_id_fk" FOREIGN KEY ("target_agent_instance_id") REFERENCES "public"."agent_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_nodes_company_host_status_idx" ON "host_nodes" USING btree ("company_id","host_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_instances_company_agent_status_idx" ON "agent_instances" USING btree ("company_id","agent_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_participations_company_issue_idx" ON "task_participations" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_participations_issue_last_seen_idx" ON "task_participations" USING btree ("issue_id","last_seen_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mutation_leases_company_issue_status_idx" ON "mutation_leases" USING btree ("company_id","issue_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mutation_leases_token_idx" ON "mutation_leases" USING btree ("lease_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_intents_company_root_status_idx" ON "control_intents" USING btree ("company_id","root_issue_id","status");
