/**
 * UKFT RCOL — Phase 1 Data Pipeline
 * ukft-inflation-pipeline.js
 *
 * Fetches ONS Layer 1 inflation series and AWE earnings data,
 * validates integrity, and writes JSON data files for the RCOL tool.
 *
 * Outputs:
 *   ../data/ukft-inflation-data.json     - CPI/CPIH/RPI series
 *   ../data/ukft-awe-data.json           - AWE earnings series
 *   ../data/ukft-inflation-meta.json     - validation state + timestamps
 *   ../data/ukft-forecast-vintages.json  - forecast schema (Phase 5, empty)
 *
 * Usage:
 *   node ukft-inflation-pipeline.js           - full refresh
 *   node ukft-inflation-pipeline.js --dry-run - fetch and validate, no writes
 *
 * Kill-switch: if ../data/inflation-refresh-paused.flag exists, exits cleanly.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const DRY_RUN     = process.argv.includes('--dry-run');
const KILL_SWITCH = path.join(DATA_DIR, 'inflation-refresh-paused.flag');
const ONS_BASE    = 'https://api.beta.ons.gov.uk/v1/data?uri=';

// Cloudflare blocks Node default UA; curl UA passes
const FETCH_HEADERS = { 'User-Agent': 'curl/8.5.0', 'Accept': '*/*' };

const CPI_MIN_PP      = -5;
const CPI_MAX_PP      = 30;
const MOM_CHANGE_FLAG = 3;
const MIN_CPI_MONTHS  = 400;
const MIN_AWE_MONTHS  = 300;

const INFLATION_SERIES = [
  { key: 'cpi_rate',   id: 'D7G7', uri: '/economy/inflationandpriceindices/timeseries/d7g7/mm23',  title: 'CPI Annual Rate 00: All Items 2015=100',  unit: '%',     primary_validation: true },
  { key: 'cpi_index',  id: 'D7BT', uri: '/economy/inflationandpriceindices/timeseries/d7bt/mm23',  title: 'CPI Index 00: All Items 2015=100',         unit: 'Index' },
  { key: 'cpih_rate',  id: 'L55O', uri: '/economy/inflationandpriceindices/timeseries/l55o/mm23',  title: 'CPIH Annual Rate 00: All Items 2015=100',  unit: '%'     },
  { key: 'cpih_index', id: 'L522', uri: '/economy/inflationandpriceindices/timeseries/l522/mm23',  title: 'CPIH Index 00: All Items 2015=100',        unit: 'Index' },
  { key: 'rpi_rate',   id: 'CHAW', uri: '/economy/inflationandpriceindices/timeseries/chaw/mm23',  title: 'RPI All Items Index: Jan 1987=100',        unit: 'Index' },
];

// CPI 12-month rate by COICOP division (Phase 4 - personal inflation calculator price side).
// Verified live on the API 2026-06-10; same MM23 uri pattern as headline.
const DIVISION_SERIES = [
  { key: 'd01', no: '01', label: 'Food & non-alcoholic drinks',      id: 'D7G8' },
  { key: 'd02', no: '02', label: 'Alcoholic drinks & tobacco',       id: 'D7G9' },
  { key: 'd03', no: '03', label: 'Clothing & footwear',              id: 'D7GA' },
  { key: 'd04', no: '04', label: 'Housing, water, fuel & power',     id: 'D7GB' },
  { key: 'd05', no: '05', label: 'Furniture & household goods',      id: 'D7GC' },
  { key: 'd06', no: '06', label: 'Health',                           id: 'D7GD' },
  { key: 'd07', no: '07', label: 'Transport',                        id: 'D7GE' },
  { key: 'd08', no: '08', label: 'Communication',                    id: 'D7GF' },
  { key: 'd09', no: '09', label: 'Recreation & culture',             id: 'D7GG' },
  { key: 'd10', no: '10', label: 'Education',                        id: 'D7GH' },
  { key: 'd11', no: '11', label: 'Restaurants & hotels',             id: 'D7GI' },
  { key: 'd12', no: '12', label: 'Miscellaneous goods & services',   id: 'D7GJ' },
].map(d => ({ ...d, uri: `/economy/inflationandpriceindices/timeseries/${d.id.toLowerCase()}/mm23`,
              title: `CPI ANNUAL RATE ${d.no}: ${d.label}`, unit: '%' }));

const AWE_SERIES = [
  { key: 'awe_nominal',    id: 'KAB9', uri: '/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kab9/emp', title: 'AWE: Whole Economy Level: Seasonally Adjusted Total Pay',      unit: 'GBP per week', range_note: 'Available from January 2000 only' },
  { key: 'awe_private',    id: 'KAC4', uri: '/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kac4/emp', title: 'AWE: Private Sector Level: Seasonally Adjusted Total Pay',     unit: 'GBP per week', range_note: 'Available from January 2000 only' },
  { key: 'awe_public',     id: 'KAC7', uri: '/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kac7/emp', title: 'AWE: Public Sector Level: Seasonally Adjusted Total Pay',      unit: 'GBP per week', range_note: 'Available from January 2000 only' },
  { key: 'awe_real_index', id: 'A2F8', uri: '/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/a2f8/emp', title: 'AWE: Whole Economy Real Terms Index: SA Regular Pay',          unit: 'Index',        range_note: 'Available from January 2000 only' },
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: FETCH_HEADERS }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${body.slice(0, 150)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function fetchSeries(series) {
  const url = ONS_BASE + encodeURIComponent(series.uri);
  return fetchJson(url).then(data => {
    if (!data || typeof data !== 'object') throw new Error(`Empty response for ${series.id}`);
    if (!data.months || !Array.isArray(data.months)) throw new Error(`No monthly data for ${series.id}`);
    return data;
  });
}

function validateInflation(key, data) {
  const months = data.months;
  const warnings = [], errors = [];
  if (months.length < MIN_CPI_MONTHS) errors.push(`${key}: only ${months.length} months (expected >=${MIN_CPI_MONTHS})`);
  const recent = months.slice(-24);
  const nulls = recent.filter(m => !m.value && m.value !== '0').length;
  if (nulls > 0) errors.push(`${key}: ${nulls} null/empty values in last 24 months`);
  if (key === 'cpi_rate') {
    recent.forEach(m => {
      const v = parseFloat(m.value);
      if (!isNaN(v) && (v < CPI_MIN_PP || v > CPI_MAX_PP)) errors.push(`${key}: implausible value ${v} at ${m.date}`);
    });
    for (let i = 1; i < recent.length; i++) {
      const delta = Math.abs(parseFloat(recent[i].value) - parseFloat(recent[i-1].value));
      if (!isNaN(delta) && delta > MOM_CHANGE_FLAG) warnings.push(`${key}: large MoM change ${delta.toFixed(2)}pp at ${recent[i].date}`);
    }
  }
  const latest = months[months.length - 1];
  if (latest && (new Date().getFullYear() - parseInt(latest.year)) > 1) warnings.push(`${key}: latest data ${latest.date} may be stale`);
  return { errors, warnings, latestDate: latest?.date, latestValue: latest?.value };
}

function validateAwe(key, data) {
  const months = data.months;
  const warnings = [], errors = [];
  if (months.length < MIN_AWE_MONTHS) errors.push(`${key}: only ${months.length} months (expected >=${MIN_AWE_MONTHS})`);
  const latest = months[months.length - 1];
  return { errors, warnings, latestDate: latest?.date, latestValue: latest?.value };
}

// Division rates swing wider than headline (clothing < -8% in 2009; education step-jumps each
// September on fee changes) - wider plausibility band, null check on recent months only.
function validateDivision(key, data) {
  const months = data.months;
  const warnings = [], errors = [];
  if (months.length < 300) errors.push(`${key}: only ${months.length} months (expected >=300)`);
  const recent = months.slice(-24);
  const nulls = recent.filter(m => m.value === '' || m.value === null).length;
  if (nulls > 0) errors.push(`${key}: ${nulls} null/empty values in last 24 months`);
  for (const m of recent) {
    const v = parseFloat(m.value);
    if (!isNaN(v) && (v < -15 || v > 35)) errors.push(`${key}: implausible division rate ${v} at ${m.date}`);
  }
  const latest = months[months.length - 1];
  return { errors, warnings, latestDate: latest?.date, latestValue: latest?.value };
}

function buildSeriesRecord(series, data) {
  return {
    series_id: series.id, title: series.title, unit: series.unit,
    source: 'ONS via api.beta.ons.gov.uk', licence: 'Open Government Licence v3.0',
    range_note: series.range_note || null,
    monthly: data.months.map(m => ({ date: m.date, year: m.year, month: m.month, value: m.value })),
    annual:  (data.years || []).map(y => ({ date: y.date, value: y.value })),
  };
}

function buildInflationData(results, divResults, ts) {
  const doc = { _meta: { description: 'UKFT RCOL Layer 1 — Official UK inflation indices from ONS MM23 (headline + 12 COICOP division annual rates)', generated: ts, source: 'ONS MM23 via api.beta.ons.gov.uk', licence: 'Open Government Licence v3.0', attribution: 'Office for National Statistics' } };
  for (const [k, { series, data }] of Object.entries(results)) doc[k] = buildSeriesRecord(series, data);
  // Compact division records (date+value only) - the personal-rate engine's price side
  doc.divisions = {};
  for (const [k, { series, data }] of Object.entries(divResults)) {
    doc.divisions[k] = {
      division: series.no, label: series.label, series_id: series.id, unit: '%',
      monthly: data.months.map(m => ({ date: m.date, value: m.value })),
    };
  }
  return doc;
}

function buildAweData(results, ts) {
  const doc = { _meta: { description: 'UKFT RCOL — Average Weekly Earnings from ONS for purchasing power analysis', generated: ts, source: 'ONS Labour Market Statistics via api.beta.ons.gov.uk', licence: 'Open Government Licence v3.0', attribution: 'Office for National Statistics', range_note: 'AWE available from January 2000 only. All series seasonally adjusted.' } };
  for (const [k, { series, data }] of Object.entries(results)) doc[k] = buildSeriesRecord(series, data);
  return doc;
}

function buildMeta(inflRes, aweRes, validation, ts) {
  const allErrors   = Object.values(validation).flatMap(v => v.errors);
  const allWarnings = Object.values(validation).flatMap(v => v.warnings);
  return {
    _meta: { description: 'UKFT RCOL — Pipeline validation state and data coverage metadata', schema_version: '1.0' },
    last_updated: ts,
    pipeline_status: allErrors.length === 0 ? 'passed' : 'failed',
    layer1: {
      last_refresh: ts,
      latest_month: validation.cpi_rate?.latestDate || null,
      latest_cpi_rate: validation.cpi_rate?.latestValue || null,
      validation_status: validation.cpi_rate?.errors.length === 0 ? 'passed' : 'failed',
      series_covered: INFLATION_SERIES.map(s => s.id),
      division_series_covered: DIVISION_SERIES.map(s => s.id),
      divisions_latest_month: validation.div_d01?.latestDate || null,
    },
    awe: { last_refresh: ts, latest_month: validation.awe_nominal?.latestDate || null, latest_value: validation.awe_nominal?.latestValue || null, series_covered: AWE_SERIES.map(s => s.id) },
    hci: (() => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ukft-hci-data.json'), 'utf8'));
        return { last_refresh: d._meta?.generated || null, latest_month: d.latest_month || null,
          note: 'HCI Layer 2 populated from ONS Household Costs Indices reference tables (quarterly manual ingest via ukft-hci-pipeline.py).' };
      } catch { return { last_refresh: null, note: 'Phase 3 - not yet populated. Awaiting HCI series confirmation (Open Question #3).' }; }
    })(),
    ...(() => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ukft-lcf-weights.json'), 'utf8'));
        const vintage = d._meta?.vintage || null;
        const year = vintage ? (parseInt(String(vintage).match(/\d{4}/)?.[0], 10) || null) : null;
        return { lcf_vintage_year: year,
          lcf_note: `LCF Layer 3 weights loaded ${d._meta?.generated || '(date n/a)'}, vintage ${vintage || 'n/a'}, from ONS Family Spending workbook (annual manual ingest via ukft-lcf-pipeline.py).` };
      } catch { return { lcf_vintage_year: null, lcf_note: 'Phase 4 - not yet populated. LCF weights loaded manually on ONS publication.' }; }
    })(),
    forecast_vintages: { last_capture: null, vintages_count: 0, latest_vintage: null, note: 'Phase 5 - schema reserved. Population begins when Phase 5 activates.' },
    validation: { errors: allErrors, warnings: allWarnings, checked: ts },
  };
}

function initForecastVintagesSchema() {
  return {
    _meta: {
      description: 'UKFT RCOL — BoE MPR forecast vintages with ONS CPI outturns for accuracy analysis',
      schema_version: '1.0',
      status: 'Phase 5 - schema only. Population begins when Phase 5 activates.',
      distribution_model: 'Split-normal. Parameters: mode (central projection), uncertainty (width), skewness (asymmetry). Pre-computed percentile bands stored for efficient rendering.',
      sources: [
        'Bank of England Monetary Policy Report (quarterly) - chart slides and data Excel download',
        'OBR Economic and Fiscal Outlook (twice yearly)',
        'ONS CPI/CPIH outturns from MM23 (this pipeline)',
      ],
      licence: 'Open Government Licence v3.0',
    },
    vintages: [],
    outturn_series: 'D7G7',
    example_vintage_structure: {
      source: 'BoE MPR', publication_date: 'YYYY-MM-DD', vintage_label: 'YYYY QN', base_quarter: 'YYYY QN',
      forecasts: [
        { horizon_quarters: 4,  horizon_label: '1 year ahead',  mode: null, uncertainty: null, skewness: null, p10: null, p25: null, p75: null, p90: null },
        { horizon_quarters: 8,  horizon_label: '2 years ahead', mode: null, uncertainty: null, skewness: null, p10: null, p25: null, p75: null, p90: null },
        { horizon_quarters: 12, horizon_label: '3 years ahead', mode: null, uncertainty: null, skewness: null, p10: null, p25: null, p75: null, p90: null },
      ],
      outturns: { cpi_1yr_actual: null, cpi_2yr_actual: null, cpi_3yr_actual: null, outturn_source: 'ONS MM23 D7G7', error_1yr: null, error_2yr: null, error_3yr: null },
    },
  };
}

function writeJson(filepath, data, label) {
  if (DRY_RUN) { log(`  [DRY RUN] would write ${label} -> ${path.basename(filepath)}`); return; }
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  const kb = (Buffer.byteLength(JSON.stringify(data), 'utf8') / 1024).toFixed(1);
  log(`  ok  ${label} -> ${path.basename(filepath)} (${kb} KB)`);
}

function readExistingMeta(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }

function log(msg)   { console.log(msg); }
function warn(msg)  { console.warn(`  WARN  ${msg}`); }
function err(msg)   { console.error(`  ERR   ${msg}`); }

async function main() {
  const ts = new Date().toISOString();
  log('');
  log('UKFT RCOL - Phase 1 Data Pipeline');
  log(`Run: ${ts}${DRY_RUN ? '  [DRY RUN]' : ''}`);
  log('-'.repeat(60));

  if (fs.existsSync(KILL_SWITCH)) {
    log('Kill-switch active: inflation-refresh-paused.flag found. Halting.');
    process.exit(0);
  }

  const priorMeta = readExistingMeta(path.join(DATA_DIR, 'ukft-inflation-meta.json'));
  log(priorMeta ? `Prior run: ${priorMeta.last_updated} | status: ${priorMeta.pipeline_status}` : 'No prior meta - first run.');
  log('');

  // Fetch Layer 1
  log('Fetching Layer 1 inflation series from ONS MM23...');
  const inflRes = {};
  for (const series of INFLATION_SERIES) {
    try {
      process.stdout.write(`  ${series.id}  ${series.title.slice(0,45).padEnd(45)} `);
      const data = await fetchSeries(series);
      const v = validateInflation(series.key, data);
      v.errors.forEach(e => err(e));
      v.warnings.forEach(w => warn(w));
      console.log(`${data.months.length} months | ${v.latestDate} = ${v.latestValue}`);
      inflRes[series.key] = { series, data, validation: v };
    } catch (e) {
      console.log('FAILED');
      err(`${series.id}: ${e.message}`);
      err('Aborting - retaining prior data.');
      process.exit(1);
    }
  }

  // Fetch CPI division rates (Phase 4 price side) - abort on failure like Layer 1:
  // a partial write would silently drop the divisions block the live calculator reads (CC-3).
  log('');
  log('Fetching CPI division rates (12 COICOP divisions)...');
  const divRes = {};
  for (const series of DIVISION_SERIES) {
    try {
      process.stdout.write(`  ${series.id}  ${series.title.slice(0,45).padEnd(45)} `);
      const data = await fetchSeries(series);
      const v = validateDivision(series.key, data);
      v.errors.forEach(e => err(e));
      v.warnings.forEach(w => warn(w));
      console.log(`${data.months.length} months | ${v.latestDate} = ${v.latestValue}`);
      divRes[series.key] = { series, data, validation: v };
    } catch (e) {
      console.log('FAILED');
      err(`${series.id}: ${e.message}`);
      err('Aborting - retaining prior data.');
      process.exit(1);
    }
  }

  // Fetch AWE
  log('');
  log('Fetching AWE earnings series from ONS...');
  const aweRes = {};
  for (const series of AWE_SERIES) {
    try {
      process.stdout.write(`  ${series.id}  ${series.title.slice(0,45).padEnd(45)} `);
      const data = await fetchSeries(series);
      const v = validateAwe(series.key, data);
      v.errors.forEach(e => err(e));
      v.warnings.forEach(w => warn(w));
      console.log(`${data.months.length} months | ${v.latestDate} = ${v.latestValue}`);
      aweRes[series.key] = { series, data, validation: v };
    } catch (e) {
      console.log('FAILED');
      err(`${series.id}: ${e.message} - AWE will not be updated.`);
    }
  }

  // Validation summary
  log('');
  log('Validation:');
  const allValidation = {
    ...Object.fromEntries(Object.entries(inflRes).map(([k, v]) => [k, v.validation])),
    ...Object.fromEntries(Object.entries(divRes).map(([k, v]) => [`div_${k}`, v.validation])),
    ...Object.fromEntries(Object.entries(aweRes).map(([k, v]) => [k, v.validation])),
  };
  const totalErrors   = Object.values(allValidation).flatMap(v => v.errors);
  const totalWarnings = Object.values(allValidation).flatMap(v => v.warnings);

  if (totalErrors.length === 0 && totalWarnings.length === 0) {
    log('  All series passed - no errors or warnings.');
  } else {
    totalErrors.forEach(e => err(e));
    totalWarnings.forEach(w => warn(w));
  }

  if (totalErrors.length > 0) {
    err('Validation errors - aborting write. Prior data retained.');
    process.exit(1);
  }

  // Write files
  log('');
  log('Writing data files...');
  writeJson(path.join(DATA_DIR, 'ukft-inflation-data.json'), buildInflationData(inflRes, divRes, ts), 'Layer 1 inflation + divisions');
  if (Object.keys(aweRes).length > 0) writeJson(path.join(DATA_DIR, 'ukft-awe-data.json'), buildAweData(aweRes, ts), 'AWE earnings');
  writeJson(path.join(DATA_DIR, 'ukft-inflation-meta.json'), buildMeta(inflRes, aweRes, allValidation, ts), 'Pipeline meta');

  const forecastPath = path.join(DATA_DIR, 'ukft-forecast-vintages.json');
  if (!fs.existsSync(forecastPath)) {
    writeJson(forecastPath, initForecastVintagesSchema(), 'Forecast vintages schema (Phase 5 init)');
  } else {
    log('  Forecast vintages file exists - not overwritten.');
  }

  log('');
  log('-'.repeat(60));
  log('Pipeline complete.');
  log(`  Layer 1:  ${Object.keys(inflRes).length}/${INFLATION_SERIES.length} series`);
  log(`  Divisions: ${Object.keys(divRes).length}/${DIVISION_SERIES.length} series`);
  log(`  AWE:      ${Object.keys(aweRes).length}/${AWE_SERIES.length} series`);
  log(`  Warnings: ${totalWarnings.length}`);
  log(`  CPI:      ${allValidation.cpi_rate?.latestDate} = ${allValidation.cpi_rate?.latestValue}%`);
  log(`  AWE:      ${allValidation.awe_nominal?.latestDate} = GBP ${allValidation.awe_nominal?.latestValue}/wk`);
  if (DRY_RUN) log('  [DRY RUN] - no files written.');
  log('');
}

main().catch(e => { console.error('\nUnhandled error:', e.message); process.exit(1); });
