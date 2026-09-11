import type { ReactNode } from "react";

/** Shared heading and instruction rhythm for provider authentication steps. */
export function AccountSetupSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-item">
			<h5 className="text-sm font-medium">{title}</h5>
			<div className="flex min-w-0 flex-col gap-row text-sm leading-relaxed text-muted-foreground">
				{children}
			</div>
		</div>
	);
}
