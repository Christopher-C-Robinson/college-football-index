# Refreshing the model after a game day

The model refresh is driven by completed game days, not an unconditional daily CFBD download. The public site retains its existing GitHub Pages address.

## Completion and midnight

`Refresh model after the last final` checks every 15 minutes during August–January, offset from the top of the hour. Most checks read only the repository snapshot, completion ledger, and the already-cached score service. Reading that service makes no new BBS request. GitHub scheduling can be delayed; this is a readiness checker, not an exact-time service.

Expected games come from the deduplicated CFBD schedule. Each day is keyed by football season and its scheduled calendar date in `America/Chicago`. A late Saturday game finishing Sunday stays in Saturday's batch. Provider quota resets in UTC do not reset completion tracking. The checker retains unfinished days across missed runs and midnight.

A final requires an identified game, an explicit completed/final state, and valid non-tied scores. Canceled or postponed games are terminal only when confirmed by the source; rescheduled games move to their authoritative new scheduled day. Missing live rows and elapsed game-duration estimates never establish completion. Recent verified live or suspended activity prevents a completion refresh.

The normal model refresh waits 20 minutes after the day is observed complete. If the score provider omits a final, a bounded CFBD schedule check becomes eligible after the last plausible finish plus the reporting buffer. This timer permits confirmation; it does not invent a final. Confirmed schedules are reused in the model collection instead of downloaded twice.

No scheduled games means no new model collection. Work still pending from a previously played day can continue on an otherwise empty day.

## Statistics retries and free quota

The first refresh imports confirmed results and available team box scores. Missing required passing/rushing yards and attempt counts are tracked separately from mere box-entry coverage. Retries request only the relevant season-type/week batches, retain valid previously collected boxes when a provider response omits them, and reuse the snapshot's venue history and preseason summary. A retry with unchanged model inputs neither regenerates the snapshot nor deploys it.

Retries use persisted backoff and a finite attempt limit rather than downloading indefinitely on every checker tick. Delayed data can therefore be collected the following morning without restoring an unrelated daily refresh. An unavailable field remains explicitly missing when retry limits are reached; the model does not fabricate it.

Automatic collection checks the authenticated CFBD quota and reserves at least 50 calls, increasing the reserve for remaining scheduled game days in the month. Collection pauses through the monthly reset when the reserve cannot be protected. Failed requests count conservatively. The BBS daily quota remains independently controlled by the existing Worker ledger.

An ordinary warm-cache day in one statistics week typically costs five CFBD requests: usage, two schedules, and two box-score batches. Weekly metadata refresh, additional weeks, transient retries, or cold historical caches increase that count. A statistics-only retry normally costs three: usage plus the two subdivision box requests. The checker does not require a paid provider plan.

## Publication and recovery

`data/model-refresh-state.json` stores expected identities, completion observations, readiness/statistics attempts and deadlines, and publication state. The checker and manual season refresh share the `football-data-main` workflow concurrency lock and check out current `main` after acquiring it.

Fresh primary-source schedule corrections are retained in a bounded per-game ledger until a newer snapshot supersedes them. A moved or postponed game therefore stays corrected between checks; a missing primary row stays pending. Season-specific bootstrap dates keep earlier seasons as audit history without reopening their collection.

Changed model data, forecast archives, and a staged publication marker are committed together. The workflow explicitly requests a build of the existing GitHub Pages site because `GITHUB_TOKEN` commits do not automatically trigger Pages. It then reads the actual public `data/current-season.json` and verifies both the generation timestamp and model-input SHA-256 fingerprint. Only that confirmation marks a day published. If publication fails, the next checker retries the build and verification without making another CFBD collection.

A newer manual refresh can supersede an interrupted publication. Recovery verifies the newer public snapshot, retires the obsolete marker, and marks only days whose confirmed identities and final results still match. Changed schedules return to normal reconciliation.

The saved pregame forecast archive retains its existing policy. Explorer and game-day predictions continue to use the loaded current snapshot.

## Operations

Run a cheap plan locally (writes the completion ledger, but does not contact CFBD):

```sh
node scripts/refresh-after-games.mjs --plan-only
```

Run the automatic completion path with the existing private `CFBD_API_KEY` environment variable:

```sh
node scripts/refresh-after-games.mjs
```

The `Refresh model after the last final` workflow can also be dispatched manually to check readiness. The original `Update season data and publish site` workflow keeps `task: refresh` for an explicit full refresh and `task: backtest` for research; it no longer has an unconditional daily schedule. Keep API keys in GitHub secrets or private local environment variables.

Run a manual full refresh when activating a new football season or when the provider adds postseason/makeup games on dates absent from the bundled schedule. The automatic checker tracks known scheduled games; it cannot discover an entirely new date without a schedule update. Normal played-day refreshes retrieve the full current schedule and incorporate changes then.

### Sources

- [CFBD API tiers](https://collegefootballdata.com/api-tiers): free monthly allowance.
- [CFBD terms](https://collegefootballdata.com/terms): update timing and completeness are not guaranteed.
- [GitHub scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): default-branch execution and possible delays.
- [GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token): bot commits do not trigger another push workflow or Pages build.
- [Request a Pages build](https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build): explicit rebuild of the existing branch-published site.
