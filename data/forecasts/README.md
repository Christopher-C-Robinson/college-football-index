# Team Explorer forecast archives

These compact files support the Team Explorer schedule ledger. They contain predicted scores and probabilities with model version, source fingerprint, source cutoff, actual generation time, and origin. Actual scores are read separately from the selected season dataset.

## Origins

- **Reconstructed pregame:** copied from the preserved, fingerprint-verified `data/backtests/<season>.json` report. Each forecast was rebuilt from a historical cutoff using only eligible results and venue history. It was generated after the season or game, not published at the time. Historical corrections and assumed result availability remain limitations.
- **Saved pregame:** generated from a dated public snapshot before kickoff. Each daily refresh can revise games that have not started; once kickoff passes, the forecast is retained even while the provider still marks the game unfinished.
- **Current snapshot:** upcoming projections calculated in the browser with the same simulator, using the selected dataset. These are projections from that snapshot. They are never substituted for a past game's pregame forecast when grading accuracy.

The initial archive includes the 2022–2025 completed-season baselines and the 2026 baseline through October 7. Scheduled FBS/FCS games with known kickoff times also receive saved pregame forecasts. The browser can project future games with a time marked TBD, but those do not receive an archived pregame record until kickoff timing is resolved. Lower-division opponents, canceled games, and past games without a valid forecast remain explicit gaps.

## Regeneration

No API key or network access is needed to create forecasts from bundled inputs:

```sh
node scripts/update-forecasts.mjs
node scripts/update-forecasts.mjs --from 2022 --to 2025
```

The season sync calls the same archive updater after validating the new dataset. The publishing workflow commits both `data/current-season.json` and `data/forecasts/`.

Prediction identities and timestamps are checked before writing. A source snapshot cannot be used to fabricate a saved forecast after kickoff. Forecasts whose schedule identity changes are preserved separately rather than silently rewritten; the active ledger only uses matching games. Full reconstructed inputs, temporal audits, and prediction fingerprints remain in `data/backtests/` and `data/history/`.

## Reading errors and season totals

Scores are displayed with the selected team first. Signed misses equal actual minus projected, so a positive margin miss means the team outperformed the predicted margin. Summary margin MAE is the average absolute margin miss. Score MAE averages absolute score misses across both sides of each graded game, using unrounded predictions. Only completed games with a valid saved or reconstructed pregame forecast enter those summaries.

Expected remaining wins sum the simulated win probabilities for listed, unplayed games with projections. Expected final records add those wins and losses to actual results; they appear only when every remaining listed game is covered. They do not predict opponents or games that have not been scheduled. Independence between games is not needed for the expected-win sum; no probability distribution for the final record is claimed.

The model's score, probability, and uncertainty assumptions remain uncalibrated. These archives make forecast comparisons inspectable; they do not by themselves establish predictive accuracy.
