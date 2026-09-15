# pi-peak-hours

Correct pi's recorded cost for providers that bill by time of day, and show the rate in force in the footer.

DeepSeek is the current example. Its peak windows are `01:00–04:00` and `06:00–10:00` UTC, Monday to Friday, and off-peak is half the peak rate. pi has no notion of time-of-day pricing: `usage.cost` is computed once from the model's flat rates when usage is finalized, so a session is over- or understated by up to 2x depending on which side of the schedule the recorded rate sits.

Both built-in entries follow what DeepSeek advertises: ×2 inside those windows and ×1 outside, because the published rate is the off-peak one and peak is a surcharge on it. Since the extension scales whatever rate pi recorded, an entry is right only where that rate really is the off-peak one — true of the OpenRouter route, which pi rates at `0.15/0.60`, and of the direct provider wherever `models.json` pins it to off-peak. Stock pi.dev rates direct as `deepseek-flash` at `0.30/1.20`, its peak number, so the configuration below inverts that one entry; the pair exists because each entry is scoped, covering the DeepSeek models on both routes without claiming unrelated OpenRouter models. Naming your own providers replaces both.

This extension rewrites `usage.cost` on the finalized assistant message, so the footer total, the per-model breakdown, and the HTML export all reflect the billed rate. The status line quotes the rate in force for the selected model — `· ▲ peak $0.30/$1.20/M` during a peak window, `· $0.15/$0.60/M` off it — with `▲ peak` or `▼ off-peak` added when the hour costs more or less than the rate pi recorded. `/peak-hours status` names the schedule behind it.

The quoted rate is pi's recorded rate scaled by the schedule, so it always agrees with the cost written to the session. It describes the hour in force rather than a particular request, though: a request that started before a boundary is billed by its start time while the footer has already moved to the new hour. Where pi's rate table is stale or wrong for your route, the quoted rate is stale in the same way — the extension corrects the shape of the bill, not the base rate.

## Install

```bash
pi install npm:@nijaru/pi-peak-hours
```

Or copy `extensions/index.ts` to `~/.pi/agent/extensions/` for a single-machine install.

## Usage

```
/peak-hours           # show the effective schedule and the current rate
/peak-hours on|off    # toggle correction; persists to pi-peak-hours.json
```

The footer status is a separate line under the stats bar. It shows the model's current rate while a schedule covers it, and clears when correction is off, no schedule applies, or pi records no cost for the model. It re-evaluates on model switch, on every turn, and when a message is finalized — and it arms a timer for the next instant the rate it quotes actually changes, so a session sitting idle across 04:00 UTC flips to the new rate on time instead of at its next turn.

## Configuration

Optional. `~/.pi/agent/extensions/pi-peak-hours.json` overlays the DeepSeek schedule; anything you leave out keeps its default. The OpenRouter route for the same models is covered out of the box, and setting `providers` yourself replaces both built-in schedules with the one you describe.

```json
{
  "active": true,
  "multiplier": 2,
  "outside": 1,
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

**Pick the side that matches your own rate card.** The extension applies the difference from the rate pi recorded; it does not guess which side that is. The built-in pair encodes today's pi.dev catalog — DeepSeek direct at its **peak** rate, the same model through OpenRouter at its **off-peak** rate — and if your catalog changes, or you override rates in `models.json` as below, say so in the config instead of relying on the default. `/peak-hours status` reports what it would charge right now, and the numbers are in the provider's docs.

```json
// Your models.json pins DeepSeek direct to the off-peak rate: scale up at peak.
{ "multiplier": 2, "outside": 1 }

// Stock pi.dev lists DeepSeek direct at the peak rate: scale down off-peak.
{ "providers": ["deepseek"], "multiplier": 1, "outside": 0.5 }
```

### Other providers

A `schedules` list replaces the built-in schedules with one entry per service. Each entry starts from a clean slate rather than inheriting DeepSeek's windows.

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

OpenRouter publishes the same windows machine-readably for models it hosts (`pricing.overrides` with `utc_days` / `utc_start` / `utc_end` on `https://openrouter.ai/api/v1/models`), but this extension reads its schedule from config rather than the network: the correction is a rate difference, not a price lookup, and a fetch would add a failure mode to a handler that must never throw.

A malformed field falls back to its default rather than disabling the extension; a malformed file warns and resolves to defaults.

## Design notes

- **Only the selected model drives the indicator.** Schedules are provider- and model-scoped, so the footer never shows a rate for a service that does not bill by time of day. A rate above the recorded one reads `peak`, below it `off-peak`, and a discount is never labelled a peak. The quoted rate and the written cost come from the same multiplication, so they cannot disagree.
- **The footer follows the window it quotes.** pi has no render tick and fires no event while a session is idle, and a rate that changes at 04:00 would otherwise stay on screen until the next turn. The extension arms a single timer for the next instant the quoted rate changes and re-arms it after each fire, from the same clock reading as the status it is keeping fresh. It arms nothing when there is no status on screen, and the timer is unreferenced and cleared on session shutdown, so it neither holds pi open nor outlives its session.
- **Rate by request start.** DeepSeek bills by arrival time, so the multiplier is chosen from the `message_start` timestamp rather than `message_end`. A request spanning a window boundary would otherwise land on the wrong side.
- **Scaled once.** Retries and overflow recovery can re-deliver the same message object, so adjustments are guarded by identity; the replacement returned to pi is registered too, so a replayed replacement cannot be scaled twice.
- **Only cost moves.** The four cost fields are scaled and `total` is recomputed from them, matching pi's own invariant. Token counts are untouched, so rate-from-cost derivations stay self-consistent — including pi's cache-miss accounting, which derives its paid and read rates from the same message and scales with it.
- **Coverage.** Assistant messages carry the bulk of a session's spend. Compaction and branch-summary usage, plus token usage reported by tools, also feed the footer but cannot be adjusted after the fact, so totals stay an estimate rather than an invoice.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`). `@earendil-works/pi-ai` is a dev dependency only — the handlers use pi's own `Model` and usage shapes structurally, so nothing from it ships. No build step — pi loads the extension directly.

## Testing

```bash
bun run check
```
