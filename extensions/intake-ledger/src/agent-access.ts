import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IntakeLedgerConfig } from "./config.js";

/** OpenClaw's built-in default agent id. Safe intake-owner default. */
export const DEFAULT_INTAKE_OWNER_AGENT_ID = "main";

export type IntakeAgentSurface = "owner" | "automation" | "implementation" | "none";

export function resolveIntakeAgentSurface(
  config: IntakeLedgerConfig,
  agentId: string | undefined,
): IntakeAgentSurface {
  const id = normalizeOptionalString(agentId);
  if (!id) {
    return "none";
  }
  if (config.implementationAgentIds.includes(id)) {
    return "implementation";
  }
  if (config.intakeOwnerAgentIds.includes(id)) {
    return "owner";
  }
  if (config.automationAgentIds.includes(id)) {
    return "automation";
  }
  return "none";
}

export function isIntakeOwnerAgent(
  config: IntakeLedgerConfig,
  agentId: string | undefined,
): boolean {
  return resolveIntakeAgentSurface(config, agentId) === "owner";
}

export function isAutomationAgent(
  config: IntakeLedgerConfig,
  agentId: string | undefined,
): boolean {
  return resolveIntakeAgentSurface(config, agentId) === "automation";
}
