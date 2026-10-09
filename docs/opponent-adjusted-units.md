# Opponent-adjusted passing and rushing: box-units-1

This release adds descriptive unit profiles and a separately evaluated forecasting challenger. The four profiles are passing offense, passing defense, rushing offense, and rushing defense. FBS and FCS use the same connected schedule, equations, and priors. Subdivision and conference labels do not enter the fit.

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

## Forecast challenger contract

The champion remains the shared power/venue model. The candidate learns an additive correction to its **pregame margin errors**, using four features:

1. Home-minus-away passing matchup edge.
2. Home-minus-away rushing matchup edge.
3. Passing edges weighted by each offense's observed passing share.
4. Rushing edges weighted by each offense's observed rushing share.

Each edge combines the relevant offense and opposing defense effects. Features negate when the teams swap. Ridge fitting uses zero intercept and root-mean-square feature scaling about zero, preserving neutral reversal. Reported passing share is a box-derived exposure proxy; it is not a game-state-adjusted tactical tendency.

If either team lacks any required unit or passing-share evidence, the candidate uses the exact baseline forecast. It does not substitute an average team and claim complete coverage.

### Frozen chronological design

This design was declared before fitting the first candidate:

- **2022–2023:** fit candidate coefficients for each regularization choice.
- **2024:** select lambda from `0.1, 1, 10, 100, 1000` using margin MAE.
- **2022–2024:** refit the selected candidate.
- **2025:** evaluate the frozen candidate and promotion gates.
- **2026:** report separately as incomplete-season monitoring.

Construct unit features from the same cutoff-eligible results/boxes as the frozen baseline. Future and target-game outcomes cannot enter a unit fit. Current-snapshot profiles used on the website remain retrospective descriptive views; the historical candidate must use its own pregame profiles.

Historical inputs are corrected final provider archives. The existing kickoff-plus-24-hour availability policy and Monday cutoffs remain declared reconstructions of availability, not proof of original publication times. The optional live zero-current-results prior-season fallback is not part of the frozen historical baseline.

### Promotion gates

Compare identical games, reporting margin MAE/RMSE/bias, winner matches, Brier/log loss, range coverage and width, subdivision splits, and eligible/fallback games. Use a deterministic paired week-block bootstrap for the mean absolute-error difference; repeated-team dependence across weeks remains a limitation.

The candidate must reduce holdout margin MAE with the paired 95% interval entirely below zero, avoid subdivision MAE deterioration above 0.5 points, avoid Brier/log-loss deterioration, and bring middle-80% coverage within three percentage points of target. These are predeclared research gates, not universal statistical standards. The first candidate shifts the existing predictive distribution; it does not fit a new calibration or claim that its ranges are calibrated.

Passing these gates establishes readiness for a versioned inference release. Failing any gate retains the existing forecast and leaves the adjusted profiles available as descriptive matchup information.

## Public and private artifacts

The experiment publishes aggregate metrics, fitted coefficients, model/feature definitions, source fingerprints, chronology, and its decision. Per-game feature matrices and acquisition inputs stay in the ignored `.cache` directory. No additional raw API feed is added by this release.

Existing public schedule/box/history delivery still requires a separate migration to compact derived model state. CFBD permits independently created predictions, rankings and models while restricting bulk redistribution of raw or substantially equivalent normalized inputs; its terms provide no numerical safe harbor for a reasonable factual display. This release does not expand the public raw-data payload. See [CFBD's terms](https://collegefootballdata.com/terms).

## Code

- `js/unit-model.js`: canonical observations, joint fits, profiles, and symmetric candidate features.
- `js/unit-profile-view.js`: selected-team and matchup presentations.
- `scripts/matchup-challenger.mjs`: reproducible experiment CLI.
- `scripts/lib/matchup-challenger.mjs`: chronological coefficient selection, prediction comparison and promotion gates.
- `data/experiments/box-units-v1/summary.json`: derived evaluation and decision.
- `js/challenger-status.js`: historical candidate scorecard beside current-model information.

The historical experiment is independent of ranking sliders, team selection, board filters, and the current-model-fit headline. An improvement in retrospective fit alone is not a promotion criterion.

## First frozen result

On the 1,625-game 2025 candidate holdout, margin MAE improved from 14.9726 to 14.6573 points. The paired week-block 95% interval for the mean change was −0.4599 to −0.1701 points. Brier improved from 0.19531 to 0.19167; log loss improved from 0.57292 to 0.56526. All three subdivision groups improved margin MAE, but the FBS–FCS group's probability scores worsened slightly. The selected ridge lambda was 1,000.

The candidate had complete required features for 1,455 games; 170 games used the exact baseline fallback. Middle-80% coverage improved from 67.32% to 68.25%, failing the predeclared 77–83% requirement. **Decision: retain the baseline forecast.** The adjusted profiles remain available for matchup analysis.

Incomplete 2026 monitoring is separate: margin MAE improved from 17.9930 to 17.8076, while log loss worsened slightly. These observations are not additional tuning data for this frozen experiment. The 2025 baseline results had already been inspected before this candidate; “holdout” here means excluded from the candidate's coefficient fitting and lambda selection, not outcomes that nobody had previously viewed.

To reproduce from the preserved inputs and frozen baseline reports, run from the repository root:

```sh
node scripts/matchup-challenger.mjs --out .cache/reproduced-box-units --private-out .cache/reproduced-box-units-audit
```

The default output is `data/experiments/box-units-v1/summary.json`. Changed outputs require a new destination or explicit `--force`; unchanged artifacts are preserved. Source-file SHA-256 digests use exact file bytes. Archive/report fingerprints use the same canonical JSON serialization as the original replay.
