export interface ModelLike {
	id: string;
	name?: string;
	provider?: string;
}

export interface ModelLabelOptions {
	short?: boolean;
}

// Single definition of how a model is named on screen. Welcome, footer, and
// explore tool all route through this so they never drift.
export function formatModelLabel(
	model: ModelLike | undefined,
	opts: ModelLabelOptions = {},
): string {
	if (!model) return "no-model";
	const base = model.name || model.id;
	if (!opts.short) return base;
	return shortenModelId(base);
}

// Shortens noisy vendor-prefixed IDs like "claude-opus-4-6-20250514" to
// something a footer can show without eating horizontal space.
export function shortenModelId(id: string): string {
	const tail = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	return tail
		.replace(/^claude-/i, "")
		.replace(/-\d{8}$/, "")
		.replace(/-latest$/, "");
}
