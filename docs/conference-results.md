# Conference strength results and forecast 2.2.0

## What changed

Forecast **2.2.0** uses a conference-aware estimate of each team's power in the simulator and season projections. Teams and conference averages are fitted together from game results, accounting for opponent strength and the existing home/away adjustment. This gives a team with limited results some support from its conference's results, while allowing it to be stronger or weaker than that conference.

The conference signal is part of the jointly fitted team strength; it is not an extra bonus added to a completed rating. Conference names, reputations and Power Four status do not award points. FBS and FCS use identical equations, and independent teams do not share an invented independent conference.

The original conference activation left the ranking board’s blend unchanged. The board now ranks teams by their average active-forecast win probability against every other rated FBS/FCS team on a neutral field, so its ordering includes conference-aware strength and the fitted passing/rushing effects. Core power model **2.0.0**, venue estimates, score-total calculation and uncertainty parameters remain unchanged. Conference-aware powers are calculated across the complete loaded FBS/FCS schedule; board filters do not change them. The simulator retains the labeled prior-season fallback for a team with no current-season results when available. See [neutral matchup ranking](neutral-matchup-rankings.md).

## Results

The experiment compared the previous active forecast **2.1.0** with the selected conference model. Lower margin error, Brier score and log loss are better; higher winner accuracy is better. These are reconstructed pregame forecasts, not comparisons fitted to the same completed games shown in the current-snapshot dashboard.

| Evaluation | Games | Previous forecast | Conference forecast |
|---|---:|---:|---:|
| 2025 average margin error | 1,625 | 14.66 points | **14.01 points** |
| 2025 cross-conference margin error | 570 | 17.82 points | **16.13 points** |
| 2025 correct winners | 1,625 | 71.14% | **72.68%** |
| 2025 Brier score | 1,625 | 0.1917 | **0.1840** |
| 2025 log loss | 1,625 | 0.5653 | **0.5449** |
| Incomplete 2026 average margin error | 647 | 17.81 points | **16.69 points** |
| Incomplete 2026 cross-conference margin error | 411 | 19.83 points | **18.15 points** |
| Incomplete 2026 correct winners | 647 | 72.18% | **73.72%** |

The largest 2025 improvement was in FBS–FCS games, but each subdivision pairing improved:

| 2025 pairing | Games | Previous margin error | Conference margin error |
|---|---:|---:|---:|
| FBS–FBS | 808 | 13.84 | **13.57** |
| FBS–FCS | 126 | 27.29 | **22.11** |
| FCS–FCS | 691 | 13.31 | **13.05** |

The same-conference margin error also improved slightly, from 12.95 to 12.87 points. Aggregate 2026 probability scores improved: Brier score 0.1870 to 0.1761, and log loss 0.5577 to 0.5259. Monitoring results remain provisional because the season is incomplete.

Paired week-block bootstrap intervals for the 2025 change were **−1.30 to −0.14 points** for all games and **−2.72 to −0.44 points** for cross-conference games. Both favor the conference forecast. These intervals describe the resampled weeks; they do not account fully for repeated teams, corrected source archives or repeated model evaluation.

## Selection and activation

The predeclared choices used conference priors of **1, 4, 16 and 64 average teams**, plus an infinite-prior control that fixes conference strength to zero. The selected prior was **1**, chosen by 2024 cross-conference margin error before scoring 2025 or 2026. The infinite-prior control closely reproduced the previous forecast, separating conference pooling from numerical-solver changes.

The experiment recommended activation because the selected model improved cross-conference error with paired evidence, improved overall error and aggregate probability scores, and did not worsen any subdivision's margin error. Forecast **2.2.0** activates that configuration under the user's existing accuracy-first policy. The original design and aggregate experiment output remain unchanged. Their `activeForecastVersion: 2.1.0` and `productionModelChanged: false` describe the offline experiment when it was run, before this activation decision.

Already-started saved forecast rows retain their original values and model versions. Subsequent archive generation refreshes only eligible future forecasts to 2.2.0. Explorer projections continue to use the currently loaded snapshot for every schedule game, including completed games; that is a separate current-fit view.

## Limits of the evidence

- **2025 is reused validation.** Its outcomes and the 2026 results had already been inspected for the earlier passing/rushing experiment. Neither season selected this conference parameter, but this is not a new untouched holdout.
- Historical inputs are reconstructed from corrected final archives using frozen Monday cutoffs and the kickoff-plus-24-hour availability policy. They are not archived pregame API responses.
- The passing/rushing coefficients remain frozen from their earlier fit. Changing forecast power could change their best values; they were not refitted here.
- **Prediction ranges remain uncalibrated.** The displayed middle-80% range contained 69.54% of 2025 outcomes and 65.07% of monitored 2026 outcomes. Those improvements do not make the intervals reliable 80% coverage claims.
- Membership is season-specific. Conflicting conference assignments are rejected, and teams with unknown membership use an unpooled zero-centered prior.

## Reproduce and inspect

```sh
node scripts/conference-challenger.mjs
```

The command performs the offline comparison and does not activate a model. Commit `1af3341` preserves the original experiment source before activation. Source fingerprints are part of the frozen report: rerunning after source changes can refuse replacement even if forecast results agree. Preserve that report rather than forcing replacement; its recorded source environment defines the original experiment. See the [design declared before scoring](conference-experiment.md) and [saved aggregate report](../data/experiments/conference-pooling-v1/summary.json). Detailed per-game output remains under ignored `.cache/experiments/conference-pooling-v1/`.

Saved summary fingerprint: `24c3bb5312f8718f3a43e788375d260063aa349467869b3a573097c528ffe614`.
