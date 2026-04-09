import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { statusGlyph } from "../../shared/ui/status.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";

interface TavilyResult {
	title: string;
	url: string;
	content: string;
	score: number;
}

interface TavilyResponse {
	results: TavilyResult[];
	answer?: string;
}

interface SearchDetails {
	query: string;
	answer?: string;
	results: { title: string; url: string }[];
}

export const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the web using Tavily. Requires the TAVILY_API_KEY environment variable.",
	parameters: Type.Object({
		query: Type.String({ description: "The search query" }),
		max_results: Type.Optional(
			Type.Number({
				description: "Maximum number of results (default: 5)",
				minimum: 1,
				maximum: 20,
			}),
		),
	}),
	async execute(_toolCallId, params) {
		const apiKey = process.env.TAVILY_API_KEY;
		if (!apiKey) {
			throw new Error(
				"TAVILY_API_KEY environment variable is not set. Get one at https://tavily.com",
			);
		}

		const res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				api_key: apiKey,
				query: params.query,
				max_results: params.max_results ?? 5,
				include_answer: true,
			}),
		});

		if (!res.ok) {
			throw new Error(`Tavily API error: ${res.status} ${await res.text()}`);
		}

		const data = (await res.json()) as TavilyResponse;

		const lines: string[] = [];
		if (data.answer) {
			lines.push(`**Answer:** ${data.answer}`, "");
		}
		for (const r of data.results) {
			lines.push(`### ${r.title}`, r.url, "", r.content, "");
		}

		const details: SearchDetails = {
			query: params.query,
			answer: data.answer,
			results: data.results.map((r) => ({ title: r.title, url: r.url })),
		};

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Web Search",
			arg: args.query,
		});
	},
	renderResult(result, _options, theme) {
		const details = result.details as SearchDetails | undefined;
		if (!details?.results.length) {
			return new Text(theme.fg("muted", "No results found."), 0, 0);
		}
		const lines: string[] = [];
		if (details.answer) {
			lines.push(`${statusGlyph(theme, "ok")} ${details.answer}`, "");
		}
		for (const r of details.results) {
			lines.push(theme.fg("text", theme.bold(r.title)), theme.fg("dim", r.url));
		}
		return new Text(lines.join("\n"), 0, 0);
	},
});
