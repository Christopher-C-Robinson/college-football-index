# Shared live scores

The site’s forecasts continue to use its CFBD snapshot. This optional backend supplies reported game status and actual scores, without replacing the forecast model or pretending a scheduled game is live because its kickoff time passed.

## Activation status

The implementation uses the published Big Balls Sports Data (BBS) contract. As of the October 10, 2026 verification checkpoint, the user-approved free account is created and authenticated. It has the ordinary 250-call/day allowance, requires no payment card, and its key is stored privately as the Cloudflare Worker secret. Authenticated provider responses include both expected college leagues. These steps establish account and source access; a successful cached Worker response is still required before enabling the website feed.

BBS advertises free current-season FBS and FCS score coverage. The response’s `league` is a **display name**, not its query slug. This normalizer accepts the documented `NCAAF` and `NCAAF FCS` display names, including punctuation variations. An unfamiliar NCAA league causes an explicit coverage error instead of silently disappearing. No provider UUID is treated as a CFBD ID.

The cache service is deployed at `https://cfi-live-scores.bingoflow-support.workers.dev/scores`. Its first successful cached board is still pending. A network-routing fix has been deployed; the observed retry time is `2026-10-11T02:42:32Z`. That retry time is a checkpoint, not evidence that retrieval has succeeded. The website endpoint remains unset until the public `/scores` cache and website joins are confirmed operational.

### Verified source and join coverage

Direct authenticated samples produced the following provider rows. These are rows in the source response, not a claim that every row is a distinct game in the website schedule.

| Chicago date | Total provider rows | `NCAAF` rows | `NCAAF FCS` rows |
|---|---:|---:|---:|
| October 10, 2026 | 109 | 48 | 61 |
| October 9, 2026 | 11 | 7 | 4 |

Against the October 10 snapshot schedule, exact safe joins found **82 of 95 games**: 44 of 46 in the FBS group and 38 of 44 in the FCS group. Five additional lower-division matchup rows lack sufficient provider team metadata for a safe join. This is observed coverage for these samples, not a guarantee for every day or season. Unmatched games retain their labeled CFBD snapshot information.

The samples also contain duplicate or conflicting provider game entries. Ambiguous matches are rejected rather than choosing a score arbitrarily. A join requires known team names/aliases, compatible kickoff/date, and a unique scheduled matchup; provider IDs never become CFBD IDs. A complete backend board can therefore still have frontend coverage gaps. The website also rejects tied provider finals, including observed 0–0 placeholders. Live activation must preserve the snapshot fallback for those gaps.

## Free architecture and quota

- A Cloudflare Worker runs a cron every 12 minutes during August–January.
- One **SQLite-backed Durable Object** stores the last complete normalized board and all refresh reservations. The Free plan supports SQLite-backed Durable Objects; the legacy KV-backed variant is not used.
- All requests use the same object name, `college-football-global-v1`. Its synchronous SQLite transaction reserves one slot and two provider calls before fetching. A UTC-day budget cannot exceed **240 reserved calls**, even if cron and authorized manual refresh overlap. Failed and unused reservations are not refunded.
- Two requests cover the previous and current calendar days in `America/Chicago`. Each uses the all-league `american_football` query; the Worker retains college games and discards NFL games. This catches Saturday night games still running after midnight without four separate FBS/FCS requests.
- The 120 possible cron slots × two requests fit below BBS’s ordinary free 250/day allowance. Use a dedicated key and avoid separate pollers: the Worker cannot account for other clients spending that key’s quota. It also stops when the provider reports ten or fewer calls remaining and honors reset/backoff headers.
- A public `GET /scores` only reads cached SQLite state. Page visits, date selection, sorting, and filters never fetch BBS.
- Discovery runs after each Chicago calendar-day change and at least every two hours, so an initially empty or revised board is not ignored all day. Further refreshes run when a cached game is live/suspended, its scheduled time is TBD, or a scheduled kickoff is within 45 minutes before through six hours after kickoff. Idle slots make no upstream requests.
- Each call asks for `limit=200&offset=0`. A full page or metadata indicating additional pages rejects the batch; the Worker retains the last complete board and flags partial coverage. It never spends unreserved calls to follow pagination.
- Network requests have a 20-second timeout. Auth failures, throttling, malformed data, and fetch errors retain the last good board and back off. Manual requests cannot bypass the daily budget, slot, or backoff.

The SQLite tables are created by the class constructor. No D1 database or KV namespace needs provisioning. Normal refreshes write far below the Free storage write allowance. Cloudflare’s Free request/CPU/storage limits still apply; reaching a limit can make scores temporarily unavailable, so do not upgrade the account automatically.

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
with urllib.request.urlopen(request, timeout=55) as response:
    result = json.load(response)
print({key: result.get(key) for key in ('status', 'reason', 'games', 'fetchedAt')})
PY
```

Then inspect the public `/scores` response and confirm its date coverage, counts, FBS/FCS display names, score/status fields, and team joins. When those checks succeed, configure the website with the deployed `/scores` URL. The frontend should request the unfiltered endpoint and use its own device timezone to place games on a day.

Do not rename the Durable Object, remove its migration, recreate its namespace, or switch to multiple per-date objects during a UTC day: doing so would reset or split the provider budget. Keep the account on its Free plan.

## Public endpoint contract

`GET /scores` returns only the cached, normalized board. Optional `?date=YYYY-MM-DD` filters using the backend’s **Chicago** calendar and reports `dateCovered`; it does not cause a fetch. Invalid dates and other parameters return 400. Origin access allows the GitHub Pages origin and localhost/127.0.0.1 on port 8000. Direct read-only requests without an Origin header are allowed. CORS is not an upstream-fetch permission.

```json
{
  "schemaVersion": 1,
  "provider": "Big Balls Sports Data",
  "refreshedAt": "ISO time of the last successful complete retrieval",
  "fetchedAt": "same conservative retrieval time",
  "providerAsOf": null,
  "status": "fresh",
  "stale": false,
  "reason": null,
  "retryAt": null,
  "refreshIntervalSeconds": 720,
  "staleAfterSeconds": 1800,
  "coverage": {
    "dates": ["previous Chicago day", "current Chicago day"],
    "timeZone": "America/Chicago",
    "partial": false,
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
  "status": "scheduled",
  "homeScore": null,
  "awayScore": null,
  "providerAsOf": null,
  "fetchedAt": "ISO retrieval time",
  "stale": false
}
```

- Game status is `scheduled`, `live`, `final`, `postponed`, `canceled`, `suspended`, or `unknown`. Only the provider status determines live/final state.
- Scores are nonnegative integers or null, including valid zero scores. Missing scores never become zero.
- `aliases` contains an explicitly supplied provider short name, when different. Join by known names/aliases plus kickoff/date; never guess a CFBD team ID from a provider UUID or strip arbitrary mascot words.
- `leagueClassification` describes the league feed. Both participants’ classifications remain null because a college game can cross subdivisions.
- The free match schema does not supply a reliable game clock or quarter. Neither is invented. Provider timestamps remain null when unavailable; the gateway’s response timestamp is not substituted for a score timestamp.
- A complete successful two-date batch updates `refreshedAt`. A failure leaves it unchanged. Per-date and per-game `fetchedAt` remain attached to their own retrieval.
- The Worker marks transport data stale at 30 minutes, immediately after a failed refresh, or when the provider itself reports stale data or a cache age of at least 30 minutes. Fresh retrieval does not establish how recently the provider updated an individual score when its source timestamp is absent.
- With no successful cache, `/scores` responds 503 with `status: "unavailable"`, `stale: true`, `games: []`, and a safe reason. The frontend should preserve its snapshot schedule and explain score availability.

`POST /refresh` requires the separate bearer admin secret. It returns a small result such as `refreshed`, `idle`, `backoff`, `slot_or_daily_budget_used`, `refresh_in_progress`, `offseason`, `unconfigured`, or `failed`; the actual board is read from `/scores`.

## Source contracts

- [BBS OpenAPI](https://bigballsdata.com/openapi.json): `/v1/matches`, sport/date/timezone parameters, always-array match response, status and score fields, pagination.
- [BBS league codes](https://bigballsdata.com/docs/league-codes): NCAAF and NCAAF FCS names and query codes.
- [BBS rate limits](https://bigballsdata.com/docs/rate-limits): free quotas, UTC reset, authentication and throttle headers.
- [BBS NCAAF scoreboard guide](https://bigballsdata.com/how-to-build-an-ncaaf-scoreboard): free score contract; the guide itself is not proof of this deployment’s authenticated coverage.
- [BBS terms](https://bigballsdata.com/legal/terms): building products is permitted; raw-feed resale and key sharing are prohibited. This endpoint exposes a normalized score-only view for the website, not a raw provider feed.
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): SQLite-backed Free-plan availability and limits.
- [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): strongly consistent storage and `transactionSync` for atomic reservations.
- [Cloudflare Durable Objects setup](https://developers.cloudflare.com/durable-objects/get-started/): bindings, RPC and SQLite class configuration.
