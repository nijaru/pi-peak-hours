/**
 * pi-peak-hours — correct recorded cost for providers that bill by time of day.
 *
 * DeepSeek is the clearest example: its published prices are the off-peak
 * rates, and a 2x multiplier applies during peak windows (01:00-04:00 and
 * 06:00-10:00 UTC, Monday-Friday, as of September 2026). pi has no notion of
 * time-of-day pricing — `usage.cost` is computed once from the model's flat
 * rates when usage is finalized — so the footer understates such sessions by
 * up to 2x while a peak window is open.
 *
 * This extension rewrites `usage.cost` on the finalized assistant message in
 * `message_end`, the documented hook for replacing a message. The footer
 * recomputes session totals from persisted entries on every render, so the
 * corrected number appears in the footer, the per-model breakdown, and the
 * HTML export without further plumbing.
 *
 * Design constraints:
 *
 * - The rate is chosen from the request's START time, not its end. DeepSeek
 *   bills by when a request arrives, so a request spanning a window boundary
 *   would otherwise be billed on the wrong side of it. `message_start` gives
 *   the start; `message_end` gives the end.
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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATUS_KEY = "peak-hours";
/**
 * Status text is deliberately generic: the footer already carries the session
 * cost, and the multiplier differs per service. Detail lives in
 * `/peak-hours status`, which names the schedule and the rate in force.
 */
export const STATUS_PEAK = "▲ peak";
export const COMMAND_PEAK_HOURS = "peak-hours";
export const CONFIG_BASENAME = "pi-peak-hours.json";
export const CONFIG_PATH = join(getAgentDir(), "extensions", CONFIG_BASENAME);

/** Minutes from UTC midnight; `end` is exclusive. */
export interface ClockWindow {
	start: number;
	end: number;
}

export interface Schedule {
	multiplier: number;
	windows: ClockWindow[];
	/** 0 = Sunday, matching Date#getUTCDay. */
	days: number[];
	providers: string[];
	models: string[];
}

export interface ConfigFile {
	active?: boolean;
	multiplier?: number;
	windows?: [string, string][];
	days?: (string | number)[];
	providers?: string[];
	models?: string[];
}

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** DeepSeek's published schedule: peak mornings on UTC weekdays, everything else off-peak. */
export const DEFAULT_SCHEDULE: Schedule = {
	multiplier: 2,
	windows: [
		{ start: 60, end: 240 },
		{ start: 360, end: 600 },
	],
	days: [1, 2, 3, 4, 5],
	providers: ["deepseek"],
	models: ["*"],
};

export const DEFAULT_ACTIVE = true;

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
		if (!Array.isArray(entry) || entry.length !== 2) return undefined;
		const start = parseClock(entry[0]);
		const end = parseClock(entry[1]);
		if (start === undefined || end === undefined || start === end) return undefined;
		windows.push({ start, end });
	}
	return windows;
}

function parseStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
	return items.length === value.length ? items.map((item) => item.trim()) : undefined;
}

/** Overlay a parsed config file onto the defaults. Invalid fields fall back to the default. */
export function resolveSchedule(config: ConfigFile): Schedule {
	const schedule: Schedule = {
		multiplier: DEFAULT_SCHEDULE.multiplier,
		windows: DEFAULT_SCHEDULE.windows,
		days: DEFAULT_SCHEDULE.days,
		providers: DEFAULT_SCHEDULE.providers,
		models: DEFAULT_SCHEDULE.models,
	};

	if (typeof config.multiplier === "number" && Number.isFinite(config.multiplier) && config.multiplier >= 1) {
		schedule.multiplier = config.multiplier;
	}
	const windows = parseWindows(config.windows);
	if (windows) schedule.windows = windows;
	if (Array.isArray(config.days)) {
		const days = config.days.map(parseDay);
		if (days.every((day): day is number => day !== undefined)) schedule.days = days;
	}
	const providers = parseStringList(config.providers);
	if (providers) schedule.providers = providers;
	const models = parseStringList(config.models);
	if (models) schedule.models = models;

	return schedule;
}

/** Whether a request that started at `startedAt` falls inside a peak window. */
export function isPeakAt(startedAt: Date, schedule: Schedule): boolean {
	const minutes = startedAt.getUTCHours() * 60 + startedAt.getUTCMinutes();
	const day = startedAt.getUTCDay();

	for (const window of schedule.windows) {
		if (window.end > window.start) {
			if (schedule.days.includes(day) && minutes >= window.start && minutes < window.end) return true;
			continue;
		}
		// A window that runs past midnight started on the previous UTC day.
		const previous = (day + 6) % 7;
		if (schedule.days.includes(day) && minutes >= window.start) return true;
		if (schedule.days.includes(previous) && minutes < window.end) return true;
	}

	return false;
}

export function multiplierAt(startedAt: Date, schedule: Schedule): number {
	return isPeakAt(startedAt, schedule) ? schedule.multiplier : 1;
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

export interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
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

function describeSchedule(schedule: Schedule): string {
	const windows = schedule.windows
		.map((window) => {
			const fmt = (minutes: number) =>
				`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
			return `${fmt(window.start)}-${fmt(window.end)}`;
		})
		.join(", ");
	const days = schedule.days.map((day) => DAY_NAMES[day]).join(",");
	return `${windows} UTC (${days}) ×${schedule.multiplier} for ${schedule.providers.join(",")}`;
}

export default function peakHours(pi: ExtensionAPI): void {
	let config = readConfig(CONFIG_PATH) ?? {};
	let schedule = resolveSchedule(config);
	let active = config.active ?? DEFAULT_ACTIVE;
	/** Messages already scaled; retries can re-deliver the same object. */
	const adjusted = new WeakSet<AssistantMessage>();
	let pendingStart: number | undefined;

	function refresh(): void {
		config = readConfig(CONFIG_PATH) ?? {};
		schedule = resolveSchedule(config);
		active = config.active ?? DEFAULT_ACTIVE;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const multiplier = multiplierAt(new Date(), schedule);
		ctx.ui.setStatus(STATUS_KEY, multiplier > 1 ? `· ${STATUS_PEAK}` : undefined);
	}

	function notifyStatus(ctx: ExtensionContext): void {
		if (!active) {
			ctx.ui.notify(`Peak hours: off.`, "info");
			return;
		}
		const now = new Date();
		const multiplier = multiplierAt(now, schedule);
		const state = multiplier > 1 ? `peak ×${multiplier} right now` : "off-peak right now";
		ctx.ui.notify(`Peak hours: ${state}. ${describeSchedule(schedule)}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		refresh();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingStart = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") pendingStart = Date.now();
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

		if (!active || !matchesSchedule(schedule, message.provider, message.model)) {
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
		return {
			message: {
				...message,
				usage: {
					...message.usage,
					cost: applyMultiplier(message.usage.cost, multiplier),
				},
			},
		};
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
			writeActive(CONFIG_PATH, arg === "on");
			refresh();
			updateStatus(ctx);
			notifyStatus(ctx);
		},
	});
}
