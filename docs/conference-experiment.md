# Conference pooling experiment: conference-pooling-v1

## Design declared before scoring

Compare a jointly fitted conference/team power model with the currently active forecast 2.1.0. Keep the 28-point margin cap, team prior of two games, venue estimates, passing/rushing profiles and frozen correction coefficients, score-total model, simulation parameters, and historical availability policy fixed.

For each historical pregame snapshot, minimize:

```text
sum((capped home margin - venue - home power + away power)^2)
  + 2 * sum((team power - conference mean)^2)
  + 2 * k * sum(conference mean^2)
```

Conference membership comes from that season's schedule and is checked against its metadata, with conflicting membership rejected. Independents and teams with unavailable membership have the original zero-centered team prior and do not form a pooled conference. All FBS and FCS teams use the same equations. No conference receives a reputation-based adjustment. Conference and team effects are fitted together; no conference bonus is appended to an existing power rating.

`k` is the number of hypothetical average teams pulling each conference mean toward zero. Predeclared choices are **1, 4, 16, 64**, plus an **infinite** no-pooling numerical control. The untouched active forecast is also a candidate. Infinity uses a converged zero-centered fit, separating numerical-solver differences from actual conference pooling.

Select using **2024 cross-conference margin MAE**, with all-game MAE as the first tie-break and stronger pooling toward zero as the second. Choose before scoring 2025 or 2026. There is no new residual-coefficient training. The existing pass/rush correction was fitted through 2024, so 2024 is development data, not independent validation.

Evaluate the selected configuration on **2025**, and report **2026** incomplete-season monitoring separately. Both seasons have already been inspected for the earlier matchup experiment: this is reused validation, not a new untouched holdout. Do not choose conference parameters from either season. Preserve historical source files, frozen predictions and earlier experiment outputs.

## Comparisons

Replay the exact frozen Monday cutoffs with results/box scores eligible only after the declared kickoff-plus-24-hour delay. Verify source, prediction and reconstructed snapshot fingerprints. Use the shared active predictor and simulator for both models with the same original game seed and 10,000 runs; substitute only the candidate's team powers. Teams with zero current-season results retain the replay's original cold-start behavior. No prior-season or conference fallback is added to that path by this experiment.

Report margin MAE/RMSE/bias, score MAE, winner accuracy, Brier score, log loss, 80% interval coverage/width, and splits for cross/same conference, subdivision, early/middle/late weeks, venue and evidence depth. Actual ties are excluded from probability scores. Independent-versus-independent games count as cross-conference rather than inventing an independent league.

Pair 5,000 bootstrap resamples by season and Monday cutoff for all-game and cross-conference MAE differences. This accounts for within-week dependence only, not all repeated-team dependence, corrected source revisions, parameter selection or repeated evaluation.

An activation recommendation requires a finite conference-pooling choice, lower 2025 cross-conference MAE with the paired interval entirely below zero, lower all-game MAE, no aggregate Brier/log-loss regression, and no subdivision MAE regression greater than 0.5 points. Uncertainty calibration is reported separately under the existing accuracy-first policy. The experiment command never changes production configuration.

## Reproduce

```sh
node scripts/conference-challenger.mjs
```

Public output contains aggregate evaluation, configuration and source fingerprints. Per-game forecasts, fitted conference values and cutoff diagnostics stay under ignored `.cache/experiments/conference-pooling-v1/`. No new raw data feed or API requests are needed.
