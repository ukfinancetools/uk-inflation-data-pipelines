# Methodology

How the datasets in `data/` are produced, validated and refreshed. Everything is reproducible: run the pipeline, get the JSON.

## Sources

| Dataset | ONS source | Cadence | Pipeline |
|---|---|---|---|
| `ukft-inflation-data.json` | ONS time-series API: CPI (D7G7/D7BT), CPIH (L55O/L522), RPI (CHAW), 12 COICOP division annual rates | Monthly release, checked each weekday | `ukft-inflation-pipeline.js` |
| `ukft-awe-data.json` | ONS time-series API: Average Weekly Earnings | Monthly release | `ukft-inflation-pipeline.js` |
| `ukft-hci-data.json` | ONS Household Costs Indices reference tables (quarterly xlsx; not available via the API) | Quarterly | `ukft-hci-pipeline.py` |
| `ukft-lcf-weights.json` | ONS Family Spending workbooks 2 and 3 (Living Costs and Food Survey) | Annual (~September) | `ukft-lcf-pipeline.py` |

All content is Open Government Licence v3.0. The pipelines fetch only published statistics; nothing is scraped from behind a login and no personal data is involved.

## Approach

1. **Resolve, do not hardcode.** Spreadsheet-only releases (HCI, LCF) move URL each quarter or year. The pipelines resolve the latest edition from the ONS landing page at run time, with a pinned fallback URL as a safety net.
2. **Validate before writing.** The API pipeline cross-checks a primary series before accepting a refresh, and refuses to write partial output. A failed fetch leaves the previous good data in place rather than a broken file.
3. **Capped common windows.** Where ONS groups start their series at different dates (the HCI all-households series starts January 2022 in the current tables), series are capped to a common window so downstream comparisons are like-for-like.
4. **Values are stored as published.** 12-month percentage changes are kept to the precision the ONS publishes (one decimal place). No smoothing, no interpolation, no seasonal adjustment beyond what the ONS applies.

## Caveats that are part of the data

- **HCI is "official statistics in development"** and uses the payments approach, which includes mortgage interest payments. It is designed to answer "how have costs changed for households like mine", not to replace CPI. Comparing HCI to CPI is legitimate only if the mortgage-interest difference is stated.
- **HCI income deciles are equivalised household disposable income deciles.** They are not comparable with individual earnings percentiles (for example ASHE hourly-pay percentiles): different unit, different measure. Do not overlay them.
- **12-month % change is not a price level.** A falling rate means prices rising more slowly, not prices falling.
- **LCF spending weights are survey-based** and revised annually; they describe average spending patterns for a household group, not any actual household.

## Verification pattern used downstream

On the UK Finance Tools site, any published claim derived from this data is encoded as an executable assertion and re-run before use - superlatives, ranks and "in every month" claims are tested as range queries over the whole series, never as single point lookups. The pattern is simple and transferable: a claims file next to the dataset, run to all-pass before anything quoting the data ships. It exists because point checks happily "verify" a wrong peak month.

## Refresh behaviour

Each JSON carries its own metadata (timestamps, series ranges) so consumers can detect vintage. If a pipeline run fails validation it exits non-zero and leaves the previous file untouched - consumers see stale-but-consistent data with an honest timestamp, never a silently broken file.
