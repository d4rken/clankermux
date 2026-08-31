import { Card, CardContent, CardHeader } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

export function LoadingSkeleton() {
	return (
		<div className="space-y-section">
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-group">
				{[...Array(4)].map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Skeleton cards are temporary placeholders
					<Card key={i}>
						{/* Numeric, like every padding that has to CANCEL a primitive's
						    own: `CardContent` ships `pt-0` for headed cards, and
						    tailwind-merge only drops it against a padding utility it
						    recognises — a scale key such as `p-section` would leave
						    `pt-0` live and jam these bars against the top border. See
						    the Card primitive for the full reasoning. */}
						<CardContent className="p-6">
							<Skeleton className="h-4 w-24 mb-item" />
							<Skeleton className="h-8 w-32 mb-item" />
							<Skeleton className="h-4 w-20" />
						</CardContent>
					</Card>
				))}
			</div>
			<Card>
				<CardHeader>
					<Skeleton className="h-6 w-32" />
				</CardHeader>
				<CardContent>
					<Skeleton className="h-64 w-full" />
				</CardContent>
			</Card>
		</div>
	);
}
