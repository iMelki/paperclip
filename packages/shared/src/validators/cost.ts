import { z } from "zod";
import { BILLING_TYPES, COST_STATUSES } from "../constants.js";

export const createCostEventSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(128).optional().nullable(),
  sourceAccountId: z.string().trim().min(1).max(256).optional().nullable(),
  sourceEventId: z.string().trim().min(1).max(512).optional().nullable(),
  agentId: z.string().uuid(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  heartbeatRunId: z.string().uuid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  costStatus: z.enum(COST_STATUSES).optional().default("reported"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  costCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
}).superRefine((value, ctx) => {
  const fields = ["sourceSystem", "sourceAccountId", "sourceEventId"] as const;
  const supplied = fields.filter((field) => value[field] != null);
  if (supplied.length > 0 && supplied.length !== fields.length) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceEventId"],
      message: "sourceSystem, sourceAccountId and sourceEventId must be supplied together",
    });
  }
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;
