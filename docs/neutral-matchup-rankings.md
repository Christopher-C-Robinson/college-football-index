# Neutral matchup rankings

The board ranks teams by how well the active forecast expects them to perform against the same complete FBS/FCS field on neutral sites. It replaces the previous adjustable power/efficiency/résumé blend. Power, efficiency and résumé remain supporting measurements where shown; they do not supply separate user-selected ranking weights.

## Method

For every eligible pair of different teams, call the shared `predictMatchup()` with `neutralSite: true` and the active forecast. The prediction includes conference-aware team strength and the frozen opponent-adjusted passing/rushing matchup correction when required evidence is available. Home-field points are zero.

For a field of `N` eligible teams, team `i` has:

```text
neutralScore_i = sum(P(team i beats team j)) / (N - 1), for every j != i
expectedWins_i = sum(P(team i beats team j))
```

The displayed neutral win percentage is `100 * neutralScore_i`. It is an average against the entire field, rather than a win percentage against the team's actual schedule or its next opponent. Expected wins refer to this hypothetical one-game-against-every-opponent schedule; they are not a projected season record.

Sort by the unrounded average win probability, then by average neutral margin, then by team name for a deterministic tie break. Display rounding never determines the order. Each pair contributes once. Both team orderings are evaluated to check neutral symmetry; their complementary probabilities are averaged to remove numerical orientation noise. The other team receives the complement because the shared neutral margin changes sign when the teams swap.

Method version: `neutral-round-robin-v1`. The ranking report also records the active forecast version; the current forecast remains `2.2.0`. This is a new summary of existing predictions, not a new prediction model or another demonstrated forecast-accuracy improvement.

## Who enters the field

Teams must be classified FBS or FCS and support a shared forecast from either current-season rated results and power or the predictor's validated prior-season fallback. Unsupported teams remain visible as unavailable rather than receiving an invented average rating. Lower-division opponents do not enter this field.

The existing broad-coverage requirement must be met before ranks appear. With insufficient coverage, fewer than two eligible teams, or incomplete pair forecasts, the ranking remains unavailable; partial calculations do not publish misleading ranks. Excluded teams and reasons remain in the report.

FBS/FCS, conference and team-search filters only hide rows from the completed full-field result. A team's overall rank and neutral score stay the same under filters. Subdivision ranks use that same global ordering restricted to the team's subdivision. Team Explorer and schedule opponent badges use these ranks too.

## Relation to the simulator

Rankings use the deterministic forecast's analytic win probability. They do not run 10,000 random outcomes for each pair. The hypothetical simulator retains its seeded Monte Carlo calculation, rating uncertainty and rounded-score treatment, so its displayed win probability can differ slightly from the analytic value. Both use the same active neutral strength and matchup forecast.

A lower-ranked team can still be favored at home because the ranking has no home advantage. Specific passing/rushing advantages can also favor it on a neutral field: team A can match up well against B, B against C, and C against A. No single total ordering can represent every edge in such a cycle. The ranking summarizes performance against all opponents, while the matchup view answers the question about a particular opponent and venue.

## Browser computation

`js/neutral-rankings.js` accumulates each unique pair once, checks both forecast orientations, yields between batches to keep controls responsive, and caches the complete report by model snapshot. `getNeutralRankings(model)` supplies the cached result to the board and schedule views. Stale work is canceled when the loaded dataset changes. No partial result replaces the finished ranking.

This computation changes neither the forecast model nor saved historical predictions, forecast archives, current-fit reports, or actual/projected season records. CSV export uses the same completed full-field ranks and neutral scores displayed on the board.
