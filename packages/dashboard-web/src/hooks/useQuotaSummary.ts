import { useEffect, useMemo, useState } from "react";
import { dataAvailability } from "../lib/data-availability";
import { subscribePoolClock } from "../lib/pool-clock";
import { buildQuotaSummary } from "../lib/quota-summary";
import { useAccounts, useUsageScopedHistory } from "./queries";

/** Same data and clock on Overview and Usage, including retained model membership. */
export function useQuotaSummary() {
	const query = useAccounts();
	const history = useUsageScopedHistory("30d");
	const [now, setNow] = useState(Date.now);
	useEffect(() => subscribePoolClock(setNow), []);
	const rows = useMemo(
		() => buildQuotaSummary(query.data ?? [], now, history.data),
		[query.data, now, history.data],
	);
	return {
		rows,
		now,
		accounts: query.data ?? [],
		availability: dataAvailability(query, query.isLoading),
	};
}
