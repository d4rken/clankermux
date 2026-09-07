import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useMemo } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AccountsTab } from "./components/AccountsTab";
import { ApiKeysTab } from "./components/ApiKeysTab";
import { AuthGate } from "./components/AuthGate";
import { CombosTab } from "./components/combos/CombosTab";
import { DebugPanel } from "./components/DebugPanel";
import { LogsTab } from "./components/LogsTab";
import { ModelsTab } from "./components/ModelsTab";
import { Navigation } from "./components/navigation";
import { OverviewTab } from "./components/OverviewTab";
import { RequestEventProvider } from "./components/RequestEventProvider";
import { RequestsTab } from "./components/RequestsTab";
import { SettingsTab } from "./components/SettingsTab";
import { SystemTab } from "./components/SystemTab";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { ThemeProvider } from "./contexts/theme-context";
import "./index.css";

// Lazy load heavy components for better bundle splitting
const LazyAnalyticsTab = lazy(() =>
	import("./components/LazyAnalytics").then((module) => ({
		default: module.LazyAnalytics,
	})),
);
const LazyLimitsTab = lazy(() =>
	import("./components/LazyLimits").then((module) => ({
		default: module.LazyLimits,
	})),
);
const LoadingSkeleton = () => (
	<div className="space-y-section p-6">
		<div className="animate-pulse">
			<div className="h-8 bg-muted rounded w-32 mb-4"></div>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-group">
				{Array.from({ length: 4 }, (_, i) => `skeleton-card-${i}`).map(
					(key) => (
						<div key={key} className="h-24 bg-muted rounded" />
					),
				)}
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-section">
				{Array.from({ length: 2 }, (_, i) => `skeleton-chart-${i}`).map(
					(key) => (
						<div key={key} className="h-64 bg-muted rounded" />
					),
				)}
			</div>
		</div>
	</div>
);

export function App() {
	const location = useLocation();

	const routes = useMemo(() => {
		return [
			{
				path: "/",
				element: <OverviewTab />,
				title: "Overview",
			},
			{
				path: "/analytics",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyAnalyticsTab />
					</Suspense>
				),
				title: "Analytics",
			},
			{
				path: "/limits",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyLimitsTab />
					</Suspense>
				),
				title: "Usage",
			},
			{
				path: "/requests",
				element: <RequestsTab />,
				title: "Requests",
			},
			{
				path: "/accounts",
				element: <AccountsTab />,
				title: "Accounts",
			},
			{
				path: "/combos",
				element: <CombosTab />,
				title: "Routing Chains",
			},
			{
				path: "/api-keys",
				element: <ApiKeysTab />,
				title: "API Keys",
			},
			{
				path: "/models",
				element: <ModelsTab />,
				title: "Models",
			},
			{
				path: "/logs",
				element: <LogsTab />,
				title: "Logs",
			},
			{
				path: "/system",
				element: <SystemTab />,
				title: "System",
			},
			{
				path: "/settings",
				element: <SettingsTab />,
				title: "Settings",
			},
		];
	}, []);

	const currentRoute =
		routes.find((route) => route.path === location.pathname) || routes[0];

	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchInterval: REFRESH_INTERVALS.default,
						staleTime: QUERY_CONFIG.staleTime,
						retry: (failureCount) => failureCount < 2,
					},
					mutations: {
						retry: false,
					},
				},
			}),
		[],
	);

	return (
		<QueryClientProvider client={queryClient}>
			{/* ThemeProvider wraps the gate, not the other way round: the login
			    screen is a full page and has to be themed like every other one. */}
			<ThemeProvider>
				{/* The management login. OUTSIDE RequestEventProvider on purpose —
				    that provider opens /api/requests/stream and fires a protected
				    backfill query on mount, so a gate inside it would have made both
				    calls before deciding the browser is signed out. */}
				<AuthGate>
					{/* Owns the single request-stream connection. Mounted ABOVE <Routes>
					    so it survives navigation: Overview and Requests are mutually
					    exclusive routes, and a per-page connection would leave a hole in
					    the live view on every page change. */}
					<RequestEventProvider>
						<div className="min-h-screen bg-background">
							<Navigation />

							{/* Main Content */}
							<main className="lg:pl-48">
								{/* Mobile spacer */}
								<div className="h-16 lg:hidden" />

								{/* Page Content */}
								<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
									{/* One line, not three. The title used to be a gradient-filled
								    3xl over a subtitle that restated it, and Overview then
								    printed its own name a third time immediately below. The
								    title now matches the sidebar label exactly, so a page has
								    one name instead of three. */}
									<div className="mb-6 border-b pb-3">
										<h1 className="page-title">{currentRoute.title}</h1>
									</div>

									{/* No enter animation: a fade on every navigation is a delay
								    between clicking and reading. */}
									<div>
										<Routes>
											{routes.map((route) => (
												<Route
													key={route.path}
													path={route.path}
													element={route.element}
												/>
											))}
											<Route path="*" element={<Navigate to="/" replace />} />
										</Routes>
									</div>
								</div>
							</main>
						</div>
						<DebugPanel />
					</RequestEventProvider>
				</AuthGate>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
