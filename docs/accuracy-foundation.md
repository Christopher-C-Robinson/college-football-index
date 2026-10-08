# Accuracy foundation: model 2.0.0

This release establishes a reproducible evaluation baseline. It fixes objectively incorrect inputs and makes future model changes measurable. It does not tune the 28-point cap, prior, venue pooling, probability scale, composite weights, or simulator error distribution.

## Shared implementation

| File | Responsibility |
|---|---|
| `js/config.js` | Model/schema versions and frozen baseline parameters |
| `js/model.js` | Completion rules, power, venue estimation, raw efficiency, retrospective résumé |
| `js/prediction.js` | Deterministic matchup forecast and seeded simulator, shared by browser/Node |
| `scripts/lib/backtest.mjs` | Sanitized pregame snapshots and chronological replay |
| `scripts/lib/scoring.mjs` | Forecast metrics, reliability bins, and splits |
| `scripts/lib/cfbd.mjs` | Secret-authenticated acquisition, quota guard, raw cache |
| `scripts/lib/dataset.mjs` | Integrity checks, metadata, duplicate handling, atomic output |

The simulator uses predictive power. Changing descriptive CFI lens weights does not change the predicted spread. Résumé still uses fitted retrospective probabilities and must not be interpreted as a forecasting score. Frozen pregame résumé is a later model release.

## Temporal evaluation contract

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

Use a distinct output directory for each candidate and record its exact code/configuration. Existing predictions cannot be silently rewritten; the CLI rejects changed reports unless `--force` is explicit. Scoring rejects mixed versions/configurations/temporal policies and duplicate game forecasts.

Use older seasons to select parameters and reserve later seasons as a final holdout. Repeatedly selecting changes against the same final seasons makes them development data. This release supplies evaluation machinery, not an automated optimizer or a claim of statistical significance. Later releases should add paired game-error comparisons, uncertainty on performance differences, and untouched season holdouts before promoting more complex models.

## Provider contracts

The collector follows CFBD's [game API](https://apinext.collegefootballdata.com/api/games), [OpenAPI schema](https://apinext.collegefootballdata.com/api/5.32.1/cfbd-openapi.json), and [API tiers](https://collegefootballdata.com/api-tiers). The free allowance is 1,000 monthly calls; cold historical collection consumes more calls than a cached daily refresh. `/info` checks quota; historical collection preserves 50 calls and ordinary refreshes can use that reserve down to five. Requests are paced and transient errors retry with bounded backoff and `Retry-After`. Credentials stay in the existing GitHub Actions secret or local process memory and never enter reports.

Committed source archives may be compressed as `YYYY.json.gz`; replay reads plain or gzip JSON identically and rejects duplicate years. Keep exact source archives alongside frozen reports: Actions artifacts expire, and fetching the same season later can return corrected values.
