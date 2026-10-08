# College Football Index

A neutral, transparent analysis site for every FBS and FCS team. One connected game graph lets fans compare results across subdivisions, conferences, and schedules. Every team uses the same model, filters, and evidence standards.

## What it measures

- **Game power:** iterative opponent-adjusted scoring across FBS and FCS, with a 2.5-point home-field adjustment, a 28-point margin cap, and a two-game prior toward the combined field average.
- **Efficiency:** yards per play, third-down performance, and turnover margin from available box scores. Missing categories are omitted rather than filled with guesses.
- **Résumé:** opponent power plus wins above the model's expected wins against each schedule.
- **Evidence depth:** game count and box-score coverage, shown beside the rating.
- **Filters:** FBS + FCS, either subdivision, Power Four or other FBS, and individual conferences. Filters change which teams appear, never which games feed the ratings.
- **Team comparison:** compare any two loaded teams by power, opponent power, expected wins, wins above expectation, efficiency, and raw scoring margin.

The Power Four grouping for 2026 is ACC, Big Ten, Big 12, and SEC. The conference filter adapts to the selected subdivision, so FCS conferences remain available when FCS is selected.

## Season data

The published site starts with an empty dataset instead of a partial team schedule. That keeps a small example from looking like a national ranking. Import a complete FBS + FCS dataset to populate team records, schedules, filters, and ratings. The board waits for broad coverage (at least 180 completed games across 100 teams) before showing model rankings.

CollegeFootballData.com offers a free API key with a monthly request cap. Create a key, then run the sync script. It asks for the key in a hidden terminal prompt; the key is sent only to CFBD and is never embedded in the website or written to a file.

    node scripts/sync-season.mjs 2026

The script downloads both subdivisions' regular-season schedules and results, plus team box scores for completed weeks. It merges duplicate cross-division games and writes `data/current-season.json`. A refresh uses roughly two schedule requests plus two requests per completed week.

Choose the generated JSON in the Data Room to load it for your browser. To make the current dataset available to every visitor, commit the generated public game data to the repository and push it to `main`. Never commit the API key.

## Run locally

The site is plain HTML, CSS, JavaScript, and JSON, with no runtime dependencies. From this folder, start Python's built-in web server:

    python3 -m http.server 8000

Then open `http://localhost:8000` in a browser.

## Free hosting

The site can be hosted as a static website without a paid server. [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) is free for public repositories. The website and the game data committed with it are public; the API key stays local.

## Interpretation

This is an open first model, not a poll or an official selection formula. The composite index is a weighted standardized comparison, not a predicted win probability. Early-season results and incomplete box scores can change the ordering, so sample depth remains visible.
