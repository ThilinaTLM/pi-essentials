import { defineTool, DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, Container, Markdown, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// --- State ---

let planActive = false;

export function isPlanActive(): boolean {
  return planActive;
}

// --- Helpers ---

const PLANS_DIR = join(homedir(), ".pi", "plans");

function exitPlanMode(ctx: ExtensionContext) {
  planActive = false;
  ctx.ui.setStatus("plan-mode", undefined);
}

function enterPlanMode(ctx: ExtensionContext) {
  planActive = true;
  ctx.ui.setStatus(
    "plan-mode",
    ctx.ui.theme.fg("warning", "⏸ plan"),
  );
}

// --- Blocked bash patterns ---

const BLOCKED_BASH = [
  /\brm\s/, /\brm$/, // rm commands
];

export function isBlockedBashCommand(command: string): boolean {
  const trimmed = command.trim();
  return BLOCKED_BASH.some((pattern) => pattern.test(trimmed));
}

function resolvePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }
  return resolve(filePath);
}

function isAllowedWritePath(filePath: string): boolean {
  return resolvePath(filePath).startsWith(PLANS_DIR);
}

// --- Tools ---

export const planEnterTool = defineTool({
  name: "plan_enter",
  label: "Enter Plan Mode",
  description:
    `Enter plan mode for researching and planning before making changes. During plan mode, only read-only operations and writing plan files to ${PLANS_DIR}/ are allowed. Use this when a task is complex and needs proper planning before implementation.`,
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    if (planActive) {
      throw new Error(
        "Already in plan mode. Use plan_present to present your plan or plan_force_exit to exit.",
      );
    }

    await mkdir(PLANS_DIR, { recursive: true });
    enterPlanMode(ctx!);

    return {
      content: [
        {
          type: "text",
          text: `Plan mode active. Write your plan to ${PLANS_DIR}/<feature-name>.md\n\nGuidelines:\n- Research and explore the codebase (read-only)\n- Ask clarifying questions if requirements are ambiguous\n- Write a plan covering requirements, approach, and implementation steps\n- Mark open questions with [!QUESTION] and decisions with [!DECISION]\n- When ready, use plan_present to show the plan to the user`,
        },
      ],
      details: {},
    };
  },
  renderCall(_args, theme, context) {
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(theme.fg("toolTitle", theme.bold("Enter Plan Mode")));
    return text;
  },
  renderResult(_result, _options, theme) {
    return new Text(theme.fg("success", "Plan mode active"), 0, 0);
  },
});

export const planForceExitTool = defineTool({
  name: "plan_force_exit",
  label: "Exit Plan Mode",
  description:
    "Exit plan mode without presenting the plan. Use when planning is no longer needed.",
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    if (!planActive) {
      throw new Error("Not in plan mode.");
    }
    exitPlanMode(ctx!);
    return {
      content: [{ type: "text", text: "Exited plan mode. Full access restored." }],
      details: {},
    };
  },
  renderCall(_args, theme, context) {
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(theme.fg("toolTitle", theme.bold("Exit Plan Mode")));
    return text;
  },
  renderResult(_result, _options, theme) {
    return new Text(theme.fg("muted", "Plan mode exited."), 0, 0);
  },
});

export const planPresentTool = defineTool({
  name: "plan_present",
  label: "Present Plan",
  description:
    "Present the plan to the user for review. The user can accept (start implementation), request changes, or discard the plan. This is the primary way to exit plan mode.",
  parameters: Type.Object({
    file_path: Type.String({ description: "Path to the plan markdown file" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!planActive) {
      throw new Error("Not in plan mode. Use plan_enter first.");
    }

    let content: string;
    try {
      content = await readFile(params.file_path, "utf-8");
    } catch {
      throw new Error(`Could not read plan file: ${params.file_path}`);
    }

    if (!content.trim()) {
      throw new Error("Plan file is empty. Write your plan first, then present it.");
    }

    const options = ["Accept & Execute", "Request Changes", "Discard"] as const;
    type Choice = (typeof options)[number];

    const choice = await ctx!.ui.custom<Choice | null>((_tui, theme, _kb, done) => {
      const container = new Container();
      const border = new DynamicBorder((s: string) => theme.fg("accent", s));
      const mdTheme = getMarkdownTheme();

      let selected = 0;

      const optionLines = options.map(() => new Text("", 1, 0));
      const hint = new Text(theme.fg("dim", "↑/↓ navigate  1-3 select  Enter confirm  Esc cancel"), 1, 0);

      const updateOptions = () => {
        for (let i = 0; i < options.length; i++) {
          const num = `${i + 1}.`;
          if (i === selected) {
            optionLines[i].setText(theme.fg("accent", `${num} ${options[i]}`));
          } else {
            optionLines[i].setText(theme.fg("muted", `${num} `) + theme.fg("text", options[i]));
          }
        }
        container.invalidate();
      };

      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold("Plan Review")), 1, 0));
      container.addChild(new Text("", 0, 0));
      container.addChild(new Markdown(content, 1, 1, mdTheme));
      container.addChild(new Text("", 0, 0));
      container.addChild(border);
      for (const line of optionLines) container.addChild(line);
      container.addChild(hint);

      updateOptions();

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "up")) {
            selected = (selected - 1 + options.length) % options.length;
            updateOptions();
          } else if (matchesKey(data, "down")) {
            selected = (selected + 1) % options.length;
            updateOptions();
          } else if (data === "1" || data === "2" || data === "3") {
            done(options[parseInt(data) - 1]);
          } else if (matchesKey(data, "enter")) {
            done(options[selected]);
          } else if (matchesKey(data, "escape")) {
            done(null);
          }
        },
      };
    });

    if (choice === "Accept & Execute") {
      exitPlanMode(ctx!);
      return {
        content: [
          {
            type: "text",
            text: `Plan accepted. Read the plan file at ${params.file_path} and start implementing it step by step.`,
          },
        ],
        details: { content, action: "accepted", filePath: params.file_path },
      };
    }

    if (choice === "Discard") {
      exitPlanMode(ctx!);
      ctx!.abort();
      return {
        content: [{ type: "text", text: "Plan discarded. Full access restored." }],
        details: { content, action: "discarded", filePath: params.file_path },
      };
    }

    // Request Changes, cancelled, or null — stay in plan mode, stop agent turn
    ctx!.abort();
    return {
      content: [
        {
          type: "text",
          text: `User wants changes to the plan. Update the plan file at ${params.file_path} and present again.`,
        },
      ],
      details: { content, action: "changes_requested", filePath: params.file_path },
    };
  },
  renderCall(_args, theme, context) {
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(theme.fg("toolTitle", theme.bold("Plan")));
    return text;
  },
  renderResult(result, _options, theme) {
    const details = result.details as
      | { content: string; action: string; filePath: string }
      | undefined;
    if (!details) return new Text("", 0, 0);

    const container = new Container();
    const mdTheme = getMarkdownTheme();

    // Render the full plan
    container.addChild(new Markdown(details.content, 1, 1, mdTheme));
    container.addChild(new Text("", 0, 0));

    // Status and file path at the bottom
    if (details.action === "accepted") {
      container.addChild(new Text(theme.fg("success", "✓ Plan accepted — executing"), 0, 0));
    } else if (details.action === "discarded") {
      container.addChild(new Text(theme.fg("muted", "Plan discarded."), 0, 0));
    } else {
      container.addChild(new Text(theme.fg("warning", "Changes requested — describe what you'd like changed below."), 0, 0));
    }
    container.addChild(new Text(theme.fg("dim", details.filePath), 0, 0));

    return container;
  },
});

// --- Extension registration ---

export function registerPlan(pi: ExtensionAPI) {
  pi.registerTool(planEnterTool);
  pi.registerTool(planForceExitTool);
  pi.registerTool(planPresentTool);

  // Slash commands
  pi.registerCommand("plan", {
    description: "Enter plan mode",
    handler: async (_args, ctx) => {
      if (planActive) {
        ctx.ui.notify("Already in plan mode.", "warning");
        return;
      }
      await mkdir(PLANS_DIR, { recursive: true });
      enterPlanMode(ctx);
      ctx.ui.notify("Plan mode active.", "info");
    },
  });

  pi.registerCommand("plan_exit", {
    description: "Exit plan mode",
    handler: async (_args, ctx) => {
      if (!planActive) {
        ctx.ui.notify("Not in plan mode.", "warning");
        return;
      }
      exitPlanMode(ctx);
      ctx.ui.notify("Plan mode exited. Full access restored.", "info");
    },
  });

  // Block destructive tools during plan mode
  pi.on("tool_call", async (event) => {
    if (!planActive) return;

    const blocked = ["edit", "notebook_edit"];
    if (blocked.includes(event.toolName)) {
      return {
        block: true,
        reason: "Plan mode active — file modifications are not allowed. Use plan_present to present your plan or plan_force_exit to exit.",
      };
    }

    // Allow write only to plan files
    if (event.toolName === "write") {
      const filePath = (event.input.path ?? event.input.file_path) as string | undefined;
      if (!filePath || !isAllowedWritePath(filePath)) {
        return {
          block: true,
          reason: `Plan mode active — writes are only allowed to ${PLANS_DIR}/. Attempted: ${filePath}`,
        };
      }
    }

    // Block destructive bash commands
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (isBlockedBashCommand(command)) {
        return {
          block: true,
          reason: `Plan mode active — destructive command blocked.\nCommand: ${command}`,
        };
      }
    }
  });

  // Inject plan mode context
  pi.on("before_agent_start", async () => {
    if (!planActive) return;

    return {
      message: {
        customType: "plan-mode-context",
        content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only research and planning mode.

Restrictions:
- You can READ files, search, grep, and run safe bash commands
- You can WRITE only to ${PLANS_DIR}/ directory
- You CANNOT edit existing code files
- Use plan_present when your plan is ready for review

Workflow:
1. Understand the requirements — ask clarifying questions if anything is ambiguous
2. Explore the codebase to ground your understanding
3. Write a comprehensive plan to ${PLANS_DIR}/<feature-name>.md covering:
   - Context: what problem this solves and why
   - Requirements (functional)
   - Implementation steps (specific files, functions, approach)
   - Dependencies and order of operations
   - Verification steps
4. Mark open questions with [!QUESTION] and decisions needing input with [!DECISION]
5. Use plan_present to show the plan to the user

Do NOT attempt to modify code — just research and plan.`,
        display: false,
      },
    };
  });

  // Clean up plan mode context when not active
  pi.on("context", async (event) => {
    if (planActive) return;
    return {
      messages: event.messages.filter((m) => {
        const msg = m as { customType?: string };
        return msg.customType !== "plan-mode-context";
      }),
    };
  });
}
