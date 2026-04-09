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

// Display form: "Claude Opus 4.6" -> "Opus 4.6", "opus-4-6" -> "Opus 4.6".
// Prefers the provider's display name; falls back to a prettified short ID.
export function prettyModelLabel(model: ModelLike | undefined): string {
	if (!model) return "no-model";
	if (model.name) {
		return model.name.replace(/^Claude\s+/i, "");
	}
	return prettifyModelId(shortenModelId(model.id));
}

function prettifyModelId(id: string): string {
	const parts = id.split("-");
	const out: string[] = [];
	let numBuf: string[] = [];
	const flushNum = () => {
		if (numBuf.length > 0) {
			out.push(numBuf.join("."));
			numBuf = [];
		}
	};
	for (const part of parts) {
		if (/^\d+$/.test(part)) {
			numBuf.push(part);
			continue;
		}
		flushNum();
		if (/^(gpt|ai|llm)$/i.test(part)) {
			out.push(part.toUpperCase());
		} else {
			out.push(part.charAt(0).toUpperCase() + part.slice(1));
		}
	}
	flushNum();
	return out.join(" ");
}
