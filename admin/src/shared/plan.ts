import type { CodeItem, PlanItem } from "../types";

type PlanLike = Pick<PlanItem, "code" | "name" | "duration_days"> | Pick<CodeItem, "plan_code" | "plan_name" | "duration_days">;
type Translate = (key: string, values?: Record<string, string | number>) => string;

export function formatPlanDuration(plan: PlanLike, t?: Translate): string {
  const code = "code" in plan ? plan.code : plan.plan_code;

  switch (code) {
    case "monthly":
      return t ? t("planDuration.monthly") : "1 calendar month after activation";
    case "quarterly":
      return t ? t("planDuration.quarterly") : "3 calendar months after activation";
    case "yearly":
      return t ? t("planDuration.yearly") : "1 calendar year after activation";
    default:
      return t ? t("planDuration.days", { days: plan.duration_days }) : `${plan.duration_days} days after activation`;
  }
}

export function formatPlanLabel(plan: PlanLike, t?: Translate): string {
  const name = "name" in plan ? plan.name : plan.plan_name;
  return `${name} (${formatPlanDuration(plan, t)})`;
}
