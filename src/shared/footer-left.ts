const items = new Map<string, string>();
let onChange: (() => void) | undefined;

export function setFooterLeftItem(key: string, text: string | undefined): void {
	if (text === undefined) {
		items.delete(key);
	} else {
		items.set(key, text);
	}
	onChange?.();
}

export function getFooterLeftItems(): ReadonlyMap<string, string> {
	return items;
}

export function onFooterLeftChange(cb: () => void): () => void {
	onChange = cb;
	return () => {
		if (onChange === cb) onChange = undefined;
	};
}
