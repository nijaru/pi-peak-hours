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
	NEUTRAL_SCHEDULE,
	parseClock,
	parseDay,
	parseMultiplier,
	readConfig,
	resolveSchedule,
	resolveSchedules,
	scheduleFor,
	STATUS_OFF_PEAK,
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
		expect(resolveSchedule({ multiplier: 0 }).multiplier).toBe(DEFAULT_SCHEDULE.multiplier);
		expect(resolveSchedule({ outside: Number.NaN }).outside).toBe(DEFAULT_SCHEDULE.outside);
	});

	test("accepts a discount and per-window multipliers", () => {
		const schedule = resolveSchedule({ multiplier: 0.5, outside: 1 });
		expect(schedule.multiplier).toBe(0.5);
		expect(schedule.outside).toBe(1);

		const perWindow = resolveSchedule({
			windows: [
				{ start: "22:00", end: "08:00", multiplier: 0.4 },
				{ start: "08:00", end: "22:00", multiplier: 0.8 },
			],
		});
		expect(perWindow.windows).toEqual([
			{ start: 1320, end: 480, multiplier: 0.4 },
			{ start: 480, end: 1320, multiplier: 0.8 },
		]);

		// A bad per-window multiplier falls back to the schedule's own.
		expect(resolveSchedule({ windows: [{ start: "01:00", end: "04:00", multiplier: 0 }] }).windows).toEqual(
			DEFAULT_SCHEDULE.windows,
		);
	});
});

describe("resolveSchedules", () => {
	test("defaults to the single DeepSeek schedule", () => {
		expect(resolveSchedules({})).toEqual([DEFAULT_SCHEDULE]);
	});

	test("an explicit list replaces the default and does not inherit it", () => {
		const schedules = resolveSchedules({ schedules: [{ providers: ["zai"], multiplier: 0.5 }] });

		expect(schedules).toHaveLength(1);
		const [zai] = schedules;
		expect(zai).toEqual({ ...NEUTRAL_SCHEDULE, providers: ["zai"], multiplier: 0.5 });
		// The DeepSeek windows are not smuggled into a different provider's entry.
		expect(zai?.windows).toEqual([]);
	});

	test("an empty or malformed list falls back to the flat config", () => {
		expect(resolveSchedules({ schedules: [] })).toEqual([DEFAULT_SCHEDULE]);
		expect(resolveSchedules({ schedules: ["nope"] as never })).toEqual([DEFAULT_SCHEDULE]);
	});

	test("selects the first schedule covering a provider and model", () => {
		const schedules = resolveSchedules({
			schedules: [
				{ providers: ["zai"], models: ["glm-5.3"], outside: 0.5 },
				{ providers: ["openrouter"], models: ["deepseek/*"], multiplier: 2 },
			],
		});

		expect(scheduleFor(schedules, "zai", "glm-5.3")?.outside).toBe(0.5);
		expect(scheduleFor(schedules, "openrouter", "deepseek/v4")?.multiplier).toBe(2);
		expect(scheduleFor(schedules, "deepseek", "deepseek-flash")).toBeUndefined();
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

describe("multiplierAt", () => {
	test("applies `outside` everywhere the windows do not reach", () => {
		const schedule = resolveSchedule({ multiplier: 2, outside: 1.5 });
		expect(multiplierAt(weekday(2), schedule)).toBe(2);
		expect(multiplierAt(weekday(5), schedule)).toBe(1.5);
		expect(multiplierAt(saturday(2), schedule)).toBe(1.5);
	});

	test("models a discount as a rate below 1", () => {
		// Z.ai's coding plan: standard rate during the weekday peak window, half of
		// it everywhere else. The windows are the expensive side, not the cheap one.
		const schedule = resolveSchedule({ windows: [["06:00", "10:00"]], multiplier: 1, outside: 0.5 });

		expect(multiplierAt(weekday(7), schedule)).toBe(1);
		expect(isPeakAt(weekday(7), schedule)).toBe(false);
		expect(multiplierAt(weekday(2), schedule)).toBe(0.5);
		expect(isPeakAt(weekday(2), schedule)).toBe(false);
	});

	test("prefers a window's own multiplier", () => {
		const schedule = resolveSchedule({
			multiplier: 2,
			outside: 1,
			windows: [
				{ start: "01:00", end: "04:00", multiplier: 3 },
				{ start: "06:00", end: "10:00" },
			],
		});

		expect(multiplierAt(weekday(2), schedule)).toBe(3);
		expect(multiplierAt(weekday(7), schedule)).toBe(2);
		expect(multiplierAt(weekday(5), schedule)).toBe(1);
	});
});

describe("applyMultiplier", () => {
	test("scales every rate field and recomputes total from them", () => {
		const scaled = applyMultiplier({ input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.004, total: 0.035 }, 2);

		expect(scaled).toEqual({ input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0.008, total: 0.07 });
		expect(scaled.total).toBeCloseTo(scaled.input + scaled.output + scaled.cacheRead + scaled.cacheWrite, 12);
	});

	test("scales down for a discount and still recomputes total", () => {
		const scaled = applyMultiplier({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, total: 1.506 }, 0.5);

		expect(scaled.input).toBeCloseTo(0.15, 12);
		expect(scaled.output).toBeCloseTo(0.6, 12);
		expect(scaled.cacheRead).toBeCloseTo(0.003, 12);
		expect(scaled.total).toBeCloseTo(0.753, 12);
	});

	test("is a no-op at 1x", () => {
		const cost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 };
		expect(applyMultiplier(cost, 1)).toEqual(cost);
	});
});

describe("parseMultiplier", () => {
	test("accepts any positive finite rate change", () => {
		expect(parseMultiplier(2)).toBe(2);
		expect(parseMultiplier(0.5)).toBe(0.5);
		expect(parseMultiplier(1)).toBe(1);
	});

	test("rejects zero, negatives, and non-numbers", () => {
		expect(parseMultiplier(0)).toBeUndefined();
		expect(parseMultiplier(-1)).toBeUndefined();
		expect(parseMultiplier(Number.NaN)).toBeUndefined();
		expect(parseMultiplier("2")).toBeUndefined();
		expect(parseMultiplier(undefined)).toBeUndefined();
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
		expect(statusIndicator([DEFAULT_SCHEDULE], true, deepseek, weekday(2))).toBe(`· ${STATUS_PEAK}`);
	});

	test("stays hidden for models no schedule covers", () => {
		expect(statusIndicator([DEFAULT_SCHEDULE], true, other, weekday(2))).toBeUndefined();
		expect(statusIndicator([DEFAULT_SCHEDULE], true, undefined, weekday(2))).toBeUndefined();
	});

	test("stays hidden off-peak or when correction is off", () => {
		expect(statusIndicator([DEFAULT_SCHEDULE], true, deepseek, weekday(5))).toBeUndefined();
		expect(statusIndicator([DEFAULT_SCHEDULE], true, deepseek, saturday(2))).toBeUndefined();
		expect(statusIndicator([DEFAULT_SCHEDULE], false, deepseek, weekday(2))).toBeUndefined();
	});

	test("honors a provider-scoped override", () => {
		const schedules = [resolveSchedule({ providers: ["openrouter"], models: ["deepseek/*"] })];
		expect(statusIndicator(schedules, true, { provider: "openrouter", id: "deepseek/v4" }, weekday(2))).toBe(
			`· ${STATUS_PEAK}`,
		);
		expect(statusIndicator(schedules, true, deepseek, weekday(2))).toBeUndefined();
	});

	test("reports a discount as off-peak, not as a peak", () => {
		const schedules = resolveSchedules({
			schedules: [{ providers: ["zai"], windows: [["06:00", "10:00"]], multiplier: 1, outside: 0.5 }],
		});
		const zai = { provider: "zai", id: "glm-5.3" };

		// 07:00 UTC is the peak window, where the standard rate applies.
		expect(statusIndicator(schedules, true, zai, weekday(7))).toBeUndefined();
		expect(statusIndicator(schedules, true, zai, weekday(2))).toBe(`· ${STATUS_OFF_PEAK}`);
		expect(statusIndicator(schedules, true, zai, saturday(2))).toBe(`· ${STATUS_OFF_PEAK}`);
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
