import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { pauseLoader } from "../modal-chrome.js";

interface ModalComponent extends Component {
	handleInput(data: string): void;
}

export function showModal<T>(
	ctx: ExtensionContext,
	createComponent: (
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		done: (result: T) => void,
	) => ModalComponent,
): Promise<T> {
	return ctx.ui.custom<T>((tui, theme, _kb, done) => {
		const resumeLoader = pauseLoader(tui);
		const component = createComponent(tui, theme, done);
		const focusable = component as ModalComponent & Partial<Focusable>;

		return {
			render: (width: number) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput: (data: string) => component.handleInput(data),
			get focused() {
				return focusable.focused ?? false;
			},
			set focused(value: boolean) {
				if ("focused" in focusable) {
					focusable.focused = value;
				}
			},
			dispose: () => resumeLoader(),
		};
	});
}
