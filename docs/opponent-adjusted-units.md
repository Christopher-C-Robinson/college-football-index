# Opponent-adjusted passing and rushing: box-units-1

Forecast `2.1.0` introduced the evaluated box-unit matchup correction, retained in current forecast `2.2.0`. The four profiles are passing offense, passing defense, rushing offense, and rushing defense. FBS and FCS use the same connected schedule, equations, and priors. Subdivision and conference labels do not enter the unit fit. Forecast `2.2.0` separately adds [jointly estimated conference/team power](conference-results.md); it does not change these unit profiles or fitted correction coefficients.

The correction improved historical margin predictions, so it is active under the user's accuracy-first release decision. Its uncertainty ranges remain too narrow. Activation does not claim that calibration is solved or that every subdivision's probability scores improved.

## Measurement contract

Only completed rated Division I games contribute. The box-derived definitions are **reported passing yards per reported pass attempt** and **reported rushing yards per reported rush attempt**. The first version does not relabel these as dropbacks, designed runs, EPA, or sack-adjusted efficiency. Team rushing boxes can include sacks and kneels; contextual play processing is a separate future definition.

Preserve yards, attempts, covered games, eligible games, and raw rates. A missing observation or zero attempts produces an unavailable rate, not 0%. Defensive observations mirror the opponent's offensive production. Conflicting boxes or game identities cannot silently contribute twice. Full-field ranks include only teams with measured evidence for that unit; board filters and CFI sliders do not change them.

## Joint opponent adjustment

For each passing or rushing observation, fit

```text
yards / attempt = field mean + offense effect − defense effect + residual
```

Weight each observation by its reported attempts. Regularize offense and defense toward common zero effects using a 100-attempt ridge prior; fit at most 120 iterations with a 1e-7 convergence tolerance. These are fixed first-challenger settings, not empirically established optimum values or confidence levels. The intercept and effects are anchored so the decomposition is identifiable.

The displayed adjusted offense rate is `field mean + offense effect`; adjusted defense is `field mean − defense effect`. Higher offense and lower defense values mean stronger performance. The effect is positive for stronger offense **and** stronger defense. Against a specific opponent, the fitted context rate is `field mean + offense effect − opposing defense effect`.

This is a coupled schedule adjustment: each defense is estimated against the offenses faced, and each offense against the defenses faced. It is not a one-pass subtraction of raw opponent averages. Raw yard totals do not determine strength independently of attempts or opponent quality.

Attempts control weighting, not a statistical claim that every play is an independent observation. Sparse schedule connections, correlated plays, and differences in data coverage remain limitations. Coverage is shown as evidence, not a fabricated probability of confidence.

## Experimental yardage context

`yardage-context-1` is a separate descriptive estimate displayed in schedule cards and the hypothetical simulator. It does not modify the active point forecast, probabilities, historical experiment coefficients, or unit-strength ranks.

For each passing/rushing category, multiply the existing opponent-adjusted matchup rate by estimated attempts:

```text
matchup yards/attempt = field rate + offense effect − opposing defense effect
estimated attempts   = max(0, field attempts/game + offense volume effect − opposing defense volume effect)
estimated yards      = matchup yards/attempt × estimated attempts
```

Volume effects are jointly fitted over the same validated FBS/FCS game graph with equal weight per team-game. A separate fixed four-game ridge prior pulls them toward zero. The setting has not been selected with held-out forecasts. Positive defense-volume effects mean opponents attempted fewer plays in that category; they do not measure defensive efficiency. Valid zero-attempt games contribute to volume, while an absent positive-attempt rate remains unavailable. Negative net yardage is preserved.

Actual game yards come from the same scheduled-team, score, statistic and duplicate checks as the rate model. A total is available only when both passing and rushing yards are known and their sum agrees with any reported total. Missing actual or projected categories stay unavailable. The displayed approximate total adds the individually rounded passing and rushing estimates; full-precision rate and attempt assumptions are available in the game breakdown.

These estimates have not been validated for predictive accuracy and have no calibrated yardage intervals. They do not explicitly model venue, game state, overtime length, roster changes or weather. The existing box definitions still include sack/kneel accounting limitations. Disconnected schedules are anchored by the prior, not by observed cross-component evidence. Prior-season score summaries do not contain unit/volume histories and cannot supply missing yardage estimates. Past games use the current snapshot, including their actual results.

## Active matchup forecast

The forecast starts with the shared power/venue model and adds a correction fitted to its historical **pregame margin errors**, using four features:

1. Home-minus-away passing matchup edge.
2. Home-minus-away rushing matchup edge.
3. Passing edges weighted by each offense's observed passing share.
4. Rushing edges weighted by each offense's observed rushing share.

Each edge combines the relevant offense and opposing defense effects. Features negate when the teams swap. Ridge fitting uses zero intercept and root-mean-square feature scaling about zero, preserving neutral reversal. Reported passing share is a box-derived exposure proxy; it is not a game-state-adjusted tactical tendency.

If either team lacks any required unit or passing-share evidence, the forecast uses the exact baseline result and labels the fallback. It does not substitute an average team and claim complete coverage.

The active coefficients and feature scales are the frozen `summary.fit` from the original experiment, selected with ridge lambda 1,000 and fitted on 2022–2024. Live snapshot results supply the unit features, not newly fitted correction coefficients. The same implementation serves the hypothetical simulator, Team Explorer's entire schedule, current-model-fit comparisons, and newly generated forecast archives. Ranking sliders and board filters do not alter a fixed matchup's forecast.

The correction changes the margin, scores, win probability, and margin range. Deterministic team scores are derived from the unchanged projected total and the corrected margin, with each score floored at zero; away from that floor, the correction moves the two scores by half its value in opposite directions. Simulated margins translate by the correction exactly as in the evaluated challenger; the correction does not widen the distribution or add a new total model. Passing and rushing contributions are fitted statistical associations, not causal estimates of points created by a particular play call.

### Versions and frozen archives

`FORECAST_VERSION = '2.2.0'` identifies the active forecast, and `MATCHUP_FORECAST_VERSION = '2.1.0'` identifies the explicit pre-conference comparator. The core rating `MODEL_VERSION = '2.0.0'` and dataset schema `2` remain unchanged: ranking power, venue, CFI weights, and the underlying baseline simulator parameters have not been retuned. Forecast power now uses the separate conference fit. The unit definition remains `box-units-1`.

Explicit `forecastModel: 'baseline'` selects the original predictor for historical replay; `forecastModel: 'matchup'` selects the frozen 2.1.0 comparison without conference pooling. Saved baseline rows and the original challenger report remain unchanged. Newly generated forecasts record the active forecast version and model provenance, including fallback reasons. Past forecasts retain their original versions.

### Frozen chronological design

This design was declared before fitting the first candidate:

- **2022–2023:** fit candidate coefficients for each regularization choice.
- **2024:** select lambda from `0.1, 1, 10, 100, 1000` using margin MAE.
- **2022–2024:** refit the selected candidate.
- **2025:** evaluate the frozen candidate and promotion gates.
- **2026:** report separately as incomplete-season monitoring.

Construct unit features from the same cutoff-eligible results/boxes as the frozen baseline. Future and target-game outcomes cannot enter a unit fit. Current-snapshot profiles used on the website remain retrospective descriptive views; the historical candidate must use its own pregame profiles.

Historical inputs are corrected final provider archives. The existing kickoff-plus-24-hour availability policy and Monday cutoffs remain declared reconstructions of availability, not proof of original publication times. The optional live zero-current-results prior-season fallback is not part of the frozen historical baseline.

### Original research gates

Compare identical games, reporting margin MAE/RMSE/bias, winner matches, Brier/log loss, range coverage and width, subdivision splits, and eligible/fallback games. Use a deterministic paired week-block bootstrap for the mean absolute-error difference; repeated-team dependence across weeks remains a limitation.

The original experiment required lower holdout margin MAE with the paired 95% interval entirely below zero, no subdivision MAE deterioration above 0.5 points, no aggregate Brier/log-loss deterioration, and middle-80% coverage within three percentage points of target. These were predeclared research gates, not universal statistical standards. The experiment shifts the existing predictive distribution; it does not fit a new calibration or claim that its ranges are calibrated.

The original report failed only the interval-coverage gate and retains that historical decision. The report is not rewritten to make activation appear to have passed the original requirements.

### Activation decision for forecast 2.1.0

The user subsequently requested activation of the more accurate model. The release decision prioritizes the measured margin improvement with its paired interval below zero, no material subdivision margin harm, and no aggregate probability-score deterioration. The frozen candidate satisfies those criteria. The failed coverage requirement is disclosed as unfinished calibration work rather than used to retain the less accurate baseline.

This is an explicit change to the activation policy after seeing the evaluation. It is not a fresh independent validation. Both baseline and candidate miss the intended 80% coverage, and the FBS–FCS probability scores worsened slightly even though that group's margin error improved. Future calibration changes need their own versioned evaluation.

## Public and private artifacts

The experiment publishes aggregate metrics, fitted coefficients, model/feature definitions, source fingerprints, chronology, and its decision. Per-game feature matrices and acquisition inputs stay in the ignored `.cache` directory. No additional raw API feed is added by this release.

Existing public schedule/box/history delivery still requires a separate migration to compact derived model state. CFBD permits independently created predictions, rankings and models while restricting bulk redistribution of raw or substantially equivalent normalized inputs; its terms provide no numerical safe harbor for a reasonable factual display. This release does not expand the public raw-data payload. See [CFBD's terms](https://collegefootballdata.com/terms).

## Code

- `js/unit-model.js`: canonical observations, joint fits, profiles, and symmetric candidate features.
- `js/unit-profile-view.js`: selected-team and matchup presentations.
- `js/config.js`: frozen active correction configuration and core/forecast versions.
- `js/prediction.js`: shared active inference and explicit historical baseline path.
- `scripts/matchup-challenger.mjs`: reproducible experiment CLI.
- `scripts/lib/matchup-challenger.mjs`: chronological coefficient selection, prediction comparison and promotion gates.
- `data/experiments/box-units-v1/summary.json`: derived evaluation and decision.
- `js/challenger-status.js`: historical comparison and active release status beside current-model information.

The historical experiment is independent of ranking sliders, team selection, board filters, and the current-model-fit headline. An improvement in retrospective fit alone is not a promotion criterion.

## First frozen result

On the 1,625-game 2025 candidate holdout, margin MAE improved from 14.9726 to 14.6573 points. The paired week-block 95% interval for the mean change was −0.4599 to −0.1701 points. Brier improved from 0.19531 to 0.19167; log loss improved from 0.57292 to 0.56526. All three subdivision groups improved margin MAE, but the FBS–FCS group's probability scores worsened slightly. The selected ridge lambda was 1,000.

The candidate had complete required features for 1,455 games; 170 games used the exact baseline fallback. Middle-80% coverage improved from 67.32% to 68.25%, failing the predeclared 77–83% requirement. **Original experiment decision: retain the baseline forecast. Subsequent release decision: activate the evaluated correction in forecast 2.1.0, retaining it in 2.2.0 with the coverage shortfall visible.**

Incomplete 2026 monitoring is separate: margin MAE improved from 17.9930 to 17.8076, while log loss worsened slightly. These observations are not additional tuning data for this frozen experiment. The 2025 baseline results had already been inspected before this candidate; “holdout” here means excluded from the candidate's coefficient fitting and lambda selection, not outcomes that nobody had previously viewed.

To reproduce from the preserved inputs and frozen baseline reports, run from the repository root:

```sh
node scripts/matchup-challenger.mjs --out .cache/reproduced-box-units --private-out .cache/reproduced-box-units-audit
```

The default output is `data/experiments/box-units-v1/summary.json`. Changed outputs require a new destination or explicit `--force`; unchanged artifacts are preserved. Source-file SHA-256 digests use exact file bytes. Archive/report fingerprints use the same canonical JSON serialization as the original replay.
