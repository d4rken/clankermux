import { Logger } from "@clankermux/logger";
import {
	envelopeFromPayloadFrame,
	type PayloadEnvelope,
} from "./payload-frame";

/**
 * Payload storage: optional zstd compression before AES-256-GCM encryption.
 *
 * Binary form (`request_payloads.payload`): one flags byte, then the body.
 * FLAG_ZSTD marks a zstd frame and FLAG_ENCRYPTED marks iv || ciphertext ||
 * authTag; with both set the ciphertext wraps the zstd frame. The innermost
 * plaintext is a payload frame (payload-frame.ts). Any other flag bit is
 * rejected.
 *
 * Legacy text form (`request_payloads.json`), read only: `zst:` +
 * base64(zstd(json)), or `enc:` + base64(iv || ciphertext || authTag) wrapping
 * either raw JSON or the compressed form.
 *
 * - The 12-byte IV is generated per-encryption with `crypto.getRandomValues`.
 * - GCM's authentication tag is appended by `crypto.subtle.encrypt`, so any
 *   tampering or wrong-key decryption fails loudly (the tag check throws).
 * - When `PAYLOAD_ENCRYPTION_KEY` is unset, payloads are stored unencrypted
 *   and unencrypted rows read as-is — this keeps existing databases readable
 *   and lets operators opt in without a migration.
 *
 * Bun Workers have isolated module scopes, so any worker that calls these
 * helpers MUST also call `initPayloadEncryption()` at module load time.
 */

const log = new Logger("PayloadEncryption");

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH_BITS = 256;
const KEY_LENGTH_BYTES = 32;
const HEX_KEY_LENGTH = KEY_LENGTH_BYTES * 2;
const ENC_PREFIX = "enc:";
const ZSTD_PREFIX = "zst:";
const FLAG_ZSTD = 0b01;
const FLAG_ENCRYPTED = 0b10;
const KNOWN_FLAGS = FLAG_ZSTD | FLAG_ENCRYPTED;
const MIN_COMPRESS_BYTES = 512;

let encryptionKey: CryptoKey | null = null;
let initPromise: Promise<boolean> | null = null;

/**
 * Initialize the payload encryption key from `PAYLOAD_ENCRYPTION_KEY`
 * (a 64-character hex string = 32 bytes = AES-256).
 *
 * Idempotent — concurrent or repeated calls share the same in-flight promise.
 * Returns `true` when encryption is enabled, `false` when no key is configured
 * or initialization failed (the function never throws).
 */
export function initPayloadEncryption(): Promise<boolean> {
	if (initPromise) return initPromise;
	initPromise = doInit();
	return initPromise;
}

async function doInit(): Promise<boolean> {
	const keyHex = process.env.PAYLOAD_ENCRYPTION_KEY;
	if (!keyHex) {
		log.info("PAYLOAD_ENCRYPTION_KEY not set — payloads stored in plaintext");
		return false;
	}

	if (keyHex.length !== HEX_KEY_LENGTH) {
		log.error(
			`PAYLOAD_ENCRYPTION_KEY must be ${HEX_KEY_LENGTH} hex chars (${KEY_LENGTH_BYTES} bytes), got ${keyHex.length}`,
		);
		return false;
	}

	let keyBytes: Uint8Array;
	try {
		keyBytes = hexToBytes(keyHex);
	} catch (err) {
		log.error("Invalid PAYLOAD_ENCRYPTION_KEY:", err);
		return false;
	}

	try {
		// Copy into a fresh ArrayBuffer to satisfy SubtleCrypto's BufferSource type
		// (rules out SharedArrayBuffer-backed views).
		const keyBuffer = new ArrayBuffer(keyBytes.length);
		new Uint8Array(keyBuffer).set(keyBytes);
		encryptionKey = await crypto.subtle.importKey(
			"raw",
			keyBuffer,
			{ name: ALGORITHM, length: KEY_LENGTH_BITS },
			false,
			["encrypt", "decrypt"],
		);
		log.info("Payload encryption enabled (AES-256-GCM)");
		return true;
	} catch (err) {
		log.error("Failed to import encryption key:", err);
		return false;
	}
}

/**
 * iv || ciphertext || authTag, or null when no key is configured. Throws if
 * the Web Crypto call fails — callers must let this propagate so a write
 * error is observable rather than silently storing plaintext.
 *
 * Awaits `initPayloadEncryption()` first so callers (especially Bun workers,
 * which have isolated module scopes) cannot accidentally skip initialization
 * and silently store plaintext when a key was set. The init promise is cached,
 * so this is a no-op after the first successful call.
 */
async function encryptBytes(
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
	await initPayloadEncryption();
	if (!encryptionKey) return null;

	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		encryptionKey,
		plaintext,
	);

	const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), IV_LENGTH);
	return combined;
}

/**
 * A stored payload could not be decrypted: no key is configured, the encrypted
 * input is truncated, or the GCM check failed (wrong key or tampering). Other
 * decode errors (zstd, frame, JSON) are plain Errors, so callers can tell a key
 * problem from a corrupt row.
 */
export class PayloadDecryptError extends Error {
	override name = "PayloadDecryptError";
}

/**
 * Reverse {@link encryptBytes}. Never silently returns cipher text — that
 * would corrupt downstream parsing; every failure is a {@link PayloadDecryptError}.
 */
async function decryptBytes(
	combined: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
	await initPayloadEncryption();
	if (!encryptionKey) {
		throw new PayloadDecryptError(
			"Encrypted payload found but PAYLOAD_ENCRYPTION_KEY is not configured",
		);
	}
	if (combined.length <= IV_LENGTH) {
		throw new PayloadDecryptError(
			"Encrypted payload is too short to contain IV + ciphertext",
		);
	}

	const iv = combined.slice(0, IV_LENGTH);
	const ciphertext = combined.slice(IV_LENGTH);
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: ALGORITHM, iv },
				encryptionKey,
				ciphertext,
			),
		);
	} catch (error) {
		throw new PayloadDecryptError(
			error instanceof Error ? error.message : String(error),
			{ cause: error },
		);
	}
}

/**
 * Produce the binary stored form of a payload frame without blocking the
 * proxy on zstd work. The result is a fresh, exactly-sized allocation.
 */
export async function encodePayloadBlob(
	frame: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	let flags = 0;
	let body = frame;
	if (frame.byteLength >= MIN_COMPRESS_BYTES) {
		try {
			// Bun schedules this on its native job pool, not the JS thread.
			const compressed = await Bun.zstdCompress(frame);
			if (compressed.byteLength < frame.byteLength) {
				body = new Uint8Array(compressed);
				flags |= FLAG_ZSTD;
			}
		} catch (error) {
			// Compression is optional; encryption is not. Its errors must still
			// propagate so the recorder drops the payload rather than exposing it.
			log.warn("Payload compression failed; storing uncompressed:", error);
		}
	}
	const encrypted = await encryptBytes(body);
	if (encrypted) {
		body = encrypted;
		flags |= FLAG_ENCRYPTED;
	}
	const blob = new Uint8Array(1 + body.byteLength);
	blob[0] = flags;
	blob.set(body, 1);
	return blob;
}

/** Decode a binary stored payload: decrypt, then decompress, then unframe. */
export async function decodePayloadBlob(
	blob: Uint8Array,
): Promise<PayloadEnvelope> {
	const flags = blob[0];
	if (flags === undefined) throw new Error("Payload blob is empty");
	if ((flags & ~KNOWN_FLAGS) !== 0) {
		throw new Error(`Payload blob has unknown flags 0x${flags.toString(16)}`);
	}
	let body: Uint8Array = blob.subarray(1);
	if (flags & FLAG_ENCRYPTED) body = await decryptBytes(body);
	if (flags & FLAG_ZSTD) body = await Bun.zstdDecompress(body);
	return envelopeFromPayloadFrame(body);
}

/**
 * Encrypt a UTF-8 string into the legacy text form. When encryption is
 * disabled, returns the input unchanged (no `enc:` prefix).
 */
export async function encryptPayload(plaintext: string): Promise<string> {
	const combined = await encryptBytes(new TextEncoder().encode(plaintext));
	if (!combined) return plaintext;
	return ENC_PREFIX + Buffer.from(combined).toString("base64");
}

/**
 * Decrypt a legacy text payload. Plaintext (no `enc:` prefix) passes through
 * so pre-encryption rows remain readable; see {@link decryptBytes} for what
 * throws.
 */
export async function decryptPayload(stored: string): Promise<string> {
	await initPayloadEncryption();
	if (!stored.startsWith(ENC_PREFIX)) return stored;
	const decrypted = await decryptBytes(
		Buffer.from(stored.slice(ENC_PREFIX.length), "base64"),
	);
	return new TextDecoder().decode(decrypted);
}

/** Decode a legacy text row: decrypt first, then decompress. */
export async function decodePayloadFromStorage(
	stored: string,
): Promise<string> {
	const decoded = await decryptPayload(stored);
	if (!decoded.startsWith(ZSTD_PREFIX)) return decoded;
	return (
		await Bun.zstdDecompress(
			Buffer.from(decoded.slice(ZSTD_PREFIX.length), "base64"),
		)
	).toString("utf8");
}

/** One `request_payloads` row as read: binary `payload`, legacy text `json`. */
export interface StoredPayloadRow {
	payload: Uint8Array | null;
	json: string | null;
}

/**
 * SQL selecting `request_payloads.payload` as written by `column`, or NULL on
 * a database the server has not migrated since the column was added. For
 * tools that open the file directly instead of through runMigrations().
 */
export function payloadColumnSql(
	db: { query(sql: string): { get(): unknown } },
	column: string,
): string {
	const exists = db
		.query(
			"SELECT 1 FROM pragma_table_info('request_payloads') WHERE name = 'payload'",
		)
		.get();
	return exists ? column : "NULL";
}

/**
 * Decode a row to its envelope object, or null when it holds no payload.
 * Decrypt, decompress and frame errors propagate; only malformed legacy JSON
 * (historical rows) reads as null.
 */
export async function decodeStoredPayload(
	row: StoredPayloadRow,
): Promise<unknown | null> {
	if (row.payload) return decodePayloadBlob(row.payload);
	if (!row.json) return null;
	const decoded = await decodePayloadFromStorage(row.json);
	try {
		return JSON.parse(decoded);
	} catch {
		return null;
	}
}

/**
 * Decode a row to envelope JSON text, or null when it holds no payload. A
 * legacy row comes back exactly as decoded, even when it is malformed JSON.
 */
export async function decodeStoredPayloadText(
	row: StoredPayloadRow,
): Promise<string | null> {
	if (row.payload) return JSON.stringify(await decodePayloadBlob(row.payload));
	if (!row.json) return null;
	return decodePayloadFromStorage(row.json);
}

/** Whether a row's stored form is encrypted, read without decrypting it. */
export function isStoredPayloadEncrypted(row: StoredPayloadRow): boolean {
	if (row.payload) return ((row.payload[0] ?? 0) & FLAG_ENCRYPTED) !== 0;
	return row.json?.startsWith(ENC_PREFIX) ?? false;
}

/** Returns true when a key has been imported and encryption is active. */
export function isEncryptionEnabled(): boolean {
	return encryptionKey !== null;
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) {
		throw new Error("Hex string must have even length");
	}
	if (!/^[0-9a-fA-F]+$/.test(hex)) {
		throw new Error("Hex string contains non-hex characters");
	}
	return new Uint8Array(Buffer.from(hex, "hex"));
}
