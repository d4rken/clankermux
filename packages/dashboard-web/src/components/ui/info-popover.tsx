import { Info } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** Hover help that also opens with a click, tap, or keyboard activation. */
export function InfoPopover({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const content = useRef<HTMLDivElement>(null);
	const pinned = useRef(false);
	const restoreFocus = useRef(false);
	const changeOpen = (next: boolean) => {
		if (openTimer.current) clearTimeout(openTimer.current);
		restoreFocus.current =
			content.current?.contains(document.activeElement) ?? false;
		pinned.current = next;
		setOpen(next);
	};
	const cancelClose = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
	};
	useEffect(
		() => () => {
			if (openTimer.current) clearTimeout(openTimer.current);
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);
	const scheduleClose = () => {
		if (openTimer.current) clearTimeout(openTimer.current);
		cancelClose();
		// Allow the pointer to cross the gap into the portalled content.
		closeTimer.current = setTimeout(() => {
			if (
				!pinned.current &&
				!content.current?.contains(document.activeElement)
			) {
				restoreFocus.current = false;
				setOpen(false);
			}
		}, 200);
	};
	return (
		<Popover open={open} onOpenChange={changeOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0 text-muted-foreground"
					aria-label={label}
					onClick={(event) => {
						if (openTimer.current) clearTimeout(openTimer.current);
						if (open && !pinned.current) {
							event.preventDefault();
							pinned.current = true;
							content.current?.focus({ preventScroll: true });
						}
					}}
					onPointerEnter={(event) => {
						if (event.pointerType !== "mouse") return;
						cancelClose();
						if (openTimer.current) clearTimeout(openTimer.current);
						if (open) return;
						openTimer.current = setTimeout(() => {
							restoreFocus.current = false;
							setOpen(true);
						}, 200);
					}}
					onPointerLeave={(event) => {
						if (event.pointerType === "mouse") scheduleClose();
					}}
				>
					<Info aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				ref={content}
				align="end"
				collisionPadding={16}
				aria-label={label}
				className="w-96 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto space-y-item text-sm"
				onPointerEnter={cancelClose}
				onPointerLeave={(event) => {
					if (event.pointerType === "mouse") scheduleClose();
				}}
				onOpenAutoFocus={(event) => {
					if (!pinned.current) event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					if (!restoreFocus.current) event.preventDefault();
				}}
			>
				<p className="font-medium">{label}</p>
				<div className="space-y-item text-muted-foreground">{children}</div>
			</PopoverContent>
		</Popover>
	);
}
