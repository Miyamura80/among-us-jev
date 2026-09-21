import type { AgentPlan, PlanOption } from "@/game/types";

export function activePlan(plan: AgentPlan): PlanOption {
    return plan.active === "B" && plan.alternative ? plan.alternative : plan;
}
