import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * The open SDK bridge turn as `?turn=<id>`. Opening pushes a history entry,
 * so Back closes the dialog; closing replaces it. Other params are kept.
 */
export function useSdkBridgeTurnParam() {
	const [searchParams, setSearchParams] = useSearchParams();
	const turnId = searchParams.get("turn") || null;
	const openTurn = useCallback(
		(id: string) => {
			setSearchParams((prev) => {
				const next = new URLSearchParams(prev);
				next.set("turn", id);
				return next;
			});
		},
		[setSearchParams],
	);
	const closeTurn = useCallback(() => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("turn");
				return next;
			},
			{ replace: true },
		);
	}, [setSearchParams]);
	return { turnId, openTurn, closeTurn };
}
