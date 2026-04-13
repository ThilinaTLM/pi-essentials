import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { showPromptDialog } from "../../shared/ui/dialog.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";

interface AskUserDetails {
	question: string;
	response?: string;
	dismissed: boolean;
}

function requireContext<T>(ctx: T | undefined): T {
	if (!ctx) {
		throw new Error("Extension context unavailable.");
	}
	return ctx;
}

function buildPromptBody(
	ctx: ExtensionContext,
	params: {
		question: string;
		context?: string;
		recommendation?: string;
	},
): Container {
	const theme = ctx.ui.theme;
	const body = new Container();
	body.addChild(new Text(theme.fg("text", theme.bold(params.question)), 0, 0));
	if (params.context) {
		body.addChild(new Text("", 0, 0));
		body.addChild(new Text(theme.fg("muted", params.context), 0, 0));
	}
	if (params.recommendation) {
		body.addChild(new Text("", 0, 0));
		body.addChild(
			new Text(
				theme.fg("accent", `Recommendation: ${params.recommendation}`),
				0,
				0,
			),
		);
	}
	body.addChild(new Text("", 0, 0));
	body.addChild(
		new Text(
			theme.fg(
				"dim",
				"Reply, disagree, refine the request, or ask for more explanation.",
			),
			0,
			0,
		),
	);
	return body;
}

export const askUserTool = defineTool({
	name: "ask_user",
	label: "Ask User",
	description:
		"Ask the user one focused question and wait for a free-text reply. Include your recommendation when useful, but do not present choices. The user may answer, disagree, refine the request, or ask for more explanation. Do not use this when the answer can be derived from the codebase or other tools.",
	parameters: Type.Object({
		question: Type.String({
			description: "The single focused question to ask the user",
		}),
		context: Type.Optional(
			Type.String({
				description: "Optional background that helps the user answer",
			}),
		),
		recommendation: Type.Optional(
			Type.String({
				description: "Optional recommendation or current leaning",
			}),
		),
		placeholder: Type.Optional(
			Type.String({
				description: "Optional placeholder text for the reply input",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const context = requireContext(ctx);
		const response = await showPromptDialog(context, {
			title: "Question",
			content: buildPromptBody(context, params),
			placeholder:
				params.placeholder ??
				"Type your reply, disagree, or ask for more explanation",
		});
		const details: AskUserDetails = {
			question: params.question,
			response: response ?? undefined,
			dismissed: response === null,
		};

		return {
			content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
			details,
		};
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Ask User",
			arg: args.question,
		});
	},
	renderResult(result, _options, theme) {
		const details = result.details as AskUserDetails | undefined;
		if (!details) return new Text("", 0, 0);
		const body = new Container();
		body.addChild(
			new Text(theme.fg("muted", theme.bold(details.question)), 0, 0),
		);
		body.addChild(new Text("", 0, 0));
		if (details.dismissed) {
			body.addChild(
				new Text(theme.fg("muted", "User dismissed the prompt."), 0, 0),
			);
			return body;
		}
		body.addChild(new Text(theme.fg("text", details.response ?? ""), 0, 0));
		return body;
	},
});
