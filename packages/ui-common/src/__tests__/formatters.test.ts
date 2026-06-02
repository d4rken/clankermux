import { describe, expect, it } from "bun:test";
import { formatBytes } from "../formatters";

describe("formatBytes", () => {
	it("returns '0 B' for zero, negative, and undefined", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(undefined)).toBe("0 B");
	});

	it("formats raw bytes without decimals", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("formats KB / MB / GB with one decimal by default", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
		expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
	});

	it("respects a custom decimal count", () => {
		expect(formatBytes(1536, 2)).toBe("1.50 KB");
	});

	it("caps at TB for very large values", () => {
		expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB");
		// Beyond TB still reports in TB rather than an unlabeled unit.
		expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
	});
});
