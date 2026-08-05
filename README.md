# UK inflation data pipelines

Open pipelines and derived datasets for UK inflation statistics, built and maintained for the free calculators at [UK Finance Tools](https://www.ukfinancetools.co.uk). Everything here is reproducible from ONS primary sources, and the derived JSON is the same data the live [Real Cost of Living tool](https://www.ukfinancetools.co.uk/calculators/real-cost-of-living) serves.

## What is in here

| Path | What it is |
|---|---|
| `pipelines/ukft-inflation-pipeline.js` | Node. Fetches CPI, CPIH and RPI headline series plus the 12 COICOP division rates, and AWE earnings, from the ONS time-series API. Validates before writing; refuses partial output. |
| `pipelines/ukft-hci-pipeline.py` | Python. The ONS Household Costs Indices are spreadsheet-only (not in the API) - this resolves the latest quarterly xlsx from the ONS reference-tables page and parses the 12-month % change for every household group (income deciles, tenure, retired, children). |
| `pipelines/ukft-lcf-pipeline.py` | Python. Parses the annual ONS Family Spending (Living Costs and Food Survey) workbooks into household spending-weight profiles. |
| `data/*.json` | The derived datasets the pipelines produce, refreshed on the cadence of each ONS release (daily-checked API series; quarterly HCI; annual LCF). |

## Why it exists

Most UK inflation coverage quotes one number. Household inflation differs sharply by tenure, income and spending mix, and the source data for that story is scattered across an API, quarterly spreadsheets and annual workbooks. These pipelines gather it into clean JSON so anyone - journalist, researcher, tinkerer - can use it without repeating the parsing work.

## Method notes (the short version)

- **Sources:** ONS time-series API (CPI/CPIH/RPI, AWE), ONS Household Costs Indices reference tables, ONS Family Spending workbooks. All Open Government Licence v3.0.
- **HCI caveat that matters:** HCI uses the payments approach and includes mortgage interest, so it is deliberately different from headline CPI. Attribute it as "ONS Household Costs Indices", never as CPI.
- **Figures are 12-month percentage changes**, not price levels. Easing inflation does not mean falling prices.
- Full method detail, validation approach and caveats: [`docs/methodology.md`](docs/methodology.md).

## Using the data

Free to use under the terms below. If you publish something built on it, an attribution line and a link are appreciated:

> Source: ONS (Open Government Licence v3.0), pipeline and derived data by [UK Finance Tools](https://www.ukfinancetools.co.uk)

## Licence

Code: MIT (see `LICENSE`). Derived data: contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/); attribute the ONS as the underlying source.
