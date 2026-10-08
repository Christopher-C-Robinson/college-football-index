# Preserved baseline inputs

These are the exact CollegeFootballData.com final-record archives collected on October 8, 2026 for the model 2.0.0 baseline. The gzip files decompress to the original JSON bytes. No API key is included.

- 2018–2021 supply venue warmup results; box scores were not requested.
- 2022–2025 supply completed evaluation seasons and available box scores.
- 2026 is incomplete, with results through October 7.

`manifest.json` records source fingerprints and the collection run. Report `sourceArchives` fields must match the SHA-256 of `JSON.stringify(parsed archive)`, rather than the compressed file bytes. Node tests verify these matches and the saved prediction fingerprints.

Provider rows remain intact, including canceled games mislabeled completed 0–0 and unresolved kickoff flags. The shared model excludes modern 0–0 rows from played results; replay reports disclose these and unresolved-kickoff exclusions. Archive metadata counts predate this correction and should not replace the shared validator's recomputed counts.

See [the evaluation protocol](../../../docs/accuracy-foundation.md) for the temporal reconstruction limits and replay commands in the [project README](../../../README.md).
