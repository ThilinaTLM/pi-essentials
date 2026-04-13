import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";

export interface DialogOption<T> {
	id: T;
	label: string;
	captureInput?: { placeholder?: string };
}

export interface DialogSection<T> {
	label?: string;
	content?: Component;
	options?: DialogOption<T>[];
}

export interface DialogOptions<T> {
	title: string;
	tone?: Extract<ThemeColor, "border" | "borderAccent" | "borderMuted">;
	sections: DialogSection<T>[];
}

export interface DialogResult<T> {
	id: T;
	input?: string;
}

export interface PromptDialogQuickReply {
	label: string;
	value: string;
}

export interface PromptDialogOptions {
	title: string;
	tone?: Extract<ThemeColor, "border" | "borderAccent" | "borderMuted">;
	content: Component;
	inputLabel?: string;
	placeholder?: string;
	quickReplies?: PromptDialogQuickReply[];
}
