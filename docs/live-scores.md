# Shared live scores

The site's forecasts continue to use its CFBD snapshot. This optional backend supplies reported game status and actual scores. It doesn't replace the forecast model, and it never treats a scheduled game as live just because its kickoff time has passed.

The website reads one public, cached endpoint, `GET /scores`, from the `cfi-live-scores` Cloudflare Worker. Two independent producers fill that cache: the public ESPN scoreboard, which is primary and needs no account or key, and Big Balls Sports Data (BBS), a fallback that uses a free account, a private key, and the existing conservative 240-call/day ledger. Either producer can fail without stopping the other. Neither source, alone or together, guarantees complete or continuous coverage.

## Why there are two sources

On October 14, 2026, WKU at Sam Houston finished 16–3 but stayed **Scheduled** on the site. BBS live retrieval had stalled since about 2026-10-13 23:56Z, and that day's BBS catalog contained duplicated and conflicting entries. The browser was already polling the score cache, but the cache had no usable result to give it. The page also loaded the public model snapshot only once and had no automatic way to catch up, so even after CFBD later published the result, the page needed a reload to show it. Earlier, a conflicting FIU–Jacksonville State catalog entry had hidden a final in the same way until CFBD published it and the page was reloaded.

The current design addresses each failure. ESPN is polled independently of BBS, with its own persistence, schedule, and backoff, so a missing key, exhausted quota, throttling, or a BBS outage can't stop it. A unique verified ESPN observation is preferred over ambiguous catalog rows. Confirmed finals are retained so that stale scheduled or live rows can't erase them. Open tabs now check for a newer public model snapshot periodically and when they become visible again.

## Architecture

The public `GET /scores` URL is unchanged. Both producers use the existing SQLite-backed Durable Object binding, `LIVE_SCORE_CACHE` (class `LiveScoreCache`, object name `college-football-global-v1`). No D1 database, KV namespace, or paid plan is needed, and the account should stay on its Free plan.

A cron runs every minute. On each run, ESPN and BBS evaluate their own refresh plans, and a provider makes requests only when its plan says they're due, so cron frequency isn't polling frequency. Each producer keeps its own observations, retrieval times, failures, and backoff: a BBS backoff or exhausted budget doesn't delay ESPN, and an ESPN failure doesn't spend BBS calls. `GET /scores` reads only cached state, so page visits, date changes, sorting, and filters never contact ESPN or BBS.

### ESPN producer

The producer requests the public college-football scoreboard separately for group 80 (FBS) and group 81 (FCS), one calendar date per request, with `limit=100`. Discovery covers the previous, current, and next days as seen in Eastern, Chicago, and UTC time, requesting only the dates and groups that are due (at most 12 boards per run), so the number of requests per cycle varies. In direct testing, `limit=1000` silently returned 25 events and a date-range request returned HTTP 400, so neither form is used or treated as complete coverage. A game between an FBS and an FCS team can appear in both groups; the producer dedupes it into one game.

A response that reaches the requested limit, or otherwise looks incomplete, is treated as possibly incomplete. The producer never infers that a game ended or was removed because a response omitted it. Omitted games keep their earlier observations and timestamps and age normally.

Discovery runs every 10 minutes. From 10 minutes before kickoff, the boards holding an unresolved game are polled about every minute for its first 48 hours, including after its original Chicago date passes midnight; the game stays on that original date. After 48 hours, an unresolved game falls back to slower 10-minute recovery checks until ESPN explicitly reports a terminal state (final, canceled, or postponed). A TBD kickoff (ESPN `timeValid: false`) has no exact time, so planning uses its declared board date and treats the whole day conservatively rather than inventing a kickoff. Failures back off per board, and an ESPN rate limit pauses the ESPN source; that bounded backoff can stretch either cadence, so one minute is the normal pace, not a guarantee during an outage. When more boards are due than the 12-request cap allows, 4 slots stay reserved for discovery and recovery boards and the rest rotate by oldest attempt, so deferred boards are picked up on later runs and no unresolved game is abandoned. Elapsed time, estimated game length, and the game clock never create a final; only an explicit provider status does.

### BBS fallback

The BBS producer keeps its existing behavior and budget. It shares the Durable Object's SQLite budget ledger, where a synchronous transaction reserves calls before any fetch. The UTC-day total can't exceed 240 reserved calls, even if cron and an authorized manual refresh overlap, and failed or unused reservations aren't refunded. The producer also stops when the provider reports ten or fewer calls remaining and honors reset and backoff headers. Use a dedicated key, because the Worker can't account for calls made elsewhere.

Live observations come from the two undated league feeds, `ncaaf` and `ncaaf-fcs`, sent without `date` or `tz` parameters; adding either switches BBS to its stored-data route. Observations merge only through canonical provider UUIDs already present in the catalog. Catalog discovery makes three date-based `/matches` calls for the previous, current, and next Chicago days, every two hours and at Chicago midnight. These supply identity and schedule metadata, not live freshness. Catalog calls use `limit=200&offset=0`; a full page, or metadata showing more pages, rejects that discovery and keeps the previous catalog. A full 50-row live response is treated as possibly truncated, and no unreserved pagination follows.

The planner spreads remaining calls across live and result windows until the next 00:00 UTC reset. A live window runs from kickoff through an estimated 3.5 hours plus a 15-minute final check, and named result checks cost one extra call per date rather than per game. Timers never mark a game final, and a stale catalog live claim can't extend a window. Requests time out after 20 seconds; authentication failures, throttling, malformed data, and fetch errors keep the last good BBS observations and start BBS backoff. The catalog's `league` field is a display name (`NCAAF`, `NCAAF FCS`), not a query slug. The catalog can contain duplicate or conflicting provider entries, and the site never picks one arbitrarily.

## Matching and source precedence

A feed row matches a scheduled CFBD game only when both teams match uniquely owned names or explicit aliases and the row falls within the game's kickoff window. Explicit aliases cover supported lower-division opponents whose mascot names are missing from CFBD team metadata; fuzzy name matching isn't used. Home and away identity is normalized rather than required to be in one fixed order: if a provider lists the teams in the reverse order, the matcher accepts the row and swaps its scores into the snapshot's home/away order. For a timed kickoff, the window allows a modest shift on the same game; for a date-only or TBD kickoff, the row must fall on the same scheduled date. Provider IDs from either source never become CFBD IDs.

ESPN and BBS rows are resolved separately, and conflicts inside one source are never settled by the newest timestamp. One matching row from a source is that source's candidate, including a unique date-only match. Several matching rows from one source resolve only when they describe the same final: every row must share one precise timed kickoff and any reported league, every final must give the same scores in the snapshot's home/away order, and any remaining rows must be unverified, scoreless scheduled or unknown stubs, which never supply the result. Because that check needs a precise timed kickoff, multiple candidates for a date-only game stay unresolved. Any other combination, such as two different finals, a final beside an active status, or different timed kickoffs, leaves the game unavailable from that source rather than taking a guessed score.

Between sources, a unique verified ESPN scored observation is preferred over BBS, even when the BBS catalog is ambiguous. A verified ESPN final remains the answer when it's stale. A stale ESPN live or suspended score yields to a valid BBS final or to a fresh verified BBS score. ESPN's canceled or postponed status takes precedence only when that ESPN observation is fresh. If ESPN itself is ambiguous and any of its candidates is a verified score or a fresh cancellation or postponement, the game stays unavailable rather than falling back to BBS; otherwise BBS supplies the result if it resolves cleanly.

Tied finals are rejected, including observed 0–0 placeholders, and missing scores never become zero. A final already in the CFBD snapshot isn't downgraded by a non-final row, or replaced by a contradictory row that is stale or no newer than the snapshot. A valid, fresh correction observed after the snapshot was generated can still overlay a snapshot final.

### Records and forecasts

Displayed overall, FBS, and FCS records and season-record outlooks include uniquely matched, valid final scores. Each scheduled game counts at most once, even after CFBD imports the same result, and live or incomplete scores can't create a win or loss. Corrections to cached displayed records follow the same source precedence as score matching: a verified ESPN final can replace a previously cached BBS result even when ESPN's retrieval is older, a later lower-priority BBS row can't revert it, and results from the same source still only move forward in time. Projected scores, win probabilities, rankings, and snapshot-fit statistics keep using the loaded model snapshot until the next completed-game-day refresh. Observed scores appear separately from projections, with their own labels.

## Status, timing, and retention

Status is one of `scheduled`, `live`, `final`, `postponed`, `canceled`, `suspended`, or `unknown`, and a catalog claim alone doesn't verify a live state. The site never invents a game clock, quarter, or final. After kickoff, a game with no verified score shows **Awaiting score update** instead of staying **Scheduled**, and it isn't shown as live or final.

Retrieval time (`fetchedAt`) is reported separately from any upstream observation time (`scoreObservedAt`, `providerAsOf`); a retrieval time is never presented as a source update or upstream observation. ESPN's scoreboard carries no per-score timestamp, so ESPN rows report both observation fields as null and `fetchedAt` as the actual retrieval. BBS rows can carry a genuine upstream timestamp. Transport freshness and observation freshness are tracked separately, so a fresh response doesn't make an old score fresh, and the UI says when a score is stale.

The ESPN producer normally keeps resolved games for 35 days, measured from the later of kickoff and final retrieval. If the cache reaches its 3,000-game cap, resolved games past 30 days on that same clock may be evicted early; resolved games within 30 days and all unresolved games are protected, and any excess beyond the cap is reported rather than deleting protected rows. A game first confirmed final long after kickoff (for example, 40 days later) therefore isn't pruned immediately and gets the full retention and cap protection from its final retrieval. That keeps confirmed finals visible in reopened tabs, Team Explorer schedules, and recent past dates on Today's games. A later stale scheduled or live row can't overwrite a cached final, and a confirmed final keeps its original retrieval times and stays usable, so the UI can show its age; providers aren't promised to recheck old games. Unresolved games never expire, and omission from a later response never finalizes or drops a game. The cache isn't a complete archive; older results come from the CFBD snapshot. A partial board is handled conservatively: a game missing from a partial response keeps its prior state rather than being dropped, expired early, or finalized.

## Browser refresh

The page polls the cached `/scores` endpoint, and a hidden or resumed tab refreshes scores immediately when it becomes visible again.

The page also keeps the public model snapshot current. While the page is visible on a score-using view (Rankings, Today's games, Matchups, or Team Explorer with a selected team), it sends a cheap HTTP `HEAD` request at most every 60 seconds, and again on visibility or `pageshow` resume. A full `GET` follows when the `ETag` or `Last-Modified` validators change, with full downloads spaced at least 5 minutes apart. If `HEAD` fails or returns no comparable validators, a bounded slow fallback downloads the full file about every 30 minutes, even when it hasn't changed. Only a strictly newer, compatible snapshot is applied. Visitors on public data get it automatically, with selections and scroll position kept; the swap waits while someone is typing or a dropdown is open. A deliberately imported dataset stays selected; the page shows that a newer public snapshot exists, and "Return to public snapshot" switches to it. This model check is separate from the site release check, which offers a Refresh button when the site's code changes.

## Failure matrix

| Condition | ESPN producer | BBS producer | Website |
|---|---|---|---|
| BBS key missing | Runs normally | `unconfigured`; no calls | Uses ESPN observations |
| BBS quota used, throttled, or in backoff | Runs normally | Waits; keeps last good data | Uses ESPN; BBS data ages |
| ESPN omits a game or date, or looks incomplete | Keeps prior observations and timestamps; coverage partial | Runs normally | Unique verified observation, else labeled prior state or **Awaiting score update** |
| ESPN requests fail | Own backoff; cached rows age | Runs normally | Cached ESPN finals stay; otherwise BBS when precedence allows |
| Conflicting rows within ESPN | Unavailable from ESPN | Runs normally | Unavailable if any ESPN candidate is a verified score or fresh cancellation/postponement, even when BBS has a row; otherwise a clean BBS result, the snapshot result, or unavailable |
| Conflicting rows within BBS | Runs normally | Unavailable from BBS | ESPN's result if unique, the snapshot result, or unavailable |
| Game finishes after Chicago midnight | Normally polls about every minute until terminal | Existing overnight windows | Stays on its original date |
| Game still unresolved 48 hours after kickoff | 10-minute recovery checks until terminal | Existing behavior | Labeled prior state or **Awaiting score update**; never a timer-made final |
| Both providers fail | Backoff | Backoff | Retained finals and stale-labeled scores; else snapshot schedule |
| No cache has ever succeeded | — | — | `/scores` returns 503 `unavailable`; snapshot site stays usable |

## Regression checklist

Changes to the producers or the frontend overlay should keep these cases working:

1. Missing BBS key: ESPN finals appear and BBS reports `unconfigured`.
2. BBS out of quota or in backoff: ESPN keeps updating active games at its normal one-minute cadence.
3. Omitted or incomplete ESPN date: earlier observations keep their timestamps; nothing is marked final or removed.
4. Same game in groups 80 and 81: counted once.
5. Provider lists teams in reversed order: scores are swapped into snapshot order.
6. Unique date-only match: shown. Several date-only candidates: unresolved.
7. Conflicting finals within one source: unavailable from that source, never chosen by timestamp; an ambiguous verified ESPN result keeps the game unavailable even when BBS has a row.
8. Verified ESPN final beside a duplicated or conflicting BBS catalog (the WKU–Sam Houston case): the ESPN final shows, including when stale.
9. Stale ESPN live score beside a BBS final or fresh verified BBS score: BBS wins.
10. Late kickoff finishing after Chicago midnight: polled until final and kept on its original date.
11. Game unresolved 48 hours after kickoff: moves to 10-minute recovery checks and keeps them until an explicit terminal status; it isn't abandoned or finalized.
12. TBD kickoff: planned from its declared board date without an invented kickoff time.
13. Cached ESPN final, past day reloaded within the protected 30 days: still shown, including in the unfiltered `/scores` response; stale rows don't replace it. A final first confirmed 40 days after kickoff isn't pruned immediately; its retention and cap protection run from that final retrieval.
14. Kickoff passed with no verified score: **Awaiting score update**, never a timer-made final.
15. New public model while a score view is open: a `HEAD` validator change triggers a `GET`, which applies it while keeping selections and scroll (deferred while typing); an imported dataset stays selected with a notice. Without usable validators, only the bounded 30-minute fallback downloads.

## Limitations

Neither ESPN nor BBS guarantees availability, completeness, or timing. ESPN's scoreboard is a public endpoint, not a supported or contracted API, and the behavior described here comes from observation and could change. Actual FBS and FCS coverage from both sources is partial and hasn't been confirmed game by game. Two independent sources reduce the chance that one upstream failure hides a finished game, but scores can still be missing or late if both fail, or wrong if a provider reports wrong data. Cloudflare's Free request, CPU, and storage limits still apply and can make scores temporarily unavailable; don't upgrade the account automatically.

## Deploy and activate

Run these from the repository root with the intended Cloudflare account selected. The config is `worker/live-scores/wrangler.jsonc` and the Worker is `cfi-live-scores`.

```sh
npx wrangler deploy --config worker/live-scores/wrangler.jsonc
```

The ESPN producer needs no secret, so deploying without a BBS key is safe; only BBS reports `unconfigured`. To enable the fallback and manual refresh, enter each secret at Wrangler's interactive prompt. Don't commit them, put them in browser JavaScript, or paste them into a shell command.

```sh
npx wrangler secret put BBS_API_KEY --config worker/live-scores/wrangler.jsonc
npx wrangler secret put REFRESH_TOKEN --config worker/live-scores/wrangler.jsonc
```

`BBS_API_KEY` authenticates to BBS with `Authorization: Bearer …`. `REFRESH_TOKEN` is a separate random admin secret for `POST /refresh`, taken from a password manager or other secret source and never sent to the website. Runtime logs are disabled, and public output excludes both secrets, raw API errors, and raw provider payloads.

To load the first board, wait for the next cron run or make an authorized manual request. This command prompts for the token without echoing it or saving it to shell history:

```sh
python3 - <<'PY'
import getpass, json, urllib.request
endpoint = input('Worker URL (https://…workers.dev): ').strip().rstrip('/')
token = getpass.getpass('Private refresh token: ')
request = urllib.request.Request(endpoint + '/refresh', data=b'', method='POST',
    headers={'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(request, timeout=120) as response:
    result = json.load(response)
fields = ('status', 'reason', 'games', 'fetchedAt', 'boards', 'succeeded', 'failed')
print('status:', result.get('status'))
for name in ('espn', 'bbs'):
    summary = result.get(name) or {}
    print(name + ':', {key: summary.get(key) for key in fields if key in summary})
PY
```

Then read the public `/scores` response and check each source's coverage, retrieval times, conflicts, and any upstream score times. A catalog row marked live isn't enough; it needs a verified observation.

`data/live-scores-config.json` holds only the public `/scores` URL. The frontend requests the unfiltered endpoint and places games on a day using the device's timezone. Don't rename the Durable Object, remove its migration, recreate its namespace, or split it into per-date objects: any of these would reset or split the BBS budget and discard retained finals.

## Public endpoint contract

`GET /scores` returns only the cached, normalized board. Without a date it returns the entire retained archive plus every pending game; only ESPN discovery is limited to the ±1-day window across Eastern, Chicago, and UTC. The optional `?date=YYYY-MM-DD` filters by the backend's Chicago calendar, including cached past dates, and never triggers a fetch; invalid dates and other parameters return 400. Its `dateCovered` means some source has identity or cached data for that date, not that every game is covered or final. Cross-origin reads are allowed from the GitHub Pages origin and from localhost and 127.0.0.1 on port 8000, and direct requests without an `Origin` header are allowed. CORS doesn't grant permission to fetch upstream.

The packet keeps `schemaVersion: 1` with `scoreFeedVersion: 2`. `coverage.bySource.espn` and `coverage.bySource.bbs` independently describe each producer's status, staleness, retrieval times, failures, and backoff. ESPN coverage also lists its boards (group, date, event and accepted counts, quarantined rows, `truncated`, completeness) and its polling schedule. A fresh top-level envelope means at least one producer is fresh; it doesn't freshen the other producer's rows, which keep their own `stale` flags.

Each game identifies the source of its score separately from catalog metadata. ESPN rows have `sourceProvider: "ESPN"`, `scoreSource: "scoreboard"`, and `liveVerified: true` for a valid live, final, or suspended score; their `providerAsOf` and `scoreObservedAt` are null and `fetchedAt` is the actual retrieval (see [status, timing, and retention](#status-timing-and-retention)). An ESPN row that a later board omitted is marked `retained: true` and keeps its original timestamps; older BBS rows use `retainedLiveScore` for the same idea. An active score that isn't confirmed again becomes stale. Scores are nonnegative integers or null, and valid zeros are kept. `coverage.partial` stays true whenever source or identity coverage is incomplete; a successful retrieval doesn't clear it. When present, `leagueClassification` describes the source feed or group (compact ESPN rows carry `leagueCode` instead); participants' classifications are never asserted and stay null because a game can cross subdivisions. With no successful cache from either source, `/scores` responds 503 with `status: "unavailable"`, `stale: true`, `games: []`, and a safe reason.

`POST /refresh` requires the bearer admin secret and runs both producers independently. It returns a top-level `status` plus separate `espn` and `bbs` summaries. Each summary has its own status, such as `refreshed`, `partial`, `catalog_refreshed`, `waiting`, `backoff`, `refresh_too_soon`, `slot_or_daily_budget_used`, `refresh_in_progress`, `offseason`, or `failed`. `unconfigured` applies only to the BBS summary when its key is missing; ESPN still runs. Read the board itself from `/scores`.

## Cancellation overrides

When an official school announcement confirms a cancellation that CFBD is missing, `data/game-status-overrides.json` records it with the exact season and game ID, home and away identities, source URL, verification time, and reason. Synchronization applies these before modeling or archiving, reports them in dataset metadata, and keeps per-game provenance. Every active-season override must match its exact scheduled game, or the refresh fails before replacing the public snapshot. A cancellation supplies no score or win/loss and is excluded from season projections; a valid played final supersedes it and is reported as doing so. The current override marks the October 10 West Florida–Northeastern State game canceled, based on the schools' weather announcement, with no makeup scheduled.

## Model refresh after the last final

The score cache supplies completion evidence to the model-completion checker, from either source. An ESPN final doesn't make model statistics ready or publish a model: CFBD must still explicitly confirm the day's finals, and collection waits for the reporting buffer. See [completion tracking, quota, and publication recovery](game-day-refresh.md).

## Source contracts

- [BBS OpenAPI](https://bigballsdata.com/openapi.json): `/v1/matches` returns date-based catalog arrays; the observed live `/v1/scores` contract uses `data.scores.value` only without date and timezone parameters.
- [BBS league codes](https://bigballsdata.com/docs/league-codes), [rate limits](https://bigballsdata.com/docs/rate-limits), and [terms](https://bigballsdata.com/legal/terms): building products is permitted; reselling the raw feed and sharing keys are prohibited. This endpoint exposes a normalized, score-only view.
- ESPN scoreboard: no supported API documentation is relied on. Groups 80 and 81, `limit=100`, the 25-event result at `limit=1000`, and HTTP 400 for date ranges are observed behavior that could change.
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): Free-plan availability, limits, and `transactionSync` for atomic reservations.
