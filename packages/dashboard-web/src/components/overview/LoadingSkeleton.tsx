import { Card, CardContent, CardHeader } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

export function LoadingSkeleton() {
	return (
		<div className="space-y-section">
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-group">
				{[...Array(4)].map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Skeleton cards are temporary placeholders
					<Card key={i}>
						{/* `CardContent` ships `pt-0` for headed cards, and these have
						    no header. Passing the padding explicitly is what lets
						    tailwind-merge drop that `pt-0`, without which the bars sit
						    jammed against the top border. See the Card primitive for
						    the full reasoning. */}
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
