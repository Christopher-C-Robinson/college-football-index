# Model 2.0.0 baseline — October 8, 2026

These frozen reports establish the first reproducible baseline. They measure the shared power/venue simulator after input-correctness fixes, with the existing model constants unchanged. They are **reconstructed historical forecasts**, using final corrected provider archives, Monday 00:00 UTC cutoffs, kickoff + 24 hours availability, and 10,000 seeded simulations per game.

| Evaluation | Games | Margin MAE | Brier | Log loss | Middle 80% interval coverage |
|---|---:|---:|---:|---:|---:|
| 2022 | 1,540 | 14.72 | 0.1978 | 0.5774 | 68.4% |
| 2023 | 1,535 | 14.97 | 0.1999 | 0.5848 | 67.8% |
| 2024 | 1,607 | 14.98 | 0.2046 | 0.5959 | 66.9% |
| 2025 | 1,625 | 14.97 | 0.1953 | 0.5729 | 67.3% |
| **Completed seasons, 2022–2025** | **6,307** | **14.91** | **0.1994** | **0.5827** | **67.6%** |
| Incomplete 2026, through Oct 7 | 647 | 17.99 | 0.1873 | 0.5572 | 62.4% |

Lower MAE/Brier/log loss is better. These numbers are measurements, not evidence of improvement over another model. Early-season games with zero current-season results are included using the declared cold-start defaults. Historical box-score gaps remain visible in source validation.

The completed-season 80% ranges contained only 67.6% of actual margins, so uncertainty needs calibration. Mean signed margin error was +4.66 points (`actual home margin - predicted home margin`); this indicates systematic underprediction of home margins, without identifying its cause. Parameters were not adjusted after seeing these results.

## Contents

- `2022.json`–`2026.json`: frozen predictions, outcomes, weekly snapshot audits, model parameters, source commit, and fingerprints.
- `completed-seasons-summary.json`: aggregate metrics and splits for 2022–2025.
- `summary.json`: all five reports, with 2026 also available as a separate season split.
- [Exact compressed inputs](../history/baseline-2026-10-08/): 2018–2026 archives and source manifest.

Replay excludes 15 nominal completed Division I rows: ten unresolved kickoffs and five modern 0–0 cancellation sentinels. Their counts/IDs appear in each report's `meta.exclusions`. Original provider rows remain preserved. The independent local 2022 reproduction exactly matched the [successful Actions run](https://github.com/Christopher-C-Robinson/college-football-index/actions/runs/37850748307).

## Reproduce

From the repository root, with Node 22 or newer and no API key:

```sh
node scripts/backtest.mjs --history data/history/baseline-2026-10-08 --from 2022 --to 2026 --out .cache/reproduced-baseline
node scripts/score-backtest.mjs .cache/reproduced-baseline --out .cache/reproduced-baseline/summary.json
```

Prediction fingerprints should match these frozen reports. Generation timestamps and the executing Git commit can differ. Node tests verify every saved source/prediction fingerprint and recompute both summaries.

See [the complete evaluation protocol](../../docs/accuracy-foundation.md) for temporal limitations and experiment discipline. Final API archives do not establish when corrections or statistics were originally published. Subsequent parameter selection against these seasons makes them development data; reserve new holdouts before claiming predictive gains.
