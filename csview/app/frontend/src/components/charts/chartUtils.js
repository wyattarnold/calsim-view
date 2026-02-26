/**
 * Shared chart utilities, constants, and data-processing helpers.
 * Used by all chart sub-components in ResultsChart.
 */

// ---------------------------------------------------------------------------
// Series colour palette
// ---------------------------------------------------------------------------

export const COLORS = [
  "#3b82f6","#10b981","#f59e0b","#ef4444",
  "#8b5cf6","#06b6d4","#f97316","#84cc16",
];

// Distinct palettes for positive (inflow) and negative (outflow) series
// in stacked area charts.  Positive palette = cool tones (blues/teals/greens),
// negative palette = warm tones (reds/oranges/pinks/ambers).
export const POS_COLORS = [
  "#3b82f6", "#06b6d4", "#10b981", "#14b8a6",
  "#0ea5e9", "#22d3ee", "#34d399", "#67e8f9",
];
export const NEG_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#ec4899",
  "#e11d48", "#fb923c", "#fbbf24", "#f472b6",
];

export const REF_COLORS = { LBC: "#10b981", UBC: "#ef4444", EQC: "#f59e0b" };

// Zone fill colors (bottom → top): dead-pool gray, then progressively
// lighter blues so they read as "water level bands" behind the storage line.
export const ZONE_COLORS = [
  "#6b7280", // Zone 1 (dead pool)  — gray
  "#1e3a5f", // Zone 2              — dark blue
  "#1e5091", // Zone 3              — medium blue
  "#3b82f6", // Zone 4              — blue
  "#60a5fa", // Zone 5              — light blue
  "#93c5fd", // Zone 6              — very light blue
];

export function seriesColor(key, index) {
  return COLORS[index % COLORS.length];
}

/** Display label for a series key, using an optional override map. */
export function shortKey(key, keyLabels = {}) {
  return keyLabels[key] ?? key;
}

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

export function daysInMonth(dateKey) {
  const year  = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  return new Date(year, month, 0).getDate();
}

export function cfsToTaf(value, dateKey) {
  return value * daysInMonth(dateKey) * 86400 / 43560 / 1000;
}

// ---------------------------------------------------------------------------
// Data builder — converts the raw { key: [[date, val], …] } map into
// a Recharts-friendly array of { date, key1, key2, … } row objects.
// ---------------------------------------------------------------------------

/**
 * Convert a date string to its water year.  WY YYYY runs Oct (YYYY-1)
 * through Sep (YYYY).  Month >= 10 → next WY.
 */
export function dateToWaterYear(dateKey) {
  const yr = Number(dateKey.slice(0, 4));
  const mo = Number(dateKey.slice(5, 7));
  return mo >= 10 ? yr + 1 : yr;
}

export function buildChartData(seriesMap, dateRange, negateKeys = null, convertFn = null, convertKeys = null) {
  const [startWY, endWY] = dateRange ?? [null, null];
  const startNum = startWY ? Number(startWY) : null;
  const endNum   = endWY   ? Number(endWY)   : null;
  const dateMap = new Map();

  for (const [key, rows] of Object.entries(seriesMap)) {
    const sign = negateKeys?.has(key) ? -1 : 1;
    const shouldConvert = convertFn && (convertKeys === null || convertKeys.has(key));
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const [dateRaw, value] = row;
      const dateKey = String(dateRaw).slice(0, 10);
      const wy = dateToWaterYear(dateKey);
      if (startNum && wy < startNum) continue;
      if (endNum && wy > endNum) continue;
      if (!dateMap.has(dateKey)) dateMap.set(dateKey, { date: dateKey });
      let num = typeof value === "number" ? value : Number(value);
      if (shouldConvert) num = convertFn(num, dateKey);
      dateMap.get(dateKey)[key] = sign * num;
    }
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Series splitting — separate flat series/metadata into logical groups
// ---------------------------------------------------------------------------

const KIND_STORAGE = new Set([
  "STORAGE", "GW-STORAGE", "GROUNDWATER",
]);

const KIND_STORAGE_ZONE = new Set(["STORAGE-ZONE"]);

const SUPPRESSED_KINDS = new Set(["ANNUAL-APPLIED-WATER", "FLOW-SPILL-NON-RECOV"]);

/**
 * Split series/metadata into { arcFlows, storage, storageZones, balance }.
 *   arcFlows     — series the backend tagged with direction "in" / "out"
 *   storage      — series with a storage kind
 *   storageZones — series with STORAGE-ZONE kind (zone boundary curves)
 *   balance      — everything else (node water-budget terms, single arc, etc.)
 */
export function splitSeries(series, metadata) {
  const arcFlows     = {};
  const storage      = {};
  const storageZones = {};
  const balance      = {};

  for (const [key, data] of Object.entries(series)) {
    if (/^A_/i.test(key)) continue;
    const meta = metadata?.[key] ?? {};
    const kind = (meta.kind || "").toUpperCase().replace(/ /g, "-");
    if (SUPPRESSED_KINDS.has(kind)) continue;
    if (meta.direction) {
      arcFlows[key] = data;
    } else if (KIND_STORAGE_ZONE.has(kind)) {
      storageZones[key] = data;
    } else if (KIND_STORAGE.has(kind)) {
      storage[key] = data;
    } else {
      balance[key] = data;
    }
  }
  return { arcFlows, storage, storageZones, balance };
}

// ---------------------------------------------------------------------------
// Water-balance term definitions
// ---------------------------------------------------------------------------

export const WB_TERMS = {
  "GW-PUMPING":        { label: "GP", positive: true  },
  "SW-DELIVERY-GROSS": { label: "DG", positive: true  },
  "SW_DELIVERY-GROSS": { label: "DG", positive: true  },
  "DELIVERY-LOSS":     { label: "DL", positive: false },
  "DEEP-PERCOLATION":  { label: "DP", positive: false },
  "PERCOLATION-LOSS":  { label: "DP", positive: false },
  "EVAPORATIVE-LOSS":  { label: "EV", positive: false },
  "EVAPORATION":       { label: "EV", positive: false },
  "OPERATING-SPILL":   { label: "OS", positive: false },
  "OPERATIONAL-SPILL": { label: "OS", positive: false },
  "SPILL-LOSS":        { label: "OS", positive: false },
  "RIPARIAN-MISC-ET":  { label: "RP", positive: false },
  "REUSE":             { label: "RU", positive: true  },
  "LATERAL-FLOW-LOSS": { label: "LF", positive: false },
};

export const WB_ORDER = ["GP", "DG", "RU", "DL", "DP", "EV", "OS", "RP", "LF"];

export const WB_COLORS = {
  GP: "#10b981", DG: "#3b82f6", RU: "#14b8a6",
  DL: "#ef4444", DP: "#f59e0b", EV: "#f97316",
  OS: "#8b5cf6", RP: "#ec4899", LF: "#eab308",
};

export const WB_POSITIVE = new Set(["GP", "DG", "RU"]);

// ---------------------------------------------------------------------------
// Color helper for stacked flow charts — positive keys get cool palette,
// negative keys get warm palette.
// ---------------------------------------------------------------------------

/**
 * Pick a color for the given key based on whether it's a positive (inflow)
 * or negative (outflow) series.  `posIdx` / `negIdx` should be the order
 * index within the positive or negative key group.
 */
export function flowSeriesColor(key, isNegative, orderIdx) {
  const pal = isNegative ? NEG_COLORS : POS_COLORS;
  return pal[orderIdx % pal.length];
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Aggregate monthly rows into monthly-average rows.
 * For each unique calendar month (01-12), averages across all years
 * within the data window.  Returns 12 rows sorted Jan-Dec.
 */
export function aggregateMonthlyAvg(data, keys) {
  const monthBuckets = {};   // "01" → { key: [vals] }
  for (const row of data) {
    const mm = row.date.slice(5, 7);
    if (!monthBuckets[mm]) monthBuckets[mm] = {};
    for (const k of keys) {
      const v = row[k];
      if (v == null || isNaN(v)) continue;
      if (!monthBuckets[mm][k]) monthBuckets[mm][k] = [];
      monthBuckets[mm][k].push(v);
    }
  }
  const MONTH_NAMES = ["Oct","Nov","Dec","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep"];
  // Water-year month order: Oct(10)..Sep(09)
  const wyOrder = ["10","11","12","01","02","03","04","05","06","07","08","09"];
  return wyOrder.filter((m) => monthBuckets[m]).map((mm) => {
    const bucket = monthBuckets[mm];
    const row = { date: MONTH_NAMES[wyOrder.indexOf(mm)] };
    for (const k of keys) {
      const vals = bucket[k];
      if (vals && vals.length > 0) {
        row[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }
    return row;
  });
}

/**
 * Aggregate monthly rows into water-year annual totals.
 * Water year Y runs Oct (Y-1) through Sep (Y).
 * For flow data (CFS→TAF), values are already converted before reaching here.
 * Returns one row per water year, sorted chronologically.
 */
export function aggregateWaterYear(data, keys, avgKeys = null) {
  const wyBuckets = {};  // waterYear → { key: sum }
  const wyCounts  = {};  // waterYear → { key: count }
  for (const row of data) {
    const wy = dateToWaterYear(row.date);
    if (!wyBuckets[wy]) { wyBuckets[wy] = {}; wyCounts[wy] = {}; }
    for (const k of keys) {
      const v = row[k];
      if (v == null || isNaN(v)) continue;
      wyBuckets[wy][k] = (wyBuckets[wy][k] ?? 0) + v;
      wyCounts[wy][k]  = (wyCounts[wy][k]  ?? 0) + 1;
    }
  }
  return Object.keys(wyBuckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((wy) => {
      const row = { date: `WY ${wy}` };
      for (const k of keys) {
        if (wyBuckets[wy][k] != null) {
          // CFS (rate) keys → average; TAF (volume) keys → sum
          row[k] = (avgKeys && avgKeys.has(k))
            ? wyBuckets[wy][k] / wyCounts[wy][k]
            : wyBuckets[wy][k];
        }
      }
      return row;
    });
}

/**
 * Aggregate monthly rows into end-of-water-year values.
 * For storage nodes, annual reporting should show the September 30
 * (end-of-WY) value rather than a sum.
 * Returns one row per water year, sorted chronologically.
 */
export function aggregateWaterYearEnd(data, keys) {
  const wyEnd = {};  // waterYear → row (September value)
  for (const row of data) {
    const mo = Number(row.date.slice(5, 7));
    if (mo !== 9) continue;  // only September = end of water year
    const wy = dateToWaterYear(row.date);  // month 9 < 10 → wy = year
    wyEnd[wy] = row;
  }
  return Object.keys(wyEnd)
    .map(Number)
    .sort((a, b) => a - b)
    .map((wy) => {
      const srcRow = wyEnd[wy];
      const row = { date: `WY ${wy}` };
      for (const k of keys) {
        if (srcRow[k] != null) row[k] = srcRow[k];
      }
      return row;
    });
}

// ---------------------------------------------------------------------------
// Hooks — shared memoised computations
// ---------------------------------------------------------------------------

/**
 * Compute year-tick boundaries from Recharts data array.
 * Returns an array of date strings, one per unique year.
 */
export function computeYearTicks(data) {
  const seen = new Set();
  return data
    .filter((row) => {
      const y = row.date.slice(0, 4);
      if (seen.has(y)) return false;
      seen.add(y);
      return true;
    })
    .map((r) => r.date);
}
