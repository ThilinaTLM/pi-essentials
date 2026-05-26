import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setPlanModeWidget } from "./ui.js";

export const PLAN_MODE_STATE_ENTRY = "plan-mode-state";

const PLAN_LIFECYCLE_TOOLS = [
	"plan_mode_enter",
	"plan_mode_force_exit",
	"plan_mode_present",
];

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

export function ensurePlanLifecycleToolsActive(): void {
	if (!piRef) return;
	const current = piRef.getActiveTools();
	const missing = PLAN_LIFECYCLE_TOOLS.filter(
		(name) => !current.includes(name),
	);
	if (missing.length > 0) {
		piRef.setActiveTools([...current, ...missing]);
	}
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
}

function persistPlanModeState(active: boolean): void {
	piRef?.appendEntry(PLAN_MODE_STATE_ENTRY, { active });
}
