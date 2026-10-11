# College Football Index

A neutral, transparent analysis site for every FBS and FCS team. One connected game graph lets fans compare results across subdivisions, conferences, and schedules. Every team uses the same model, filters, and evidence standards.

**Live site:** [College Football Index](https://christopher-c-robinson.github.io/college-football-index/)

## Using the site

- **Rankings:** the default dashboard ranks the full FBS/FCS field by each team’s average neutral-site win chance against every other rated team. Filters hide teams without recalculating or renumbering the full-field ranking. The board also offers CSV export and a compact current-snapshot fit summary.
- **Today’s games:** browse the loaded FBS/FCS schedule by your device’s local date, with kickoff times in the displayed timezone and TBD dates kept as scheduled calendar dates. Sort by the highest-ranked team, best combined ranks (lowest sum of both global ranks), closest projected margin, highest projected total, or kickoff. Filter games involving a subdivision, conference group (Power Four, Non-Power Four, or Other FBS), or conference, and search by team name or abbreviation. Overall ranks stay fixed across filters; scores and probabilities use the active simulator, actual venue, and current snapshot. When the free scoreboard is configured, matched games show separately fetched scores and status with update times; unmatched games retain their labeled snapshot results. Lower-division opponents remain visible with an explicit forecast gap. Expand a game’s forecast details for the shared middle-80% margin graphic, including the actual-result marker for completed games; these retrospective comparisons use current inputs that include those results. Date navigation uses separate arrow, date, and Today controls; a clipped native date input supplies the picker beneath a fixed visible date and calendar icon, avoiding Safari’s editor overflow; the native editor becomes visible inside that same clipped field while focused for keyboard entry; win-chance bars and stadium labels are centered beneath the matchup.
- **Team explorer:** choose a team for its season outlook, adjusted passing/rushing strengths, and full-width schedule forecasts. The selection stays during the browser session; “Clear team” restores the neutral theme.
- **Matchups:** one searchable team pair controls the automatic simulator and expandable comparison. Changes to the rankings board still reset the matchup to its top two teams on a neutral field.
- **Model & data:** historical accuracy, full current-fit metrics, methodology, snapshot freshness, and imports. Imported-data warnings also appear in the header.

Team logos come from CFBD metadata and appear in rankings, team profiles, schedules, and matchup results. All 266 teams in the bundled snapshot have logo links. Click a team logo to open its explorer; standalone logos also support Enter and Space. Initials remain actionable if an image is missing or cannot load.

On phones, rankings become labeled team cards and schedule analytics stack into one column. Wide charts and detailed tables scroll inside their panels; the map centers the selected team and keeps its logos readable. Map markers use ordinary HTML images and buttons over the SVG axes, sharing the same logo loading and fallback behavior as team cards. Search fields preserve typed queries when the keyboard changes the visible viewport, and touch selections dismiss the keyboard. Controls and disclosure rows have larger tap targets.

The **Strength & schedule** logo map plots existing team power against average opponent power, follows board filters, and opens the explorer when a logo is selected. Its FBS/FCS legend checkboxes filter the graph and its searchable picker without changing rankings or predictions; graph axes stay fixed while toggling. The searchable picker highlights a team while staying on the map; blue and copper logo borders distinguish FBS and FCS. The **Season at a glance** chart plots the selected team's current-snapshot win chance for each game with actual W/L/T results. Missing forecasts remain gaps. Schedule headers show both teams and logos, with away on the left, home on the right, and the result or projected favorite in the center; neutral games are labeled separately.

## What it measures

- **Neutral matchup ranking:** run the active deterministic forecast for every pair of rated FBS/FCS teams on a neutral field, then average each team’s win probabilities across the full field. Higher averages rank first. This uses the forecast’s conference-aware strength and fitted passing/rushing matchup effects, without home-field advantage. The displayed average describes performance against the field, not the chance of winning a specific game. See [ranking method](docs/neutral-matchup-rankings.md).
- **Game power:** iterative opponent-adjusted scoring across FBS and FCS, with game-specific home and road effects estimated from five seasons, a 28-point margin cap, and a two-game prior toward the combined field average. It remains a supporting statistic rather than the board’s ordering formula.
- **Efficiency:** yards per play, third-down performance, and turnover margin from available box scores. Missing categories are omitted rather than filled with guesses.
- **Résumé:** opponent power plus wins above the model's expected wins against each schedule.
- **Data coverage:** rated FBS/FCS result count and usable box-score count, shown separately beside the rating. These are sample counts, not confidence probabilities.
- **Current model fit:** the Rankings dashboard summarizes completed-game comparisons beside snapshot coverage; Model & data contains the full report. The site automatically simulates every completed rated matchup once with the loaded snapshot and its actual venue. It reports winner matches, margin error, per-team score error, probability scores, interval coverage, and FBS/FCS splits. Results used to fit ratings are included, so these are current-fit comparisons rather than pregame accuracy. Dataset changes recalculate the report; board filters do not change it.
- **Opponent-adjusted units:** passing offense/defense and rushing offense/defense are jointly fitted over the same FBS/FCS schedule, weighted by reported attempts and shrunk toward common priors. Team explorer, simulator, and schedule views explain each unit's strength and the specific offense-versus-defense matchup, with rates, ranks and evidence available in supporting detail. Forecast `2.2.0` retains the evaluated passing/rushing correction. See [unit definitions and evaluation](docs/opponent-adjusted-units.md).
- **Conference-aware forecasts:** the simulator and schedule jointly estimate team and conference strength from results, so limited team evidence can draw support from its conference's games. Every FBS/FCS conference uses the same formula; independents remain unpooled. This replaces the forecast's power estimate rather than adding a conference bonus. Board rankings now use the active forecast in every neutral matchup; the original core power remains available as supporting context. See [conference results and activation](docs/conference-results.md).
- **Filters:** FBS + FCS, either subdivision, Power Four, Non-Power Four, Other FBS, and individual conferences. Filters change which teams appear, never which games feed the ratings.
- **Team comparison:** compare any two loaded teams by power, opponent power, expected wins, wins above expectation, efficiency, raw scoring margin, and estimated home-road swing. The comparison and simulator default to the current board’s top two ranked teams on initial load and whenever filters or data change; the simulator resets to neutral site and runs automatically. Changing either simulation team or its venue also updates results automatically. Manual choices stay available between board updates.
- **Matchup simulator:** run 10,000 hypothetical outcomes for two teams at a neutral site or either team's home field. The spread combines conference-aware adjusted power, matchup-specific home/road effects, and a historically fitted correction for opposing passing/rushing units. Current scoring and points-allowed rates supply the unchanged score-total model, with greater rating uncertainty for teams with fewer results. Missing required unit evidence omits the passing/rushing correction. A team with no current-season Division I results uses the previous season's power and scoring summaries when available, with that source labeled explicitly.
- **Season projections:** select any team in Team Explorer to automatically run the hypothetical simulator for every listed matchup using the current loaded snapshot, including Week 1 and other completed games. Select a bar in Season at a glance to scroll to and focus its schedule game; chart links also work with the keyboard. Each game's home/away/neutral setting is honored. Past games show current-model scores beside actual scores and signed differences; these comparisons include the past result in the model's current inputs. Upcoming win probabilities sum to expected remaining wins, with a projected final record rounded to whole wins and losses when every listed unplayed game is covered. The season outlook displays remaining wins as a rounded count, while calculations retain the full probabilities. Every schedule card shows both teams’ current and rounded projected final records from the same snapshot. Opponent records fill in asynchronously between individual game simulations, keeping phone input responsive; completed record values are cached for that model snapshot. Opponents show their current neutral matchup rank across all rated FBS/FCS teams and within their subdivision, using the same full-field ordering as the board. Board filters do not renumber these full-field ranks. Lower-division opponents and teams without current or prior-season evidence remain explicit gaps.
- **Device appearance:** the site follows the device’s light/dark setting, responds to appearance changes immediately, and adjusts team-colored text for contrast while retaining team logos and primary/secondary colors.
- **Schedule layout:** compact full-width matchup cards keep both teams and the score on one shared row, including on phones. Logos, home/away positions, records, ranks, and the winner or projected favorite remain visible. Three small charts compare win chances, projected/final points on a shared scale, and the simulator's middle 80% margin range. The probability and yardage bars calculate each divider color from both neighboring fills, searching for perceptual separation with a contrast requirement. Yardage bars are larger, label Pass/Rush directly, and use distinct team colors plus a rushing texture; similar secondary colors get a derived light/dark variant. Team comparisons follow the scoreboard's away/home ordering; neutral games list the selected team first. Projected points are rounded consistently in the scoreboard and bars, with precise score differences in the game breakdown. Margin signs favor the selected team. The expandable breakdown also holds point components, opponent-adjusted pass/rush comparisons, records, rates, ranks, coverage, and snapshot details. Prior-season fallback labels remain visible; missing statistics stay unavailable. Schedule cards and the hypothetical simulator share the same margin graphic: a shaded middle-80% band, a model dot, and an actual-result diamond when available. The margin range remains exploratory and uncalibrated. Lower-division opponent records are omitted because their full schedules are outside this dataset.
- **Yardage estimates:** schedule cards and the hypothetical simulator show experimental passing, rushing, and total-yard estimates. Existing opponent-adjusted yards per attempt are multiplied by a separately fitted opponent-adjusted attempt volume with a fixed four-game prior. Completed schedule games show actual validated box-score yards beside those estimates. Both fits account for the connected opponent graph; neither uses a simple average of the two teams' raw yardage. This new yardage context has not been validated for predictive accuracy and does not alter the active scoring or win forecast. Missing evidence remains unavailable. See [yardage definitions](docs/opponent-adjusted-units.md#experimental-yardage-context).
- **Game colors:** completed games use the actual winner's primary color: the selected team's for a win and the opponent's for a loss. Unplayed games use a pale version of the simulator favorite's primary color. Text identifies the winner or favorite and its probability; ties, canceled games, missing predictions, and missing colors keep neutral accents.
- **Team identity:** the site starts with a neutral theme and no team selected. Selecting a team from the ranked board or explorer applies its CFBD primary and alternate colors.
- **Searchable selectors:** entering a dropdown selects its current text so typing replaces it immediately. Team fields also match abbreviations and conferences; use arrow keys and Enter to select, or Escape to restore the current choice. Further clicks while editing preserve ordinary caret placement.

Rankings and Today’s games share identical subdivision and conference-group choices and conference definitions. The Power Four grouping for 2026 is ACC, Big Ten, Big 12, and SEC. **Non-Power Four** covers other FBS teams, independents, and FCS; **Other FBS** covers only the remaining FBS conferences and independents. Conference choices adapt to the selected subdivision and group. Selecting FCS resets and disables the conference-group selector because every FCS team is outside the Power Four. On Today’s games, a game appears by default when either participating team satisfies all selected team filters, so mixed matchups stay visible. The optional **Both teams must match** toggle requires both opponents to satisfy the full selection: Non-Power Four then excludes every game involving a Power Four team, FBS excludes FBS–FCS games, and a conference selection shows only games within that conference. Team search still matches either opponent in the qualifying games. Filters retain global ranks and cached matchup forecasts.

## Free score updates

The optional scoreboard uses Big Balls Sports Data's free allowance and a Cloudflare Worker with a free SQLite-backed Durable Object. A minute cron checks an adaptive plan; provider requests happen only when due. Each score refresh uses two calls across all concurrent games. Three-call catalog discovery covers yesterday, today, and tomorrow in Chicago every two hours and at Chicago midnight. After reserving those calls, the remaining allowance is spread across combined game windows through the next 00:00 UTC reset: kickoff through 3.5 hours plus a 15-minute final check. Recent verified live observations can extend overdue games; timers never declare a final score. Score polling stops outside those windows, while catalog discovery continues. The atomic ledger retains a hard 240-call/day limit below the free 250/day allowance. Website visitors only read the shared cache. No paid plan is required. See [setup, coverage, and quotas](docs/live-scores.md).

At the `2026-10-11T02:52:28Z` checkpoint, the cached Worker returned fresh HTTP 200 data and the configured local preview displayed its separate score overlay. Safe catalog joins cover 83 of the snapshot's 95 October 10 games, with six genuine score observations confirmed in the website; these include FCS matchups. Catalog matching is not live coverage: six source rows lack IDs and twelve old FCS IDs are absent from the current catalog, so coverage remains partial. The adaptive plan at that checkpoint allowed a three-minute score interval within the preserved daily ledger. These counts and timings are checkpoint evidence, not permanent coverage promises. The website endpoint is configured for the GitHub Pages release.

Today’s games and Team Explorer display uniquely matched scores as a separate overlay. The snapshot's projected score stays visible beside a separately labeled live/latest/final score. Both views use the schedule's middle-80% margin band, model dot, and observed-score diamond. A live diamond represents the current score difference, not a final result or an updated win forecast. In-progress scores and delayed updates are labeled; failed updates retain the last fetched score with a stale warning. Scores do not rewrite model inputs, rankings, team records, projected records, or snapshot-fit statistics. The ordinary daily CFBD refresh incorporates completed results into those calculations. These are current-snapshot projections, not archived pregame predictions. Model probabilities remain snapshot forecasts, not changing in-game win probabilities. The free route does not guarantee a game clock or quarter.

The public website keeps the same address across deployments, including bookmarks and iPhone home-screen shortcuts. After the update helper is installed, ordinary root/index page reloads bypass the browser's cached HTML and load the release's fingerprinted assets. A resumed page checks for a newer release and offers a Refresh button without changing the address or interrupting the current view. The helper stores no offline copies and does not intercept live-score or model-data requests. An already-open older release needs to load this helper once before those update checks are available.

`data/live-scores-config.json` contains only the public scoreboard URL. An empty endpoint disables the feed and leaves the snapshot site usable; a configured endpoint still needs an operational provider key and successful refresh before it can supply scores.

## Season data

The published site loads the current FBS + FCS season dataset from this repository. Visitors can also import another compatible file. The board waits for broad coverage (at least 180 completed games across 100 teams) before showing model rankings.

CollegeFootballData.com offers a free API key with 1,000 API calls per month and no credit card requirement. For a local refresh, use the sync script. It asks for the key in a hidden terminal prompt; the key is sent only to CFBD and is never embedded in the website or written to a file.

    node scripts/sync-season.mjs 2026

The script downloads regular-season **and postseason** FBS/FCS schedules, season-specific team metadata, and available completed-game boxes. It caches six raw seasons in `.cache/history/`: venue effects use the current season and four previous seasons, while the prior-season fallback uses the previous season and its four predecessors. Closed seasons are reused; current refreshes revisit the two most recent season-type/week batches and at most two older missing batches. Metadata refreshes weekly. After the first collection, a daily run typically needs 7–12 calls including its quota check. Historical collection preserves a 50-call reserve; ordinary refreshes can use that reserve down to five. Data is validated before atomic replacement. Unknown/lower-division opponents remain on schedules but do not enter the rated Division I graph.

An explicit year takes precedence. Without one, January–July selects the prior football season, keeping January bowls/playoffs with their fall season. The API key comes from `CFBD_API_KEY` or a hidden interactive prompt. The existing repository secret is already configured.

The `Update season data and publish site` workflow refreshes daily at 10:23 UTC during August–January, commits validated data, and requests a GitHub Pages rebuild. Choose `task: refresh` for a manual public update. Tests and bundled-data validation gate automated data commits; PR checks validate source changes before merge. GitHub Pages separately publishes the `main` branch. Never commit the API key.

The workflow works with this repository's current GitHub Pages branch publishing setup. Regular pushes to `main` publish the site as before; after a scheduled or manual data commit, the workflow explicitly requests a Pages rebuild. The repository and generated game data are public; the API key stays in GitHub's secret store and is not included in the website.

The browser always checks the public snapshot. A deliberately imported file remains selected, with source/timestamps visible and a warning if the same-season public dataset is newer. “Return to public snapshot” switches back.

The simulator and backtester share `js/prediction.js`. Active forecast `2.2.0` uses jointly fitted team/conference power and the frozen box-unit matchup correction; historical baseline replay explicitly selects the original forecast. Score totals still use shrunk scoring/allowed averages. The existing uncertainty parameters remain unchanged. The middle-80% range covered 69.5% of the 2025 conference evaluation, so uncertainty remains **uncalibrated**. Injuries and weather are not included. Résumé remains retrospective; its expected wins are not claimed as pregame forecasts.

Passing/rushing matchups now affect forecasts when the required unit evidence is available. Drive field position, red-zone performance, and kicking remain research inputs for future releases. See [matchup model research](docs/matchup-model-research.md) for the downloaded-data audit, free CFBD endpoints, coverage caveats, and evaluation plan.

Before a team has any current-season FBS/FCS results, the simulator and Explorer use its previous-season adjusted power and scoring/allowed averages. Venue effects still come from the loaded snapshot. Once that team has a current-season result, current-season inputs take over; there is no tuned blend of seasons. Prior-season sources are labeled, and uncertainty still uses the number of **current-season** games. The optional fallback has policy version `1`; the saved historical baseline did not use it and does not validate its accuracy. The neutral ranking includes teams supported by current results or this validated prior-season fallback, with prior-season sources labeled; teams without either source remain unranked.

The daily sync embeds the compact `preseason` summary automatically. To add it offline from the preserved historical archives without changing the snapshot timestamp or forecast archives:

```sh
node scripts/update-preseason.mjs
```

Team Explorer recalculates the entire selected team's schedule from the loaded data. Its current-model comparisons describe how those ratings fit past results; they are not pregame backtest accuracy. Each dataset change reruns the schedule and refreshes opponent ranks from the same full-field neutral matchup ranking. The separate `data/backtests/` and `data/forecasts/` artifacts retain pregame evaluation evidence for research. Daily data refreshes save upcoming forecasts and retain their original values once kickoff passes; these archives do not supply the Explorer's current-snapshot projections. See [forecast archive details](data/forecasts/README.md).

Generate the current archive without API calls:

```sh
node scripts/update-forecasts.mjs
```

## Accuracy foundation

Core rating model `2.0.0` and dataset schema `2` make constants, provenance, historical replay, and correctness checks explicit. Forecast `2.1.0` added the evaluated passing/rushing correction: in 1,625 reconstructed pregame 2025 forecasts, margin MAE improved from 14.97 to 14.66 points. Forecast **`2.2.0`** now uses conference-aware forecast power, lowering that error to **14.01 points** and cross-conference error from **17.82 to 16.13 points** across 570 games. Correct winners improved from 71.14% to 72.68%; aggregate probability scores and all three subdivision pairings' margin errors improved. Incomplete 2026 monitoring also improved. Conference prior strength was chosen using 2024; 2025 is reused validation, not a new untouched holdout. The user authorized accuracy-first model activation despite unresolved interval calibration. The core power calculation, earlier experiment outputs and saved baseline reports remain unchanged. The separate neutral matchup ranking changes board ordering to follow the active forecast; it does not change forecasts or establish another accuracy improvement. See [the evaluation protocol](docs/accuracy-foundation.md), [passing/rushing activation](docs/opponent-adjusted-units.md#activation-decision-for-forecast-210) and [conference results and activation](docs/conference-results.md).

Run checks without installing packages (Node 22 or newer):

```sh
node --test
node scripts/validate-data.mjs
```

Reproduce the saved baseline without an API key or network calls:

```sh
node scripts/backtest.mjs --history data/history/baseline-2026-10-08 --from 2022 --to 2026 --out .cache/reproduced-baseline
node scripts/score-backtest.mjs .cache/reproduced-baseline --out .cache/reproduced-baseline/summary.json
```

The [saved baseline reports](data/backtests/README.md) separate completed seasons from incomplete 2026. Exact compressed source archives and fingerprints are preserved with them.

To collect a fresh dataset and create a separate evaluation:

```sh
node scripts/sync-history.mjs --from 2018 --to 2026 --stats-from 2022 --out .cache/history
node scripts/backtest.mjs --history .cache/history --from 2022 --to 2026 --out .cache/backtests
node scripts/score-backtest.mjs .cache/backtests --out .cache/backtests/summary.json
```

The four warmup seasons are required for five-season venue fits. Historical collection uses the same secret/prompt as current sync. Alternatively, run the workflow with `task: backtest` on the desired branch; it uploads raw archives and reports and does not publish the site. Reports include margin MAE/RMSE/bias, Brier/log loss, reliability bins, 80% interval coverage, and subdivision/venue/season-phase/favorite-size/evidence splits.

Predictions freeze at Monday 00:00 UTC by default; `--window day` uses daily UTC cutoffs. A result is eligible only after kickoff plus 24 hours (`--delay` can increase this). Future scores, boxes, postgame provider fields, and precomputed full-season venue effects are excluded. **This reconstructs historical forecasts from final API archives; it cannot prove historical publication times or remove later corrections.** New output is refused if it would replace different frozen predictions; choose a new directory for experiments or explicitly use `--force`.

## Run locally

The site is plain HTML, CSS, JavaScript, and JSON, with no runtime dependencies. From this folder, start Python's built-in web server:

    python3 -m http.server 8000

Then open `http://localhost:8000` in a browser.

## Free hosting

The site can be hosted as a static website without a paid server. [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and GitHub Actions are available at no cost for public repositories. The website and game data committed with it are public; the API key stays in the repository's Actions secret store.

## Interpretation

The ranking orders teams by their average forecast win chance against the same full FBS/FCS field on neutral sites. It is a model-based strength comparison, not a poll or an official selection formula. A lower-ranked team can still be favored at home or in a particular style matchup; pairwise advantages can form cycles that no single ordering can satisfy. Early-season results and incomplete box scores can change the ordering, so sample depth remains visible.
