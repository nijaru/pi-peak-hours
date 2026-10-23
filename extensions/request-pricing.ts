import { registerSessionResourceCleanup, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const OBSERVE_USAGE = "pi-provider-compaction:observe-usage";
export const USAGE_OBSERVER_READY = "pi-provider-compaction:usage-observer-ready";
type TargetModel = NonNullable<ExtensionContext["model"]>;
type ModelKey = Pick<TargetModel, "provider" | "id">;

export interface UsageLease {
	provider: string;
	api: TargetModel["api"];
	isInstalled(): boolean;
	remove(): void;
}

export interface UsageRequest {
	context: ExtensionContext;
	model: TargetModel;
	priceFor(model: ModelKey): (timestamp: number, usage: Usage) => void;
	respond(lease: UsageLease | undefined): void;
	handled?: boolean;
}

// Shared with foreground fallback and separately loaded copies of the extension.
// Unchanged decisions (1x, disabled, uncovered) are handled too: a later config
// refresh must not reprice a request whose decision was sampled at dispatch.
const PRICED_USAGE = Symbol.for("pi-peak-hours.priced-usage");
const shared = globalThis as typeof globalThis & { [PRICED_USAGE]?: WeakSet<object> };
export const handledUsage = shared[PRICED_USAGE] ??= new WeakSet<object>();

export function applyMultiplier(cost: Usage["cost"], multiplier: number): Usage["cost"] {
	const scaled = {
		...cost,
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
	};
	scaled.total = scaled.input + scaled.output + scaled.cacheRead + scaled.cacheWrite;
	return scaled;
}

interface PricingRules {
	covers(model: ModelKey): boolean;
	/** Called at dispatch; return a timestamp selector with no mutable config. */
	snapshot(model: ModelKey): (timestamp: number) => number;
}

function leaseKey(target: Pick<TargetModel, "provider" | "api">): string {
	return JSON.stringify([target.provider, target.api]);
}

/** Usage-only client of the companion's safe shared provider dispatcher. */
export function requestPricing(pi: ExtensionAPI, rules: PricingRules, onRetire: () => void) {
	let owner: { context: ExtensionContext; sessionId: string; revision: number; available: readonly TargetModel[] } | undefined;
	const leases = new Map<string, UsageLease>();
	let unsubscribeReady: (() => void) | undefined;
	let unregisterCleanup: (() => void) | undefined;

	function owns(context: ExtensionContext): boolean {
		return owner !== undefined && context.modelRegistry === owner.context.modelRegistry &&
			context.sessionManager.getSessionId() === owner.sessionId;
	}

	function stop(): void {
		owner = undefined;
		unsubscribeReady?.();
		unsubscribeReady = undefined;
		unregisterCleanup?.();
		unregisterCleanup = undefined;
		for (const lease of leases.values()) lease.remove();
		leases.clear();
		onRetire();
	}

	function priceFor(model: ModelKey): (timestamp: number, usage: Usage) => void {
		const selectMultiplier = rules.snapshot(model);
		return (timestamp, usage) => {
			if (handledUsage.has(usage)) return;
			handledUsage.add(usage);
			const multiplier = selectMultiplier(timestamp);
			if (multiplier !== 1) usage.cost = applyMultiplier(usage.cost, multiplier);
		};
	}

	async function reconcile(context: ExtensionContext, model = context.model): Promise<void> {
		if (!owns(context) || !owner) return;
		const current = owner;
		current.context = context;
		const revision = ++current.revision;
		const live = () => owner === current && current.revision === revision;
		for (const [key, lease] of leases) {
			if (!lease.isInstalled()) { lease.remove(); leases.delete(key); }
		}
		const tryModel = (candidate: TargetModel) => {
			if (!live() || !rules.covers(candidate) || leases.has(leaseKey(candidate))) return;
			const request: UsageRequest = {
				context: current.context,
				model: candidate,
				priceFor,
				respond(lease) {
					if (!lease) return;
					const key = leaseKey(lease);
					if (!live() || leases.has(key) || !lease.isInstalled()) { lease.remove(); return; }
					leases.set(key, lease);
				},
			};
			pi.events.emit(OBSERVE_USAGE, request);
		};
		// Do not await catalog/auth discovery before covering the selected model:
		// the companion's ready notification is synchronous and can precede dispatch.
		if (model) tryModel(model);
		// A source-first start can answer immediately. A client-first start has
		// already discovered available models by the time the source says ready;
		// retry those synchronously too, before any auxiliary request can dispatch.
		for (const candidate of current.available) tryModel(candidate);
		try {
			const available = await context.modelRegistry.getAvailable();
			if (!live()) return;
			current.available = available;
			// A lease covers only its provider/API pair. Keep trying other APIs
			// even after one succeeds, and other candidates when a lease fails.
			for (const candidate of available) tryModel(candidate);
		} catch { /* Optional discovery failure leaves foreground fallback usable. */ }
		// Keep acquired leases until retirement, even after schedule removal, so
		// requests already in flight can finish with their dispatch snapshots.
	}

	return {
		async start(context: ExtensionContext): Promise<void> {
			stop();
			const sessionId = context.sessionManager.getSessionId();
			owner = { context, sessionId, revision: 0, available: [] };
			unsubscribeReady = pi.events.on(USAGE_OBSERVER_READY, (value) => {
				const ready = value as { context?: ExtensionContext } | undefined;
				if (ready?.context && owns(ready.context) && owner) void reconcile(owner.context);
			});
			unregisterCleanup = registerSessionResourceCleanup((disposedId) => {
				if (disposedId === undefined || disposedId === sessionId) stop();
			});
			await reconcile(context);
		},
		reconcile,
		isCurrent: owns,
		stop,
	};
}
