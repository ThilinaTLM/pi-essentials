import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { setPlanModeWidget } from "./ui.js";

export const PLAN_MODE_STATE_ENTRY = "plan-mode-state";

const PLAN_ONLY_TOOLS = ["plan_mode_force_exit", "plan_mode_present"];

let planActive = false;
let piRef: ExtensionAPI | null = null;

export function initializePlanState(pi: ExtensionAPI): void {
	piRef = pi;
}

export function getPi(): ExtensionAPI {
	if (!piRef) {
		throw new Error("Plan state not initialized.");
	}
	return piRef;
}

export function isPlanActive(): boolean {
	return planActive;
}

export function restorePlanMode(ctx: ExtensionContext, active: boolean): void {
	applyPlanModeState(ctx, active);
}

export function enterPlanMode(ctx: ExtensionContext): void {
	applyPlanModeState(ctx, true);
	persistPlanModeState(true);
}

export function exitPlanMode(ctx: ExtensionContext): void {
	applyPlanModeState(ctx, false);
	persistPlanModeState(false);
}

function applyPlanModeState(ctx: ExtensionContext, active: boolean): void {
	planActive = active;
	setPlanModeWidget(ctx, active);
	setPlanToolsActive(active);
}

function persistPlanModeState(active: boolean): void {
	piRef?.appendEntry(PLAN_MODE_STATE_ENTRY, { active });
}

function setPlanToolsActive(active: boolean): void {
	if (!piRef) return;
	const current = piRef.getActiveTools();
	if (active) {
		const toAdd = PLAN_ONLY_TOOLS.filter((name) => !current.includes(name));
		if (toAdd.length > 0) {
			piRef.setActiveTools([...current, ...toAdd]);
		}
		return;
	}

	const filtered = current.filter((name) => !PLAN_ONLY_TOOLS.includes(name));
	if (filtered.length !== current.length) {
		piRef.setActiveTools(filtered);
	}
}
