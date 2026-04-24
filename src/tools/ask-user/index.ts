import { defineTool, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { showPromptDialog } from "../../shared/ui/dialog/index.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";

interface AskUserDetails {
	question: string;
	context?: string;
	recommendation?: string;
	response?: string;
	dismissed: boolean;
}

interface PromptBodyParams {
	question: string;
	context?: string;
	recommendation?: string;
}

function requireContext<T>(ctx: T | undefined): T {
	if (!ctx) {
		throw new Error("Extension context unavailable.");
	}
	return ctx;
}

function buildPromptBody(theme: Theme, params: PromptBodyParams): Container {
	const body = new Container();
	if (params.context) {
		body.addChild(new Text(theme.fg("muted", params.context), 0, 0));
		body.addChild(new Text("", 0, 0));
	}
	body.addChild(
		new Text(theme.fg("accent", theme.bold(params.question)), 0, 0),
	);
	if (params.recommendation) {
		body.addChild(new Text("", 0, 0));
		body.addChild(new Text(theme.fg("text", params.recommendation), 0, 0));
	}
	return body;
}

export const askUserTool = defineTool({
	name: "ask_user",
	label: "Ask User",
	description:
		"Ask the user one focused question and wait for a free-text reply. Use this only when the answer must come from the user rather than the codebase, tools, or prior context. When helpful, include a brief recommendation and why, but do not present fixed choices. The user may answer directly, disagree, refine the request, or ask for more explanation. If the reply does not resolve the issue, continue with another single focused question.",
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
			content: buildPromptBody(context.ui.theme, params),
			placeholder:
				params.placeholder ??
				"Type your reply, disagree, or ask for more explanation",
			quickReplies: [
				{
					label: "I Agree",
					value: "I agree with your recommendation",
				},
				{
					label: "Explain More",
					value: "Could you explain it a bit further?",
				},
			],
		});
		const details: AskUserDetails = {
			question: params.question,
			context: params.context,
			recommendation: params.recommendation,
			response: response ?? undefined,
			dismissed: response === null,
		};
		if (response === null) {
			context.abort();
		}

		return {
			content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
			details,
		};
	},
	renderCall(_args, theme, context) {
		if (context.isPartial) {
			return new Container();
		}
		return renderToolHeader(theme, context.lastComponent, {
			title: "Ask User",
		});
	},
	renderResult(result, _options, theme) {
		const details = result.details as AskUserDetails | undefined;
		const body = new Container();
		if (!details) return body;
		body.addChild(
			buildPromptBody(theme, {
				question: details.question,
				context: details.context,
				recommendation: details.recommendation,
			}),
		);
		body.addChild(new Text("", 0, 0));
		const reply = details.dismissed
			? "User dismissed the question."
			: (details.response ?? "");
		body.addChild(new Text(theme.fg("toolOutput", reply), 0, 0));
		return body;
	},
});
