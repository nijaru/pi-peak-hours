# pi-peak-hours

Correct pi's recorded cost for providers that bill by time of day, and show the rate in force in the footer.

DeepSeek is the current example. Its published prices are the **off-peak** rates, and a **2x** multiplier applies during peak windows — `01:00–04:00` and `06:00–10:00` UTC, Monday to Friday, with every other hour (including all weekend) off-peak. pi has no notion of time-of-day pricing: `usage.cost` is computed once from the model's flat rates when usage is finalized, so a session running during a peak window understates its cost by up to 2x.

This extension rewrites `usage.cost` on the finalized assistant message, so the footer total, the per-model breakdown, and the HTML export all reflect the billed rate. While peak is in force the status shows `▲ peak`; off-peak it clears. The indicator stays generic because the multiplier differs per service — `/peak-hours status` names the schedule and the rate in force.

## Install

```bash
pi install git:github.com/nijaru/pi-peak-hours
```

Or copy `extensions/index.ts` to `~/.pi/agent/extensions/` for a single-machine install.

## Usage

```
/peak-hours           # show the effective schedule and the current rate
/peak-hours on|off    # toggle correction; persists to pi-peak-hours.json
```

## Configuration

Optional. `~/.pi/agent/extensions/pi-peak-hours.json` overlays the built-in DeepSeek schedule; anything you leave out keeps its default.

```json
{
  "active": true,
  "multiplier": 2,
  "windows": [["01:00", "04:00"], ["06:00", "10:00"]],
  "days": ["mon", "tue", "wed", "thu", "fri"],
  "providers": ["deepseek"],
  "models": ["*"]
}
```

Times are **UTC**. `days` accepts names or `0`–`6` (`0` is Sunday). `providers` and `models` accept `*` globs, so an OpenRouter route (`"providers": ["openrouter"], "models": ["deepseek/*"]`) picks up the same schedule.

A malformed field falls back to its default rather than disabling the extension; a malformed file warns once and resolves to defaults.

## Design notes

- **Rate by request start.** DeepSeek bills by arrival time, so the multiplier is chosen from the `message_start` timestamp rather than `message_end`. A request spanning a window boundary would otherwise land on the wrong side.
- **Scaled once.** Retries and overflow recovery can re-deliver the same message object, so adjustments are guarded by identity.
- **Only cost moves.** The four cost fields are scaled and `total` is recomputed from them, matching pi's own invariant. Token counts are untouched, so rate-from-cost derivations stay self-consistent — including pi's cache-miss accounting, which derives its paid and read rates from the same message and scales with it.
- **Coverage.** Assistant messages carry the bulk of a session's spend. Compaction and branch-summary usage, plus token usage reported by tools, also feed the footer but cannot be adjusted after the fact, so totals stay an estimate rather than an invoice.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`). No build step — pi loads the extension directly.

## Testing

```bash
bun run check
```
