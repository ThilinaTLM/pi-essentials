import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const FIRST_SENTENCE =
	"You are an expert coding assistant operating inside pi, a coding agent harness.";
const FIRST_SENTENCE_REPLACEMENT =
	"You are an expert coding assistant operating inside Claude Code, a coding agent harness.";
const DOCUMENTATION_HEADER =
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";

function replaceFirstSentenceProductName(systemPrompt: string): string {
	return systemPrompt.replace(FIRST_SENTENCE, FIRST_SENTENCE_REPLACEMENT);
}

function removePiDocumentationSection(systemPrompt: string): string {
	const spacedHeader = `\n\n${DOCUMENTATION_HEADER}`;
	const start = systemPrompt.includes(spacedHeader)
		? systemPrompt.indexOf(spacedHeader)
		: systemPrompt.indexOf(DOCUMENTATION_HEADER);

	if (start === -1) return systemPrompt;

	const searchFrom = start + DOCUMENTATION_HEADER.length;
	const boundaries = [
		"\n\n# Project Context",
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"\n<available_skills>",
		"\n\n[PLAN MODE ACTIVE]",
		"\nCurrent date:",
	]
		.map((marker) => systemPrompt.indexOf(marker, searchFrom))
		.filter((index) => index !== -1);

	if (boundaries.length === 0) return systemPrompt;

	const end = Math.min(...boundaries);
	return `${systemPrompt.slice(0, start)}${systemPrompt.slice(end)}`;
}

function transformSystemPrompt(
	systemPrompt: string,
	provider: string | undefined,
): string {
	const withoutDocs = removePiDocumentationSection(systemPrompt);
	if (provider !== "anthropic") return withoutDocs;
	return replaceFirstSentenceProductName(withoutDocs);
}

export function registerSystemPromptOverride(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		return {
			systemPrompt: transformSystemPrompt(
				event.systemPrompt,
				ctx.model?.provider,
			),
		};
	});
}
