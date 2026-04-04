# AGENTS.md

- Make the smallest direct change that solves the task.
- Keep feature logic in focused `src/*.ts` modules.
- Keep extension/tool wiring in `src/index.ts`.
- Prefer editing existing code over adding abstractions, migration layers, or compatibility shims.
- Backward compatibility is not a priority here; optimize for the current maintainer workflow.
- After meaningful code changes, run `pnpm check`.
- Keep comments and docs sparse; add them only when behavior is non-obvious.
