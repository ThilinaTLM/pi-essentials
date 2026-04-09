import { defineTool, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { statusGlyph } from "../../shared/ui/status.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";

interface TodoItem {
	todo: string;
	done: boolean;
}

const todos: TodoItem[] = [];

function snapshot(): TodoItem[] {
	return todos.map((t) => ({ ...t }));
}

function buildTodoBody(items: TodoItem[], theme: Theme): Container {
	const body = new Container();
	if (items.length === 0) {
		body.addChild(new Text(theme.fg("muted", "No todos set."), 0, 0));
		return body;
	}
	for (const item of items) {
		const glyph = statusGlyph(theme, item.done ? "ok" : "idle");
		const label = item.done
			? theme.fg("muted", theme.strikethrough(item.todo))
			: theme.fg("text", item.todo);
		body.addChild(new Text(`${glyph}  ${label}`, 0, 0));
	}
	return body;
}

export const todosSetTool = defineTool({
	name: "todos_set",
	label: "Set Todos",
	description:
		"Set the todo list for the current task. Replaces any existing todos. Use this at the start of a complex task to outline the steps.",
	parameters: Type.Object({
		todos: Type.Array(
			Type.Object({
				todo: Type.String({ description: "The todo item text" }),
				done: Type.Boolean({ description: "Whether the item is done" }),
			}),
			{ description: "List of todo items with completion status" },
		),
	}),
	async execute(_toolCallId, params) {
		todos.length = 0;
		for (const item of params.todos) {
			todos.push({ todo: item.todo, done: item.done });
		}
		return {
			content: [{ type: "text", text: JSON.stringify(snapshot(), null, 2) }],
			details: {},
		};
	},
	renderCall(_args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Set Todos",
		});
	},
	renderResult(_result, _options, theme) {
		return buildTodoBody(todos, theme);
	},
});

export const todosGetTool = defineTool({
	name: "todos_get",
	label: "Get Todos",
	description: "Get the current todo list with completion status.",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text", text: JSON.stringify(snapshot(), null, 2) }],
			details: {},
		};
	},
	renderCall(_args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Get Todos",
		});
	},
	renderResult(_result, _options, theme) {
		return buildTodoBody(todos, theme);
	},
});
