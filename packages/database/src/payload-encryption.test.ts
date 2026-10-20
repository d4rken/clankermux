import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { buildPayloadFrame, envelopeFromPayloadFrame } from "./payload-frame";

// We deliberately re-import the module fresh per test so module-level state
// (encryptionKey, initPromise) doesn't leak between cases. The dynamic import
// + cache bust pattern is the only way to reset Bun module singletons in tests.
let modCounter = 0;
async function loadFreshModule() {
	modCounter += 1;
	// Append a query string to bust Bun's module cache.
	return await import(`./payload-encryption?fresh=${modCounter}`);
}

const VALID_HEX_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("payload encryption", () => {
	beforeEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	afterEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	it("passes through plaintext when no key is configured", async () => {
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(false);
		expect(mod.isEncryptionEnabled()).toBe(false);

		const plain = '{"hello":"world"}';
		const encrypted = await mod.encryptPayload(plain);
		expect(encrypted).toBe(plain); // pass-through
		const decrypted = await mod.decryptPayload(encrypted);
		expect(decrypted).toBe(plain);
	});

	it("round-trips a payload when a key is configured", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(true);
		expect(mod.isEncryptionEnabled()).toBe(true);

		const plain = '{"sensitive":"value","n":42}';
		const encrypted = await mod.encryptPayload(plain);
		expect(encrypted).not.toBe(plain);
		expect(encrypted.startsWith("enc:")).toBe(true);

		const decrypted = await mod.decryptPayload(encrypted);
		expect(decrypted).toBe(plain);
	});

	it("produces a different ciphertext for the same plaintext (random IV)", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		const plain = "same input";
		const a = await mod.encryptPayload(plain);
		const b = await mod.encryptPayload(plain);
		expect(a).not.toBe(b);
		expect(await mod.decryptPayload(a)).toBe(plain);
		expect(await mod.decryptPayload(b)).toBe(plain);
	});

	it("decrypts pre-encryption plaintext rows transparently", async () => {
		// Operator enables encryption AFTER having plaintext rows in the DB.
		// Those rows must remain readable.
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		const legacyRow = '{"this":"was stored before encryption was enabled"}';
		expect(await mod.decryptPayload(legacyRow)).toBe(legacyRow);
	});

	it("rejects a key with the wrong length", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = "tooshort";
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(false);
		expect(mod.isEncryptionEnabled()).toBe(false);
	});

	it("rejects a key with non-hex characters", async () => {
		// Same length as a valid key, but contains non-hex chars.
		process.env.PAYLOAD_ENCRYPTION_KEY =
			"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(false);
	});

	it("throws when an encrypted payload is read with no key configured", async () => {
		// First produce a valid encrypted payload with a key.
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const enc = await loadFreshModule();
		await enc.initPayloadEncryption();
		const ciphertext = await enc.encryptPayload('{"x":1}');
		expect(ciphertext.startsWith("enc:")).toBe(true);

		// Now load a fresh module instance with no key — must throw, not silently
		// return cipher text (which would corrupt downstream JSON.parse).
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
		const dec = await loadFreshModule();
		await dec.initPayloadEncryption();
		expect(dec.isEncryptionEnabled()).toBe(false);
		expect(dec.decryptPayload(ciphertext)).rejects.toThrow();
	});

	it("throws on tampered ciphertext (GCM auth tag check)", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		const original = await mod.encryptPayload('{"a":"b"}');
		// Flip a byte in the middle of the ciphertext payload.
		const b64 = original.slice("enc:".length);
		const bytes = Buffer.from(b64, "base64");
		bytes[bytes.length - 1] ^= 0xff;
		const tampered = `enc:${bytes.toString("base64")}`;

		expect(mod.decryptPayload(tampered)).rejects.toThrow();
	});

	it("throws on a truncated encrypted payload", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		// 12-byte IV + 0 ciphertext bytes — not even one block of GCM
		// authentication data, so reject before calling subtle.decrypt.
		const onlyIv = `enc:${Buffer.alloc(8).toString("base64")}`;
		expect(mod.decryptPayload(onlyIv)).rejects.toThrow();
	});

	for (const encrypted of [false, true]) {
		for (const compressed of [false, true]) {
			it(`decodes stored payloads (encrypted=${encrypted}, compressed=${compressed})`, async () => {
				if (encrypted) process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
				const mod = await loadFreshModule();
				const json = JSON.stringify({ text: "日本語 payload ".repeat(1000) });
				const body = compressed
					? `zst:${(await Bun.zstdCompress(json)).toString("base64")}`
					: json;
				const stored = await mod.encryptPayload(body);
				expect(await mod.decodePayloadFromStorage(stored)).toBe(json);
			});
		}
	}

	it("rejects corrupt compressed rows rather than returning undecoded text", async () => {
		const mod = await loadFreshModule();
		await expect(
			mod.decodePayloadFromStorage("zst:bm90IHpzdGQ="),
		).rejects.toThrow();
	});

	it("propagates encryption failures through the storage decoder", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const enc = await loadFreshModule();
		const stored = await enc.encryptPayload("zst:irrelevant");
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
		const dec = await loadFreshModule();
		await expect(dec.decodePayloadFromStorage(stored)).rejects.toThrow(
			"not configured",
		);
	});

	const skeleton = JSON.stringify({
		request: { headers: { "x-k": "日本語" }, body: null },
		response: { status: 200, headers: {}, body: null },
		meta: { accountId: "acc" },
	});
	const bigFrame = () =>
		buildPayloadFrame(
			skeleton,
			new TextEncoder().encode("日本語 message ".repeat(10_000)),
			[new TextEncoder().encode("data: done\n\n")],
		);

	for (const encrypted of [false, true]) {
		it(`blob: compresses before optional encryption (encrypted=${encrypted})`, async () => {
			if (encrypted) process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
			const mod = await loadFreshModule();
			const frame = bigFrame();
			const blob = await mod.encodePayloadBlob(frame);
			expect(blob[0]).toBe(encrypted ? 0b11 : 0b01);
			expect(blob.byteLength).toBeLessThan(frame.byteLength);
			expect(blob.byteOffset).toBe(0);
			expect(blob.buffer.byteLength).toBe(blob.byteLength);
			expect(mod.isStoredPayloadEncrypted({ payload: blob, json: "" })).toBe(
				encrypted,
			);
			expect(await mod.decodePayloadBlob(blob)).toEqual(
				envelopeFromPayloadFrame(frame),
			);
		});
	}

	it("blob: skips frames below 512 bytes without calling zstd", async () => {
		const mod = await loadFreshModule();
		const compress = spyOn(Bun, "zstdCompress");
		try {
			const frame = buildPayloadFrame(skeleton, null, []);
			expect(frame.byteLength).toBeLessThan(512);
			const blob = await mod.encodePayloadBlob(frame);
			expect(blob[0]).toBe(0);
			expect(blob.subarray(1)).toEqual(frame);
			expect(compress).not.toHaveBeenCalled();
		} finally {
			compress.mockRestore();
		}
	});

	it("blob: keeps incompressible frames uncompressed", async () => {
		const mod = await loadFreshModule();
		const frame = buildPayloadFrame(skeleton, randomBytes(2048), []);
		const blob = await mod.encodePayloadBlob(frame);
		expect(blob[0]).toBe(0);
		expect(blob.byteLength).toBe(frame.byteLength + 1);
	});

	it("blob: falls back to uncompressed encryption if compression fails", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		const compress = spyOn(Bun, "zstdCompress").mockRejectedValue(
			new Error("compression unavailable"),
		);
		try {
			const frame = bigFrame();
			const blob = await mod.encodePayloadBlob(frame);
			expect(blob[0]).toBe(0b10);
			expect(await mod.decodePayloadBlob(blob)).toEqual(
				envelopeFromPayloadFrame(frame),
			);
		} finally {
			compress.mockRestore();
		}
	});

	it("blob: does not swallow encryption errors after successful compression", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();
		const encrypt = spyOn(crypto.subtle, "encrypt").mockRejectedValue(
			new Error("encrypt failed"),
		);
		try {
			await expect(mod.encodePayloadBlob(bigFrame())).rejects.toThrow(
				"encrypt failed",
			);
		} finally {
			encrypt.mockRestore();
		}
	});

	it("blob: reading an encrypted blob without a key throws", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const enc = await loadFreshModule();
		const blob = await enc.encodePayloadBlob(bigFrame());
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
		const dec = await loadFreshModule();
		await expect(dec.decodePayloadBlob(blob)).rejects.toThrow("not configured");
	});

	it("blob: rejects tampering, unknown flags and an empty blob", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		const blob = await mod.encodePayloadBlob(bigFrame());
		const tampered = blob.slice();
		tampered[tampered.length - 1] ^= 0xff;
		await expect(mod.decodePayloadBlob(tampered)).rejects.toThrow();

		const unknown = blob.slice();
		unknown[0] |= 0b100;
		await expect(mod.decodePayloadBlob(unknown)).rejects.toThrow(
			"unknown flags",
		);
		await expect(mod.decodePayloadBlob(new Uint8Array(0))).rejects.toThrow(
			"empty",
		);
	});

	it("blob: key and GCM failures are PayloadDecryptError, corrupt rows are not", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		const blob = await mod.encodePayloadBlob(bigFrame());
		const tampered = blob.slice();
		tampered[tampered.length - 1] ^= 0xff;
		const gcm = await mod.decodePayloadBlob(tampered).catch((e: unknown) => e);
		expect(gcm).toBeInstanceOf(mod.PayloadDecryptError);
		expect((gcm as Error).cause).toBeDefined();
		const short = await mod
			.decodePayloadBlob(Uint8Array.of(0b10, 1, 2, 3))
			.catch((e: unknown) => e);
		expect(short).toBeInstanceOf(mod.PayloadDecryptError);

		for (const corrupt of [Uint8Array.of(0b01, 1, 2, 3), Uint8Array.of(0, 1)]) {
			const error = await mod
				.decodePayloadBlob(corrupt)
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(mod.PayloadDecryptError);
		}

		delete process.env.PAYLOAD_ENCRYPTION_KEY;
		const keyless = await loadFreshModule();
		const missingKey = await keyless
			.decodePayloadBlob(blob)
			.catch((e: unknown) => e);
		expect(missingKey).toBeInstanceOf(keyless.PayloadDecryptError);
	});

	describe("stored rows", () => {
		const legacyJson = JSON.stringify({
			request: { headers: {}, body: "aGk=" },
			response: { status: 200, headers: {}, body: null },
		});

		it("prefers the blob and rebuilds the envelope object and text", async () => {
			const mod = await loadFreshModule();
			const frame = buildPayloadFrame(
				skeleton,
				new TextEncoder().encode("hi"),
				[],
			);
			const row = { payload: await mod.encodePayloadBlob(frame), json: "" };
			const envelope = envelopeFromPayloadFrame(frame);
			expect(await mod.decodeStoredPayload(row)).toEqual(envelope);
			expect(await mod.decodeStoredPayloadText(row)).toBe(
				JSON.stringify(envelope),
			);
		});

		it("falls back to the legacy text form", async () => {
			const mod = await loadFreshModule();
			const compressed = `zst:${(await Bun.zstdCompress(legacyJson)).toString("base64")}`;
			const row = { payload: null, json: compressed };
			expect(await mod.decodeStoredPayload(row)).toEqual(
				JSON.parse(legacyJson),
			);
			expect(await mod.decodeStoredPayloadText(row)).toBe(legacyJson);
		});

		it("reads absent payloads as null and malformed legacy JSON as null or raw text", async () => {
			const mod = await loadFreshModule();
			expect(await mod.decodeStoredPayload({ payload: null, json: "" })).toBe(
				null,
			);
			expect(
				await mod.decodeStoredPayloadText({ payload: null, json: null }),
			).toBe(null);
			const malformed = { payload: null, json: "{not json" };
			expect(await mod.decodeStoredPayload(malformed)).toBe(null);
			expect(await mod.decodeStoredPayloadText(malformed)).toBe("{not json");
		});

		it("does not treat a corrupt blob as malformed legacy JSON", async () => {
			const mod = await loadFreshModule();
			const row = { payload: Uint8Array.of(0, 1, 2), json: legacyJson };
			await expect(mod.decodeStoredPayload(row)).rejects.toThrow();
			await expect(mod.decodeStoredPayloadText(row)).rejects.toThrow();
		});

		it("detects encryption on legacy rows", async () => {
			const mod = await loadFreshModule();
			expect(
				mod.isStoredPayloadEncrypted({ payload: null, json: "enc:abc" }),
			).toBe(true);
			expect(
				mod.isStoredPayloadEncrypted({ payload: null, json: legacyJson }),
			).toBe(false);
		});
	});

	it("init is idempotent — concurrent calls share the same promise", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();

		const [a, b, c] = await Promise.all([
			mod.initPayloadEncryption(),
			mod.initPayloadEncryption(),
			mod.initPayloadEncryption(),
		]);
		expect(a).toBe(true);
		expect(b).toBe(true);
		expect(c).toBe(true);
		expect(mod.isEncryptionEnabled()).toBe(true);
	});
});
