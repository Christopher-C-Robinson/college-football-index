# College Football Index

A neutral, transparent analysis site for every FBS and FCS team. One connected game graph lets fans compare results across subdivisions, conferences, and schedules. Every team uses the same model, filters, and evidence standards.

**Live site:** [College Football Index](https://christopher-c-robinson.github.io/college-football-index/)

## What it measures

- **Game power:** iterative opponent-adjusted scoring across FBS and FCS, with game-specific home and road effects estimated from five seasons, a 28-point margin cap, and a two-game prior toward the combined field average.
- **Efficiency:** yards per play, third-down performance, and turnover margin from available box scores. Missing categories are omitted rather than filled with guesses.
- **Résumé:** opponent power plus wins above the model's expected wins against each schedule.
- **Data coverage:** rated FBS/FCS result count and usable box-score count, shown separately beside the rating. These are sample counts, not confidence probabilities.
- **Filters:** FBS + FCS, either subdivision, Power Four or other FBS, and individual conferences. Filters change which teams appear, never which games feed the ratings.
- **Team comparison:** compare any two loaded teams by power, opponent power, expected wins, wins above expectation, efficiency, raw scoring margin, and estimated home-road swing.
- **Matchup simulator:** run 10,000 hypothetical outcomes for two teams at a neutral site or either team's home field. It uses adjusted power and each matchup's home/road effects for the spread, current scoring and points-allowed rates for the score total, and greater rating uncertainty for teams with fewer results.
- **Team identity:** the site starts with a neutral theme and no team selected. Selecting a team from the ranked board or explorer applies its CFBD primary and alternate colors.

The Power Four grouping for 2026 is ACC, Big Ten, Big 12, and SEC. The conference filter adapts to the selected subdivision, so FCS conferences remain available when FCS is selected.

## Season data

The published site loads the current FBS + FCS season dataset from this repository. Visitors can also import another compatible file. The board waits for broad coverage (at least 180 completed games across 100 teams) before showing model rankings.

CollegeFootballData.com offers a free API key with 1,000 API calls per month and no credit card requirement. For a local refresh, use the sync script. It asks for the key in a hidden terminal prompt; the key is sent only to CFBD and is never embedded in the website or written to a file.

    node scripts/sync-season.mjs 2026

The script downloads regular-season **and postseason** FBS/FCS schedules, season-specific team metadata, and available completed-game boxes. It caches raw seasons in `.cache/history/`, then fits venue effects from the current season and four previous seasons. Closed seasons are reused; current refreshes revisit the two most recent season-type/week batches and at most two older missing batches. Metadata refreshes weekly. After the first collection, a daily run typically needs 7–12 calls including its quota check. The collector preserves a 50-call reserve and validates data before atomic replacement. Unknown/lower-division opponents remain on schedules but do not enter the rated Division I graph.

An explicit year takes precedence. Without one, January–July selects the prior football season, keeping January bowls/playoffs with their fall season. The API key comes from `CFBD_API_KEY` or a hidden interactive prompt. The existing repository secret is already configured.

The `Update season data and publish site` workflow refreshes daily at 10:23 UTC during August–January, commits validated data, and requests a GitHub Pages rebuild. Choose `task: refresh` for a manual public update. Tests and bundled-data validation gate automated data commits; PR checks validate source changes before merge. GitHub Pages separately publishes the `main` branch. Never commit the API key.

The workflow works with this repository's current GitHub Pages branch publishing setup. Regular pushes to `main` publish the site as before; after a scheduled or manual data commit, the workflow explicitly requests a Pages rebuild. The repository and generated game data are public; the API key stays in GitHub's secret store and is not included in the website.

The browser always checks the public snapshot. A deliberately imported file remains selected, with source/timestamps visible and a warning if the same-season public dataset is newer. “Return to public snapshot” switches back.

The simulator and backtester share `js/prediction.js`; both use power and matchup-specific venue effects. Score totals use shrunk scoring/allowed averages. Logistic game error plus normal rating uncertainty remains an **uncalibrated baseline**. Injuries, weather, and tactical details are not included. Résumé remains retrospective; its expected wins are not claimed as pregame forecasts.

## Accuracy foundation

Model `2.0.0` and dataset schema `2` make constants, provenance, historical replay, and correctness checks explicit. Numerical model parameters remain the original baseline; this release does not claim empirically tuned accuracy. See [the evaluation protocol](docs/accuracy-foundation.md) for temporal rules, report fields, and limitations.

Run checks without installing packages (Node 22 or newer):

```sh
node --test
node scripts/validate-data.mjs
```

Collect raw history once, replay 2022–2026, and score it:

```sh
node scripts/sync-history.mjs --from 2018 --to 2026 --stats-from 2022 --out .cache/history
node scripts/backtest.mjs --history .cache/history --from 2022 --to 2026 --out data/backtests
node scripts/score-backtest.mjs data/backtests --out data/backtests/summary.json
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
