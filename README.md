# pi-peak-hours

Estimate time-of-day pricing from pi's recorded cost, and show the current estimated rate in the footer.

DeepSeek is the current example. Its peak windows are `01:00–04:00` and `06:00–10:00` UTC, Monday to Friday, and off-peak is half the peak rate. pi has no notion of time-of-day pricing: `usage.cost` is computed once from the model's flat rates when usage is finalized, so a session is over- or understated by up to 2x depending on which side of the schedule the recorded rate sits.

The default covers DeepSeek direct only: pi records it at the published **peak** rate, so correction is ×1 inside the windows and ×0.5 outside. Reseller routes bill flat — OpenRouter prices each model per key and publishes no time-of-day overrides — so a default multiplier would corrupt their cost instead of correcting it. Give a route an explicit schedule only when its provider really bills by time of day. Custom `models.json` rates also need matching multipliers.

With a compatible [pi-provider-compaction](https://github.com/nijaru/pi-provider-compaction) companion loaded, this extension scales existing `usage.cost` before request completion reaches stream consumers or cache observers. It covers observed foreground requests, compaction, branch summaries, and cache warming for scheduled providers. Without the companion, it still corrects finalized foreground assistant messages through `message_end`; auxiliary usage stays unchanged. Both paths preserve token counts and existing cost corrections such as `/fast`.

The status line quotes the selected model's scheduled catalog estimate — `· $0.30/$1.20/M` during a peak window, `· ▼ off-peak $0.15/$0.60/M` off it. `▲ peak` or `▼ off-peak` marks a rate above or below pi's recorded rate. With stock peak-base prices, peak has no indicator and off-peak is marked as a discount. `/peak-hours status` names the schedule.

The footer describes the current hour, not a particular request: a request invoked before a boundary uses its invocation timestamp even after the footer moves to the new hour. Request-specific corrections can also differ from the quoted catalog rate. Stale base prices remain stale; this extension applies a multiplier, not a price lookup. All costs are estimates, not invoices: server arrival times and Chinese public holidays are not modeled.

## Install

```bash
pi install npm:@nijaru/pi-peak-hours
```

For a manual install, copy both files from `extensions/` into `~/.pi/agent/extensions/peak-hours/`, keeping `index.ts` and `request-pricing.ts` together.

Request-wide pricing requires a companion version that supports the `pi-provider-compaction:observe-usage` event. Older or absent companions leave foreground correction usable; no second provider wrapper is installed.

## Usage

```
/peak-hours           # show the effective schedule and the current rate
/peak-hours on|off    # toggle correction; persists to pi-peak-hours.json
```

`/peak-hours status` also reloads the configuration. With the companion, configuration and on/off changes apply to new requests; requests already dispatched keep their sampled decision.

The footer status is a separate line under the stats bar. It shows the model's current rate while a schedule covers it, and clears when correction is off, no schedule applies, or pi records no cost for the model. It re-evaluates on model switch, on every turn, and when a message is finalized — and it arms a timer for the next instant the rate it quotes actually changes, so a session sitting idle across 04:00 UTC flips to the new rate on time instead of at its next turn.

## Configuration

Optional. `~/.pi/agent/extensions/pi-peak-hours.json` overlays the DeepSeek schedule; anything you leave out keeps its default. A `schedules` list replaces the default outright instead of overlaying it.

```json
{
  "active": true,
  "multiplier": 1,
  "outside": 0.5,
  "windows": [["01:00", "04:00"], ["06:00", "10:00"]],
  "days": ["mon", "tue", "wed", "thu", "fri"],
  "providers": ["deepseek"],
  "models": ["*"]
}
```

Times are **UTC**. `days` accepts names or `0`–`6` (`0` is Sunday). `providers` and `models` accept `*` globs, so a self-hosted gateway or a reseller (`"providers": ["tokenrouter"], "models": ["deepseek/*"]`) can pick up the same schedule.

`multiplier` applies **inside** `windows` and `outside` applies everywhere else. Either may be below 1, because not every provider prices the same way round. A window may carry its own `multiplier`, which wins for that window:

```json
"windows": [{ "start": "22:00", "end": "08:00", "multiplier": 0.4 }]
```

**Pick the side that matches your own rate card.** The extension applies the difference from the rate pi recorded; it does not guess which side that is. The built-in schedule encodes today's pi.dev catalog — DeepSeek direct at its **peak** rate — and if your catalog changes, or you override rates in `models.json` as below, say so in the config instead of relying on the default. `/peak-hours status` reports what it would charge right now, and the numbers are in the provider's docs.

```json
// Your models.json pins DeepSeek direct to the off-peak rate: scale up at peak.
{ "multiplier": 2, "outside": 1 }

// Stock pi.dev lists DeepSeek direct at the peak rate: scale down off-peak.
{ "providers": ["deepseek"], "multiplier": 1, "outside": 0.5 }
```

### Other providers

A `schedules` list replaces the built-in schedule with one entry per service. Each entry starts from a clean slate rather than inheriting DeepSeek's windows.

**Z.ai coding plan** — the standard credit rate during the weekday peak window, half of it everywhere else (docs.z.ai/devpack). This is inverted relative to DeepSeek: `06:00–10:00` UTC Monday–Friday is the *expensive* side, so the windows match and the multiplier lands below 1.

```json
{
  "schedules": [
    { "providers": ["zai"], "windows": [["06:00", "10:00"]], "days": ["mon", "tue", "wed", "thu", "fri"],
      "multiplier": 1, "outside": 0.5 }
  ]
}
```

Note that a coding plan is billed in credits against a subscription, so pi's cost for it is a list-price estimate either way.

**Alibaba Model Studio (Qwen)** — a limited-time night discount: night is `22:00–08:00` UTC+8 (`14:00–00:00` UTC) and the percentage is quoted per model, so the schedule is per model too. The example below is the published `night 60% off / daytime 20% off` shape.

```json
{
  "schedules": [
    { "providers": ["qwen"], "models": ["qwen3.8-max"],
      "windows": [
        { "start": "14:00", "end": "00:00", "multiplier": 0.4 },
        { "start": "00:00", "end": "14:00", "multiplier": 0.8 }
      ], "outside": 1 }
  ]
}
```

**Xiaomi MiMo Token Plan** — subscription credits rather than the pay-as-you-go API (which is flat-rate): the night rate consumes 0.8× credits from 00:00–08:00 Beijing (16:00–24:00 UTC) daily ([docs](https://mimo.mi.com/static/docs/price/token-plan.md)), as a `schedules` entry: `{ "providers": ["xiaomi-token-plan-*"], "windows": [["16:00", "00:00"]], "multiplier": 0.8, "outside": 1 }`.

OpenRouter publishes the same windows machine-readably for models it hosts (`pricing.overrides` with `utc_days` / `utc_start` / `utc_end` on `https://openrouter.ai/api/v1/models`), but this extension reads its schedule from config rather than the network: the correction is a rate difference, not a price lookup, and a fetch would add a failure mode to a handler that must never throw.

A malformed field falls back to its default rather than disabling the extension; a malformed file warns and resolves to defaults. `/peak-hours on|off` refuses to rewrite a malformed, unreadable, or non-object config and reports that the save failed, leaving the existing file untouched.

## Design notes

- **Only the selected model drives the indicator.** Schedules are provider- and model-scoped, so the footer shows no rate for uncovered models. A rate above the recorded one reads `peak`, below it `off-peak`.
- **The footer follows the window it quotes.** pi has no render tick and fires no event while a session is idle, and a rate that changes at 04:00 would otherwise stay on screen until the next turn. The extension arms a single timer for the next instant the quoted rate changes and re-arms it after each fire, from the same clock reading as the status it is keeping fresh. It arms nothing when there is no status on screen, and the timer is unreferenced and cleared on session shutdown, so it neither holds pi open nor outlives its session.
- **Rate by provider invocation.** Pi providers timestamp each assistant message before preparing and sending its HTTP request. That timestamp selects the multiplier, not completion time or the shared payload hook. With the companion, active state and schedules are captured at request dispatch; without it, foreground fallback uses the configuration at `message_end`.
- **Scaled once.** Global weak identity guards protect usage and foreground message objects across loaded copies, retries, and returned replacements. Usage observed at dispatch remains handled even when its decision is unchanged (×1 or inactive), so fallback cannot overwrite it after a config change.
- **Shared ownership.** The client requests usage-only leases for covered available models and the current model, deduplicated by provider. The companion scopes callbacks to the owning session. Retired leases are reacquired on reconciliation; shutdown and SDK disposal remove only this client's leases. Neither catalogs nor unrelated provider slots are replaced.
- **Only cost moves.** The four cost fields are scaled and `total` is recomputed from them, matching pi's own invariant. Token counts are untouched, so rate-from-cost derivations stay self-consistent — including pi's cache-miss accounting, which derives its paid and read rates from the same message and scales with it.
- **Coverage.** Only requests observed by the companion's safe dispatcher receive request-wide correction. Unavailable models, unsupported provider registrations, and usage reported independently by tools can remain uncorrected. Without the companion, coverage is foreground assistant messages only. The default weekday schedule does not encode Chinese public holidays, which DeepSeek treats as off-peak; holiday costs can therefore be overstated.

## Stack

TypeScript, Bun. `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are host-provided peers; the latter supplies session-resource cleanup for SDK disposal. No build step — pi loads `extensions/index.ts` directly.

## Testing

```bash
bun run check
```
