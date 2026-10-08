# College Football Index

A neutral, transparent analysis site for every FBS and FCS team. One connected game graph lets fans compare results across subdivisions, conferences, and schedules. Every team uses the same model, filters, and evidence standards.

**Live site:** [College Football Index](https://christopher-c-robinson.github.io/college-football-index/)

## What it measures

- **Game power:** iterative opponent-adjusted scoring across FBS and FCS, with game-specific home and road effects estimated from five seasons, a 28-point margin cap, and a two-game prior toward the combined field average.
- **Efficiency:** yards per play, third-down performance, and turnover margin from available box scores. Missing categories are omitted rather than filled with guesses.
- **Résumé:** opponent power plus wins above the model's expected wins against each schedule.
- **Evidence depth:** game count and box-score coverage, shown beside the rating.
- **Filters:** FBS + FCS, either subdivision, Power Four or other FBS, and individual conferences. Filters change which teams appear, never which games feed the ratings.
- **Team comparison:** compare any two loaded teams by power, opponent power, expected wins, wins above expectation, efficiency, raw scoring margin, and estimated home-road swing.
- **What-If simulator:** run 10,000 hypothetical outcomes for two teams at a neutral site or either team's home field. It uses adjusted power and each matchup's home/road effects for the spread, current scoring and points-allowed rates for the score total, and greater rating uncertainty for teams with fewer results.
- **Team identity:** the site starts with a neutral theme and no team selected. Selecting a team from the ranked board or explorer applies its CFBD primary and alternate colors.

The Power Four grouping for 2026 is ACC, Big Ten, Big 12, and SEC. The conference filter adapts to the selected subdivision, so FCS conferences remain available when FCS is selected.

## Season data

The published site loads the current FBS + FCS season dataset from this repository. Visitors can also import another compatible file. The board waits for broad coverage (at least 180 completed games across 100 teams) before showing model rankings.

CollegeFootballData.com offers a free API key with 1,000 API calls per month and no credit card requirement. For a local refresh, use the sync script. It asks for the key in a hidden terminal prompt; the key is sent only to CFBD and is never embedded in the website or written to a file.

    node scripts/sync-season.mjs 2026

The script downloads current-season schedules and results, team metadata (including colors), and team box scores for completed weeks. It also downloads the current season and previous four seasons of regular-season schedules, then computes opponent-adjusted home and road effects. Recent seasons count more, and team estimates shrink toward the field average when samples are limited. The generated file stores the estimate and its sample counts, not the full historical game archive. A refresh uses ten schedule requests, one team-metadata request, and two requests per completed current-season week.

For automatic public updates, add a GitHub Actions repository secret named `CFBD_API_KEY` under **Settings → Secrets and variables → Actions**. The `Update season data and publish site` workflow refreshes every Monday after the weekend games, commits changed data, and requests a GitHub Pages rebuild. You can also start it from **Actions → Update season data and publish site → Run workflow**. Never commit the API key.

The workflow works with this repository's current GitHub Pages branch publishing setup. Regular pushes to `main` publish the site as before; after a scheduled or manual data commit, the workflow explicitly requests a Pages rebuild. The repository and generated game data are public; the API key stays in GitHub's secret store and is not included in the website.

The simulator uses schedule-adjusted power ratings and the matchup-specific home/road estimates to calculate the spread. A neutral-site game gets no venue term. It estimates total points from each team's scoring and points allowed, shrunk toward the full-field average when the sample is small. The outcome draws use a logistic game-variation model and add rating uncertainty based on each team's game count. It does not account for injuries, weather, or tactical matchup details.

## Run locally

The site is plain HTML, CSS, JavaScript, and JSON, with no runtime dependencies. From this folder, start Python's built-in web server:

    python3 -m http.server 8000

Then open `http://localhost:8000` in a browser.

## Free hosting

The site can be hosted as a static website without a paid server. [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and GitHub Actions are available at no cost for public repositories. The website and game data committed with it are public; the API key stays in the repository's Actions secret store.

## Interpretation

This is an open first model, not a poll or an official selection formula. The composite index is a weighted standardized comparison, not a predicted win probability. Early-season results and incomplete box scores can change the ordering, so sample depth remains visible.
