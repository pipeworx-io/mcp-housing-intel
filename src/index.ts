interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Housing Intel MCP — Meta-pack that chains FRED, BLS, ATTOM, and HUD APIs
 * into higher-level housing market workflows.
 *
 * BYO keys required:
 *   _fredKey  — FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html)
 *   _attomKey — ATTOM API key (https://api.gateway.attomdata.com)
 * Optional:
 *   _hudKey   — HUD API token (https://www.huduser.gov/portal/dataset/fmr-api.html)
 *
 * BLS public API requires no key.
 *
 * Tools:
 * - housing_market_snapshot:  macro market overview (FRED + BLS)
 * - housing_property_report:  full property analysis (ATTOM)
 * - housing_rental_analysis:  rental market analysis (ATTOM + HUD + BLS)
 * - housing_affordability_check: affordability metrics (FRED + HUD + BLS)
 * - housing_employment_outlook: labor market indicators (BLS)
 */


// ── API helpers ────────────────────────────────────────────────────────

async function fredGet(apiKey: string, path: string) {
  const res = await fetch(
    `https://api.stlouisfed.org/fred${path}&api_key=${apiKey}&file_type=json`,
  );
  if (!res.ok) throw new Error(`FRED error (${res.status})`);
  return res.json();
}

async function blsPost(seriesIds: string[], startYear: string, endYear: string) {
  const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seriesid: seriesIds, startyear: startYear, endyear: endYear }),
  });
  if (!res.ok) throw new Error(`BLS error (${res.status})`);
  return res.json();
}

async function attomGet(apiKey: string, path: string) {
  const res = await fetch(`https://api.gateway.attomdata.com/propertyapi/v1.0.0${path}`, {
    headers: { accept: 'application/json', apikey: apiKey },
  });
  if (!res.ok) {
    const status = res.status;
    let hint = '';
    if (status === 404 || status === 400) {
      hint = ' — ATTOM could not match that address. Try a different format: use the city where the property is located (e.g., "Garden City, GA" instead of "Savannah, GA"), include the ZIP code, or verify the street address spelling.';
    }
    throw new Error(`ATTOM error (${status})${hint}`);
  }
  return res.json();
}

async function hudGet(token: string, path: string) {
  const res = await fetch(`https://www.huduser.gov/hudapi/public${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HUD error (${res.status})`);
  return res.json();
}

// ── Metro CBSA lookup (FHFA HPI series: ATNHPIUS{CBSA}Q) ─────────────

const METRO_CBSA: Record<string, string> = {
  'atlanta': '12060', 'austin': '12420', 'baltimore': '12580', 'boston': '14460',
  'charlotte': '16740', 'chicago': '16980', 'cincinnati': '17140', 'cleveland': '17460',
  'columbus': '18140', 'dallas': '19100', 'denver': '19740', 'detroit': '19820',
  'houston': '26420', 'indianapolis': '26900', 'jacksonville': '27260',
  'kansas city': '28140', 'las vegas': '29820', 'los angeles': '31080',
  'memphis': '32820', 'miami': '33100', 'milwaukee': '33340', 'minneapolis': '33460',
  'nashville': '34980', 'new orleans': '35380', 'new york': '35620',
  'oklahoma city': '36420', 'orlando': '36740', 'philadelphia': '37980',
  'phoenix': '38060', 'pittsburgh': '38300', 'portland': '38900',
  'raleigh': '39580', 'richmond': '40060', 'riverside': '40140',
  'sacramento': '40900', 'salt lake city': '41620', 'san antonio': '41700',
  'san diego': '41740', 'san francisco': '41860', 'san jose': '41940',
  'savannah': '42340', 'seattle': '42660', 'st louis': '41180',
  'tampa': '45300', 'virginia beach': '47260', 'washington': '47900',
};

// ── Utility helpers ────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentYear(): string {
  return String(new Date().getFullYear());
}

function previousYear(): string {
  return String(new Date().getFullYear() - 1);
}

/**
 * Compute a simple trend label from the last 3+ numeric values.
 * Values should be in chronological order (oldest first).
 */
function trendLabel(values: number[]): 'rising' | 'falling' | 'stable' {
  if (values.length < 2) return 'stable';
  const recent = values.slice(-3);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const pctChange = ((last - first) / Math.abs(first || 1)) * 100;
  if (pctChange > 0.5) return 'rising';
  if (pctChange < -0.5) return 'falling';
  return 'stable';
}

/**
 * Extract the latest N observations from a FRED observations response.
 * Returns { date, value }[] in chronological order.
 */
function extractFredObs(data: unknown, count: number): { date: string; value: number }[] {
  const obs = ((data as Record<string, unknown>)?.observations as { date: string; value: string }[]) ?? [];
  const filtered = obs
    .filter((o) => o.value !== '.')
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .sort((a, b) => a.date.localeCompare(b.date)); // always chronological
  return filtered.slice(-count);
}

/**
 * Extract the latest data from a BLS series response.
 * BLS returns data newest-first; we reverse for chronological order.
 */
function extractBlsSeries(
  data: unknown,
  seriesId: string,
): { date: string; value: number }[] {
  const results = (data as Record<string, unknown>)?.Results as Record<string, unknown> | undefined;
  const seriesList = (results?.series as { seriesID: string; data: { year: string; period: string; periodName: string; value: string }[] }[]) ?? [];
  const series = seriesList.find((s) => s.seriesID === seriesId);
  if (!series) return [];
  return series.data
    .filter((d) => d.period !== 'M13') // skip annual averages
    .map((d) => ({
      date: `${d.year}-${d.period.replace('M', '')}`,
      value: parseFloat(d.value),
    }))
    .reverse(); // chronological order
}

/**
 * Safely run a promise, returning result or an error string.
 */
async function safe<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (err) {
    return { error: (err as Error).message ?? String(err) };
  }
}

function isError(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

// ── Signal detection (inspired by Mike Simonsen's dashboard) ─────────

interface Signal {
  type: 'reversal' | 'unusual' | 'accelerating' | 'turn' | 'extreme';
  message: string;
}

function detectSignals(values: number[], label: string): Signal[] {
  const signals: Signal[] = [];
  if (values.length < 4) return signals;

  const recent = values.slice(-6);
  const current = recent[recent.length - 1];
  const prior = recent[recent.length - 2];
  const priorTrend = recent.slice(0, -1);

  // Calculate mean and std dev for the series
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  // Reversal detection: current direction differs from prior 3+ periods
  if (priorTrend.length >= 3) {
    const priorDeltas = priorTrend.slice(-3).map((v, i, a) => i > 0 ? v - a[i - 1] : 0).slice(1);
    const wasRising = priorDeltas.every(d => d > 0);
    const wasFalling = priorDeltas.every(d => d < 0);
    const currentDelta = current - prior;

    if (wasRising && currentDelta < 0) {
      signals.push({ type: 'reversal', message: `Reversal: ${label} downtick breaks recent advance` });
    }
    if (wasFalling && currentDelta > 0) {
      signals.push({ type: 'reversal', message: `Reversal: ${label} uptick breaks recent decline` });
    }
  }

  // Unusual move detection (> 1.5 std devs from mean change)
  if (stdDev > 0) {
    const change = Math.abs(current - prior);
    const meanChange = values.slice(1).reduce((a, v, i) => a + Math.abs(v - values[i]), 0) / (values.length - 1);
    const changeStdDev = Math.sqrt(values.slice(1).reduce((a, v, i) => a + (Math.abs(v - values[i]) - meanChange) ** 2, 0) / (values.length - 1));
    if (changeStdDev > 0 && change > meanChange + 1.5 * changeStdDev) {
      const direction = current > prior ? 'jump' : 'drop';
      const stdDevs = ((change - meanChange) / changeStdDev).toFixed(1);
      signals.push({ type: 'unusual', message: `Unusual ${direction} (${stdDevs} std devs) in ${label}` });
    }
  }

  // Accelerating: YoY change is increasing in magnitude
  if (values.length >= 13) {
    const yoyNow = current - values[values.length - 13];
    const yoyPrior = prior - values[values.length - 14];
    if (Math.abs(yoyNow) > Math.abs(yoyPrior) * 1.1) {
      signals.push({ type: 'accelerating', message: `${label} YoY change accelerating` });
    }
  }

  // Turn: period-over-period direction changed
  if (recent.length >= 3) {
    const prevDelta = recent[recent.length - 2] - recent[recent.length - 3];
    const currDelta = current - prior;
    if (prevDelta <= 0 && currDelta > 0) {
      signals.push({ type: 'turn', message: `${label} period change turned positive (was negative)` });
    }
    if (prevDelta >= 0 && currDelta < 0) {
      signals.push({ type: 'turn', message: `${label} period change turned negative (was positive)` });
    }
  }

  // Extreme: value > 2 std devs from mean
  if (stdDev > 0 && Math.abs(current - mean) > 2 * stdDev) {
    const direction = current > mean ? 'above' : 'below';
    signals.push({ type: 'extreme', message: `${label} at extreme level (${((current - mean) / stdDev).toFixed(1)} std devs ${direction} mean)` });
  }

  return signals;
}

function computeYoY(values: { date: string; value: number }[]): { value: number; change: number; pctChange: number } | null {
  if (values.length < 13) return null;
  const current = values[values.length - 1].value;
  const yearAgo = values[values.length - 13].value;
  return {
    value: current,
    change: current - yearAgo,
    pctChange: ((current - yearAgo) / Math.abs(yearAgo || 1)) * 100,
  };
}

// ── Tool definitions ───────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'housing_market_snapshot',
    description:
      'Get a national housing market snapshot — 30-year mortgage rates, housing starts, Case-Shiller home price index, unemployment, owners equivalent rent, and construction employment. Mortgage rates, housing starts, unemployment, OER, and construction employment are always national-level data. When metro_name is provided (e.g., "Denver", "Atlanta"), the response also includes the FHFA metro-level House Price Index for that metro. Combines FRED and BLS data in a single call. Note: this meta-pack uses _attomKey (not _apiKey) for ATTOM tools, unlike the standalone attom pack which uses _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html)',
        },
        metro_name: {
          type: 'string',
          description: 'Metro area name for metro-level FHFA HPI (e.g., "Denver", "Atlanta"). Supports top 50 US metros. National data is always included.',
        },
      },
      required: ['_fredKey'],
    },
  },
  {
    name: 'housing_property_report',
    description:
      'Complete property analysis combining ATTOM data — property details, automated valuation (AVM), sales history, and tax assessment in one call. Note: this meta-pack uses _attomKey (not _apiKey like the standalone attom pack).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _attomKey: {
          type: 'string',
          description: 'ATTOM API key (https://api.gateway.attomdata.com)',
        },
        address1: {
          type: 'string',
          description: 'Street address (e.g., "4529 Winona Court")',
        },
        address2: {
          type: 'string',
          description: 'City, state ZIP (e.g., "Denver, CO 80212")',
        },
      },
      required: ['_attomKey', 'address1', 'address2'],
    },
  },
  {
    name: 'housing_rental_analysis',
    description:
      'Rental market analysis for a property and area — estimated rent (ATTOM), fair market rents (HUD, if key provided), and CPI rent trend (BLS). Note: uses _attomKey (not _apiKey) for ATTOM access.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _attomKey: {
          type: 'string',
          description: 'ATTOM API key',
        },
        _hudKey: {
          type: 'string',
          description: 'HUD API token (optional — needed for fair market rents)',
        },
        address1: {
          type: 'string',
          description: 'Street address (e.g., "4529 Winona Court")',
        },
        address2: {
          type: 'string',
          description: 'City, state ZIP (e.g., "Denver, CO 80212")',
        },
        state_code: {
          type: 'string',
          description: 'Two-letter state code for HUD FMR lookup (e.g., "CO")',
        },
      },
      required: ['_attomKey', 'address1', 'address2', 'state_code'],
    },
  },
  {
    name: 'housing_affordability_check',
    description:
      'Check housing affordability metrics — current mortgage rate (national), median home price (national), metro-level FHFA HPI if metro_name provided, average hourly earnings, estimated monthly payment, income needed, and HUD income limits.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key',
        },
        _hudKey: {
          type: 'string',
          description: 'HUD API token (optional — needed for income limits)',
        },
        metro_name: {
          type: 'string',
          description: 'Metro name for metro-level FHFA HPI (e.g., "Denver", "Savannah"). Optional.',
        },
        state_code: {
          type: 'string',
          description: 'Two-letter state code for HUD income limits (e.g., "CO")',
        },
        zip_code: {
          type: 'string',
          description: 'ZIP code for more specific HUD data (optional)',
        },
      },
      required: ['_fredKey', 'state_code'],
    },
  },
  {
    name: 'housing_employment_outlook',
    description:
      'Labor market indicators relevant to housing — total nonfarm employment, construction employment, residential building employment, unemployment rate, JOLTS job openings, and JOLTS hires. All from BLS (no key needed).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key (accepted for consistency but not used — BLS is free)',
        },
      },
      required: [],
    },
  },
  {
    name: 'housing_signal_scan',
    description:
      'Comprehensive housing market signal scan — checks 45+ indicators for reversals, unusual moves, acceleration, and extreme readings. Covers: mortgage rates, housing starts/permits, NAR existing home sales & inventory, Case-Shiller (national + 20 metros), consumer confidence, Atlanta Fed wage growth, unemployment, CPI shelter/rent (national + 14 metros), construction employment. Returns flagged anomalies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key',
        },
      },
      required: ['_fredKey'],
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────

async function housingMarketSnapshot(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');
  const metroRaw = (args.metro_name as string) ?? '';
  const metroNorm = metroRaw.trim().toLowerCase();
  const cbsa = METRO_CBSA[metroNorm] ?? null;
  const metro = metroRaw || 'National';

  // Fire all requests in parallel
  const [mortgage, houst, caseShiller, blsData, metroHpiData] = await Promise.all([
    safe(fredGet(fredKey, '/series/observations?series_id=MORTGAGE30US&sort_order=desc&limit=4')),
    safe(fredGet(fredKey, '/series/observations?series_id=HOUST&sort_order=desc&limit=3')),
    safe(fredGet(fredKey, '/series/observations?series_id=CSUSHPISA&sort_order=desc&limit=3')),
    safe(
      blsPost(
        ['LNS14000000', 'CUUR0000SEHC', 'CES2000000001'],
        previousYear(),
        currentYear(),
      ),
    ),
    cbsa
      ? safe(fredGet(fredKey, `/series/observations?series_id=ATNHPIUS${cbsa}Q&sort_order=desc&limit=20`))
      : Promise.resolve(null),
  ]);

  // Process FRED mortgage data
  let mortgageResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(mortgage)) {
    const obs = extractFredObs(mortgage, 4);
    if (obs.length > 0) {
      const values = obs.map((o) => o.value);
      mortgageResult = {
        current: values[values.length - 1],
        '4wk_ago': values[0],
        trend: trendLabel(values),
      };
    }
  } else {
    mortgageResult = mortgage;
  }

  // Process FRED housing starts
  let housingStartsResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(houst)) {
    const obs = extractFredObs(houst, 3);
    if (obs.length > 0) {
      housingStartsResult = {
        current: obs[obs.length - 1].value,
        unit: 'thousands',
        '3mo_trend': obs.map((o) => ({ date: o.date, value: o.value })),
      };
    }
  } else {
    housingStartsResult = houst;
  }

  // Process FRED Case-Shiller
  let caseShillerResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(caseShiller)) {
    const obs = extractFredObs(caseShiller, 3);
    if (obs.length > 0) {
      caseShillerResult = {
        current: obs[obs.length - 1].value,
        '3mo_trend': obs.map((o) => ({ date: o.date, value: o.value })),
      };
    }
  } else {
    caseShillerResult = caseShiller;
  }

  // Process BLS data
  let unemploymentResult: Record<string, unknown> = { error: 'unavailable' };
  let ownersEquivRentResult: Record<string, unknown> = { error: 'unavailable' };
  let constructionEmpResult: Record<string, unknown> = { error: 'unavailable' };

  if (!isError(blsData)) {
    const unemployment = extractBlsSeries(blsData, 'LNS14000000');
    if (unemployment.length > 0) {
      const vals = unemployment.map((d) => d.value);
      unemploymentResult = {
        current: vals[vals.length - 1],
        trend: unemployment.slice(-6).map((d) => ({ date: d.date, value: d.value })),
      };
    }

    const ownersRent = extractBlsSeries(blsData, 'CUUR0000SEHC');
    if (ownersRent.length > 0) {
      const vals = ownersRent.map((d) => d.value);
      ownersEquivRentResult = {
        current: vals[vals.length - 1],
        trend: ownersRent.slice(-6).map((d) => ({ date: d.date, value: d.value })),
      };
    }

    const constructionEmp = extractBlsSeries(blsData, 'CES2000000001');
    if (constructionEmp.length > 0) {
      const vals = constructionEmp.map((d) => d.value);
      constructionEmpResult = {
        current: vals[vals.length - 1],
        unit: 'thousands',
        trend: constructionEmp.slice(-6).map((d) => ({ date: d.date, value: d.value })),
      };
    }
  } else {
    unemploymentResult = blsData;
    ownersEquivRentResult = blsData;
    constructionEmpResult = blsData;
  }

  // Process FHFA metro HPI (if requested)
  let metroHpiResult: Record<string, unknown> | null = null;
  if (cbsa && metroHpiData && !isError(metroHpiData)) {
    const obs = extractFredObs(metroHpiData, 20);
    if (obs.length > 0) {
      const values = obs.map((o) => o.value);
      const current = values[values.length - 1];
      // FHFA is quarterly — YoY is 4 quarters back
      let yoyResult: { change: number; pctChange: number } | null = null;
      if (obs.length >= 5) {
        const yearAgo = values[values.length - 5];
        const change = current - yearAgo;
        yoyResult = { change: Math.round(change * 100) / 100, pctChange: Math.round((change / Math.abs(yearAgo || 1)) * 10000) / 100 };
      }
      metroHpiResult = {
        series: `ATNHPIUS${cbsa}Q`,
        metro: metro,
        current,
        trend: trendLabel(values.slice(-6)),
        recent_data: obs.slice(-8).map((o) => ({ date: o.date, value: o.value })),
        yoy: yoyResult,
      };
    }
  } else if (metroRaw && !cbsa) {
    metroHpiResult = { error: `Metro "${metroRaw}" not found in CBSA lookup. Supported metros include: ${Object.keys(METRO_CBSA).slice(0, 10).join(', ')}, and more.` };
  } else if (isError(metroHpiData)) {
    metroHpiResult = metroHpiData;
  }

  return {
    snapshot_date: today(),
    metro,
    note: 'Mortgage rate, housing starts, Case-Shiller, unemployment, OER, and construction employment are national. metro_hpi is metro-specific (FHFA).',
    mortgage_rate: { scope: 'national', ...mortgageResult as object },
    housing_starts: { scope: 'national', ...housingStartsResult as object },
    case_shiller: { scope: 'national', ...caseShillerResult as object },
    unemployment: { scope: 'national', ...unemploymentResult as object },
    owners_equiv_rent: { scope: 'national', ...ownersEquivRentResult as object },
    construction_employment: { scope: 'national', ...constructionEmpResult as object },
    metro_hpi: metroHpiResult,
  };
}

async function housingPropertyReport(args: Record<string, unknown>) {
  const attomKey = args._attomKey as string;
  if (!attomKey) throw new Error('ATTOM API key required (_attomKey).');
  const address1 = args.address1 as string;
  const address2 = args.address2 as string;
  const addrParams = `?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;

  const [detail, avm, sales, assessment] = await Promise.all([
    safe(attomGet(attomKey, `/property/detail${addrParams}`)),
    safe(attomGet(attomKey, `/attomavm/detail${addrParams}`)),
    safe(attomGet(attomKey, `/saleshistory/expandedhistory${addrParams}`)),
    safe(attomGet(attomKey, `/assessment/detail${addrParams}`)),
  ]);

  // Flatten property details
  let propertyResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(detail)) {
    const prop = ((detail as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const building = (prop.building as Record<string, unknown>) ?? {};
    const size = (building.size as Record<string, unknown>) ?? {};
    const rooms = (building.rooms as Record<string, unknown>) ?? {};
    const lot = (prop.lot as Record<string, unknown>) ?? {};
    const summary = (prop.summary as Record<string, unknown>) ?? {};
    propertyResult = {
      beds: rooms.beds ?? rooms.bathstotal ?? null,
      baths: rooms.bathstotal ?? null,
      sqft: size.universalsize ?? size.livingsize ?? null,
      yearBuilt: summary.yearbuilt ?? null,
      lotSqft: lot.lotsize2 ?? lot.lotsize1 ?? null,
    };
  } else {
    propertyResult = detail;
  }

  // Flatten AVM
  let valuationResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(avm)) {
    const prop = ((avm as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const avmData = (prop.avm as Record<string, unknown>) ?? {};
    const amount = (avmData.amount as Record<string, unknown>) ?? {};
    valuationResult = {
      avm: amount.value ?? null,
      low: amount.low ?? null,
      high: amount.high ?? null,
      confidence: avmData.condition ?? avmData.confidence ?? null,
    };
  } else {
    valuationResult = avm;
  }

  // Flatten sales history
  let salesResult: unknown[] | Record<string, unknown> = { error: 'unavailable' };
  if (!isError(sales)) {
    const props = ((sales as Record<string, unknown>)?.property as Record<string, unknown>[]) ?? [];
    const saleList: { date: string | null; amount: number | null }[] = [];
    for (const prop of props) {
      const saleHistory = (prop.saleHistory as Record<string, unknown>[]) ??
        ((prop.sale as Record<string, unknown>)?.saleHistory as Record<string, unknown>[]) ?? [];
      for (const s of saleHistory) {
        const amount = (s.amount as Record<string, unknown>) ?? {};
        const saleAmt = (amount.saleAmt ?? amount.saleamt ?? amount.saleprice ?? amount.salePrice ?? null) as number | null;
        const transType = (amount.saleTransType ?? '') as string;
        saleList.push({
          date: (s.saleTransDate ?? s.saleSearchDate ?? s.saleDate ?? s.date ?? null) as string | null,
          amount: saleAmt,
          type: transType || null,
        });
      }
    }
    salesResult = saleList;
  } else {
    salesResult = sales;
  }

  // Flatten assessment
  let assessmentResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(assessment)) {
    const prop = ((assessment as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const assessed = (prop.assessment as Record<string, unknown>) ?? {};
    const assessedVal = (assessed.assessed as Record<string, unknown>) ?? {};
    const market = (assessed.market as Record<string, unknown>) ?? {};
    const tax = (assessed.tax as Record<string, unknown>) ?? {};
    assessmentResult = {
      assessed: assessedVal.assdttlvalue ?? null,
      market: market.mktttlvalue ?? null,
      taxAmount: tax.taxamt ?? null,
    };
  } else {
    assessmentResult = assessment;
  }

  return {
    address: `${address1}, ${address2}`,
    property: propertyResult,
    valuation: valuationResult,
    sales_history: salesResult,
    assessment: assessmentResult,
  };
}

async function housingRentalAnalysis(args: Record<string, unknown>) {
  const attomKey = args._attomKey as string;
  if (!attomKey) throw new Error('ATTOM API key required (_attomKey).');
  const hudKey = args._hudKey as string | undefined;
  const address1 = args.address1 as string;
  const address2 = args.address2 as string;
  const stateCode = args.state_code as string;
  const addrParams = `?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;

  // Build parallel requests
  const promises: Promise<unknown>[] = [
    safe(attomGet(attomKey, `/valuation/rentalavm${addrParams}`)),
    hudKey
      ? safe(hudGet(hudKey, `/fmr/statedata/${encodeURIComponent(stateCode)}`))
      : Promise.resolve(null),
    safe(blsPost(['CUUR0000SEHA'], '2024', currentYear())),
  ];

  const [rentalAvm, fmrData, blsRent] = await Promise.all(promises);

  // Flatten rental AVM
  let propertyRentResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(rentalAvm)) {
    const prop = ((rentalAvm as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const rental = (prop.rentalAVM ?? prop.rentalavm ?? prop.avm ?? {}) as Record<string, unknown>;
    const amount = (rental.amount ?? rental) as Record<string, unknown>;
    const monthly = (amount.value ?? amount.rent ?? null) as number | null;
    // Attempt to compute yield — needs AVM value which we don't have here
    propertyRentResult = {
      monthly: monthly,
      annual_yield: null, // would need property value to compute
    };
  } else {
    propertyRentResult = rentalAvm as Record<string, unknown>;
  }

  // Flatten HUD FMR — response structure for /fmr/statedata/{state}:
  // { "state":"CO", "data": { "data": { "year":"2026", "metroareas":[...], "counties":[...] } } }
  let fmrResult: Record<string, unknown> | null = null;
  if (fmrData && !isError(fmrData)) {
    const raw = fmrData as Record<string, unknown>;

    // Extract FMR area from a single record
    function extractFmr(rec: Record<string, unknown>): Record<string, unknown> {
      const basic = (rec.basicdata as Record<string, unknown>) ?? {};
      return {
        area_name: rec.area_name ?? rec.areaname ?? rec.metro_name ?? rec.county_name ?? null,
        efficiency: rec.efficiency ?? rec.Efficiency ?? basic.efficiency ?? basic.Efficiency ?? null,
        '1br': rec['One-Bedroom'] ?? rec.one_bedroom ?? rec.One_Bedroom ?? basic['One-Bedroom'] ?? null,
        '2br': rec['Two-Bedroom'] ?? rec.two_bedroom ?? rec.Two_Bedroom ?? basic['Two-Bedroom'] ?? null,
        '3br': rec['Three-Bedroom'] ?? rec.three_bedroom ?? rec.Three_Bedroom ?? basic['Three-Bedroom'] ?? null,
        '4br': rec['Four-Bedroom'] ?? rec.four_bedroom ?? rec.Four_Bedroom ?? basic['Four-Bedroom'] ?? null,
      };
    }

    // Dig into the nested structure: data.data.metroareas / data.data.counties
    let innerData: Record<string, unknown> | null = null;
    if (raw.data && typeof raw.data === 'object') {
      const d1 = raw.data as Record<string, unknown>;
      if (d1.data && typeof d1.data === 'object' && !Array.isArray(d1.data)) {
        innerData = d1.data as Record<string, unknown>;
      } else {
        innerData = d1;
      }
    }

    if (innerData) {
      const metroareas = (innerData.metroareas as Record<string, unknown>[]) ?? [];
      const counties = (innerData.counties as Record<string, unknown>[]) ?? [];
      const allAreas = [...metroareas, ...counties];

      if (allAreas.length > 0) {
        // Return first few areas as a summary; if there are many, limit to 10
        const fmrAreas = allAreas.slice(0, 10).map(extractFmr);
        fmrResult = {
          year: innerData.year ?? null,
          state: stateCode,
          areas: fmrAreas,
          total_areas: allAreas.length,
        };
      } else {
        // Maybe the data itself has FMR fields directly
        fmrResult = extractFmr(innerData);
      }
    } else if (Array.isArray(raw)) {
      // Direct array response
      if (raw.length > 0) {
        fmrResult = extractFmr(raw[0] as Record<string, unknown>);
      }
    } else {
      // Try treating raw as a single FMR record
      fmrResult = extractFmr(raw);
    }
  } else if (isError(fmrData)) {
    fmrResult = fmrData;
  }

  // Flatten BLS rent CPI
  let rentCpiResult: { date: string; value: number }[] | Record<string, unknown> = {
    error: 'unavailable',
  };
  if (!isError(blsRent)) {
    const series = extractBlsSeries(blsRent, 'CUUR0000SEHA');
    if (series.length > 0) {
      rentCpiResult = series.slice(-12);
    }
  } else {
    rentCpiResult = blsRent as Record<string, unknown>;
  }

  return {
    property_rent_estimate: propertyRentResult,
    area_fair_market_rent: fmrResult,
    rent_cpi_trend: rentCpiResult,
  };
}

async function housingAffordabilityCheck(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');
  const hudKey = args._hudKey as string | undefined;
  const stateCode = args.state_code as string;
  const metroRaw = (args.metro_name as string) ?? '';
  const metroNorm = metroRaw.trim().toLowerCase();
  const cbsa = METRO_CBSA[metroNorm] ?? null;

  // Fire requests in parallel
  const promises: Promise<unknown>[] = [
    safe(fredGet(fredKey, '/series/observations?series_id=MORTGAGE30US&sort_order=desc&limit=1')),
    safe(fredGet(fredKey, '/series/observations?series_id=CSUSHPISA&sort_order=desc&limit=1')),
    safe(fredGet(fredKey, '/series/observations?series_id=MSPUS&sort_order=desc&limit=1')),
    hudKey && stateCode
      ? safe(hudGet(hudKey, `/il/statedata/${encodeURIComponent(stateCode)}`))
      : Promise.resolve(null),
    safe(blsPost(['CES0500000003'], previousYear(), currentYear())),
    cbsa
      ? safe(fredGet(fredKey, `/series/observations?series_id=ATNHPIUS${cbsa}Q&sort_order=desc&limit=8`))
      : Promise.resolve(null),
  ];

  const [mortgageData, caseShillerData, medianPriceData, hudIL, blsEarnings, metroHpiData] =
    await Promise.all(promises);

  // Extract mortgage rate
  let mortgageRate: number | null = null;
  if (!isError(mortgageData)) {
    const obs = extractFredObs(mortgageData, 1);
    if (obs.length > 0) mortgageRate = obs[0].value;
  }

  // Extract Case-Shiller
  let caseShillerIndex: number | null = null;
  if (!isError(caseShillerData)) {
    const obs = extractFredObs(caseShillerData, 1);
    if (obs.length > 0) caseShillerIndex = obs[0].value;
  }

  // Extract median home price
  let medianHomePrice: number | null = null;
  if (!isError(medianPriceData)) {
    const obs = extractFredObs(medianPriceData, 1);
    if (obs.length > 0) medianHomePrice = obs[0].value; // MSPUS is already in dollars (e.g., 405300)
  }

  // Extract average hourly earnings from BLS
  let avgHourlyEarnings: number | null = null;
  if (!isError(blsEarnings)) {
    const series = extractBlsSeries(blsEarnings, 'CES0500000003');
    if (series.length > 0) avgHourlyEarnings = series[series.length - 1].value;
  }

  // Calculate estimated monthly payment (30yr fixed, 20% down)
  let estimatedMonthlyPayment: number | null = null;
  let incomeNeeded: number | null = null;
  if (mortgageRate !== null && medianHomePrice !== null) {
    const principal = medianHomePrice * 0.8; // 20% down
    const monthlyRate = mortgageRate / 100 / 12;
    const n = 360; // 30 years
    if (monthlyRate > 0) {
      estimatedMonthlyPayment = Math.round(
        (principal * (monthlyRate * Math.pow(1 + monthlyRate, n))) /
          (Math.pow(1 + monthlyRate, n) - 1),
      );
    } else {
      estimatedMonthlyPayment = Math.round(principal / n);
    }
    // Income needed: payment should be < 28% of gross monthly income
    incomeNeeded = Math.round((estimatedMonthlyPayment / 0.28) * 12);
  }

  // HUD income limits — raw API response: { data: { year, median_income, very_low, low, extremely_low } }
  // (our HUD pack wraps it as { state, data: { data: {...} } } but here we call HUD directly)
  let hudIncomeLimits: Record<string, unknown> | null = null;
  if (hudIL && !isError(hudIL)) {
    const raw = hudIL as Record<string, unknown>;
    // Navigate: could be raw.data.data.median_income or raw.data.median_income
    let ilData: Record<string, unknown> | null = null;
    if (raw.data && typeof raw.data === 'object') {
      const d1 = raw.data as Record<string, unknown>;
      if (d1.median_income) {
        ilData = d1;
      } else if (d1.data && typeof d1.data === 'object' && !Array.isArray(d1.data)) {
        const d2 = d1.data as Record<string, unknown>;
        if (d2.median_income) ilData = d2;
      }
    } else if (raw.median_income) {
      ilData = raw;
    }

    if (ilData && ilData.median_income) {
      const veryLow = (ilData.very_low as Record<string, number>) ?? {};
      const low = (ilData.low as Record<string, number>) ?? {};
      const extremelyLow = (ilData.extremely_low as Record<string, number>) ?? {};
      hudIncomeLimits = {
        state: stateCode,
        year: ilData.year ?? null,
        median_income: ilData.median_income,
        very_low_4person: veryLow.il50_p4 ?? null,
        low_4person: low.il80_p4 ?? null,
        extremely_low_4person: extremelyLow.il30_p4 ?? null,
        note: 'Income limits shown for 4-person household. p1-p8 = 1 to 8 person households.',
      };
    } else {
      hudIncomeLimits = { raw_response: raw, note: 'Could not parse HUD income limits structure' };
    }
  } else if (isError(hudIL)) {
    hudIncomeLimits = hudIL;
  }

  // Metro FHFA HPI
  let metroHpi: Record<string, unknown> | null = null;
  if (cbsa && metroHpiData && !isError(metroHpiData)) {
    const obs = extractFredObs(metroHpiData, 8);
    if (obs.length > 0) {
      metroHpi = {
        metro: metroRaw,
        series: `ATNHPIUS${cbsa}Q`,
        current: obs[obs.length - 1].value,
        trend: trendLabel(obs.map(o => o.value).slice(-4)),
      };
    }
  }

  return {
    mortgage_rate: mortgageRate,
    median_home_price: medianHomePrice,
    median_home_price_note: 'National median (MSPUS). Metro-specific pricing not available via FRED.',
    metro_hpi: metroHpi,
    case_shiller_index: caseShillerIndex,
    avg_hourly_earnings: avgHourlyEarnings,
    estimated_monthly_payment: estimatedMonthlyPayment,
    income_needed: incomeNeeded,
    income_needed_note: 'Based on 28% DTI ratio, 20% down, 30yr fixed.',
    hud_income_limits: hudIncomeLimits,
  };
}

async function housingEmploymentOutlook(args: Record<string, unknown>) {
  void args; // _fredKey accepted but not used

  const seriesIds = [
    'CES0000000001', // total nonfarm
    'CES2000000001', // construction
    'CES2023610001', // residential building
    'LNS14000000', // unemployment rate
    'JTS000000000000000JOL', // JOLTS openings
    'JTS000000000000000HIR', // JOLTS hires
  ];

  const blsData = await safe(blsPost(seriesIds, previousYear(), currentYear()));

  if (isError(blsData)) {
    return { error: blsData.error };
  }

  const seriesLabels: Record<string, { label: string; unit: string }> = {
    CES0000000001: { label: 'total_nonfarm', unit: 'thousands' },
    CES2000000001: { label: 'construction', unit: 'thousands' },
    CES2023610001: { label: 'residential_building', unit: 'thousands' },
    LNS14000000: { label: 'unemployment_rate', unit: 'percent' },
    JTS000000000000000JOL: { label: 'jolts_openings', unit: 'thousands' },
    JTS000000000000000HIR: { label: 'jolts_hires', unit: 'thousands' },
  };

  const result: Record<string, unknown> = {
    snapshot_date: today(),
  };

  for (const [seriesId, meta] of Object.entries(seriesLabels)) {
    const data = extractBlsSeries(blsData, seriesId);
    if (data.length > 0) {
      const values = data.map((d) => d.value);
      result[meta.label] = {
        current: values[values.length - 1],
        unit: meta.unit,
        trend: trendLabel(values.slice(-6)),
        recent_data: data.slice(-6).map((d) => ({ date: d.date, value: d.value })),
      };
    } else {
      result[meta.label] = { error: `No data returned for ${seriesId}` };
    }
  }

  return result;
}

async function housingSignalScan(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');

  const seriesConfig = [
    // Core housing
    { id: 'MORTGAGE30US', label: '30-Year Mortgage Rate', fredPath: '/series/observations?series_id=MORTGAGE30US&sort_order=asc&limit=52' },
    { id: 'HOUST', label: 'Housing Starts (Total)', fredPath: '/series/observations?series_id=HOUST&sort_order=asc&limit=24' },
    { id: 'HOUST1F', label: 'Housing Starts (Single-Family)', fredPath: '/series/observations?series_id=HOUST1F&sort_order=asc&limit=24' },
    { id: 'PERMIT', label: 'Building Permits', fredPath: '/series/observations?series_id=PERMIT&sort_order=asc&limit=24' },
    { id: 'MSACSR', label: 'Months Supply of Houses', fredPath: '/series/observations?series_id=MSACSR&sort_order=asc&limit=24' },
    { id: 'MSPUS', label: 'Median Sales Price', fredPath: '/series/observations?series_id=MSPUS&sort_order=asc&limit=16' },
    // NAR existing home sales
    { id: 'EXHOSLUSM495S', label: 'NAR Existing Home Sales', fredPath: '/series/observations?series_id=EXHOSLUSM495S&sort_order=asc&limit=24' },
    { id: 'HOSINVUSM495N', label: 'NAR Housing Inventory', fredPath: '/series/observations?series_id=HOSINVUSM495N&sort_order=asc&limit=24' },
    // Case-Shiller (national + 20 metros)
    { id: 'CSUSHPISA', label: 'Case-Shiller National HPI', fredPath: '/series/observations?series_id=CSUSHPISA&sort_order=asc&limit=24' },
    { id: 'SFXRNSA', label: 'Case-Shiller San Francisco', fredPath: '/series/observations?series_id=SFXRNSA&sort_order=asc&limit=24' },
    { id: 'LXXRNSA', label: 'Case-Shiller Los Angeles', fredPath: '/series/observations?series_id=LXXRNSA&sort_order=asc&limit=24' },
    { id: 'SEXRNSA', label: 'Case-Shiller Seattle', fredPath: '/series/observations?series_id=SEXRNSA&sort_order=asc&limit=24' },
    { id: 'DNXRNSA', label: 'Case-Shiller Denver', fredPath: '/series/observations?series_id=DNXRNSA&sort_order=asc&limit=24' },
    { id: 'NYXRNSA', label: 'Case-Shiller New York', fredPath: '/series/observations?series_id=NYXRNSA&sort_order=asc&limit=24' },
    { id: 'MIXRNSA', label: 'Case-Shiller Miami', fredPath: '/series/observations?series_id=MIXRNSA&sort_order=asc&limit=24' },
    { id: 'DAXRNSA', label: 'Case-Shiller Dallas', fredPath: '/series/observations?series_id=DAXRNSA&sort_order=asc&limit=24' },
    { id: 'PHXRNSA', label: 'Case-Shiller Phoenix', fredPath: '/series/observations?series_id=PHXRNSA&sort_order=asc&limit=24' },
    { id: 'TPXRNSA', label: 'Case-Shiller Tampa', fredPath: '/series/observations?series_id=TPXRNSA&sort_order=asc&limit=24' },
    { id: 'CHXRNSA', label: 'Case-Shiller Chicago', fredPath: '/series/observations?series_id=CHXRNSA&sort_order=asc&limit=24' },
    { id: 'ATXRNSA', label: 'Case-Shiller Atlanta', fredPath: '/series/observations?series_id=ATXRNSA&sort_order=asc&limit=24' },
    { id: 'BOXRNSA', label: 'Case-Shiller Boston', fredPath: '/series/observations?series_id=BOXRNSA&sort_order=asc&limit=24' },
    { id: 'WDXRNSA', label: 'Case-Shiller Washington DC', fredPath: '/series/observations?series_id=WDXRNSA&sort_order=asc&limit=24' },
    { id: 'LVXRNSA', label: 'Case-Shiller Las Vegas', fredPath: '/series/observations?series_id=LVXRNSA&sort_order=asc&limit=24' },
    { id: 'SDXRNSA', label: 'Case-Shiller San Diego', fredPath: '/series/observations?series_id=SDXRNSA&sort_order=asc&limit=24' },
    { id: 'POXRNSA', label: 'Case-Shiller Portland', fredPath: '/series/observations?series_id=POXRNSA&sort_order=asc&limit=24' },
    { id: 'MNXRNSA', label: 'Case-Shiller Minneapolis', fredPath: '/series/observations?series_id=MNXRNSA&sort_order=asc&limit=24' },
    { id: 'DEXRNSA', label: 'Case-Shiller Detroit', fredPath: '/series/observations?series_id=DEXRNSA&sort_order=asc&limit=24' },
    { id: 'CRXRNSA', label: 'Case-Shiller Charlotte', fredPath: '/series/observations?series_id=CRXRNSA&sort_order=asc&limit=24' },
    { id: 'CEXRNSA', label: 'Case-Shiller Cleveland', fredPath: '/series/observations?series_id=CEXRNSA&sort_order=asc&limit=24' },
    // Consumer confidence
    { id: 'CSCICP03USM665S', label: 'Consumer Confidence Index', fredPath: '/series/observations?series_id=CSCICP03USM665S&sort_order=asc&limit=24' },
    // Atlanta Fed Wage Tracker
    { id: 'FRBATLWGT3MMAUMHWGO', label: 'Atlanta Fed Wage Growth (3mo MA)', fredPath: '/series/observations?series_id=FRBATLWGT3MMAUMHWGO&sort_order=asc&limit=24' },
  ];

  // Batch FRED requests (CF Workers have subrequest limits, so batch in groups of 10)
  const fredResults: (unknown | { error: string })[] = [];
  for (let i = 0; i < seriesConfig.length; i += 10) {
    const batch = seriesConfig.slice(i, i + 10);
    const batchResults = await Promise.all(
      batch.map(s => safe(fredGet(fredKey, s.fredPath)))
    );
    fredResults.push(...batchResults);
  }

  // Fetch BLS series — employment, CPI shelter, metro CPI
  const blsResult = await safe(blsPost(
    [
      'LNS14000000',    // Unemployment rate
      'CUUR0000SEHC',   // Owners equivalent rent (national)
      'CUUR0000SEHA',   // Rent of primary residence (national)
      'CES2000000001',  // Construction employment
      'CES2023610001',  // Residential building employment
    ],
    String(new Date().getFullYear() - 2),
    currentYear(),
  ));

  // Metro CPI — separate BLS call (max 50 series per request)
  const metroCpiResult = await safe(blsPost(
    [
      'CUURS12ASA0',    // New York
      'CUURS11ASA0',    // Boston
      'CUURS23ASA0',    // Chicago
      'CUURS37ASA0',    // Dallas
      'CUURS49ASA0',    // Los Angeles (West Region A)
      'CUURS49BSA0',    // Los Angeles (West Region B — actually Riverside)
      'CUURS35ASA0',    // Denver (actually Denver-Aurora-Lakewood)
      'CUURS24ASA0',    // Minneapolis
      'CUURS35BSA0',    // Phoenix
      'CUURS35CSA0',    // Seattle (West Size Class B)
      'CUURS12BSA0',    // Philadelphia
      'CUURS35DSA0',    // Portland
      'CUURS33ASA0',    // Washington DC
      'CUURS33BSA0',    // Miami (South Size Class B — actually Tampa area)
    ],
    String(new Date().getFullYear() - 2),
    currentYear(),
  ));

  const scanResults: {
    series: string;
    label: string;
    current: number | null;
    prior: number | null;
    periodChange: number | null;
    yoy: { change: number; pctChange: number } | null;
    trend: string;
    signals: Signal[];
  }[] = [];

  // Process FRED series
  for (let i = 0; i < seriesConfig.length; i++) {
    const config = seriesConfig[i];
    const data = fredResults[i];
    if (isError(data)) {
      scanResults.push({ series: config.id, label: config.label, current: null, prior: null, periodChange: null, yoy: null, trend: 'unknown', signals: [{ type: 'unusual', message: `Error fetching ${config.label}` }] });
      continue;
    }
    const obs = extractFredObs(data, 52);
    const values = obs.map(o => o.value);
    if (values.length < 2) continue;

    const current = values[values.length - 1];
    const prior = values[values.length - 2];
    const yoy = computeYoY(obs);

    scanResults.push({
      series: config.id,
      label: config.label,
      current,
      prior,
      periodChange: current - prior,
      yoy: yoy ? { change: yoy.change, pctChange: Math.round(yoy.pctChange * 100) / 100 } : null,
      trend: trendLabel(values.slice(-6)),
      signals: detectSignals(values, config.label),
    });
  }

  // Process BLS series
  if (!isError(blsResult)) {
    const blsSeries = [
      { id: 'LNS14000000', label: 'Unemployment Rate' },
      { id: 'CUUR0000SEHC', label: 'Owners Equivalent Rent CPI' },
      { id: 'CUUR0000SEHA', label: 'Rent of Primary Residence CPI' },
      { id: 'CES2000000001', label: 'Construction Employment' },
      { id: 'CES2023610001', label: 'Residential Building Employment' },
    ];

    for (const s of blsSeries) {
      const obs = extractBlsSeries(blsResult, s.id);
      const values = obs.map(o => o.value);
      if (values.length < 2) continue;

      const current = values[values.length - 1];
      const prior = values[values.length - 2];
      const yoy = obs.length >= 13 ? computeYoY(obs) : null;

      scanResults.push({
        series: s.id,
        label: s.label,
        current,
        prior,
        periodChange: current - prior,
        yoy: yoy ? { change: yoy.change, pctChange: Math.round(yoy.pctChange * 100) / 100 } : null,
        trend: trendLabel(values.slice(-6)),
        signals: detectSignals(values, s.label),
      });
    }
  }

  // Process metro CPI
  if (!isError(metroCpiResult)) {
    const metroCpiSeries = [
      { id: 'CUURS12ASA0', label: 'CPI New York' },
      { id: 'CUURS11ASA0', label: 'CPI Boston' },
      { id: 'CUURS23ASA0', label: 'CPI Chicago' },
      { id: 'CUURS37ASA0', label: 'CPI Dallas' },
      { id: 'CUURS49ASA0', label: 'CPI Los Angeles' },
      { id: 'CUURS49BSA0', label: 'CPI Riverside' },
      { id: 'CUURS35ASA0', label: 'CPI Denver' },
      { id: 'CUURS24ASA0', label: 'CPI Minneapolis' },
      { id: 'CUURS35BSA0', label: 'CPI Phoenix' },
      { id: 'CUURS35CSA0', label: 'CPI Seattle' },
      { id: 'CUURS12BSA0', label: 'CPI Philadelphia' },
      { id: 'CUURS35DSA0', label: 'CPI Portland' },
      { id: 'CUURS33ASA0', label: 'CPI Washington DC' },
      { id: 'CUURS33BSA0', label: 'CPI Tampa' },
    ];

    for (const s of metroCpiSeries) {
      const obs = extractBlsSeries(metroCpiResult, s.id);
      const values = obs.map(o => o.value);
      if (values.length < 2) continue;

      const current = values[values.length - 1];
      const prior = values[values.length - 2];
      const yoy = obs.length >= 13 ? computeYoY(obs) : null;

      scanResults.push({
        series: s.id,
        label: s.label,
        current,
        prior,
        periodChange: current - prior,
        yoy: yoy ? { change: yoy.change, pctChange: Math.round(yoy.pctChange * 100) / 100 } : null,
        trend: trendLabel(values.slice(-6)),
        signals: detectSignals(values, s.label),
      });
    }
  }

  // Collect all signals
  const allSignals = scanResults.flatMap(r => r.signals.map(s => ({ ...s, series: r.label })));
  const flagged = scanResults.filter(r => r.signals.length > 0);

  return {
    scan_date: today(),
    total_series_scanned: scanResults.length,
    flagged_count: flagged.length,
    signals: allSignals,
    flagged_series: flagged,
    all_series: scanResults.map(r => ({
      series: r.series,
      label: r.label,
      current: r.current,
      periodChange: r.periodChange != null ? Math.round(r.periodChange * 1000) / 1000 : null,
      yoy: r.yoy,
      trend: r.trend,
      signal_count: r.signals.length,
    })),
  };
}

// ── callTool dispatcher ────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Clean gateway-injected context
  delete args._context;

  switch (name) {
    case 'housing_market_snapshot':
      return housingMarketSnapshot(args);
    case 'housing_property_report':
      return housingPropertyReport(args);
    case 'housing_rental_analysis':
      return housingRentalAnalysis(args);
    case 'housing_affordability_check':
      return housingAffordabilityCheck(args);
    case 'housing_employment_outlook':
      return housingEmploymentOutlook(args);
    case 'housing_signal_scan':
      return housingSignalScan(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 50 } } satisfies McpToolExport;
