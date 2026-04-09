import { type Component, Loader, type TUI } from "@mariozechner/pi-tui";

// Walks the TUI tree to find the first Loader. Modal dialogs pause it while
// they own the screen so the spinner doesn't redraw over the modal.
export function findLoader(root: TUI): Loader | null {
	const walk = (node: { children?: Component[] }): Loader | null => {
		if (node instanceof Loader) return node;
		if (node.children) {
			for (const child of node.children) {
				const found = walk(child as unknown as { children?: Component[] });
				if (found) return found;
			}
		}
		return null;
	};
	return walk(root);
}

// Pauses any running loader in the TUI and returns a resume function.
// Returns a no-op if no loader was running.
export function pauseLoader(tui: TUI): () => void {
	const loader = findLoader(tui);
	if (!loader) return () => {};
	loader.stop();
	loader.setText("");
	return () => loader.start();
}
