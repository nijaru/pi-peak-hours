# pi-peak-hours

Correct pi's recorded cost for providers that charge more during peak hours, and show the multiplier in the footer status.

DeepSeek bills by time of day: its published rates are the off-peak rates, and a 2x multiplier applies during 01:00–04:00 and 06:00–10:00 UTC on weekdays. pi computes `usage.cost` once from flat model rates, so this extension rewrites the finalized assistant message's cost in `message_end` to match the billed rate.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`).

## Testing

```bash
bun run check
```

No build step — pi loads the extension directly.

## Invariants

- Rate selection uses the request start time from `message_start`, never `message_end`, because the provider bills by arrival.
- A message is scaled at most once, including the replacement returned to pi; retries re-deliver the same object.
- The footer quotes the rate in force (input/output per million tokens) and names the direction: `▲ peak` above the recorded rate, `▼ off-peak` below it.
- The footer follows the window it quotes. pi emits nothing while a session is idle, so a timer armed for the next instant the quoted rate changes re-renders it. It is armed only while a status is actually on screen, from the same clock reading as that status, and cleared in `session_shutdown`.
- Only the four cost fields change and `total` is recomputed from them. Token counts are never modified.
- A malformed field keeps its default, including `active`; a malformed file warns and resolves to defaults. The extension never throws inside a message handler.

## Integration discipline

Merge only a coherent, independently usable slice: it must be complete as a user-facing capability or behavior-preserving infrastructure with a tested contract that leaves `main` usable. Keep incomplete scaffolding and dependent follow-ups on feature branches. Before merging, run `bun run check` and inspect the complete diff.

## Key Files

```
extensions/index.ts   # schedule parsing, peak detection, cost correction, status timer, command
tests/                # schedule, boundary, wrapping-window, config, and handler tests
```
