import * as React from "react";

import { cn } from "../../lib/utils";

type AlertTone = "info" | "success" | "warning" | "destructive";

const TONE: Record<AlertTone, string> = {
	info: "bg-info/10 border-info/25",
	success: "bg-success/10 border-success/25",
	warning: "bg-warning/10 border-warning/25",
	destructive: "bg-destructive/10 border-destructive/25",
};

// Icon colour is the TEXT hue (`-strong`), never the fill hue: on a /10 tint over a
// card, `--info`/`--success` are fill values and fail as foreground. `info` maps to
// `text-foreground` because no info call site carries an icon today — when one does,
// that is the moment to add `--info-strong` WITH a consumer, not before.
const ICON_TONE: Record<AlertTone, string> = {
	info: "text-foreground",
	success: "text-success-strong",
	warning: "text-warning-strong",
	destructive: "text-destructive-strong",
};

type AlertSize = "sm" | "md";

const SIZE: Record<AlertSize, { root: string; title: string; body: string }> = {
	// The eight inline device-flow callouts in AccountAddForm: hints beside a form field.
	sm: {
		root: "p-row",
		title: "text-sm",
		body: "mt-item text-xs text-muted-foreground",
	},
	// The delete confirmation: a modal warning before permanent removal. Matches what
	// that box renders today, so this change does not quieten it.
	md: {
		root: "p-group",
		title: "text-base",
		body: "mt-item text-sm text-foreground",
	},
};

// `title` is omitted from the div props and redeclared: the DOM attribute of
// that name is a tooltip string, and this one is the rendered heading.
interface AlertProps
	extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
	tone?: AlertTone;
	size?: AlertSize;
	title: React.ReactNode;
	icon?: React.ReactNode;
	/**
	 * A control that belongs beside the title rather than in the body — the
	 * "Show more"/"Show less" toggles on the three conversation blocks.
	 *
	 * Passing one switches the header to a `justify-between` row. Omitting one
	 * MUST leave the header byte-identical to what every existing call site
	 * renders today, which is why this is a branch and not an unconditional
	 * wrapper (alert.test.tsx pins both shapes with full-string equality).
	 */
	action?: React.ReactNode;
}

/**
 * A tinted callout box: a title row, optionally an icon, and an optional body.
 *
 * Nine of these were hand-rolled across the account flows in six variants that
 * had drifted apart on padding and border opacity. Border opacity unifies at
 * `/25`, the eight-instance majority.
 *
 * The body is `children`, not a string, and the `space-y-item` on its wrapper is
 * load-bearing: four call sites embed a device-code chip, a link row or a "Try
 * again" button rather than a paragraph, and the size's body classes set type
 * and top offset but separate nothing within the body. Embedded elements keep
 * their own classes; the wrapper supplies only rhythm and the default body type.
 *
 * Titles stay `text-foreground` in every tone, destructive included. One rule
 * beats a conditional, titles keep maximum legibility, and the tone is carried
 * unmistakably by the tint, the border and the icon.
 */
const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
	(
		{
			tone = "info",
			size = "sm",
			title,
			icon,
			action,
			className,
			children,
			...props
		},
		ref,
	) => {
		const sizing = SIZE[size];
		const iconNode = icon ? (
			<span className={cn("flex shrink-0", ICON_TONE[tone])}>{icon}</span>
		) : null;
		const titleNode = (
			<p className={cn(sizing.title, "font-medium text-foreground")}>{title}</p>
		);
		return (
			<div
				ref={ref}
				className={cn("rounded-lg border", sizing.root, TONE[tone], className)}
				{...props}
			>
				{action == null ? (
					<div className="flex items-center gap-item">
						{iconNode}
						{titleNode}
					</div>
				) : (
					<div className="flex items-center justify-between gap-item">
						<div className="flex min-w-0 flex-1 items-center gap-item">
							{iconNode}
							{titleNode}
						</div>
						<span className="shrink-0">{action}</span>
					</div>
				)}
				{children ? (
					<div className={cn(sizing.body, "space-y-item")}>{children}</div>
				) : null}
			</div>
		);
	},
);
Alert.displayName = "Alert";

export type { AlertSize, AlertTone };
export { Alert };
