# home-manager

## Testing

- `npm test` runs the suite (`node --require ts-node/register --test server/**/*.test.ts`, Node's built-in test runner — no extra test framework dependency).
- Tests are scenario-level, not line-by-line: they lock down *requirements* (what a kill switch does, what manual-off preservation does at the room and light level, what drift-correction does and doesn't touch, what a smart scene never gets) rather than exercising every branch. When adding scheduler behavior, prefer one new scenario test over several micro-tests of internal steps.
- `server/schedules.test.ts` tests `processSchedule` (the per-room per-tick decision, exported from `server/schedules.ts` specifically so it's reachable without going through the full `tick()` orchestration — file I/O, bridge fetches, the tick loop itself). It mocks `server/hue.ts`'s bridge-touching exports by reassigning them on the shared CJS module object (`import hue = require('./hue')`, not `import * as hue`, since only the `require` form is mutable for this) — no mocking library needed.
- **Claude should always run `npm test` (and `npx tsc --noEmit -p .`) to verify a change before reporting it as done** — this is a hard requirement here, not a suggestion. Verification means the suite actually ran and passed, not that the change looks correct on inspection.
- A pre-push git hook runs the suite and blocks the push on failure. It's installed via `.githooks/pre-push`, wired up by `git config core.hooksPath .githooks` (runs automatically on `npm install` via the `prepare` script in package.json). Don't bypass it with `--no-verify`.

## Comments

- Don't add a comment that just restates what a scenario test already documents (a comment explaining "kill switch turns the room off" next to code a test named exactly that already covers is redundant — delete it, not both).
- Do keep comments for things a test can't express: *why* a design choice was made (e.g. why breaker-only rooms don't get manual-off protection), external-system quirks (the Hue bridge rounding `ct` on readback, a smart scene restarting its cycle if re-activated), or non-obvious timing (the 500ms sleep before restoring off-lights).
- When behavior changes, check whether an existing comment now duplicates a new test and trim it rather than leaving both.

See [docs/scheduling-incident-history.md](docs/scheduling-incident-history.md) for the incident history that shaped a lot of this design (kill switch, manual-off preservation, edge-triggered vs. drift-corrected scene application).
