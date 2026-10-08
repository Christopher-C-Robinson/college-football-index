# College Football Index

A neutral, transparent analysis site for every FBS and FCS team. One connected game graph lets fans compare results across subdivisions, conferences, and schedules. Every team uses the same model, filters, and evidence standards.

**Live site:** [College Football Index](https://christopher-c-robinson.github.io/college-football-index/)

## What it measures

- **Game power:** iterative opponent-adjusted scoring across FBS and FCS, with game-specific home and road effects estimated from five seasons, a 28-point margin cap, and a two-game prior toward the combined field average.
- **Efficiency:** yards per play, third-down performance, and turnover margin from available box scores. Missing categories are omitted rather than filled with guesses.
- **Résumé:** opponent power plus wins above the model's expected wins against each schedule.
- **Data coverage:** rated FBS/FCS result count and usable box-score count, shown separately beside the rating. These are sample counts, not confidence probabilities.
- **Filters:** FBS + FCS, either subdivision, Power Four or other FBS, and individual conferences. Filters change which teams appear, never which games feed the ratings.
- **Team comparison:** compare any two loaded teams by power, opponent power, expected wins, wins above expectation, efficiency, raw scoring margin, and estimated home-road swing. Matchup Lens and the simulator default to the current board’s top two ranked teams on initial load and whenever filters, weights, or data change; the simulator resets to neutral site and runs automatically. Changing either simulation team or its venue also updates results automatically. Manual choices stay available between board updates.
- **Weight controls:** drag each slider, use its keyboard arrows, or click its decrease/increase arrows to adjust by one weight point. Displayed percentages show each weight’s normalized share of the blend, to one decimal where needed.
- **Matchup simulator:** run 10,000 hypothetical outcomes for two teams at a neutral site or either team's home field. It uses adjusted power and each matchup's home/road effects for the spread, current scoring and points-allowed rates for the score total, and greater rating uncertainty for teams with fewer results. A team with no current-season Division I results uses the previous season's power and scoring summaries when available, with that source labeled explicitly.
- **Season projections:** select any team in Team Explorer to automatically run the hypothetical simulator for every listed matchup using the current loaded snapshot, including Week 1 and other completed games. Each game's home/away/neutral setting is honored. Past games show current-model scores beside actual scores and signed differences; these comparisons include the past result in the model's current inputs. Upcoming win probabilities sum to expected remaining wins, with an expected final record when every listed unplayed game is covered. Opponents show their current CFI rank across all rated FBS/FCS teams and within their subdivision, using the board's current weights. Board filters do not renumber these full-field ranks. Lower-division opponents and teams without current or prior-season evidence remain explicit gaps.
- **Schedule layout:** each game gets one full-width row with a score comparison table, a win-probability bar, the simulator's middle 80% margin range, and the power-gap/venue decomposition. A matchup table compares current records, rated FBS/FCS result counts, effective power, and raw offensive/defensive yards per play from available boxes. Prior-season power remains labeled; missing statistics stay unavailable. Lower-division opponent records are omitted because their full schedules are outside this dataset.
- **Team identity:** the site starts with a neutral theme and no team selected. Selecting a team from the ranked board or explorer applies its CFBD primary and alternate colors.
- **Searchable selectors:** type in any dropdown to narrow its choices. Team fields also match abbreviations and conferences; use arrow keys and Enter to select, or Escape to restore the current choice.

The Power Four grouping for 2026 is ACC, Big Ten, Big 12, and SEC. The conference filter adapts to the selected subdivision, so FCS conferences remain available when FCS is selected.

## Season data

The published site loads the current FBS + FCS season dataset from this repository. Visitors can also import another compatible file. The board waits for broad coverage (at least 180 completed games across 100 teams) before showing model rankings.

CollegeFootballData.com offers a free API key with 1,000 API calls per month and no credit card requirement. For a local refresh, use the sync script. It asks for the key in a hidden terminal prompt; the key is sent only to CFBD and is never embedded in the website or written to a file.

    node scripts/sync-season.mjs 2026

The script downloads regular-season **and postseason** FBS/FCS schedules, season-specific team metadata, and available completed-game boxes. It caches six raw seasons in `.cache/history/`: venue effects use the current season and four previous seasons, while the prior-season fallback uses the previous season and its four predecessors. Closed seasons are reused; current refreshes revisit the two most recent season-type/week batches and at most two older missing batches. Metadata refreshes weekly. After the first collection, a daily run typically needs 7–12 calls including its quota check. Historical collection preserves a 50-call reserve; ordinary refreshes can use that reserve down to five. Data is validated before atomic replacement. Unknown/lower-division opponents remain on schedules but do not enter the rated Division I graph.

An explicit year takes precedence. Without one, January–July selects the prior football season, keeping January bowls/playoffs with their fall season. The API key comes from `CFBD_API_KEY` or a hidden interactive prompt. The existing repository secret is already configured.

The `Update season data and publish site` workflow refreshes daily at 10:23 UTC during August–January, commits validated data, and requests a GitHub Pages rebuild. Choose `task: refresh` for a manual public update. Tests and bundled-data validation gate automated data commits; PR checks validate source changes before merge. GitHub Pages separately publishes the `main` branch. Never commit the API key.

The workflow works with this repository's current GitHub Pages branch publishing setup. Regular pushes to `main` publish the site as before; after a scheduled or manual data commit, the workflow explicitly requests a Pages rebuild. The repository and generated game data are public; the API key stays in GitHub's secret store and is not included in the website.

The browser always checks the public snapshot. A deliberately imported file remains selected, with source/timestamps visible and a warning if the same-season public dataset is newer. “Return to public snapshot” switches back.

The simulator and backtester share `js/prediction.js`; both use power and matchup-specific venue effects. Score totals use shrunk scoring/allowed averages. Logistic game error plus normal rating uncertainty remains an **uncalibrated baseline**. Injuries, weather, and tactical details are not included. Résumé remains retrospective; its expected wins are not claimed as pregame forecasts.

Before a team has any current-season FBS/FCS results, the simulator and Explorer use its previous-season adjusted power and scoring/allowed averages. Venue effects still come from the loaded snapshot. Once that team has a current-season result, current-season inputs take over; there is no tuned blend of seasons. Prior-season sources are labeled, and uncertainty still uses the number of **current-season** games. The optional fallback has policy version `1`; the saved historical baseline did not use it and does not validate its accuracy. Rankings remain based on current-season evidence.

The daily sync embeds the compact `preseason` summary automatically. To add it offline from the preserved historical archives without changing the snapshot timestamp or forecast archives:

```sh
node scripts/update-preseason.mjs
```

Team Explorer recalculates the entire selected team's schedule from the loaded data. Its current-model comparisons describe how those ratings fit past results; they are not pregame backtest accuracy. Each dataset change reruns the schedule, and weight changes refresh opponent ranks. The separate `data/backtests/` and `data/forecasts/` artifacts retain pregame evaluation evidence for research. Daily data refreshes save upcoming forecasts and retain their original values once kickoff passes; these archives do not supply the Explorer's current-snapshot projections. See [forecast archive details](data/forecasts/README.md).

Generate the current archive without API calls:

```sh
node scripts/update-forecasts.mjs
```

## Accuracy foundation

Model `2.0.0` and dataset schema `2` make constants, provenance, historical replay, and correctness checks explicit. Numerical model parameters remain the original baseline; this release does not claim empirically tuned accuracy. See [the evaluation protocol](docs/accuracy-foundation.md) for temporal rules, report fields, and limitations.

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

This is an open first model, not a poll or an official selection formula. The composite index is a weighted standardized comparison, not a predicted win probability. Early-season results and incomplete box scores can change the ordering, so sample depth remains visible.
