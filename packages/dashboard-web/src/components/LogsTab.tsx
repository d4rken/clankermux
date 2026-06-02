import { Pause, Play, Trash2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { api, type LogEntry } from "../api";
import { useLogHistory } from "../hooks/queries";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

export function LogsTab() {
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [paused, setPaused] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const eventSourceRef = useRef<EventSource | null>(null);
	const logsEndRef = useRef<HTMLDivElement>(null);
	const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const [availableHeight, setAvailableHeight] = useState<number | undefined>(
		undefined,
	);

	// Size the log card to fill the remaining viewport height below its top edge,
	// so the log list uses all available vertical space and resizes with the
	// window. We only need to anchor the card's outer height; flexbox handles the
	// card header/footer chrome, and the log list (flex-1) absorbs the rest.
	// 32px matches the page wrapper's largest bottom padding (lg:p-8) so the card
	// sits flush with the viewport edge on desktop without introducing page scroll.
	useLayoutEffect(() => {
		const BOTTOM_GAP_PX = 32;
		const measure = () => {
			const card = cardRef.current;
			if (!card) return;
			// Add scrollY so the measurement is scroll-invariant: we want the
			// card's layout offset (its position with the page at scroll-top),
			// not its current viewport-relative position, which would drift if a
			// resize fires while the page happens to be scrolled.
			const top = card.getBoundingClientRect().top + window.scrollY;
			setAvailableHeight(
				Math.max(300, window.innerHeight - top - BOTTOM_GAP_PX),
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	const startStreaming = useCallback(() => {
		eventSourceRef.current = api.streamLogs((log: LogEntry) => {
			setLogs((prev) => [...prev.slice(-999), log]); // Keep last 1000 logs
			// Auto-scroll to bottom when new log arrives
			if (autoScroll && logsEndRef.current) {
				// Clear any pending scroll timeout to prevent accumulation
				if (scrollTimeoutRef.current) {
					clearTimeout(scrollTimeoutRef.current);
				}
				scrollTimeoutRef.current = setTimeout(() => {
					logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
					scrollTimeoutRef.current = null;
				}, 0);
			}
		});
	}, [autoScroll]);

	const stopStreaming = useCallback(() => {
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
		// Clear any pending scroll timeout
		if (scrollTimeoutRef.current) {
			clearTimeout(scrollTimeoutRef.current);
			scrollTimeoutRef.current = null;
		}
	}, []);

	// Load historical logs on mount
	const { data: history, isLoading: loading, error } = useLogHistory();

	useEffect(() => {
		if (history) {
			setLogs(history);
			// Auto-scroll to bottom after loading history
			if (autoScroll && logsEndRef.current) {
				// Clear any pending scroll timeout
				if (scrollTimeoutRef.current) {
					clearTimeout(scrollTimeoutRef.current);
				}
				scrollTimeoutRef.current = setTimeout(() => {
					logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
					scrollTimeoutRef.current = null;
				}, 0);
			}
		}
	}, [history, autoScroll]);

	useEffect(() => {
		if (!paused && !loading) {
			startStreaming();
		}

		return () => {
			stopStreaming();
			// Ensure scroll timeout is cleared on unmount
			if (scrollTimeoutRef.current) {
				clearTimeout(scrollTimeoutRef.current);
				scrollTimeoutRef.current = null;
			}
		};
	}, [paused, loading, startStreaming, stopStreaming]);

	useEffect(() => {
		if (autoScroll && logsEndRef.current) {
			logsEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [autoScroll]);

	const clearLogs = () => {
		setLogs([]);
	};

	const togglePause = () => {
		setPaused(!paused);
	};

	const getLogColor = (level: string | undefined) => {
		if (!level) return "";
		switch (level.toUpperCase()) {
			case "ERROR":
				return "text-destructive";
			case "WARN":
				return "text-yellow-600";
			case "INFO":
				return "text-green-600";
			case "DEBUG":
				return "text-muted-foreground";
			default:
				return "";
		}
	};

	const formatTimestamp = (ts: number) => {
		return new Date(ts).toLocaleTimeString();
	};

	return (
		<Card
			ref={cardRef}
			style={{ height: availableHeight }}
			className="flex flex-col min-h-[300px]"
		>
			<CardHeader className="shrink-0">
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Live Logs</CardTitle>
						<CardDescription>
							Real-time log stream {paused && "(Paused)"}
						</CardDescription>
					</div>
					<div className="flex gap-2">
						<Button onClick={togglePause} variant="outline" size="sm">
							{paused ? (
								<>
									<Play className="mr-2 h-4 w-4" />
									Resume
								</>
							) : (
								<>
									<Pause className="mr-2 h-4 w-4" />
									Pause
								</>
							)}
						</Button>
						<Button onClick={clearLogs} variant="outline" size="sm">
							<Trash2 className="mr-2 h-4 w-4" />
							Clear
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex flex-1 flex-col min-h-0">
				<div className="space-y-1 flex-1 min-h-0 overflow-y-auto font-mono text-sm">
					{loading ? (
						<p className="text-muted-foreground">Loading logs...</p>
					) : error ? (
						<p className="text-destructive">
							Error: {error instanceof Error ? error.message : String(error)}
						</p>
					) : logs.length === 0 ? (
						<p className="text-muted-foreground">No logs yet...</p>
					) : (
						logs.map((log, i) => (
							<div
								key={
									// biome-ignore lint/suspicious/noArrayIndexKey: append-only log buffer; LogEvent has no per-event id and ts is not unique across same-ms bursts
									`${log.ts}-${i}`
								}
								className="flex gap-2"
							>
								<span className="text-muted-foreground">
									{formatTimestamp(log.ts)}
								</span>
								<span className={`font-medium ${getLogColor(log.level)}`}>
									[{log.level || "LOG"}]
								</span>
								<span className="flex-1">{log.msg}</span>
							</div>
						))
					)}
					<div ref={logsEndRef} />
				</div>
				<div className="mt-4 flex shrink-0 items-center gap-2">
					<input
						type="checkbox"
						id="autoscroll"
						checked={autoScroll}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
							setAutoScroll((e.target as HTMLInputElement).checked)
						}
						className="rounded border-gray-300"
					/>
					<label htmlFor="autoscroll" className="text-sm text-muted-foreground">
						Auto-scroll to bottom
					</label>
				</div>
			</CardContent>
		</Card>
	);
}
