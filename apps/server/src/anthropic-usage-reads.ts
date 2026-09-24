import type { AnthropicUsageReadRow } from "@clankermux/database";
import type { Logger } from "@clankermux/logger";
import type {
	AnthropicUsageReadStore,
	UsageData,
	usageCache,
} from "@clankermux/providers";

interface ReadRows {
	getAnthropicUsageReads(): Promise<AnthropicUsageReadRow[]>;
	recordAnthropicUsageReadAt(accountId: string, at: number): Promise<void>;
	recordAnthropicUsageReading(
		accountId: string,
		reading: string,
		observedAt: number,
	): Promise<void>;
}

type Cache = Pick<
	typeof usageCache,
	"restoreAnthropicUsageRead" | "setAnthropicUsageReadStore"
>;

/**
 * Hand the usage cache what the last process knew, then persist every read
 * and reading from now on. Must run before the first Anthropic usage read.
 */
export async function restoreAnthropicUsageReads(
	db: ReadRows,
	cache: Cache,
	log: Pick<Logger, "info" | "warn">,
): Promise<void> {
	let rows: AnthropicUsageReadRow[] = [];
	try {
		rows = await db.getAnthropicUsageReads();
	} catch (error) {
		log.warn(`Could not load the last Anthropic usage reads: ${error}`);
	}
	for (const row of rows) {
		cache.restoreAnthropicUsageRead(row.accountId, {
			lastReadAt: row.lastReadAt,
			reading: parseReading(row.reading),
			readingObservedAt: row.readingObservedAt,
		});
	}
	if (rows.length > 0)
		log.info(
			`Restored the last usage read of ${rows.length} Anthropic account(s)`,
		);
	cache.setAnthropicUsageReadStore(anthropicUsageReadStore(db, log));
}

function parseReading(json: string | null): UsageData | null {
	if (json === null) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		return parsed && typeof parsed === "object" ? (parsed as UsageData) : null;
	} catch {
		return null;
	}
}

function anthropicUsageReadStore(
	db: ReadRows,
	log: Pick<Logger, "warn">,
): AnthropicUsageReadStore {
	return {
		recordReadAt: (accountId, at) => {
			db.recordAnthropicUsageReadAt(accountId, at).catch((error) =>
				log.warn(`Could not persist the usage read of ${accountId}: ${error}`),
			);
		},
		recordReading: (accountId, data, observedAt) => {
			db.recordAnthropicUsageReading(
				accountId,
				JSON.stringify(data),
				observedAt,
			).catch((error) =>
				log.warn(
					`Could not persist the usage reading of ${accountId}: ${error}`,
				),
			);
		},
	};
}
