# Shared live scores

The site’s forecasts continue to use its CFBD snapshot. This optional backend supplies reported game status and actual scores, without replacing the forecast model or pretending a scheduled game is live because its kickoff time passed.

## Activation status

At the October 10 Chicago / October 11 UTC, 2026 verification checkpoint, the user-approved Big Balls Sports Data (BBS) free account is authenticated. It has the ordinary 250-call/day allowance, requires no payment card, and its key is stored privately as the Cloudflare Worker secret. The corrected cache is operational and the website endpoint is enabled in the local preview. Public GitHub Pages activation awaits the PR release.

BBS advertises free current-season FBS and FCS score coverage, but the observed responses do not establish complete live coverage. The catalog’s `league` is a **display name**, not its query slug. The normalizer accepts `NCAAF` and `NCAAF FCS`, including punctuation variations. No provider UUID is treated as a CFBD ID.

The cache service at `https://cfi-live-scores.bingoflow-support.workers.dev/scores` returned HTTP 200 with `scoreFeedVersion: 2`, fresh transport data, and a live retrieval time of **2026-10-11T02:52:28Z**. It includes the previous, current, and next Chicago catalog days, while keeping catalog metadata separate from genuine live observations. Website joins confirmed six genuine score observations. In the local browser, James Madison–Georgia Southern showed the separately reported 20–10 score alongside the explicitly labeled 31–23 CFBD snapshot result. This checkpoint demonstrates the working cached overlay; it does not guarantee full source coverage or continued freshness.

### Verified source and join coverage

Direct authenticated `/matches` samples returned `meta.source: "stored"` and the following **catalog** rows. These are stored schedule/identity data, not proof of live score updates or a claim that every row is a distinct scheduled game.

| Chicago date | Total provider rows | `NCAAF` rows | `NCAAF FCS` rows |
|---|---:|---:|---:|
| October 10, 2026 | 109 | 48 | 61 |
| October 9, 2026 | 11 | 7 | 4 |

Against the October 10 snapshot schedule, safe catalog joins cover **83 of 95 games** after rejecting tied finals. Five lower-division matchup rows lack sufficient provider team metadata for a safe join. Catalog join coverage measures identity matching, not live-score coverage. Unmatched games retain their labeled CFBD snapshot information.

Genuine live observations require BBS `/scores?league=…` **without `date` or `tz`**. Adding either parameter changes the response to the stored array route, so it cannot establish live freshness. Initial undated samples, before the cached checkpoint above, were:

| Query league | Score rows | Canonical IDs in the current catalog | Observed status and coverage |
|---|---:|---:|---|
| `ncaaf` | 13 | 7 | Six live games: four FBS and two FCS; one scheduled game. Six other source rows lack `match_id` and cannot be merged safely. |
| `ncaaf-fcs` | 12 | 0 | Old scheduled UUIDs; none match the current catalog. |

The two FCS games in the `ncaaf` live sample demonstrate some FCS live access. They do not establish complete FCS coverage, and the separate FCS sample supplied no matched live observations. Backend and frontend coverage remains explicitly partial. Source observations merge only through canonical provider UUIDs already present in the catalog; missing IDs and unmatched old IDs never become guessed team/date matches.

The catalog also contains duplicate or conflicting provider game entries. Ambiguous website matches are rejected rather than choosing a score arbitrarily. Joining the catalog to CFBD requires known team names/aliases, compatible kickoff/date, and a unique scheduled matchup; provider IDs never become CFBD IDs. The website rejects tied provider finals, including observed 0–0 placeholders. Catalog rows with unverified live claims remain unknown/stale, and retained observations keep their original source timestamps. The feed preserves the snapshot fallback for all coverage gaps.

The cached checkpoint preserves **18 unresolved source rows**: six without match IDs and twelve with old FCS IDs absent from the current catalog. Genuine FCS observations include Central Arkansas–Abilene Christian; the other verified FCS matchup, UTRGV–Southeastern Louisiana, had become final by this checkpoint. Coverage remains explicitly partial despite a successful fresh transport response. The counts above describe the recorded samples and can change on subsequent refreshes.

## Free architecture and quota

- A Cloudflare Worker checks the refresh plan every minute. Provider requests happen only when the adaptive plan says they are due; cron frequency is not provider polling frequency.
- One **SQLite-backed Durable Object** stores catalog metadata, separately timestamped live observations, and refresh reservations. The Free plan supports SQLite-backed Durable Objects; the legacy KV-backed variant is not used.
- All requests use the same object name, `college-football-global-v1`. The existing SQLite budget ledger is preserved. A synchronous transaction reserves the planned call count before fetching; the UTC-day budget cannot exceed **240 reserved calls**, even if cron and authorized manual refresh overlap. Failed and unused reservations are not refunded.
- Each active refresh requests the two undated live league feeds, `ncaaf` and `ncaaf-fcs`, without timezone parameters. It merges only live observations whose canonical provider UUIDs exist in the catalog.
- Catalog discovery covers the previous, current, and next `America/Chicago` calendar days in three date-based `/matches` calls. These supply identity/schedule metadata and upcoming kickoff windows, not live freshness.
- Discovery is due every two hours and at Chicago midnight, even when score polling is idle. The planner reserves three calls for each remaining discovery before allocating live polls. Chicago date changes are calculated with `Intl` in `America/Chicago`, so daylight-saving changes do not rely on a fixed UTC offset.
- Game windows run from kickoff through an estimated **3.5 hours plus a 15-minute final check**. The planner merges overlapping windows and considers only their remaining time before the next **00:00 UTC quota reset**. Concurrent games share one two-call live refresh; they do not each receive a separate polling budget.
- A date-only/TBD kickoff covers its entire declared Chicago day plus a possible late finish of 3.5 hours and the 15-minute final check. It is not treated as a known midnight kickoff. An exact time replaces that conservative window when available.
- After holding the catalog reserve, the remaining calls determine the affordable number of two-call score refreshes. The cadence is remaining combined window time divided by affordable refreshes, rounded up to a whole minute with a one-minute minimum. It is recalculated every minute and after each fetch, so new kickoffs, final results, and spending change the plan.
- A verified live/suspended observation updated within the last hour can extend an overdue game's window by a rolling hour. A stale catalog live claim cannot extend it. Window estimates never mark a game final; only source results do. Previous/current/next Chicago catalogs let the next UTC-day plan retain overnight games and see upcoming kickoffs.
- Use a dedicated key and avoid separate pollers: the Worker cannot account for other clients spending that key's quota. It also stops when the provider reports ten or fewer calls remaining and honors reset/backoff headers.
- A public `GET /scores` only reads cached SQLite state. Page visits, date selection, sorting, and filters never fetch BBS.
- Outside active windows, scheduled score calls stop while two-hour catalog discovery continues. A minute tick with neither operation due makes no upstream requests. At UTC reset, reservations use the new day's ledger key; previous reservation rows are preserved rather than erased or reset.
- Catalog calls ask for `limit=200&offset=0`. A full page or metadata indicating additional pages rejects discovery and flags partial coverage; the Worker retains the previous catalog. It never spends unreserved calls to follow pagination.
- The undated live route uses the provider's default page. A full 50-row response is treated as possible truncation and rejected rather than silently claimed as complete; no unreserved pagination request follows.
- Network requests have a 20-second timeout. Auth failures, throttling, malformed data, and fetch errors retain the last good board and back off. Manual requests cannot bypass the daily budget, slot, or backoff.

The SQLite tables are created by the class constructor. No D1 database or KV namespace needs provisioning. Normal refreshes write far below the Free storage write allowance. Cloudflare’s Free request/CPU/storage limits still apply; reaching a limit can make scores temporarily unavailable, so do not upgrade the account automatically.

At the recorded `2026-10-11T02:52:28Z` checkpoint, the existing ledger held 11 reserved calls and 229 remaining. The planner held 33 calls for catalog discovery, leaving 98 affordable score refreshes over 203 remaining combined active minutes. That produced a **180-second planned interval**, with the next poll around `02:55Z`. This is an example of the adaptive calculation, not a fixed polling frequency or a permanently current budget.

## Deploy and activate

Run from the repository root with the intended Cloudflare account selected. The config is `worker/live-scores/wrangler.jsonc`; the Worker name is `cfi-live-scores`.

```sh
npx wrangler deploy --config worker/live-scores/wrangler.jsonc
```

Deploying without a key is safe: cron returns `unconfigured`, and `/scores` returns an unavailable packet. Put the authorized BBS key into the interactive secret prompt; do not commit it, place it in browser JavaScript, or paste it into a shell command.

```sh
npx wrangler secret put BBS_API_KEY --config worker/live-scores/wrangler.jsonc
npx wrangler secret put REFRESH_TOKEN --config worker/live-scores/wrangler.jsonc
```

`BBS_API_KEY` authenticates upstream using `Authorization: Bearer …`. `REFRESH_TOKEN` is a separate, random admin secret for `POST /refresh`; it is never sent to the website. Set it from a password manager or another secret source. Runtime logs are disabled, and the public output excludes both secrets, raw API errors, and raw provider payloads.

Allow the next cron to load the first board, or make an authorized manual request. This Python command prompts for the admin token without echoing it or putting it in shell history:

```sh
python3 - <<'PY'
import getpass, json, urllib.request
endpoint = input('Worker URL (https://…workers.dev): ').strip().rstrip('/')
token = getpass.getpass('Private refresh token: ')
request = urllib.request.Request(endpoint + '/refresh', data=b'', method='POST',
    headers={'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(request, timeout=120) as response:
    result = json.load(response)
print({key: result.get(key) for key in ('status', 'reason', 'games', 'fetchedAt')})
PY
```

Then inspect the public `/scores` response and confirm catalog dates, canonical game IDs, genuine live observation counts, partial league coverage, per-score update times, and website joins. A catalog row marked live is not enough: it needs a canonical-ID live observation. When cached retrieval and those checks succeed, configure the website with the deployed `/scores` URL. The frontend should request the unfiltered endpoint and use its own device timezone to place games on a day.

Do not rename the Durable Object, remove its migration, recreate its namespace, or switch to multiple per-date objects during a UTC day: doing so would reset or split the provider budget. Keep the account on its Free plan.

## Public endpoint contract

`GET /scores` returns only the cached, normalized board. Optional `?date=YYYY-MM-DD` filters using the backend’s **Chicago** calendar and reports `dateCovered`; it does not cause a fetch. Invalid dates and other parameters return 400. Origin access allows the GitHub Pages origin and localhost/127.0.0.1 on port 8000. Direct read-only requests without an Origin header are allowed. CORS is not an upstream-fetch permission.

The example below illustrates the shared fields, not an assertion of complete live coverage. Catalog dates and counts describe metadata availability. Live observation coverage is separate, and a recently fetched response can still be partial or contain stale individual scores.

```json
{
  "schemaVersion": 1,
  "scoreFeedVersion": 2,
  "provider": "Big Balls Sports Data",
  "refreshedAt": "ISO time of the last successful live-feed retrieval",
  "fetchedAt": "same conservative live retrieval time",
  "catalogFetchedAt": "earliest retrieval time among the covered catalog dates",
  "providerAsOf": null,
  "status": "fresh",
  "stale": false,
  "reason": null,
  "retryAt": null,
  "staleAfterSeconds": 1800,
  "coverage": {
    "dates": ["previous Chicago day", "current Chicago day", "next Chicago day"],
    "timeZone": "America/Chicago",
    "partial": true,
    "byDate": {
      "YYYY-MM-DD": {
        "date": "YYYY-MM-DD",
        "fetchedAt": "ISO retrieval time for this date",
        "providerAsOf": null,
        "stale": false,
        "partial": false,
        "count": 0,
        "source": null
      }
    },
    "leagues": ["ncaaf", "ncaaf-fcs"]
  },
  "games": []
}
```

Each game contains:

```json
{
  "id": "provider UUID",
  "providerId": "same provider UUID",
  "date": "Chicago calendar day",
  "startDate": "ISO kickoff UTC",
  "kickoffTBD": false,
  "leagueCode": "ncaaf",
  "leagueClassification": "fbs",
  "home": {"id": "provider UUID", "name": "provider name", "aliases": [], "classification": null},
  "away": {"id": "provider UUID", "name": "provider name", "aliases": [], "classification": null},
  "status": "unknown",
  "catalogStatus": "live",
  "homeScore": null,
  "awayScore": null,
  "scoreSource": "catalog",
  "liveVerified": false,
  "scoreObservedAt": null,
  "liveLeagueCode": null,
  "retainedLiveScore": false,
  "providerAsOf": null,
  "fetchedAt": "ISO retrieval time for this row",
  "catalogFetchedAt": "ISO retrieval time for the catalog metadata",
  "stale": true,
  "unavailableReason": "live_observation_missing"
}
```

- Game status is `scheduled`, `live`, `final`, `postponed`, `canceled`, `suspended`, or `unknown`. A stored catalog claim does not verify a live state; `liveVerified` requires a genuine canonical-ID observation. The example row has a catalog live claim without that observation, so its public status is unknown and its score remains unavailable.
- Scores are nonnegative integers or null, including valid zero scores. Missing scores never become zero.
- `aliases` contains an explicitly supplied provider short name, when different. Join by known names/aliases plus kickoff/date; never guess a CFBD team ID from a provider UUID or strip arbitrary mascot words.
- `leagueClassification` describes the league feed. Both participants’ classifications remain null because a college game can cross subdivisions.
- No reliable game clock or quarter is guaranteed; neither is invented. Genuine score observations retain their own `updatedAt` time, exposed as score observation/source time. A gateway or catalog retrieval timestamp is never substituted for it.
- A successful live-feed retrieval updates the global refresh time. Catalog metadata has a separate retrieval time. Old retained observations keep their original observation and retrieval times, even when another game or the catalog refreshes successfully.
- Staleness applies separately to transport retrieval and individual observations. A fresh global response does not make an old per-score observation fresh. Unverified catalog live states remain unknown/stale rather than being displayed as current live scores.
- `scoreSource` is `catalog` or `live-feed`. `scoreObservedAt` and `providerAsOf` identify the actual source update time; `fetchedAt` identifies retrieval. When a previously verified observation is absent from a later feed, it remains attached to its original timestamps with `retainedLiveScore: true`. An active retained score becomes stale with `unavailableReason: "live_observation_not_returned"`.
- Catalog metadata ages separately at two hours; individual score observations age at 30 minutes. The adaptive refresh plan does not override these timestamp checks.
- With no successful cache, `/scores` responds 503 with `status: "unavailable"`, `stale: true`, `games: []`, and a safe reason. The frontend should preserve its snapshot schedule and explain score availability.

Coverage fields distinguish metadata from live evidence:

| Field | Meaning |
|---|---|
| `coverage.byDate` | Catalog dates, counts, retrieval times, source and staleness. |
| `coverage.byLeague` | Each live query's availability, source, retrieval/source times, `count`, `matchedRows`, `liveMatched`, missing/unknown IDs, conflicts and staleness. |
| `coverage.matchedRows` | Canonical-ID observations matched to catalog games, including scheduled observations. |
| `coverage.liveMatched` | Matched observations that actually verify live games. |
| `coverage.missingMatchIds`, `unknownMatchIds` | Rows without canonical IDs or whose IDs are absent from the catalog. |
| `coverage.conflictingMatchIds`, `unresolvedLiveRows` | Conflicting or otherwise unresolved live-source rows. |
| `coverage.unverifiedLiveGames`, `retainedLiveScores` | Catalog live claims without verification and previously verified observations retained without a new matching row. |
| `coverage.partial` | Incomplete source/identity coverage; it does not become false simply because retrieval succeeded. |

A valid but unavailable league field produces `coverage.byLeague[league].available: false` with reason `provider_live_coverage_unavailable`. It does not discard valid observations from the other league. Transport can be fresh while coverage remains partial; when both live league fields are unavailable, transport is stale.

`POST /refresh` requires the separate bearer admin secret. It returns a small result such as `refreshed`, `idle`, `backoff`, `slot_or_daily_budget_used`, `refresh_in_progress`, `offseason`, `unconfigured`, or `failed`; the actual board is read from `/scores`.

## Source contracts

- [BBS OpenAPI](https://bigballsdata.com/openapi.json): `/v1/matches` supplies date-based catalog arrays; the observed genuine `/v1/scores` contract uses `data.scores.value` only when date/timezone parameters are absent. Source documentation does not substitute for authenticated coverage checks.
- [BBS league codes](https://bigballsdata.com/docs/league-codes): NCAAF and NCAAF FCS names and query codes.
- [BBS rate limits](https://bigballsdata.com/docs/rate-limits): free quotas, UTC reset, authentication and throttle headers.
- [BBS NCAAF scoreboard guide](https://bigballsdata.com/how-to-build-an-ncaaf-scoreboard): free score contract; the guide itself is not proof of this deployment’s authenticated coverage.
- [BBS terms](https://bigballsdata.com/legal/terms): building products is permitted; raw-feed resale and key sharing are prohibited. This endpoint exposes a normalized score-only view for the website, not a raw provider feed.
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): SQLite-backed Free-plan availability and limits.
- [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): strongly consistent storage and `transactionSync` for atomic reservations.
- [Cloudflare Durable Objects setup](https://developers.cloudflare.com/durable-objects/get-started/): bindings, RPC and SQLite class configuration.
