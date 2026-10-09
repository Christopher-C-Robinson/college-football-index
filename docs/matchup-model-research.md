# Matchup strengths and weaknesses

Research date: October 8, 2026. This document records the broader design and the first implemented layer.

Implementation update: `box-units-1` supplies the four jointly opponent-adjusted box-derived passing/rushing profiles. Forecast `2.1.0` now uses the frozen historical matchup correction in simulator and schedule predictions when unit evidence is available, with an explicit baseline fallback. The user authorized activation because historical margin and aggregate probability errors improved; interval calibration remains unfinished. See [definitions, limitations, original gates, and activation decision](opponent-adjusted-units.md). Richer drive/play/kicking layers below remain proposals.

## Answer

Yes. We can estimate how a team's passing, rushing, finishing, and special teams fit a particular opponent. A pass-heavy offense facing a weak pass defense should be a candidate for a different projection than the same offense facing an equally strong overall team with an excellent pass defense. The size and reliability of that difference must come from historical predictions.

The requirement is **opponent-adjusted unit ratings**, using the same connected-schedule principle as power. Raw totals or national percentiles alone do not meet it. Gaining 400 yards against a defense expected to allow 400 represents performance near expectation; 400 against a defense expected to allow 200 is stronger. Pace and attempts matter too, so the comparison should primarily use efficiency per qualifying opportunity, then project volume separately. Those expected defensive levels must themselves be adjusted for the offenses faced.

The current simulator applies a passing/rushing matchup correction learned from historical pregame errors. `js/prediction.js` starts with opponent-adjusted scoring power and venue, then combines both teams' passing/rushing offense-versus-defense edges and observed attempt shares with frozen coefficients. The correction changes predicted margin, scores, probability, and range location. Shrunk scoring/allowed averages still supply the total, and result counts still supply rating uncertainty; these parts have not been improved or calibrated by this release. The board's separate efficiency index uses offensive/defensive yards per play, third-down rates, and turnover margin. Changing the board's efficiency weight does not alter a fixed matchup's forecast.

## What is already downloaded

Audit of `data/current-season.json`, generated October 8 with results through October 7:

- 647 completed rated Division I games: 274 FBS–FBS, 119 FBS–FCS, and 254 FCS–FCS.
- All 647 have both team boxes. That is 667 FBS and 627 FCS team-game appearances, across the file's 138 FBS and 128 FCS teams.
- All these appearances contain usable passing attempts/completions, passing yards, rushing attempts/yards, third-down counts, fourth-down counts, turnovers, interceptions thrown, fumbles lost, penalty counts/yards, and possession time.
- The file has 703 boxes in total. Another 56 are FCS games against lower-division opponents, outside the current rating graph.

This establishes coverage in this particular snapshot, not in every historical season. Box-derived pass/rush unit features have since been fitted and evaluated on reconstructed historical pregame snapshots. Richer conversion, drive, finishing, and kicking inputs remain unvalidated as forecasting additions.

| Input | Already usable from boxes | Additional work |
|---|---|---|
| Passing offense and defense | Opponent-adjusted yards/attempt is active; completions/attempt, TD and interception counts are available | Separate sacks/dropbacks consistently; evaluate additional rates |
| Rushing offense and defense | Opponent-adjusted yards/attempt and observed attempt share are active; TD counts are available | Distinguish designed runs, sacks, and kneels |
| Third/fourth downs | Conversions and attempts, offense and allowed | Account for distance and selection effects where plays exist |
| Turnovers | Giveaways and takeaways | Use per-play/per-drive rates and shrink small samples |
| Penalties | Count and yards | Context and denominator selection |
| Field position | No drive starts downloaded | Fetch drive or advanced data |
| Red zone | No trips/results downloaded | Reconstruct possessions entering the opponent's 20 |
| Field goals | Kicking points only | Obtain makes, attempts, and preferably attempt distance |
| EPA/PPA, success, explosiveness | No play-level data downloaded | Fetch advanced summaries or plays and audit coverage |

Fourth downs illustrate why counts matter: 99 FBS and 120 FCS appearances have zero fourth-down attempts. Their conversion rate is unavailable, not 0%. Across the audited boxes, turnovers always equal interceptions thrown plus fumbles lost; adding all three independently would duplicate the same events. Kicking points cannot establish FG percentage, and return yards cannot establish starting field position.

## Available CFBD routes

CFBD documents these sources:

| Source | Useful fields / role |
|---|---|
| [Advanced statistics](https://api.collegefootballdata.com/api/stats) | `/stats/season/advanced` supports explicit FBS/FCS queries and supplies offense/defense passing/rushing PPA, success, explosiveness, and `fieldPosition.averageStart`. Game-level advanced statistics can support dated feature reconstruction. |
| [Passing](https://api.collegefootballdata.com/api/passing) | `/passing/teams/season` and `/passing/teams/games` supply offense/defense passing splits and coverage counters. Inspect `ppaAttemptsAvailable` and `successAttemptsAvailable`: missing measurements must not become genuine zero performance. |
| [Rushing](https://api.collegefootballdata.com/api/rushing) | `/rushing/teams/season` and `/rushing/teams/games` supply offense/defense production, PPA, success, and blocking measures. Team totals include sacks, kneels, and unattributed attempts; define the analysis population explicitly. |
| [Drives](https://api.collegefootballdata.com/api/drives) | `gameId`, offense, defense, `startYardsToGoal`, plays, outcome, and scores support starting field position, pace, and points/possession. |
| [Historical plays](https://api.collegefootballdata.com/api/plays) | Down, distance, yards to goal, drive/game IDs, play type, scores, and nullable PPA support contextual rates and red-zone reconstruction. `distance` here is yards needed for a first down, not FG attempt distance. |
| [Game/player boxes](https://api.collegefootballdata.com/api/games) | `/games/teams` supplies existing boxes. `/games/players` is a candidate source for aggregate kicking makes/attempts, subject to actual category coverage. |
| [FG expected points](https://api.collegefootballdata.com/api/metrics) | `/metrics/fg/ep` supplies reference values by distance, not a log of individual kick attempts. |

The [official availability page](https://api.collegefootballdata.com/data-availability) lists plays, drives, and advanced statistics from 2001, boxes from 2004, and enriched passing/rushing from 2025. It warns that supported seasons do not imply complete coverage of every subdivision, game, or field. FCS query support is promising; actual advanced FCS completeness remains unmeasured in this research. New enriched-route entitlement has not been checked with an authenticated request.

CFBD's advanced points per opportunity is not red-zone conversion percentage: its [official metric definitions](https://cdn.collegefootballdata.com/CFBD%20Model%20Training%20Pack%20-%20Data%20Info%20Sheet.pdf) use possessions reaching the opponent's 40. Our red-zone measure should explicitly use the 20 and report touchdown rate separately from any-score rate.

CFBD's [CORE methodology](https://api.collegefootballdata.com/core-ratings) excludes FCS games and produces retrospective ratings. It can provide an FBS diagnostic comparison, but cannot supply a unified FBS/FCS pregame feature without those limitations.

## How to combine the inputs

### 1. Estimate skills separately from schedule strength

Fit regularized offense and defense effects over the connected opponent graph for passing and rushing. Weight evidence by qualifying attempts rather than treating a 10-attempt game like a 50-attempt game. Retain a common scale across subdivisions and show where cross-division evidence is thin.

Solve four linked estimates: passing offense, passing defense, rushing offense, and rushing defense. An offense earns credit for exceeding what its opponent should allow; a defense earns credit for holding an opponent below what it should produce. Re-estimate both sides together until the fit stabilizes, with shrinkage for sparse samples. A weak defense does not become strong merely because it faced weak offenses, and an offense does not earn the same credit for every 400-yard game. Cross-division games connect the unit ratings as they connect power; there is no automatic conference or subdivision bonus.

For an efficiency such as pass PPA, a candidate expected value is:

```text
observed pass efficiency, game A against B
  = field passing average
  + fitted passing offense A
  + fitted passing efficiency allowed B
  + eligible context effects + unexplained game variation

expected pass efficiency, A against B
  = field passing average
  + A's adjusted passing offense
  + B's adjusted passing efficiency allowed
```

Define positive defensive effects as more efficiency allowed in this equation. A good defense therefore has a negative effect. Repeat for rushing and for the opposing offense. This is a candidate statistical model, not an assumption that these effects are perfectly additive.

### 2. Let style determine exposure

Estimate how often each team is likely to run or pass. A vulnerability matters more when the opposing offense frequently attacks it. Include only a small set of interpretable interactions initially, such as passing tendency × opposing pass-defense vulnerability. Model expected possessions to connect efficiency to points.

Observed tendencies are affected by game state: teams that trail may pass more, and leading teams may run out the clock. Where play coverage supports it, estimate tendencies in comparable down/distance and score situations. Treat sacks as failed passing opportunities when modeling dropbacks; do not silently label every recorded rushing attempt a designed run.

### 3. Measure incremental value beyond power

Start with the existing power-plus-venue forecast, then fit a style correction to its historical **out-of-sample** errors:

```text
candidate margin = baseline power margin + learned matchup correction
```

This directly asks whether matchup information explains misses that power does not already explain. Train the correction only on earlier replay windows, then freeze it for the next holdout. A second candidate can model each team's points/possession and expected possessions jointly, producing both margin and total. Compare the candidates rather than combining them by hand.

### 4. Handle correlations explicitly

Begin with feature correlations within each training window, then fit regularized regression and a limited set of interactions. Penalization shrinks unstable coefficients when inputs overlap. Do not interpret a correlation as a causal effect or use the same games to select features and report accuracy.

Several overlaps already exist by construction: total YPP combines passing and rushing, turnover totals contain interceptions and fumbles, and third downs/red-zone outcomes contribute to scoring and EPA. Fit competing feature groups and remove each group in turn to measure its added value. A long list of individually plausible statistics can otherwise count the same successful drive several times.

There is relevant precedent: [South and Egros, 2020](https://journals.sagepub.com/doi/10.3233/JSA-190314), compared college-football forecasting methods using prior-game offensive and opposing defensive information, training on 2011–2014 and evaluating on 2015. Their FBS-only results support temporal evaluation of regularized candidates; they do not establish an accuracy gain for this project's unified model.

## Definitions that need to be fixed before fitting

- **Conversions:** sum makes and attempts before dividing. Keep no-attempt samples unavailable; include distance where possible.
- **Field position:** use a consistent distance-to-opponent-goal orientation. Defensive starting field position means where the opponent begins its offensive possessions. Short fields can come from turnovers and special teams, so avoid assigning all their value to offensive or defensive execution.
- **Red zone:** count distinct eligible possessions reaching the opponent's 20, including drives that start there. Distinguish TD/trip, any-score/trip, and points/trip. Specify treatment of end-of-half possessions and overtime.
- **Kicking:** use makes/attempts with sample counts. Prefer distance-adjusted performance, with substantial pooling for a kicker who has attempted only a few kicks. Validate any FBS-derived reference for FCS before applying it unchanged.
- **Turnovers:** distinguish offensive giveaway and defensive takeaway rates; retain interceptions and fumbles as explanatory components without duplicating their total. Compare per-play and per-possession denominators. Recovery rates need strong shrinkage.
- **Play exclusions:** record rules for kneels, spikes, overtime, garbage time, penalties, sacks, and missing PPA. Preserve raw counts so alternative definitions can be replayed.

## Coverage and evaluation gates

Store each metric's numerator, denominator, eligible count, observed count, source, and definition version. An API response with a zero and no measured attempts must remain missing. Missing detailed data should return that matchup toward the power baseline, preserving FCS teams and widening uncertainty where supported by calibration.

Backtests must join only data from eligible games before each prediction cutoff. Full-season advanced summaries cannot be imported into early-season forecasts. Historical per-game inputs or archived summaries are required; the enriched routes' 2025 start also limits their evaluation window. The website's current-snapshot Explorer will continue applying the same loaded model to every game, including past games, as requested. Those comparisons remain separate from pregame accuracy claims.

Compare candidate and baseline forecasts on the same holdouts using margin MAE/RMSE, total error, Brier score, log loss, and interval coverage. Report FBS–FBS, FBS–FCS, and FCS–FCS separately, plus season phase and data coverage. Use older seasons for selection and retain a final untouched season or rolling window. Recalibrate win probabilities and ranges after changing the margin/total model.

## Free acquisition plan and rollout

The [current free tier](https://collegefootballdata.com/api-tiers) includes historical team statistics and basic advanced metrics at 1,000 calls/month. Advertised opponent-adjusted metrics begin in a paid tier; we can estimate our own adjustments. Live play-by-play is also paid and is unnecessary for daily snapshots.

Keep collection in GitHub Actions, the key in the existing secret, and only compact summaries in the public JSON. Cache completed historical windows, request subdivisions explicitly, and deduplicate shared games. Fetch batches by week rather than one request per team.

Planning estimates for 31 daily runs, using the repo's existing 7–12 calls/day:

| Plan | Estimated monthly calls |
|---|---:|
| Existing pipeline + two advanced-season queries/day | 279–434 |
| Also four enriched passing/rushing queries/day | 403–558 |

These are budget estimates, not measured new-endpoint usage. Retries, backfills, and other activity share the account quota. Add raw plays/drives incrementally after measuring response coverage and cost; retain a correction/retry reserve.

Implementation status and next steps:

1. **Implemented:** jointly opponent-adjusted pass/rush unit profiles and the frozen box-unit correction in forecast `2.1.0`. Views lead with unit strength and matchup explanations, keeping rates, attempts, ranks, and coverage in supporting detail. Historical 2025 margin MAE improved from 14.97 to 14.66 points; the original interval gate failed and remains documented. Apply the same opponent-adjustment discipline to future conversion/finishing candidates where their definitions and samples support it.
2. Collect advanced summaries and sample historical plays/drives to audit FBS/FCS coverage and definitions.
3. Build dated, opponent-adjusted feature snapshots; compare a small box-score candidate against a richer efficiency candidate in walk-forward replay.
4. Prefer features with repeatable predictive gains, retain a versioned fallback for missing metrics, and measure calibration separately. The user authorized the first correction despite unfinished uncertainty calibration; future range changes need their own historical coverage evaluation.
5. Show a matchup explanation beside the forecast: overall strength, venue, passing fit, rushing fit, and finishing/special teams, with learned point contributions only where the fitted model supports that interpretation.

The schedule color change is independent of this research: solid winner colors identify completed results; pale favorite colors identify unplayed forecasts. It does not alter predictions.
