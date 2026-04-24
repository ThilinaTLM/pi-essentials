import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function buildHandoverPrompt(handoverDir: string, args: string): string {
	const extraInstructions = args.trim()
		? `\n\nAdditional user instructions: ${args.trim()}`
		: "";

	return `Pause at the next clean stopping point. Then write a handover prompt for a fresh agent containing every detail needed to take over and complete this work without any issue — context, decisions, current state, and next steps. You decide what matters. Output only the handover prompt.

Save it to ${handoverDir} with a short, descriptive .md filename. Output only the resulting absolute file path.${extraInstructions}`;
}

export function registerHandover(pi: ExtensionAPI) {
	pi.registerCommand("handover", {
		description: "Handover the remaining work to a new agent",
		handler: async (args, ctx) => {
			const handoverDir = path.join(homedir(), ".pi", "handover");
			await mkdir(handoverDir, { recursive: true });

			pi.sendUserMessage(buildHandoverPrompt(handoverDir, args), {
				deliverAs: ctx.isIdle() ? undefined : "followUp",
			});
		},
	});
}
