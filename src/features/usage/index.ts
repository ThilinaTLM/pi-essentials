import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAnthropicUsage } from "./anthropic.js";
import { registerCodexUsage } from "./codex.js";

export {
	type AnthropicUsageData,
	formatAnthropicResetTime,
	getAnthropicUsageSnapshot,
	registerAnthropicUsage,
} from "./anthropic.js";
export {
	type CodexUsageData,
	formatCodexResetAfterSeconds,
	getCodexUsageSnapshot,
	registerCodexUsage,
} from "./codex.js";

export function registerUsage(pi: ExtensionAPI): void {
	registerAnthropicUsage(pi);
	registerCodexUsage(pi);
}
