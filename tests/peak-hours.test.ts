import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyMultiplier,
	DEFAULT_SCHEDULE,
	isPeakAt,
	matchesPattern,
	matchesSchedule,
	multiplierAt,
	parseClock,
	parseDay,
	readConfig,
	resolveSchedule,
	STATUS_PEAK,
	statusIndicator,
	writeActive,
} from "../extensions/index.ts";

/** 2026-09-10 is a Thursday; 2026-09-12 is a Saturday. */
const weekday = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 10, hour, minute));
const saturday = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 12, hour, minute));

describe("parseClock", () => {
	test("accepts HH:MM and H:MM", () => {
		expect(parseClock("01:00")).toBe(60);
		expect(parseClock("1:30")).toBe(90);
		expect(parseClock("23:59")).toBe(1439);
		expect(parseClock("00:00")).toBe(0);
	});

	test("rejects malformed and out-of-range values", () => {
		expect(parseClock("24:00")).toBeUndefined();
		expect(parseClock("01:60")).toBeUndefined();
		expect(parseClock("1am")).toBeUndefined();
		expect(parseClock(60)).toBeUndefined();
	});
});

describe("parseDay", () => {
	test("accepts names, abbreviations, and numbers", () => {
		expect(parseDay("mon")).toBe(1);
		expect(parseDay("Monday")).toBe(1);
		expect(parseDay("FRI")).toBe(5);
		expect(parseDay(0)).toBe(0);
	});

	test("rejects unknown days", () => {
		expect(parseDay("funday")).toBeUndefined();
		expect(parseDay(7)).toBeUndefined();
	});
});

describe("resolveSchedule", () => {
	test("defaults to DeepSeek's published peak windows", () => {
		expect(resolveSchedule({})).toEqual(DEFAULT_SCHEDULE);
	});

	test("overlays valid fields and keeps defaults for invalid ones", () => {
		const schedule = resolveSchedule({
			multiplier: 3,
			windows: [["09:00", "12:00"]],
			days: ["sat", "sun"],
			providers: ["openrouter"],
			models: ["deepseek/*"],
		});

		expect(schedule.multiplier).toBe(3);
		expect(schedule.windows).toEqual([{ start: 540, end: 720 }]);
		expect(schedule.days).toEqual([6, 0]);
		expect(schedule.providers).toEqual(["openrouter"]);
		expect(schedule.models).toEqual(["deepseek/*"]);

		// A malformed window list falls back rather than dropping the schedule.
		expect(resolveSchedule({ windows: [["nope", "04:00"]] }).windows).toEqual(DEFAULT_SCHEDULE.windows);
		expect(resolveSchedule({ multiplier: 0.5 }).multiplier).toBe(DEFAULT_SCHEDULE.multiplier);
	});
});

describe("isPeakAt", () => {
	test("matches DeepSeek's weekday windows in UTC", () => {
		expect(isPeakAt(weekday(1), DEFAULT_SCHEDULE)).toBe(true);
		expect(isPeakAt(weekday(3, 59), DEFAULT_SCHEDULE)).toBe(true);
		expect(isPeakAt(weekday(6), DEFAULT_SCHEDULE)).toBe(true);
		expect(isPeakAt(weekday(9, 59), DEFAULT_SCHEDULE)).toBe(true);
	});

	test("treats window edges as start-inclusive and end-exclusive", () => {
		expect(isPeakAt(weekday(4), DEFAULT_SCHEDULE)).toBe(false);
		expect(isPeakAt(weekday(5, 59), DEFAULT_SCHEDULE)).toBe(false);
		expect(isPeakAt(weekday(10), DEFAULT_SCHEDULE)).toBe(false);
	});

	test("is off-peak all weekend, including inside a window", () => {
		expect(isPeakAt(saturday(2), DEFAULT_SCHEDULE)).toBe(false);
		expect(isPeakAt(saturday(9), DEFAULT_SCHEDULE)).toBe(false);
	});

	test("supports windows that cross midnight", () => {
		const schedule = resolveSchedule({ windows: [["23:00", "02:00"]], days: ["fri"] });
		expect(isPeakAt(new Date(Date.UTC(2026, 8, 11, 23, 30)), schedule)).toBe(true);
		// The tail belongs to Friday's window, even though it lands on Saturday.
		expect(isPeakAt(new Date(Date.UTC(2026, 8, 12, 1, 0)), schedule)).toBe(true);
		expect(isPeakAt(new Date(Date.UTC(2026, 8, 12, 3, 0)), schedule)).toBe(false);
		// Monday 23:30 is not Friday, so it never opens a window.
		expect(isPeakAt(new Date(Date.UTC(2026, 8, 14, 23, 30)), schedule)).toBe(false);
	});

	test("charges the listed multiplier only while peak", () => {
		expect(multiplierAt(weekday(2), DEFAULT_SCHEDULE)).toBe(2);
		expect(multiplierAt(weekday(5), DEFAULT_SCHEDULE)).toBe(1);
		expect(multiplierAt(saturday(2), DEFAULT_SCHEDULE)).toBe(1);
	});
});

describe("applyMultiplier", () => {
	test("scales every rate field and recomputes total from them", () => {
		const scaled = applyMultiplier({ input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.004, total: 0.035 }, 2);

		expect(scaled).toEqual({ input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0.008, total: 0.07 });
		expect(scaled.total).toBeCloseTo(scaled.input + scaled.output + scaled.cacheRead + scaled.cacheWrite, 12);
	});

	test("is a no-op at 1x", () => {
		const cost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 };
		expect(applyMultiplier(cost, 1)).toEqual(cost);
	});
});

describe("schedule matching", () => {
	test("matches globs and exact keys", () => {
		expect(matchesPattern("*", "deepseek-flash")).toBe(true);
		expect(matchesPattern("deepseek-*", "deepseek-flash")).toBe(true);
		expect(matchesPattern("deepseek-*", "glm-5.3-flash")).toBe(false);
		expect(matchesPattern("deepseek-flash", "deepseek-flash")).toBe(true);
		expect(matchesPattern("deepseek-flash", "deepseek-flash-0731")).toBe(false);
	});

	test("requires both provider and model to match", () => {
		expect(matchesSchedule(DEFAULT_SCHEDULE, "deepseek", "deepseek-flash")).toBe(true);
		expect(matchesSchedule(DEFAULT_SCHEDULE, "openrouter", "deepseek/deepseek-v4.1-flash")).toBe(false);
	});
});

describe("statusIndicator", () => {
	const deepseek = { provider: "deepseek", id: "deepseek-flash" };
	const other = { provider: "openai-codex", id: "gpt-6-astra" };

	test("shows peak only for a covered model inside a peak window", () => {
		expect(statusIndicator(DEFAULT_SCHEDULE, true, deepseek, weekday(2))).toBe(`· ${STATUS_PEAK}`);
	});

	test("stays hidden for models the schedule does not cover", () => {
		expect(statusIndicator(DEFAULT_SCHEDULE, true, other, weekday(2))).toBeUndefined();
		expect(statusIndicator(DEFAULT_SCHEDULE, true, undefined, weekday(2))).toBeUndefined();
	});

	test("stays hidden off-peak or when correction is off", () => {
		expect(statusIndicator(DEFAULT_SCHEDULE, true, deepseek, weekday(5))).toBeUndefined();
		expect(statusIndicator(DEFAULT_SCHEDULE, true, deepseek, saturday(2))).toBeUndefined();
		expect(statusIndicator(DEFAULT_SCHEDULE, false, deepseek, weekday(2))).toBeUndefined();
	});

	test("honors a provider-scoped override", () => {
		const schedule = resolveSchedule({ providers: ["openrouter"], models: ["deepseek/*"] });
		expect(statusIndicator(schedule, true, { provider: "openrouter", id: "deepseek/v4" }, weekday(2))).toBe(
			`· ${STATUS_PEAK}`,
		);
		expect(statusIndicator(schedule, true, deepseek, weekday(2))).toBeUndefined();
	});
});

describe("config files", () => {
	test("a missing file resolves to defaults, not a failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-peak-hours-"));
		expect(readConfig(join(dir, "absent.json"))).toEqual({});
	});

	test("an unparseable file warns and resolves to defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-peak-hours-"));
		const path = join(dir, "broken.json");
		writeFileSync(path, "{not json", "utf8");
		expect(readConfig(path)).toEqual({});
		expect(resolveSchedule(readConfig(path) ?? {})).toEqual(DEFAULT_SCHEDULE);
	});

	test("writing the toggle preserves keys this version does not model", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-peak-hours-"));
		const path = join(dir, "pi-peak-hours.json");
		writeFileSync(path, `${JSON.stringify({ active: true, multiplier: 3, future: { keep: true } })}\n`, "utf8");

		writeActive(path, false);

		const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		expect(written).toEqual({ active: false, multiplier: 3, future: { keep: true } });
	});
});
