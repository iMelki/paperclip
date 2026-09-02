import { createDb, approvals } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { redactHireApprovalPayloadForPersistence } from "../services/hire-approval-payload.js";

interface AuditOptions {
  apply: boolean;
}

export async function auditAndRedactApprovalPayloads(options: AuditOptions) {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("No database URL configured. Ensure DATABASE_URL is set or config file exists.");
    process.exit(1);
  }

  const db = createDb(config.databaseUrl);
  console.log(`Auditing approval payloads (mode: ${options.apply ? "APPLY" : "DRY-RUN"})...`);

  const rows = await db.select().from(approvals);
  let totalChecked = 0;
  let sensitiveCount = 0;
  let updatedCount = 0;

  for (const row of rows) {
    totalChecked += 1;
    const payload = row.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }

    const redacted = redactHireApprovalPayloadForPersistence(payload);
    const beforeStr = JSON.stringify(payload);
    const afterStr = JSON.stringify(redacted);

    if (beforeStr !== afterStr) {
      sensitiveCount += 1;
      console.log(`[FOUND SENSITIVE] Approval ID: ${row.id}, Type: ${row.type}, Status: ${row.status}`);

      if (options.apply) {
        await db
          .update(approvals)
          .set({
            payload: redacted,
            updatedAt: new Date(),
          })
          .where(eq(approvals.id, row.id));
        updatedCount += 1;
        console.log(`  -> Redacted and updated in database.`);
      }
    }
  }

  console.log(`Audit complete.`);
  console.log(`Total approvals inspected: ${totalChecked}`);
  console.log(`Approvals with unredacted sensitive payload fields: ${sensitiveCount}`);
  if (options.apply) {
    console.log(`Successfully redacted and updated: ${updatedCount}`);
  } else {
    console.log(`Dry-run mode: no database mutations were made. Run with --apply to redact.`);
  }

  return { totalChecked, sensitiveCount, updatedCount };
}

if (process.argv[1] && process.argv[1].includes("audit-and-redact-approval-payloads")) {
  const apply = process.argv.includes("--apply");
  auditAndRedactApprovalPayloads({ apply })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Audit script failed:", err);
      process.exit(1);
    });
}
