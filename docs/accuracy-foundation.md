# Accuracy foundation: core model 2.0.0, forecast 2.2.0

The original foundation release established a reproducible evaluation baseline. It fixed objectively incorrect inputs and made future model changes measurable. It did not tune the 28-point cap, prior, venue pooling, probability scale, composite weights, or simulator error distribution.

The [first saved baseline](../data/backtests/README.md) covers 6,307 games in completed 2022–2025 seasons and 647 games in incomplete 2026. Completed-season margin MAE is 14.91 points; the simulator's middle 80% range contained 67.6% of outcomes. Those measurements establish the original reference and calibration work to do. Exact compressed inputs are committed for replay without API calls.

The later forecast `2.1.0` release activates the separately evaluated box-unit matchup correction. On the 1,625-game 2025 comparison, it lowered margin MAE from 14.97 to 14.66 points and improved aggregate Brier/log loss. The user requested activation based on the accuracy improvement. Forecast `2.2.0` adds jointly estimated conference/team strength, further lowering average margin error to 14.01 and cross-conference error from 17.82 to 16.13. This is reused validation; prediction ranges remain uncalibrated. Core rating `MODEL_VERSION = '2.0.0'` is unchanged; `FORECAST_VERSION = '2.2.0'` identifies the active inference release. See [unit definitions and activation](opponent-adjusted-units.md) and [conference results](conference-results.md).

## Shared implementation

| File | Responsibility |
|---|---|
| `js/config.js` | Core/forecast/schema versions, frozen baseline parameters and active matchup correction |
| `js/model.js` | Completion rules, power, venue estimation, raw efficiency, retrospective résumé |
| `js/prediction.js` | Active matchup forecast and seeded simulator, plus explicit baseline replay, shared by browser/Node |
| `js/neutral-rankings.js` | Full-field neutral pair forecasts and average win probabilities for board and schedule ranks |
| `js/model-fit.js` | Whole-field current-snapshot simulations and completed-result comparisons |
| `js/model-fit-view.js` | Current-fit summary, definitions, coverage gaps, and subdivision breakdown |
| `js/unit-model.js` | Joint opponent-adjusted pass/rush profiles and symmetric challenger features |
| `js/unit-profile-view.js` | Unit profiles, matchup context, and expandable schedule details |
| `scripts/lib/matchup-challenger.mjs` | Chronological box-unit residual candidate and paired evaluation |
| `scripts/lib/backtest.mjs` | Sanitized pregame snapshots and chronological replay |
| `scripts/lib/scoring.mjs` | Forecast metrics, reliability bins, and splits |
| `scripts/lib/cfbd.mjs` | Secret-authenticated acquisition, quota guard, raw cache |
| `scripts/lib/dataset.mjs` | Integrity checks, metadata, duplicate handling, atomic output |

The simulator uses predictive power, venue, and the frozen fitted passing/rushing matchup correction. It falls back to the baseline when required unit evidence is unavailable. The correction preserves the baseline projected total and translates its margin distribution; it does not recalibrate uncertainty. The board uses the same active forecast for its full-field neutral matchup ranking. Changing board filters does not change a fixed matchup’s predicted spread. Résumé still uses fitted retrospective probabilities and must not be interpreted as a forecasting score. Frozen pregame résumé is a later model release.

Team Explorer simulates every scheduled matchup from the loaded snapshot, including completed games, using the same venue and simulation defaults as the hypothetical tool. Its comparisons with actual scores describe the current model's fit, rather than pregame forecasting accuracy. Current opponent ranks use the board’s full-field neutral matchup ordering; filters do not recalculate or renumber them.

The live predictor also supports optional preseason fallback policy `1`. For a team with zero current-season Division I results, it carries forward the previous season's adjusted power and scoring/allowed summaries; current results take over after the first rated game. The previous season's power is fitted with its own five-season venue history. Prior-season source hashes, generation times, model version, and active team years are retained. Source archives must precede the loaded snapshot, and rating uncertainty continues to use current-season game counts. The preserved historical baseline has no embedded preseason summaries and is unchanged; those reports do not establish the optional fallback's accuracy. A calibrated early-season blend remains future research.

## Current-snapshot comparison on the website

The top summary runs the shared hypothetical simulator for each unique completed rated FBS/FCS game, using the loaded snapshot and the listed home/away/neutral venue. Every matchup contributes once to the whole-field report, rather than once for each team's schedule. The nominal home team supplies the probability/margin orientation, including at neutral sites. Team Explorer can reverse that neutral-site orientation for a selected team; seeded Monte Carlo probabilities can therefore differ slightly while using identical model mathematics.

Winner match rate excludes tied actual results and exact 50/50 model probabilities. Brier/log loss exclude actual ties but score 50/50 probabilities. Margin error uses the uncapped actual margin and deterministic predicted margin. Score error is the mean absolute error across both teams' deterministic projected scores. Total error compares combined scoring with the model's projected total. Interval coverage checks whether each actual margin lies inside the simulated 10th–90th percentile bounds, inclusively. Empty denominators remain unavailable.

Invalid/unavailable comparisons and duplicate records remain visible as coverage gaps. Computation yields between batches, cancels stale work on dataset switches, and caches each loaded dataset's completed report. Board filters do not rerun or modify the report.

These comparisons include completed results already used to fit power and scoring. They answer how closely the **current** model describes this season; they do not establish how accurately it forecast games before kickoff. The frozen historical evaluation below remains the source for pregame accuracy and parameter selection. The neutral matchup ranking changes how the existing forecasts are summarized, rather than changing the forecast mathematics or adding an accuracy claim. See [ranking method](neutral-matchup-rankings.md).

## Frozen baseline temporal evaluation contract

These rules describe the preserved `2.0.0` baseline. Replay explicitly requests `forecastModel: 'baseline'`; later activation does not alter saved prediction rows, evaluation reports, or their configuration identities. Newly generated active forecast archives record `2.2.0` with conference and passing/rushing correction provenance. Rows from different forecast versions must remain distinguishable rather than being treated as one unchanged model.

1. Load season-specific raw archives. For an evaluation season, require all four earlier venue seasons; do not silently shorten the warmup.
2. Order target games by actual kickoff timestamp. Postseason week 1 is not confused with regular-season week 1. Exclude unresolved/TBD kickoffs from targets and training; record excluded target counts.
3. Freeze each prediction window at Monday 00:00 UTC (or day start with `--window day`). Same-window games cannot train one another, even if one finishes Thursday and another starts Saturday.
4. Eligible results require the authoritative `completed === true`, both final scores, and kickoff + 24 hours at or before the cutoff. Legacy imports may infer completion only when the `completed` property is absent. Provider archives require an explicit boolean.
5. Whitelist schedule fields. Hide all future scores and set unfinished rows to `completed: false`. Strip postgame Elo, win probabilities, and other provider features. Include box scores only for eligible game IDs.
6. Refit the five-season venue model using only eligible historical results at **every** cutoff. Ignore stored `homeField` estimates from full-season files.
7. Build the browser's shared model and simulate with a reproducible version/cutoff/game-ID seed. Cold-start teams are retained with zero power, prior venue estimates, and a named 27-points-per-team total fallback if no current-season scoring exists. Mark cold starts explicitly.
8. Save each forecast separately from its actual outcome. Save snapshot hashes, training IDs/counts, latest inferred availability time, configuration, source hashes, model version, and source commit.

**Important limit:** CFBD's game schema has kickoff and a completion boolean, but no historical completion/publication timestamp. Kickoff + 24 hours is a conservative reconstruction rule, not observed availability. Abnormally delayed games, later score/stat corrections, revised kickoff times, season metadata corrections, and final box-score availability cannot be reconstructed perfectly. These reports are reconstructed walk-forward evaluations, not authentic archived pregame API responses. Future production snapshot archiving would strengthen this guarantee.

## Metrics and interpretation

Margins use uncapped actual final scores for MAE/RMSE, signed error (`actual - predicted`), and absolute-error quantiles. The training cap never caps evaluation misses. Totals are scored separately. Lower MAE, RMSE, Brier, and log loss are better; signed error should approach zero.

Win metrics score the simulator probability displayed to visitors. Analytic logistic probabilities are scored separately so rating-uncertainty effects can be compared. Ties remain in margin/total/interval evaluation and are excluded from binary win scoring. Log loss clamps only its numerical logarithm arguments. Reliability bins report sample count, average forecast, and observed home win rate; small bins should not be treated as stable evidence.

Intervals report inclusive coverage and mean width for the simulator's 10th–90th percentile margin range. A label of “middle 80%” describes the simulated distribution; it does not establish 80% empirical coverage. Current uncertainty parameters remain heuristic until held-out reports establish calibration.

Splits include FBS–FBS, FBS–FCS (either host), FCS–FCS; home/neutral; early/middle/late weeks and postseason; absolute predicted margins; minimum team result count; and season. Always inspect denominators. The incomplete current season must be identified separately from finished seasons.

## Correctness changes

- Explicit unfinished flags override live non-null scores in rankings, records, and venue history.
- Modern completed 0–0 rows are retained as provider data but excluded from results, venue history, and evaluation, with validator warnings and reported exclusion IDs. The initial real-data run exposed canceled games mislabeled this way, confirmed against [San Diego's 2022 cancellation announcement](https://usdtoreros.com/news/2022/9/27/san-diego-football-game-vs-stetson-canceled.aspx) and [South Dakota's 2024 schedule](https://goyotes.com/sports/football/schedule/2024). The rule applies from 1996 onward; earlier historical ties remain supported.
- Third downs aggregate made/attempted counts. Percentage-only values disclose missing denominators rather than invent attempts.
- Yards per play combines yards and known plays; CFBD rush/pass attempt counts supply plays where available. Rate-only observations are disclosed separately.
- Turnover margin uses only games with both teams' turnover data.
- Rated wins and expected wins use the same FBS/FCS game set; lower-division wins no longer inflate wins above expectation.
- Coverage reports rated results and usable boxes separately, with metric-level denominator details retained in the model.
- January–July uses the prior football season; regular, postseason, and the exceptional spring FCS phases are preserved, independently keyed by season type and week. All-star games are retained in raw provider archives and excluded from team records and ratings.
- Validation rejects conflicts, invalid finals, orphan/mismatched boxes, future finals, and implausible sudden count drops. Unknown opponent classifications are warned and excluded from ratings.
- Raw caches and atomic writes preserve the last usable dataset when acquisition/validation fails.

## Experiment discipline

The first box-unit challenger and its frozen selection/holdout design are documented in [opponent-adjusted units](opponent-adjusted-units.md). It uses the existing pregame snapshots; the website displays current-snapshot unit profiles and now uses their fitted matchup correction in active forecasts. Derived aggregate results and the original research decision live in `data/experiments/box-units-v1/summary.json`; per-game feature/audit rows stay in `.cache`.

The original experiment retained the baseline because both models missed the intended 80% range coverage. That report remains frozen. Forecast `2.1.0` adopts the evaluated correction under the user's subsequent accuracy-first activation decision: margin MAE improves with a paired interval below zero, no subdivision has material margin harm, and aggregate Brier/log loss do not deteriorate. The coverage shortfall remains visible and requires separate calibration work. This later release policy is not presented as the original predeclared gate having passed.

Use a distinct output directory for each candidate and record its exact code/configuration. Existing predictions cannot be silently rewritten; the CLI rejects changed reports unless `--force` is explicit. Scoring rejects mixed versions/configurations/temporal policies and duplicate game forecasts.

Use older seasons to select parameters and reserve later seasons as a final holdout. Repeatedly selecting changes against the same final seasons makes them development data. The box-unit comparison adds paired week-block error intervals, with repeated-team dependence across weeks still a limitation. Future features and calibration changes need new evaluations and untouched or rolling holdouts; activating this correction does not validate richer drive, red-zone, or kicking inputs.

## Provider contracts

The collector follows CFBD's [game API](https://apinext.collegefootballdata.com/api/games), [OpenAPI schema](https://apinext.collegefootballdata.com/api/5.32.1/cfbd-openapi.json), and [API tiers](https://collegefootballdata.com/api-tiers). The free allowance is 1,000 monthly calls; cold historical collection consumes more calls than a cached daily refresh. `/info` checks quota; historical collection preserves 50 calls and ordinary refreshes can use that reserve down to five. Requests are paced and transient errors retry with bounded backoff and `Retry-After`. Credentials stay in the existing GitHub Actions secret or local process memory and never enter reports.

Committed source archives may be compressed as `YYYY.json.gz`; replay reads plain or gzip JSON identically and rejects duplicate years. Keep exact source archives alongside frozen reports: Actions artifacts expire, and fetching the same season later can return corrected values.
