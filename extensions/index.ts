/**
 * pi-peak-hours — correct recorded cost for providers that bill by time of day.
 *
 * DeepSeek is the clearest example: a 2x multiplier applies during peak windows
 * (01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, as of September 2026) and the
 * off-peak rate is half of it. pi has no notion of time-of-day pricing —
 * `usage.cost` is computed once from the model's flat rates when usage is
 * finalized — so a session is over- or understated by up to 2x, in whichever
 * direction the recorded rate sits from the billed one.
 *
 * This extension rewrites `usage.cost` on the finalized assistant message in
 * `message_end`, the documented hook for replacing a message. The footer
 * recomputes session totals from persisted entries on every render, so the
 * corrected number appears in the footer, the per-model breakdown, and the
 * HTML export without further plumbing.
 *
 * The footer indicator is scoped to the selected model and quotes the rate that
 * applies to it right now, in dollars per million tokens: `· ▲ peak
 * $0.30/$1.20/M` at peak, `· $0.15/$0.60/M` off it. The rate is the one pi
 * recorded scaled by the schedule, so it always agrees with the cost this
 * extension writes. A session on a provider or model no schedule covers never
 * shows a rate, and switching models re-evaluates it.
 *
 * The indicator is a snapshot of the current hour, and pi fires no event while a
 * session sits idle — so a timer armed at the next window boundary keeps it from
 * quoting a rate that has already expired. See `arm`.
 *
 * Schedules are provider-scoped and there can be several, because the shape of
 * the correction differs: DeepSeek's list price is its off-peak rate, so peak is
 * a surcharge (×2), while Z.ai's coding plan and Alibaba's night discount are
 * priced the other way round and land below the recorded rate. A multiplier
 * above 1 reads as `peak`, below 1 as `off-peak`, and the footer names the
 * direction so a discount is never reported as a peak.
 *
 * Design constraints:
 *
 * - The rate is chosen from the request's START time, not its end. DeepSeek
 *   bills by when a request arrives, so a request spanning a window boundary
 *   would otherwise be billed on the wrong side of it. `message_start` gives
 *   the start; `message_end` gives the end.
 * - A schedule declares the multiplier INSIDE its windows and `outside` for
 *   every other hour. Which side pi's recorded rate sits on is not assumed:
 *   encode it in the config, and only the difference is applied. pi's own
 *   catalog disagrees with itself here — it lists DeepSeek direct at peak rates
 *   and the same model through OpenRouter at off-peak rates — so a schedule that
 *   guesses would double-charge one of them.
 * - A message is never scaled twice. Retries and overflow recovery can deliver
 *   the same message object again, so adjustments are guarded by identity.
 * - Only the four cost fields are touched, and `total` is recomputed from
 *   them, preserving pi's own invariant. Token counts are real and never
 *   modified, so any rate derived from cost/tokens stays self-consistent
 *   (cache-miss accounting derives paid and read rates from the same message
 *   and scales with it).
 * - Unknown or malformed configuration leaves the extension inert after a
 *   single warning; it never throws inside a message handler.
 *
 * Coverage limit: assistant messages carry the bulk of a session's spend.
 * Compaction and branch-summary usage and token usage reported by tools also
 * feed footer totals, but pi exposes no hook that can adjust them afterwards,
 * so those stay at list rates and the footer stays an estimate, not an invoice.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATUS_KEY = "peak-hours";
/**
 * Status text is deliberately generic: the footer already carries the session
 * cost, and the multiplier differs per service. Detail lives in
 * `/peak-hours status`, which names the schedule and the rate in force.
 */
export const STATUS_PEAK = "▲ peak";
/** Shown when the rate in force is below the recorded one, e.g. an off-peak discount. */
export const STATUS_OFF_PEAK = "▼ off-peak";
/** Rates are quoted per million tokens, like every provider rate card. */
export const RATE_UNIT = "/M";
export const COMMAND_PEAK_HOURS = "peak-hours";
export const CONFIG_BASENAME = "pi-peak-hours.json";
export const CONFIG_PATH = join(getAgentDir(), "extensions", CONFIG_BASENAME);

/** Minutes from UTC midnight; `end` is exclusive. */
export interface ClockWindow {
	start: number;
	end: number;
	/** Overrides the schedule multiplier inside this window. */
	multiplier?: number;
}

/**
 * The rate in force inside `windows` versus `outside` them. Either side may be
 * the cheaper one: above 1 is a surcharge, below 1 a discount.
 */
export interface Schedule {
	multiplier: number;
	outside: number;
	windows: ClockWindow[];
	/** 0 = Sunday, matching Date#getUTCDay. */
	days: number[];
	providers: string[];
	models: string[];
}

/** Everything a single schedule accepts. */
export interface ScheduleConfig {
	multiplier?: number;
	outside?: number;
	windows?: (readonly [string, string] | { start: string; end: string; multiplier?: number })[];
	days?: (string | number)[];
	providers?: string[];
	models?: string[];
}

export interface ConfigFile extends ScheduleConfig {
	active?: boolean;
	/** Provider-scoped schedules, each resolved on its own rather than over the DeepSeek default. */
	schedules?: ScheduleConfig[];
}

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** DeepSeek's published schedule: peak mornings on UTC weekdays, everything else off-peak. */
export const DEFAULT_SCHEDULE: Schedule = {
	multiplier: 2,
	outside: 1,
	windows: [
		{ start: 60, end: 240 },
		{ start: 360, end: 600 },
	],
	days: [1, 2, 3, 4, 5],
	providers: ["deepseek"],
	models: ["*"],
};

/**
 * The same model resold by OpenRouter, which pi's catalog rates at the off-peak
 * price while its own `deepseek` provider is rated at peak. Without this the
 * route silently keeps pi's flat rate.
 */
export const OPENROUTER_SCHEDULE: Schedule = {
	multiplier: 2,
	outside: 1,
	windows: [
		{ start: 60, end: 240 },
		{ start: 360, end: 600 },
	],
	days: [1, 2, 3, 4, 5],
	providers: ["openrouter"],
	models: ["deepseek/*"],
};

/** What a config that says nothing about schedules resolves to. */
export const DEFAULT_SCHEDULES: Schedule[] = [DEFAULT_SCHEDULE, OPENROUTER_SCHEDULE];

/**
 * Base for schedules listed explicitly in `schedules`: no windows, no
 * correction, every provider and model. An entry supplies its own shape rather
 * than inheriting DeepSeek's, which would be a surprising default for a
 * different service.
 */
export const NEUTRAL_SCHEDULE: Schedule = {
	multiplier: 1,
	outside: 1,
	windows: [],
	days: [0, 1, 2, 3, 4, 5, 6],
	providers: ["*"],
	models: ["*"],
};

export const DEFAULT_ACTIVE = true;

/**
 * Only an explicit boolean is a toggle. A malformed `active` falls back like
 * every other field, so a typo disables nothing silently.
 */
export function parseActive(value: unknown): boolean {
	return typeof value === "boolean" ? value : DEFAULT_ACTIVE;
}

/** "HH:MM" in UTC to minutes from midnight, or undefined when unparseable. */
export function parseClock(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return undefined;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return undefined;
	return hours * 60 + minutes;
}

export function parseDay(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) return value;
	if (typeof value === "string") {
		const index = DAY_NAMES.indexOf(value.trim().toLowerCase().slice(0, 3) as (typeof DAY_NAMES)[number]);
		if (index >= 0) return index;
	}
	return undefined;
}

function parseWindows(value: unknown): ClockWindow[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const windows: ClockWindow[] = [];
	for (const entry of value) {
		let start: unknown;
		let end: unknown;
		let multiplier: unknown;
		if (Array.isArray(entry) && entry.length === 2) {
			[start, end] = entry;
		} else if (isRecord(entry)) {
			start = entry.start;
			end = entry.end;
			multiplier = entry.multiplier;
		} else {
			return undefined;
		}
		const startMinutes = parseClock(start);
		const endMinutes = parseClock(end);
		if (startMinutes === undefined || endMinutes === undefined || startMinutes === endMinutes) return undefined;
		const window: ClockWindow = { start: startMinutes, end: endMinutes };
		if (multiplier !== undefined) {
			const parsed = parseMultiplier(multiplier);
			if (parsed === undefined) return undefined;
			window.multiplier = parsed;
		}
		windows.push(window);
	}
	return windows;
}

/** A positive finite multiplier: above 1 for a surcharge, below 1 for a discount. */
export function parseMultiplier(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

function parseStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
	return items.length === value.length ? items.map((item) => item.trim()) : undefined;
}

/** Overlay a parsed config onto `base`. Invalid fields keep the base value. */
export function resolveSchedule(config: ScheduleConfig, base: Schedule = DEFAULT_SCHEDULE): Schedule {
	return {
		multiplier: parseMultiplier(config.multiplier) ?? base.multiplier,
		outside: parseMultiplier(config.outside) ?? base.outside,
		// Copied, so a resolved schedule never aliases an exported default.
		windows: parseWindows(config.windows) ?? base.windows.map((window) => ({ ...window })),
		days: parseDays(config.days) ?? [...base.days],
		providers: parseStringList(config.providers) ?? [...base.providers],
		models: parseStringList(config.models) ?? [...base.models],
	};
}

/** Day names or numbers, or undefined when the list is absent or partly invalid. */
function parseDays(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const days = value.map(parseDay);
	return days.every((day): day is number => day !== undefined) ? days : undefined;
}

/**
 * Every schedule the config describes. An explicit `schedules` list replaces the
 * built-in schedules; a flat config overlays the DeepSeek one and drops the
 * built-in OpenRouter route once it names its own providers.
 */
export function resolveSchedules(config: ConfigFile): Schedule[] {
	if (Array.isArray(config.schedules)) {
		const entries = config.schedules.filter(isRecord).map((entry) => resolveSchedule(entry, NEUTRAL_SCHEDULE));
		if (entries.length > 0) return entries;
	}
	const schedule = resolveSchedule(config);
	return config.providers === undefined ? [schedule, OPENROUTER_SCHEDULE] : [schedule];
}

/** Whether a window covers the given instant, including windows that wrap midnight. */
function windowCovers(window: ClockWindow, startedAt: Date, days: number[]): boolean {
	const minutes = startedAt.getUTCHours() * 60 + startedAt.getUTCMinutes();
	const day = startedAt.getUTCDay();

	if (window.end > window.start) return days.includes(day) && minutes >= window.start && minutes < window.end;
	// A window that runs past midnight started on the previous UTC day.
	const previous = (day + 6) % 7;
	return (days.includes(day) && minutes >= window.start) || (days.includes(previous) && minutes < window.end);
}

/** The multiplier in force at `startedAt`: a window's own, the schedule's, or `outside`. */
export function multiplierAt(startedAt: Date, schedule: Schedule): number {
	for (const window of schedule.windows) {
		if (windowCovers(window, startedAt, schedule.days)) return window.multiplier ?? schedule.multiplier;
	}
	return schedule.outside;
}

/** Whether the rate in force costs more than the one pi recorded. */
export function isPeakAt(startedAt: Date, schedule: Schedule): boolean {
	return multiplierAt(startedAt, schedule) > 1;
}

const MS_PER_MINUTE = 60_000;

/**
 * Every instant the multiplier could move: the edges of each window, over a week
 * of days plus a day of slack so a window that wraps midnight always contributes
 * its closing edge and every weekday appears at least once. Sorted, and only
 * ahead of `now`.
 */
function candidateEdges(now: Date, schedule: Schedule): number[] {
	const nowMs = now.getTime();
	const edges: number[] = [];

	for (let offset = 0; offset <= 8; offset++) {
		const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset);
		const day = new Date(midnight).getUTCDay();
		const previousDay = (day + 6) % 7;

		for (const window of schedule.windows) {
			// A window opens on its own day and closes on that day, or on the next one
			// when it runs past midnight.
			const closesOn = window.end > window.start ? day : previousDay;
			if (schedule.days.includes(day)) edges.push(midnight + window.start * MS_PER_MINUTE);
			if (schedule.days.includes(closesOn)) edges.push(midnight + window.end * MS_PER_MINUTE);
		}
	}

	return edges.filter((edge) => edge > nowMs).sort((left, right) => left - right);
}

/**
 * The earliest instant after `now` at which the schedule's multiplier changes,
 * or undefined when it never does.
 *
 * A window edge is not enough: windows can overlap, so the edge that opens one
 * may land inside another and leave the rate where it was. Testing the
 * multiplier on both sides of each edge keeps the footer's trigger and the
 * footer's value on the same function, and leaves a schedule whose multiplier
 * never moves — a `multiplier` equal to its `outside`, say — with no timer at
 * all.
 */
export function nextTransitionAt(now: Date, schedule: Schedule): Date | undefined {
	if (schedule.windows.length === 0) return undefined;

	// Edges are ordered, so the multiplier is constant between consecutive ones:
	// the first edge that moves it is the first change after `now`.
	for (const edge of candidateEdges(now, schedule)) {
		if (multiplierAt(new Date(edge), schedule) !== multiplierAt(new Date(edge - 1), schedule)) {
			return new Date(edge);
		}
	}

	return undefined;
}

/** Glob match supporting `*` only, which is all a provider/model filter needs. */
export function matchesPattern(pattern: string, value: string): boolean {
	if (pattern === "*") return true;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

export function matchesSchedule(schedule: Schedule, provider: string, model: string): boolean {
	return (
		schedule.providers.some((pattern) => matchesPattern(pattern, provider)) &&
		schedule.models.some((pattern) => matchesPattern(pattern, model))
	);
}

/** The provider/model pair a request belongs to, as pi reports it. */
export interface ModelKey {
	provider: string;
	id: string;
}

/** Per-million-token rates, in the shape pi records them. */
export interface RateCard {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** A selected model with the rates pi would charge it at, which the schedule scales. */
export interface ModelRate extends ModelKey {
	cost: RateCard;
}

/** The first schedule covering a provider/model pair. */
export function scheduleFor(schedules: Schedule[], provider: string, model: string): Schedule | undefined {
	return schedules.find((schedule) => matchesSchedule(schedule, provider, model));
}

/** Whether the rate in force costs more (`peak`), less (`off-peak`), or the same (`none`). */
export type RateState = "peak" | "off-peak" | "none";

export function rateStateAt(when: Date, schedule: Schedule): RateState {
	const multiplier = multiplierAt(when, schedule);
	if (multiplier > 1) return "peak";
	if (multiplier < 1) return "off-peak";
	return "none";
}

/**
 * The rate in force for a model, e.g. `$0.30/$1.20/M`. Empty when the rate in
 * force is free, which keeps free models out of the footer instead of printing a
 * zero rate.
 */
export function describeRate(cost: RateCard, multiplier: number): string {
	const input = cost.input * multiplier;
	const output = cost.output * multiplier;
	if (input <= 0 && output <= 0) return "";
	return `$${formatRate(input)}/$${formatRate(output)}${RATE_UNIT}`;
}

/** Up to three decimals without trailing zeros, and finer for a smaller rate. */
function formatRate(value: number): string {
	for (const decimals of [3, 6]) {
		const text = value.toFixed(decimals).replace(/\.?0+$/, "");
		if (text !== "" && text !== "0") return text;
	}
	return "0";
}

/**
 * The footer indicator for a selected model: the rate in force, prefixed with
 * `peak` or `off-peak` when it differs from the rate pi recorded. Undefined when
 * correction is disabled, no model is selected, no schedule covers it, or it has
 * no recorded cost to report.
 */
export function statusIndicator(
	schedules: Schedule[],
	active: boolean,
	model: ModelRate | undefined,
	now: Date = new Date(),
): string | undefined {
	if (!active || !model) return undefined;
	const schedule = scheduleFor(schedules, model.provider, model.id);
	if (!schedule) return undefined;

	const rate = describeRate(model.cost, multiplierAt(now, schedule));
	if (!rate) return undefined;

	switch (rateStateAt(now, schedule)) {
		case "peak":
			return `· ${STATUS_PEAK} ${rate}`;
		case "off-peak":
			return `· ${STATUS_OFF_PEAK} ${rate}`;
		default:
			return `· ${rate}`;
	}
}

export interface CostBreakdown extends RateCard {
	total: number;
}

/** Scale every rate field and recompute `total` from them, as pi itself does. */
export function applyMultiplier(cost: CostBreakdown, multiplier: number): CostBreakdown {
	const scaled: CostBreakdown = {
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
		total: 0,
	};
	scaled.total = scaled.input + scaled.output + scaled.cacheRead + scaled.cacheWrite;
	return scaled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the config file; undefined means missing or unreadable, which stays inert. */
export function readConfig(path: string): ConfigFile | undefined {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) {
			console.warn(`[${STATUS_KEY}] ${path} is not a JSON object; using defaults`);
			return {};
		}
		return parsed as ConfigFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] Failed to read ${path}: ${message}; using defaults`);
		return {};
	}
}

/** Persist `active` while preserving keys this version does not model. */
export function writeActive(path: string, active: boolean): void {
	try {
		const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : {};
		const merged = isRecord(existing) ? { ...existing, active } : { active };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] Failed to write ${path}: ${message}`);
	}
}

function formatClock(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function describeSchedule(schedule: Schedule): string {
	const windows = schedule.windows
		.map((window) => {
			const multiplier = window.multiplier !== undefined ? ` ×${window.multiplier}` : "";
			return `${formatClock(window.start)}-${formatClock(window.end)}${multiplier}`;
		})
		.join(", ");
	const days = schedule.days.map((day) => DAY_NAMES[day]).join(",");
	const inside = windows ? `×${schedule.multiplier} in ${windows}` : `×${schedule.multiplier} always`;
	return `${inside}, ×${schedule.outside} outside (${days} UTC) for ${schedule.providers.join(",")}`;
}

function describeAll(schedules: Schedule[]): string {
	const configured = schedules.filter(
		(schedule) => schedule.windows.length > 0 || schedule.multiplier !== 1 || schedule.outside !== 1,
	);
	if (configured.length === 0) return "no schedule configured";
	return configured.map(describeSchedule).join(" | ");
}

export interface PeakHoursOptions {
	/** Config file to read; defaults to the one in pi's agent directory. */
	configPath?: string;
}

/**
 * Messages already scaled. Retries re-deliver the same object, and pi applies a
 * returned replacement by copying it onto that same object in place, so object
 * identity is what identifies a message here.
 *
 * Shared across extension instances through a global: with the npm package and a
 * local checkout both loaded, each would otherwise keep its own set and scale
 * every message twice.
 */
const ADJUSTED_KEY = Symbol.for("pi-peak-hours.adjusted");
function adjustedMessages(): WeakSet<object> {
	const registry = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
	registry[ADJUSTED_KEY] ??= new WeakSet<object>();
	return registry[ADJUSTED_KEY];
}

export default function peakHours(pi: ExtensionAPI, options: PeakHoursOptions = {}): void {
	const configPath = options.configPath ?? CONFIG_PATH;
	let config = readConfig(configPath) ?? {};
	let schedules = resolveSchedules(config);
	let active = parseActive(config.active);
	const adjusted = adjustedMessages();
	let pendingStart: number | undefined;
	let requestStartMs: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function refresh(): void {
		config = readConfig(configPath) ?? {};
		schedules = resolveSchedules(config);
		active = parseActive(config.active);
	}

	function disarm(): void {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	}

	/**
	 * Keep the footer in step with the window it quotes. pi fires no event while a
	 * session sits idle, so a session idle across a boundary would keep describing
	 * a rate that has expired. Armed only for a `status` that is on screen, and
	 * from the instant that status was computed: `now` is the one clock reading
	 * shared by the rate and the boundary that ends it, so the last millisecond of
	 * a window cannot arm the timer past its own edge.
	 */
	function arm(ctx: ExtensionContext, model: ModelRate | undefined, status: string | undefined, now: Date): void {
		disarm();
		// Nothing to keep fresh, or no footer to keep fresh in.
		if (status === undefined || !ctx.hasUI || !model) return;
		const schedule = scheduleFor(schedules, model.provider, model.id);
		if (!schedule) return;

		const next = nextTransitionAt(now, schedule);
		if (!next) return;
		// Floored, so a boundary crossed between reading the clock and arming the
		// timer cannot spin it; unreferenced, so a pending window never keeps pi
		// alive after its work is done.
		timer = setTimeout(() => {
			timer = undefined;
			updateStatus(ctx);
		}, Math.max(1000, next.getTime() - now.getTime()));
		timer.unref?.();
	}

	function updateStatus(ctx: ExtensionContext, model: ModelRate | undefined = ctx.model): void {
		const now = new Date();
		const status = statusIndicator(schedules, active, model, now);
		ctx.ui.setStatus(STATUS_KEY, status);
		arm(ctx, model, status, now);
	}

	function notifyStatus(ctx: ExtensionContext, model: ModelRate | undefined = ctx.model): void {
		if (!active) {
			ctx.ui.notify(`Peak hours: off.`, "info");
			return;
		}
		// Schedules are provider-scoped, so name why nothing applies to a model none
		// of them cover instead of reporting a rate that will never be charged.
		if (!model) {
			ctx.ui.notify(`Peak hours: no model selected. ${describeAll(schedules)}`, "info");
			return;
		}
		const schedule = scheduleFor(schedules, model.provider, model.id);
		if (!schedule) {
			ctx.ui.notify(`Peak hours: not applied to ${model.provider}/${model.id}. ${describeAll(schedules)}`, "info");
			return;
		}
		const multiplier = multiplierAt(new Date(), schedule);
		const rate = describeRate(model.cost, multiplier);
		const state =
			multiplier > 1
				? `peak ×${multiplier} right now`
				: multiplier < 1
					? `off-peak ×${multiplier} right now`
					: "no correction right now";
		const detail = rate ? `${state} (${rate})` : state;
		ctx.ui.notify(`Peak hours: ${detail}. ${describeSchedule(schedule)}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		refresh();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingStart = undefined;
		requestStartMs = undefined;
		disarm();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("model_select", async (event, ctx) => {
		updateStatus(ctx, event.model);
	});

	// The window boundary can pass between messages, and the footer quotes a price
	// that changes with it, so re-evaluate whenever a turn starts.
	pi.on("turn_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	// The provider bills when the request arrives, and `message_start` is emitted
	// only once the response begins, so capture the logical request start here and
	// fall back to the message clock when no request was observed.
	pi.on("before_provider_request", async () => {
		if (active) requestStartMs = Date.now();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		pendingStart = requestStartMs ?? Date.now();
		requestStartMs = undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (adjusted.has(message)) return;
		if (!message.usage?.cost) return;

		// The request's start decides its rate; fall back to the message clock when
		// no start was observed (resumed sessions, extension reloads mid-turn).
		const startedAt = pendingStart ?? message.timestamp ?? Date.now();
		pendingStart = undefined;

		if (!active) {
			updateStatus(ctx);
			return;
		}
		const schedule = scheduleFor(schedules, message.provider, message.model);
		if (!schedule) {
			updateStatus(ctx);
			return;
		}

		const multiplier = multiplierAt(new Date(startedAt), schedule);
		if (multiplier === 1) {
			updateStatus(ctx);
			return;
		}

		adjusted.add(message);
		updateStatus(ctx);
		const replacement = {
			...message,
			usage: {
				...message.usage,
				cost: applyMultiplier(message.usage.cost, multiplier),
			},
		};
		// pi copies this onto the original, so the original's identity already
		// carries the guard; registering the replacement covers a caller that
		// replays the returned value instead.
		adjusted.add(replacement);
		return { message: replacement };
	});

	pi.registerCommand(COMMAND_PEAK_HOURS, {
		description: "Show or toggle time-of-day cost correction; /peak-hours [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "status"];
			const items = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "status") {
				refresh();
				updateStatus(ctx);
				notifyStatus(ctx);
				return;
			}
			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify("Usage: /peak-hours [on|off|status]", "error");
				return;
			}
			writeActive(configPath, arg === "on");
			refresh();
			updateStatus(ctx);
			notifyStatus(ctx);
		},
	});
}
