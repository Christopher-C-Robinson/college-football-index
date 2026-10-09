# Pregame evaluation archives

These compact files preserve pregame projections for research and future accuracy evaluation. They contain predicted scores and probabilities with model version, source fingerprint, source cutoff, actual generation time, and origin. Team Explorer calculates every game's projection from its current loaded snapshot and does not read these files.

## Origins

- **Reconstructed pregame:** copied from the preserved, fingerprint-verified `data/backtests/<season>.json` report. Each forecast was rebuilt from a historical cutoff using only eligible results and venue history. It was generated after the season or game, not published at the time. Historical corrections and assumed result availability remain limitations.
- **Saved pregame:** generated from a dated public snapshot before kickoff. Each daily refresh can revise games that have not started; once kickoff passes, the forecast is retained even while the provider still marks the game unfinished.
- **Current snapshot in Team Explorer:** all scheduled matchups, including completed games, are recalculated in the browser with the same hypothetical simulator using the selected dataset. Past-game differences are current-model comparisons rather than pregame accuracy measurements. These recalculations do not replace any archived pregame record.

The initial archive includes the 2022–2025 completed-season baselines and the 2026 baseline through October 7. Scheduled FBS/FCS games with known kickoff times also receive saved pregame forecasts. The browser can project matchups with a time marked TBD, but those do not receive an archived pregame record until kickoff timing is resolved. Lower-division opponents, canceled games, and past games without a valid forecast remain explicit gaps in this evaluation archive.

Forecast v2.1.0 applies the evaluated opponent-adjusted passing/rushing correction. A refresh replaces future v2.0.0 forecasts with v2.1.0 forecasts even when the input snapshot has not changed. Games that already started retain their original forecast and version. The archive's `meta.modelVersion` identifies the generator, `meta.modelVersions` lists the versions present, and each row records its own version. New rows also record the baseline margin, fitted matchup adjustment, eligibility/fallback reason, and experiment fingerprint. Current Explorer projections always use the active forecast; these preserved archives can contain several forecast versions.

## Regeneration

No API key or network access is needed to create forecasts from bundled inputs:

```sh
node scripts/update-forecasts.mjs
node scripts/update-forecasts.mjs --from 2022 --to 2025
```

The season sync calls the same archive updater after validating the new dataset. The publishing workflow commits both `data/current-season.json` and `data/forecasts/`.

Prediction identities and timestamps are checked before writing. A source snapshot cannot be used to fabricate a saved forecast after kickoff. Forecasts whose schedule identity changes are preserved separately rather than silently rewritten; the active ledger only uses matching games. Full reconstructed inputs, temporal audits, and prediction fingerprints remain in `data/backtests/` and `data/history/`.

## Reading errors and season totals

Team Explorer displays scores with the selected team first. Signed differences equal actual minus current-model projected scores. A positive margin difference means the team performed better than the current model's expected margin. Its summary MAE averages absolute differences using unrounded current projections; this describes model fit to results already in its inputs. It is separate from pregame evaluation, which grades a forecast frozen before the target game's result was available.

Expected remaining wins sum the simulated win probabilities for listed, unplayed games with projections. Expected final records add those wins and losses to actual results; they appear only when every remaining listed game is covered. They do not predict opponents or games that have not been scheduled. Independence between games is not needed for the expected-win sum; no probability distribution for the final record is claimed.

The model's score, probability, and uncertainty assumptions remain uncalibrated. These archives make forecast comparisons inspectable; they do not by themselves establish predictive accuracy.
