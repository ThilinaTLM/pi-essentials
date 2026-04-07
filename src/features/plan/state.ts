import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { setPlanModeWidget } from "./ui.js";

const PLAN_ONLY_TOOLS = ["plan_mode_force_exit", "plan_mode_present"];

let planActive = false;
let piRef: ExtensionAPI | null = null;

export function initializePlanState(pi: ExtensionAPI): void {
	piRef = pi;
}

export function isPlanActive(): boolean {
	return planActive;
}

export function syncPlanToolsActive(): void {
	setPlanToolsActive(planActive);
}

export function enterPlanMode(ctx: ExtensionContext): void {
	planActive = true;
	setPlanModeWidget(ctx, true);
	setPlanToolsActive(true);
}

export function exitPlanMode(ctx: ExtensionContext): void {
	planActive = false;
	setPlanModeWidget(ctx, false);
	setPlanToolsActive(false);
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
