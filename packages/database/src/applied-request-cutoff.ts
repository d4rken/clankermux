/**
 * The newest request-retention cutoff a cleanup pass has applied, kept in
 * `strategies` under {@link APPLIED_REQUEST_CUTOFF_KEY} as `{"cutoff": ms}`.
 *
 * A pass records it before it deletes any request row, and it only ever
 * rises. A bridged request summed over its inner rows is readable only while
 * it started at or after this cutoff as well as inside the live retention
 * window: raising retention later must not make a request readable whose
 * inner rows an earlier pass already deleted.
 */
export const APPLIED_REQUEST_CUTOFF_KEY = "cleanup:applied-request-cutoff";

/** Upsert binding (name, config JSON, updated_at); never lowers the stored cutoff. */
export const RECORD_APPLIED_REQUEST_CUTOFF_SQL = `INSERT INTO strategies (name, config, updated_at)
	VALUES (?, ?, ?)
	ON CONFLICT (name) DO UPDATE SET
		config = CASE
			WHEN json_extract(excluded.config, '$.cutoff') >
				COALESCE(json_extract(strategies.config, '$.cutoff'), 0)
			THEN excluded.config ELSE strategies.config END,
		updated_at = CASE
			WHEN json_extract(excluded.config, '$.cutoff') >
				COALESCE(json_extract(strategies.config, '$.cutoff'), 0)
			THEN excluded.updated_at ELSE strategies.updated_at END`;

/** A scalar expression: the applied cutoff, 0 before any pass applied one. */
export const APPLIED_REQUEST_CUTOFF_SQL = `COALESCE((SELECT json_extract(config, '$.cutoff')
	FROM strategies WHERE name = '${APPLIED_REQUEST_CUTOFF_KEY}'), 0)`;
