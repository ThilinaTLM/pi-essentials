import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Theme } from "@mariozechner/pi-tui";

interface TodoItem {
  todo: string;
  done: boolean;
}

const todos: TodoItem[] = [];

function snapshot(): TodoItem[] {
  return todos.map((t) => ({ ...t }));
}

function renderTodos(items: TodoItem[], theme: Theme): Text {
  if (items.length === 0) {
    return new Text(theme.fg("muted", "No todos set."), 0, 0);
  }
  const lines = items.map((item) => {
    if (item.done) {
      return (
        theme.fg("success", "✓ ") +
        theme.fg("muted", theme.strikethrough(item.todo))
      );
    }
    return theme.fg("warning", "○ ") + theme.fg("text", item.todo);
  });
  return new Text(lines.join("\n"), 0, 0);
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
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(theme.fg("toolTitle", theme.bold("Set Todos")));
    return text;
  },
  renderResult(_result, _options, theme) {
    return renderTodos(todos, theme);
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
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(theme.fg("toolTitle", theme.bold("Get Todos")));
    return text;
  },
  renderResult(_result, _options, theme) {
    return renderTodos(todos, theme);
  },
});
