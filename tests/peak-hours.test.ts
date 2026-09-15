import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyMultiplier,
	DEFAULT_ACTIVE,
	DEFAULT_SCHEDULE,
	DEFAULT_SCHEDULES,
	describeRate,
	isPeakAt,
	matchesPattern,
	matchesSchedule,
	multiplierAt,
	NEUTRAL_SCHEDULE,
	nextTransitionAt,
	parseClock,
	parseDay,
	parseMultiplier,
	parseActive,
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
	test("defaults to DeepSeek direct plus the OpenRouter route for it", () => {
		expect(resolveSchedules({})).toEqual(DEFAULT_SCHEDULES);
		expect(scheduleFor(DEFAULT_SCHEDULES, "openrouter", "deepseek/deepseek-v4.1-flash")).toBeDefined();
	});

	test("an explicit list replaces the default and does not inherit it", () => {
		const schedules = resolveSchedules({ schedules: [{ providers: ["zai"], multiplier: 0.5 }] });

		expect(schedules).toHaveLength(1);
		const [zai] = schedules;
		expect(zai).toEqual({ ...NEUTRAL_SCHEDULE, providers: ["zai"], multiplier: 0.5 });
		// The DeepSeek windows are not smuggled into a different provider's entry.
		expect(zai?.windows).toEqual([]);
	});

	test("a flat config that names providers drops the built-in OpenRouter route", () => {
		const schedules = resolveSchedules({ providers: ["deepseek"], multiplier: 3 });

		expect(schedules).toHaveLength(1);
		expect(schedules[0]?.multiplier).toBe(3);
		expect(scheduleFor(schedules, "openrouter", "deepseek/deepseek-v4.1-flash")).toBeUndefined();
	});

	test("an empty or malformed list falls back to the flat config", () => {
		expect(resolveSchedules({ schedules: [] })).toEqual(DEFAULT_SCHEDULES);
		expect(resolveSchedules({ schedules: ["nope"] as never })).toEqual(DEFAULT_SCHEDULES);
	});

	test("a resolved schedule does not alias the exported defaults", () => {
		const schedule = resolveSchedule({});
		schedule.windows.push({ start: 0, end: 1 });
		schedule.providers.push("injected");

		expect(DEFAULT_SCHEDULE.windows).toHaveLength(2);
		expect(DEFAULT_SCHEDULE.providers).toEqual(["deepseek"]);
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

describe("nextTransitionAt", () => {
	test("lands on the edge the multiplier actually moves on", () => {
		// Every half hour across a week: the edge must be ahead of the clock, must
		// carry a different multiplier than the instant before it, and must be a real
		// change rather than a redraw.
		for (let step = 0; step < 7 * 48; step++) {
			const now = new Date(Date.UTC(2026, 8, 7) + step * 30 * 60_000);
			const before = multiplierAt(now, DEFAULT_SCHEDULE);
			const next = nextTransitionAt(now, DEFAULT_SCHEDULE);

			expect(next).toBeDefined();
			const at = next?.getTime() ?? 0;
			expect(at).toBeGreaterThan(now.getTime());
			expect(multiplierAt(new Date(at), DEFAULT_SCHEDULE)).not.toBe(before);
			expect(multiplierAt(new Date(at - 1), DEFAULT_SCHEDULE)).toBe(before);
		}
	});

	test("finds the closing edge of a window that wraps midnight", () => {
		const schedule = resolveSchedule({ windows: [["23:00", "02:00"]], days: ["fri"] });
		const at = (iso: string) => nextTransitionAt(new Date(iso), schedule)?.toISOString();

		expect(at("2026-09-11T23:30:00Z")).toBe("2026-09-12T02:00:00.000Z");
		// Saturday 01:00 is inside Friday's tail, so the tail's end is still ahead.
		expect(at("2026-09-12T01:00:00Z")).toBe("2026-09-12T02:00:00.000Z");
		// Once the tail closes, nothing moves until the next Friday.
		expect(at("2026-09-12T03:00:00Z")).toBe("2026-09-18T23:00:00.000Z");
	});

	test("prefers the window's own multiplier over the schedule's", () => {
		const schedule = resolveSchedule({
			multiplier: 2,
			outside: 1,
			windows: [{ start: "01:00", end: "04:00", multiplier: 3 }],
		});

		expect(nextTransitionAt(weekday(0, 30), schedule)?.toISOString()).toBe("2026-09-10T01:00:00.000Z");
		expect(nextTransitionAt(weekday(2), schedule)?.toISOString()).toBe("2026-09-10T04:00:00.000Z");
	});

	test("skips an edge that leaves the rate where it was", () => {
		// Window 1 wraps midnight and outranks window 2 in array order, so window 2
		// opening at 02:14 changes nothing; the rate moves when window 1 closes.
		const schedule = resolveSchedule({
			multiplier: 0.5,
			outside: 1,
			windows: [
				{ start: "18:17", end: "05:54" },
				{ start: "02:14", end: "10:19", multiplier: 2 },
			],
			days: ["wed", "thu"],
		});

		const now = new Date("2026-09-03T02:09:40Z");
		expect(multiplierAt(now, schedule)).toBe(0.5);
		expect(multiplierAt(new Date("2026-09-03T02:14:00Z"), schedule)).toBe(0.5);
		expect(nextTransitionAt(now, schedule)?.toISOString()).toBe("2026-09-03T05:54:00.000Z");
	});

	test("has nothing to transition to when the rate never moves", () => {
		expect(nextTransitionAt(weekday(2), NEUTRAL_SCHEDULE)).toBeUndefined();
		// A window costing the same as the hours around it is a no-op.
		expect(nextTransitionAt(weekday(2), resolveSchedule({ multiplier: 2, outside: 2, windows: [["01:00", "04:00"]] }))).toBeUndefined();
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

describe("parseActive", () => {
	test("accepts booleans and falls back on anything else", () => {
		expect(parseActive(true)).toBe(true);
		expect(parseActive(false)).toBe(false);
		expect(parseActive(0)).toBe(DEFAULT_ACTIVE);
		expect(parseActive("false")).toBe(DEFAULT_ACTIVE);
		expect(parseActive(undefined)).toBe(DEFAULT_ACTIVE);
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
	// pi's off-peak base for DeepSeek direct, as this user's models.json sets it.
	const cost = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
	const deepseek = { provider: "deepseek", id: "deepseek-flash", cost };
	const other = { provider: "openai-codex", id: "gpt-6-astra", cost };

	test("quotes the rate in force, prefixed when it differs from the recorded one", () => {
		expect(statusIndicator([DEFAULT_SCHEDULE], true, deepseek, weekday(2))).toBe(`· ${STATUS_PEAK} $0.3/$1.2/M`);
		expect(statusIndicator([DEFAULT_SCHEDULE], true, deepseek, weekday(5))).toBe("· $0.15/$0.6/M");
		expect(statusIndicator([DEFAULT_SCHEDULE], true, deepseek, saturday(2))).toBe("· $0.15/$0.6/M");
	});

	test("stays hidden for models no schedule covers", () => {
		expect(statusIndicator([DEFAULT_SCHEDULE], true, other, weekday(2))).toBeUndefined();
		expect(statusIndicator([DEFAULT_SCHEDULE], true, undefined, weekday(2))).toBeUndefined();
	});

	test("stays hidden when correction is off or the model has no recorded cost", () => {
		expect(statusIndicator([DEFAULT_SCHEDULE], false, deepseek, weekday(2))).toBeUndefined();
		const free = { provider: "deepseek", id: "deepseek-flash", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		expect(statusIndicator([DEFAULT_SCHEDULE], true, free, weekday(2))).toBeUndefined();
	});

	test("honors a provider-scoped override", () => {
		const schedules = [resolveSchedule({ providers: ["openrouter"], models: ["deepseek/*"] })];
		const routed = { provider: "openrouter", id: "deepseek/v4", cost };

		expect(statusIndicator(schedules, true, routed, weekday(2))).toBe(`· ${STATUS_PEAK} $0.3/$1.2/M`);
		expect(statusIndicator(schedules, true, deepseek, weekday(2))).toBeUndefined();
	});

	test("reports a discount as off-peak, not as a peak", () => {
		const schedules = resolveSchedules({
			schedules: [{ providers: ["zai"], windows: [["06:00", "10:00"]], multiplier: 1, outside: 0.5 }],
		});
		const zai = { provider: "zai", id: "glm-5.3", cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } };

		// 07:00 UTC is the window where the standard rate applies, so the rate is the
		// recorded one and only the price is shown.
		expect(statusIndicator(schedules, true, zai, weekday(7))).toBe("· $1.4/$4.4/M");
		expect(statusIndicator(schedules, true, zai, weekday(2))).toBe(`· ${STATUS_OFF_PEAK} $0.7/$2.2/M`);
		expect(statusIndicator(schedules, true, zai, saturday(2))).toBe(`· ${STATUS_OFF_PEAK} $0.7/$2.2/M`);
	});
});

describe("describeRate", () => {
	test("scales both directions and trims trailing zeros", () => {
		const cost = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };

		expect(describeRate(cost, 1)).toBe("$0.15/$0.6/M");
		expect(describeRate(cost, 2)).toBe("$0.3/$1.2/M");
		expect(describeRate(cost, 0.5)).toBe("$0.075/$0.3/M");
	});

	test("keeps precision on rates below a tenth of a cent", () => {
		const cost = { input: 0.0004, output: 0.00002, cacheRead: 0, cacheWrite: 0 };

		expect(describeRate(cost, 1)).toBe("$0.0004/$0.00002/M");
	});

	test("is empty for a model with no recorded cost", () => {
		expect(describeRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 2)).toBe("");
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
