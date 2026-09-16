import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InfoPopover } from "./info-popover";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<>
				<input aria-label="Other field" />
				<InfoPopover label="Details">
					<p>Help content</p>
				</InfoPopover>
			</>,
		),
	);
	const trigger = host.querySelector<HTMLButtonElement>(
		'button[aria-label="Details"]',
	);
	if (!trigger) throw new Error("Missing trigger");
	return trigger;
}

async function pointer(target: Element, type: "pointerover" | "pointerout") {
	await act(async () =>
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				pointerType: "mouse",
				relatedTarget: document.body,
			}),
		),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
	});
}

async function pressEscape() {
	await act(async () =>
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
});

describe("InfoPopover interactions", () => {
	it("focuses activated content and returns focus on Escape", async () => {
		const trigger = await mount();
		trigger.focus();
		await act(async () => trigger.click());
		expect(document.activeElement).toBe(
			document.querySelector('[role="dialog"]'),
		);
		await pressEscape();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("keeps hover help open while reading and pins it on activation", async () => {
		const trigger = await mount();
		await pointer(trigger, "pointerover");
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		if (!dialog) throw new Error("Missing dialog");
		await act(async () => {
			trigger.dispatchEvent(
				new PointerEvent("pointerout", {
					bubbles: true,
					pointerType: "mouse",
					relatedTarget: document.body,
				}),
			);
			dialog.dispatchEvent(
				new PointerEvent("pointerover", {
					bubbles: true,
					pointerType: "mouse",
					relatedTarget: document.body,
				}),
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 250));
		});
		expect(document.querySelector('[role="dialog"]')).toBe(dialog);
		await act(async () => trigger.click());
		await pointer(dialog, "pointerout");
		expect(document.querySelector('[role="dialog"]')).toBe(dialog);
		await pressEscape();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("never steals another field's focus on hover dismissal after an earlier activation", async () => {
		const trigger = await mount();
		await act(async () => trigger.click());
		await pressEscape();
		const field = host?.querySelector("input");
		if (!field) throw new Error("Missing field");
		field.focus();
		await pointer(trigger, "pointerover");
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(document.activeElement).toBe(field);
		await pointer(trigger, "pointerout");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(field);
	});
});
