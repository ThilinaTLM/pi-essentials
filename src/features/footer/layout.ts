import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type FooterSegment, joinSegments, type ThemeLike } from "./format.js";

function truncateLeft(left: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	return truncateToWidth(left, width);
}

export function buildFooterLine(
	theme: ThemeLike,
	width: number,
	left: string,
	rightSegments: FooterSegment[],
	rightSeparator: string,
): string {
	const dropOrder = ["status", "cost", "tokens", "model"];
	const activeSegments = [...rightSegments];

	const getRight = () =>
		joinSegments(
			theme,
			activeSegments.map((segment) => segment.text),
			rightSeparator,
		);
	const totalWidth = (leftText: string, rightText: string) =>
		visibleWidth(leftText) +
		(leftText && rightText ? 1 : 0) +
		visibleWidth(rightText);

	let right = getRight();

	while (totalWidth(left, right) > width) {
		const droppableKey = dropOrder.find((key) =>
			activeSegments.some(
				(segment) => segment.key === key && !segment.required,
			),
		);
		if (!droppableKey) {
			break;
		}
		const index = activeSegments.findIndex(
			(segment) => segment.key === droppableKey && !segment.required,
		);
		if (index === -1) {
			break;
		}
		activeSegments.splice(index, 1);
		right = getRight();
	}

	if (!right) {
		return truncateToWidth(left, width);
	}

	const maxLeftWidth = Math.max(0, width - visibleWidth(right) - 1);
	const fittedLeft = truncateLeft(left, maxLeftWidth);

	if (totalWidth(fittedLeft, right) <= width) {
		const pad = " ".repeat(
			Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right)),
		);
		return fittedLeft + pad + right;
	}

	if (width <= visibleWidth(right)) {
		return truncateToWidth(right, width);
	}

	const fallbackLeftWidth = Math.max(
		0,
		Math.min(visibleWidth(fittedLeft), Math.floor(width * 0.35)),
	);
	const fallbackLeft = truncateLeft(fittedLeft, fallbackLeftWidth);
	const fallbackRightWidth = Math.max(
		0,
		width - visibleWidth(fallbackLeft) - (fallbackLeft ? 1 : 0),
	);
	const fallbackRight = truncateToWidth(right, fallbackRightWidth);

	if (!fallbackLeft) {
		return fallbackRight;
	}

	const pad = " ".repeat(
		Math.max(
			1,
			width - visibleWidth(fallbackLeft) - visibleWidth(fallbackRight),
		),
	);
	return fallbackLeft + pad + fallbackRight;
}
