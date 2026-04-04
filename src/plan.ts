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

function setPlanModeUI(ctx: ExtensionContext, active: boolean) {
  if (!active) {
    ctx.ui.setWidget("plan-mode", undefined);
    return;
  }

  ctx.ui.setWidget("plan-mode", (_tui, theme) => ({
    render: () => [
      theme.fg("warning", theme.bold("⏸ PLAN MODE")),
    ],
    invalidate: () => {},
  }));
}

function exitPlanMode(ctx: ExtensionContext) {
  planActive = false;
  setPlanModeUI(ctx, false);
}

function enterPlanMode(ctx: ExtensionContext) {
  planActive = true;
  setPlanModeUI(ctx, true);
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
    `Enter plan mode — a read-only research and planning phase. You can read files, search, and run safe commands, but only write to ${PLANS_DIR}/. Use this for complex tasks that need requirements discovery, codebase research, and discussion with the user before implementation.`,
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
          text: `Plan mode active. Plans are saved to ${PLANS_DIR}/<feature-name>.md\n\nStart by understanding what the user needs — ask questions, research the codebase, and explore options before writing anything. Use plan_present only after all open questions are resolved.`,
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
    "Present the finalized plan for user review. Only use this after all open questions and decisions are resolved through discussion. The user can accept, request changes, or discard.",
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

    const options = ["Accept & Execute", "Request Changes"] as const;
    type Choice = (typeof options)[number];

    const choice = await ctx!.ui.custom<Choice | null>((_tui, theme, _kb, done) => {
      const container = new Container();
      const border = new DynamicBorder((s: string) => theme.fg("accent", s));
      const mdTheme = getMarkdownTheme();

      let selected = 0;

      const optionLines = options.map(() => new Text("", 1, 0));

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
          } else if (data === "1" || data === "2") {
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
- READ files, search, grep, run safe bash commands
- WRITE only to ${PLANS_DIR}/ directory
- NO code modifications

## Your Role

You are a technical partner, not an order-taker. Your job is to:
- **Research** the codebase and external options before suggesting anything
- **Challenge** assumptions — if the user's approach has trade-offs, explain them with evidence
- **Propose** alternatives when you find better options, with concrete reasoning
- **Ask** focused questions to eliminate ambiguity — don't guess, don't assume

Do not accept decisions at face value. If you disagree, say so and explain why with facts from the codebase or domain knowledge. The user wants your honest technical judgment.

## Workflow

1. **Understand** — Parse the requirements. Ask clarifying questions upfront. Do not proceed with ambiguity.
2. **Research** — Explore the codebase: file structure, key modules, types, patterns, dependencies. Understand what exists before proposing anything.
3. **Discuss** — Have an active back-and-forth with the user. Surface trade-offs, propose options, resolve unknowns. This is the most important step.
4. **Draft** — Once requirements are clear, write the plan to ${PLANS_DIR}/<feature-name>.md:
   - What problem this solves and why
   - Functional requirements
   - Implementation steps (specific files, functions, modules, approach)
   - Dependencies and order of operations
   - Mark unresolved items with [!QUESTION] or [!DECISION] callouts
5. **Refine** — Walk the user through the draft. Resolve every open item. Update until clean.
6. **Present** — Use plan_present ONLY when all questions and decisions are resolved. The final plan must be self-contained and actionable with no open items.

## Plan Quality

- Every step must be specific — name files, functions, types, and modules
- Respect existing codebase patterns and conventions
- Call out breaking changes, migrations, or risks explicitly
- Keep steps small enough to be single reviewable units of work
- The final plan should be executable without follow-up questions`,
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
