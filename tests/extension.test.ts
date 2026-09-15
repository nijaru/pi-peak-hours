/**
 * Handler-level contract tests: the extension is driven through the same events
 * pi emits, so the wiring (not just the pure schedule maths) is covered.
 *
 * The configs below cover every hour of the day, which keeps the multiplicand
 * deterministic without freezing the clock. The boundary-timer tests do freeze
 * it, because the instant a window turns over is the behavior under test.
 */

import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import peakHours, {
	COMMAND_PEAK_HOURS,
	type ModelRate,
	RATE_UNIT,
	type RateCard,
	STATUS_KEY,
	STATUS_OFF_PEAK,
	STATUS_PEAK,
} from "../extensions/index.ts";

const RATES: RateCard = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
const DEEPSEEK: ModelRate = { provider: "deepseek", id: "deepseek-flash", cost: RATES };
const ASTRA: ModelRate = { provider: "openai-codex", id: "gpt-6-astra", cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 } };

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** Both windows together cover the whole UTC day, so the multiplier always applies. */
const EVERY_HOUR = [
	["00:00", "12:00"],
	["12:00", "00:00"],
];
const SURCHARGE = { providers: ["deepseek"], models: ["*"], days: ALL_DAYS, windows: EVERY_HOUR, multiplier: 2, outside: 1 };
const DISCOUNT = { providers: ["deepseek"], models: ["*"], days: ALL_DAYS, windows: EVERY_HOUR, multiplier: 0.5, outside: 1 };

interface CommandOptions {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

function configPath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-peak-hours-wiring-")), "pi-peak-hours.json");
}

function assistantMessage(overrides: { provider?: string; model?: string; usage?: Partial<AssistantMessage["usage"]> } = {}): AssistantMessage {
	return {
		role: "assistant",
		provider: overrides.provider ?? "deepseek",
		model: overrides.model ?? "deepseek-flash",
		timestamp: Date.now(),
		usage: {
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2_000_000,
			cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0, total: 0.75 },
			...overrides.usage,
		},
	} as unknown as AssistantMessage;
}

function harness(path: string, options: { hasUI?: boolean } = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, CommandOptions>();
	peakHours(
		{
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			},
			registerCommand: (name: string, options: CommandOptions) => {
				commands.set(name, options);
			},
		} as unknown as ExtensionAPI,
		{ configPath: path },
	);

	const statuses: Array<string | undefined> = [];
	const notes: string[] = [];
	let model: ModelRate | undefined;
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			setStatus: (key: string, value?: string) => {
				if (key === STATUS_KEY) statuses.push(value);
			},
			notify: (message: string) => {
				notes.push(message);
			},
		},
		get model() {
			return model;
		},
	} as unknown as ExtensionContext;

	return {
		select(next?: ModelRate) {
			model = next;
		},
		statuses,
		notes,
		status: () => statuses.at(-1),
		async emit<T = unknown>(event: string, payload: Record<string, unknown> = {}): Promise<T | undefined> {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler registered for ${event}`);
			return (await handler({ type: event, ...payload }, ctx)) as T | undefined;
		},
		async command(args: string) {
			await commands.get(COMMAND_PEAK_HOURS)?.handler(args, ctx);
		},
	};
}

function write(path: string, config: unknown): void {
	writeFileSync(path, `${JSON.stringify(config)}\n`, "utf8");
}

interface TimerHandle {
	unref: () => void;
	run: () => void;
	delay: number;
	/** Pending: neither fired nor cleared. */
	live: boolean;
	unrefCalled: boolean;
}

/**
 * Hold the timers the extension schedules, so a boundary can be crossed without
 * waiting for it. `restore` has to run even when an assertion fails.
 */
function captureTimers() {
	const timers: TimerHandle[] = [];
	const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay?: number,
	) => {
		const handle: TimerHandle = {
			unref: () => {
				handle.unrefCalled = true;
			},
			delay: delay ?? 0,
			live: true,
			unrefCalled: false,
			run: () => {
				handle.live = false;
				callback();
			},
		};
		timers.push(handle);
		return handle;
	}) as unknown as typeof setTimeout);
	const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: TimerHandle) => {
		handle.live = false;
	}) as unknown as typeof clearTimeout);

	return {
		timers,
		armed: () => timers.filter((timer) => timer.live),
		restore: () => {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		},
	};
}

describe("peak hours handlers", () => {
	test("scales the finalized message and quotes the rate it used", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		const message = assistantMessage();
		await h.emit("message_start", { message });
		const result = await h.emit<{ message: AssistantMessage }>("message_end", { message });

		expect(result?.message.usage.cost.input).toBeCloseTo(0.3, 12);
		expect(result?.message.usage.cost.output).toBeCloseTo(1.2, 12);
		expect(result?.message.usage.cost.total).toBeCloseTo(1.5, 12);
		expect(result?.message.usage.cost.total).toBeCloseTo(
			(result?.message.usage.cost.input ?? 0) + (result?.message.usage.cost.output ?? 0),
			12,
		);
		expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);

		// The replacement keeps everything else about the message.
		expect(result?.message.provider).toBe("deepseek");
		expect(result?.message.usage.input).toBe(1_000_000);
	});

	test("scales a message at most once, including its replacement", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		const message = assistantMessage();
		const first = await h.emit<{ message: AssistantMessage }>("message_end", { message });
		expect(first?.message.usage.cost.total).toBeCloseTo(1.5, 12);

		// A retry re-delivers the original object.
		expect(await h.emit("message_end", { message })).toBeUndefined();
		// A replay of what we returned is a different object with the same identity.
		expect(await h.emit("message_end", { message: first?.message })).toBeUndefined();
	});

	test("two loaded copies do not scale a message twice", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const first = harness(path);
		const second = harness(path);
		first.select(DEEPSEEK);
		second.select(DEEPSEEK);
		await first.emit("session_start");
		await second.emit("session_start");

		const message = assistantMessage();
		const scaled = await first.emit<{ message: AssistantMessage }>("message_end", { message });
		expect(scaled?.message.usage.cost.total).toBeCloseTo(1.5, 12);

		// pi applies the replacement by copying it onto the original in place, so the
		// second copy sees that same object carrying a cost it did not write.
		Object.assign(message, scaled?.message);
		expect(await second.emit("message_end", { message })).toBeUndefined();
		expect(message.usage.cost.total).toBeCloseTo(1.5, 12);
	});

	test("ignores messages it cannot correct", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		expect(await h.emit("message_end", { message: { role: "user" } })).toBeUndefined();
		expect(await h.emit("message_end", { message: assistantMessage({ provider: "anthropic", model: "claude-opus" }) })).toBeUndefined();
		expect(await h.emit("message_end", { message: { role: "assistant", usage: {} } })).toBeUndefined();
		expect(await h.emit("message_end", { message: { role: "assistant" } })).toBeUndefined();
	});

	test("applies a discount schedule downwards", async () => {
		const path = configPath();
		write(path, DISCOUNT);
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		const result = await h.emit<{ message: AssistantMessage }>("message_end", { message: assistantMessage() });

		expect(result?.message.usage.cost.total).toBeCloseTo(0.375, 12);
		expect(h.status()).toBe(`· ${STATUS_OFF_PEAK} $0.075/$0.3${RATE_UNIT}`);
	});

	test("clears the status when no model is selected or the session ends", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const h = harness(path);
		h.select(undefined);
		await h.emit("session_start");
		expect(h.status()).toBeUndefined();

		h.select(DEEPSEEK);
		await h.emit("model_select", { model: DEEPSEEK });
		expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);

		await h.emit("session_shutdown");
		expect(h.status()).toBeUndefined();
	});

	test("follows the selected model, and hides an uncovered one", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		h.select(ASTRA);
		await h.emit("model_select", { model: ASTRA });
		expect(h.status()).toBeUndefined();

		h.select(DEEPSEEK);
		await h.emit("model_select", { model: DEEPSEEK });
		expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);
	});

	test("re-evaluates at the start of each turn", async () => {
		const path = configPath();
		write(path, SURCHARGE);
		const h = harness(path);
		// The model was selected before the extension saw a session, as when a
		// window boundary passes mid-session.
		h.select(DEEPSEEK);
		await h.emit("turn_start", { turnIndex: 3 });

		expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);
	});

	test("toggles from the command and persists the choice", async () => {
		const path = configPath();
		write(path, { ...SURCHARGE, active: true });
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		await h.command("off");
		expect(JSON.parse(readFileSync(path, "utf8")).active).toBe(false);
		expect(h.status()).toBeUndefined();
		await h.command("status");
		expect(h.notes.at(-1)).toContain("Peak hours: off.");

		await h.command("on");
		expect(JSON.parse(readFileSync(path, "utf8")).active).toBe(true);
		expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);

		await h.command("nonsense");
		expect(h.notes.at(-1)).toBe("Usage: /peak-hours [on|off|status]");
	});

	test("survives a malformed config and still reports a rate", async () => {
		const path = configPath();
		writeFileSync(path, "{not json", "utf8");
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		const message = assistantMessage();
		const result = await h.emit<{ message: AssistantMessage }>("message_end", { message });
		// The built-in DeepSeek schedule applies, so the rate is 1x or 2x depending
		// on the wall clock; either way the handler must not throw or lose the cost.
		const total = result?.message.usage.cost.total ?? message.usage.cost.total;
		expect([0.75, 1.5]).toContain(Number(total.toFixed(6)));
	});

	test("does nothing when the config turns correction off", async () => {
		const path = configPath();
		write(path, { ...SURCHARGE, active: false });
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		expect(h.status()).toBeUndefined();
		expect(await h.emit("message_end", { message: assistantMessage() })).toBeUndefined();
	});

	test("treats a malformed active flag as the default, not as off", async () => {
		const path = configPath();
		write(path, { ...SURCHARGE, active: 0 });
		const h = harness(path);
		h.select(DEEPSEEK);
		await h.emit("session_start");

		expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);
		const result = await h.emit<{ message: AssistantMessage }>("message_end", { message: assistantMessage() });
		expect(result?.message.usage.cost.total).toBeCloseTo(1.5, 12);
	});
});

describe("window boundary timer", () => {
	/** One window, every day, so the clock can be moved to any hour under test. */
	const NIGHT_WINDOW = {
		providers: ["deepseek"],
		models: ["*"],
		days: ALL_DAYS,
		windows: [["01:00", "04:00"]],
		multiplier: 2,
		outside: 1,
	};

	test("re-renders the footer when the window turns over while the session is idle", async () => {
		const path = configPath();
		write(path, NIGHT_WINDOW);
		const h = harness(path);
		h.select(DEEPSEEK);

		// 2026-09-15 is a Tuesday, so 03:59:30Z is 30 seconds inside the window.
		setSystemTime(new Date("2026-09-15T03:59:30Z"));
		const timers = captureTimers();

		try {
			await h.emit("session_start");
			expect(h.status()).toBe(`· ${STATUS_PEAK} $0.3/$1.2${RATE_UNIT}`);
			// Armed for the boundary itself, not for a poll interval.
			expect(timers.armed()).toHaveLength(1);
			expect(timers.armed()[0]?.delay).toBe(30_000);

			// An idle half-minute: no turn, no message, no model change. Only the timer runs.
			setSystemTime(new Date("2026-09-15T04:00:01Z"));
			timers.armed()[0]?.run();

			expect(h.status()).toBe(`· $0.15/$0.6${RATE_UNIT}`);
			// The expired timer is gone, and the next boundary is 01:00 the next day.
			expect(timers.armed()).toHaveLength(1);
			expect(timers.armed()[0]?.delay).toBe(new Date("2026-09-16T01:00:00Z").getTime() - Date.now());
		} finally {
			timers.restore();
			setSystemTime();
		}
	});

	test("keeps a timer armed only while a status is there to refresh", async () => {
		const path = configPath();
		write(path, NIGHT_WINDOW);
		const h = harness(path);
		const timers = captureTimers();

		try {
			// A model no schedule covers has no footer entry that can expire.
			h.select(ASTRA);
			await h.emit("session_start");
			expect(timers.armed()).toHaveLength(0);

			h.select(DEEPSEEK);
			await h.emit("model_select", { model: DEEPSEEK });
			expect(timers.armed()).toHaveLength(1);
			// Unreferenced, so a pending boundary never holds the process open.
			expect(timers.armed()[0]?.unrefCalled).toBe(true);

			// Switching away disarms what the covered model armed.
			h.select(ASTRA);
			await h.emit("model_select", { model: ASTRA });
			expect(timers.armed()).toHaveLength(0);

			// So does turning correction off.
			h.select(DEEPSEEK);
			await h.emit("model_select", { model: DEEPSEEK });
			expect(timers.armed()).toHaveLength(1);
			await h.command("off");
			expect(timers.armed()).toHaveLength(0);

			// A live timer must not outlive the session it was armed for.
			await h.command("on");
			expect(timers.armed()).toHaveLength(1);
			await h.emit("session_shutdown");
			expect(timers.armed()).toHaveLength(0);
		} finally {
			timers.restore();
		}
	});

	test("arms nothing for a model with no rate to quote", async () => {
		const path = configPath();
		write(path, NIGHT_WINDOW);
		const h = harness(path);
		// Covered by the schedule, but pi records no cost for it, so there is no
		// footer entry for a boundary to invalidate.
		const free: ModelRate = { provider: "deepseek", id: "deepseek-flash", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		h.select(free);
		const timers = captureTimers();

		try {
			await h.emit("session_start");
			expect(h.status()).toBeUndefined();
			expect(timers.armed()).toHaveLength(0);
		} finally {
			timers.restore();
		}
	});

	test("arms nothing for a schedule whose rate never moves", async () => {
		const path = configPath();
		// A window costing the same as the hours around it: a status, but no edge to refresh it at.
		write(path, { ...NIGHT_WINDOW, multiplier: 1, outside: 1 });
		const h = harness(path);
		h.select(DEEPSEEK);
		const timers = captureTimers();

		try {
			await h.emit("session_start");
			expect(h.status()).toBe(`· $0.15/$0.6${RATE_UNIT}`);
			expect(timers.armed()).toHaveLength(0);
		} finally {
			timers.restore();
		}
	});

	test("leaves print and JSON modes alone", async () => {
		const path = configPath();
		write(path, NIGHT_WINDOW);
		const h = harness(path, { hasUI: false });
		h.select(DEEPSEEK);
		const timers = captureTimers();

		try {
			await h.emit("session_start");
			// The status is still computed; there is just no footer to refresh.
			expect(h.status()).toBeDefined();
			expect(timers.armed()).toHaveLength(0);
		} finally {
			timers.restore();
		}
	});
});
