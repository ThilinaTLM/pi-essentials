import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { SEP } from "../../shared/ui/palette.js";
import { statusGlyph } from "../../shared/ui/status.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";

const MAX_INLINE_BYTES = 512 * 1024; // 512 KB
const TMP_DIR = "/tmp/pi-fetch";

const CONTENT_TYPE_EXT: Record<string, string> = {
	"text/html": ".html",
	"text/plain": ".txt",
	"text/xml": ".xml",
	"text/css": ".css",
	"text/csv": ".csv",
	"application/json": ".json",
	"application/xml": ".xml",
	"application/pdf": ".pdf",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

function getExtension(contentType: string): string {
	const base = contentType.split(";")[0].trim().toLowerCase();
	return CONTENT_TYPE_EXT[base] ?? ".bin";
}

function isTextType(contentType: string): boolean {
	const base = contentType.split(";")[0].trim().toLowerCase();
	return (
		base.startsWith("text/") ||
		base === "application/json" ||
		base === "application/xml" ||
		base === "application/javascript"
	);
}

function isHtml(contentType: string): boolean {
	return contentType.split(";")[0].trim().toLowerCase() === "text/html";
}

function tmpPath(url: string, ext: string): string {
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
	return join(TMP_DIR, `${hash}${ext}`);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}

interface FetchDetails {
	url: string;
	status: number;
	contentType: string;
	size: number;
	savedTo?: string;
	converted: boolean;
}

export const webFetchTool = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch the contents of a URL. HTML is converted to markdown for readability. Large responses and binary files are saved to a temp file. Pass raw=true to skip conversion and save the raw content to a temp file.",
	parameters: Type.Object({
		url: Type.String({ description: "The URL to fetch" }),
		raw: Type.Optional(
			Type.Boolean({
				description:
					"If true, save raw content to a temp file and return the path (default: false)",
			}),
		),
	}),
	async execute(_toolCallId, params) {
		const raw = params.raw ?? false;

		const res = await fetch(params.url, {
			headers: {
				"User-Agent": "pi-toolbelt/1.0",
				Accept: "text/html,application/json,text/plain,*/*",
			},
			redirect: "follow",
			signal: AbortSignal.timeout(60_000),
		});

		if (!res.ok) {
			throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
		}

		const contentType =
			res.headers.get("content-type") ?? "application/octet-stream";
		const buffer = await res.arrayBuffer();
		const size = buffer.byteLength;
		const ext = getExtension(contentType);

		const details: FetchDetails = {
			url: params.url,
			status: res.status,
			contentType,
			size,
			converted: false,
		};

		// raw=true → always save to file
		if (raw) {
			await mkdir(TMP_DIR, { recursive: true });
			const path = tmpPath(params.url, ext);
			await writeFile(path, Buffer.from(buffer));
			details.savedTo = path;
			return {
				content: [
					{
						type: "text",
						text: `Raw content saved to: ${path}\nSize: ${formatSize(size)}\nContent-Type: ${contentType}`,
					},
				],
				details,
			};
		}

		// Binary → save to file
		if (!isTextType(contentType)) {
			await mkdir(TMP_DIR, { recursive: true });
			const path = tmpPath(params.url, ext);
			await writeFile(path, Buffer.from(buffer));
			details.savedTo = path;
			return {
				content: [
					{
						type: "text",
						text: `Binary content saved to: ${path}\nSize: ${formatSize(size)}\nContent-Type: ${contentType}\nUse the read tool to inspect it.`,
					},
				],
				details,
			};
		}

		// Text content
		let text = new TextDecoder().decode(buffer);

		// HTML → convert to markdown
		if (isHtml(contentType)) {
			text = NodeHtmlMarkdown.translate(text);
			details.converted = true;
		}

		// If within inline limit, return directly
		if (Buffer.byteLength(text) <= MAX_INLINE_BYTES) {
			return {
				content: [{ type: "text", text }],
				details,
			};
		}

		// Too large → save to file
		await mkdir(TMP_DIR, { recursive: true });
		const saveExt = details.converted ? ".md" : ext;
		const path = tmpPath(params.url, saveExt);
		await writeFile(path, text);
		details.savedTo = path;

		return {
			content: [
				{
					type: "text",
					text: `Response saved to: ${path}\nSize: ${formatSize(Buffer.byteLength(text))}${details.converted ? " (converted to markdown)" : ""}\nThe content is large — use grep or read to inspect it.`,
				},
			],
			details,
		};
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Web Fetch",
			arg: args.url,
			tag: args.raw ? { text: "raw", tone: "warning" } : undefined,
		});
	},
	renderResult(result, _options, theme) {
		const details = result.details as FetchDetails | undefined;
		if (!details) {
			return new Text(theme.fg("muted", "No response."), 0, 0);
		}

		const statusKind = details.status < 400 ? "ok" : "fail";
		const statusColor = details.status < 400 ? "success" : "error";
		const statusText = `${statusGlyph(theme, statusKind)} ${theme.fg(
			statusColor,
			`${details.status}`,
		)}`;
		const parts = [
			statusText,
			theme.fg("muted", details.contentType),
			theme.fg("muted", formatSize(details.size)),
		];
		if (details.converted) {
			parts.push(theme.fg("success", "→ markdown"));
		}

		const sep = theme.fg("borderMuted", SEP);
		const lines = [parts.join(sep)];

		if (details.savedTo) {
			lines.push(theme.fg("dim", details.savedTo));
		}

		return new Text(lines.join("\n"), 0, 0);
	},
});
