import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface PiEssentialsSettings {
	exploreModel?: string;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "pi-essentials.json");

let cached: PiEssentialsSettings = {};

export async function loadSettings(): Promise<PiEssentialsSettings> {
	try {
		const raw = await readFile(SETTINGS_PATH, "utf-8");
		cached = JSON.parse(raw) as PiEssentialsSettings;
	} catch {
		cached = {};
	}
	return cached;
}

export async function saveSettings(
	settings: PiEssentialsSettings,
): Promise<void> {
	cached = settings;
	await mkdir(dirname(SETTINGS_PATH), { recursive: true });
	await writeFile(
		SETTINGS_PATH,
		`${JSON.stringify(settings, null, 2)}\n`,
		"utf-8",
	);
}

export function getSettings(): PiEssentialsSettings {
	return cached;
}

export async function getEnabledModels(): Promise<string[]> {
	const patterns: string[] = [];
	for (const path of [
		join(AGENT_DIR, "settings.json"),
		resolve(".pi", "settings.json"),
	]) {
		try {
			const raw = await readFile(path, "utf-8");
			const data = JSON.parse(raw);
			if (Array.isArray(data.enabledModels)) {
				patterns.push(...data.enabledModels);
			}
		} catch {
			/* missing or invalid */
		}
	}
	return patterns;
}
