import fs from "node:fs/promises";

const API = "https://api.carbonintensity.org.uk";
const OUTPUT = new URL("../data/carbon.json", import.meta.url);

const REGION_NAMES = {
  1: "North Scotland",
  2: "South Scotland",
  3: "North West England",
  4: "North East England",
  5: "South Yorkshire",
  6: "North Wales, Merseyside and Cheshire",
  7: "South Wales",
  8: "West Midlands",
  9: "East Midlands",
  10: "East England",
  11: "South West England",
  12: "South England",
  13: "London",
  14: "South East England"
};

function apiStartTime() {
  const d = new Date();
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30);
  return d.toISOString().slice(0, 16) + "Z";
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "GB-Energy-Live/1.5.3"
    }
  });

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return response.json();
}

function collectPeriods(node, inherited = {}, out = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => collectPeriods(item, inherited, out));
    return out;
  }

  if (!node || typeof node !== "object") return out;

  const meta = {
    regionid: node.regionid ?? inherited.regionid,
    shortname: node.shortname ?? inherited.shortname
  };

  if (
    node.from &&
    node.to &&
    node.intensity &&
    Number.isFinite(Number(node.intensity.forecast))
  ) {
    out.push({
      from: node.from,
      to: node.to,
      forecast: Number(node.intensity.forecast),
      actual:
        node.intensity.actual == null
          ? null
          : Number(node.intensity.actual),
      index: String(node.intensity.index || "unknown"),
      regionid: meta.regionid ?? null,
      shortname: meta.shortname ?? null
    });
  }

  for (const [key, value] of Object.entries(node)) {
    if (
      key !== "intensity" &&
      key !== "generationmix" &&
      (Array.isArray(value) || (value && typeof value === "object"))
    ) {
      collectPeriods(value, meta, out);
    }
  }

  return out;
}

async function readPrevious() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    return null;
  }
}

function cleanPeriods(rows) {
  const seen = new Set();

  return rows
    .filter((row) =>
      row.from &&
      row.to &&
      Number.isFinite(Number(row.forecast))
    )
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
    .filter((row) => {
      const key = `${row.from}|${row.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 96);
}

async function loadRegional(start) {
  const url =
    `${API}/regional/intensity/${encodeURIComponent(start)}/fw48h`;

  const json = await fetchJson(url);
  const rows = collectPeriods(json);

  if (!rows.length) {
    throw new Error("NESO regional endpoint returned no forecast periods.");
  }

  const grouped = {};

  for (let id = 1; id <= 14; id += 1) {
    const periods = cleanPeriods(
      rows.filter((row) => Number(row.regionid) === id)
    );

    if (periods.length) {
      grouped[String(id)] = {
        id,
        name:
          periods.find((row) => row.shortname)?.shortname ||
          REGION_NAMES[id],
        periods
      };
    }
  }

  if (!Object.keys(grouped).length) {
    throw new Error("NESO response could not be grouped into GB regions.");
  }

  return grouped;
}

async function loadNational(start) {
  const url =
    `${API}/intensity/${encodeURIComponent(start)}/fw48h`;

  const json = await fetchJson(url);
  const periods = cleanPeriods(collectPeriods(json));

  if (!periods.length) {
    throw new Error("NESO national endpoint returned no forecast periods.");
  }

  return periods;
}

const previous = await readPrevious();
const start = apiStartTime();
const updated = new Date().toISOString();

let regions = null;
let national = null;
const warnings = [];

try {
  regions = await loadRegional(start);
  console.log(`Loaded ${Object.keys(regions).length} NESO regions.`);
} catch (error) {
  console.error("Regional forecast failed:", error.message);
  warnings.push(`Regional: ${error.message}`);
  regions = previous?.regions || null;
}

try {
  national = await loadNational(start);
  console.log(`Loaded ${national.length} national periods.`);
} catch (error) {
  console.error("National forecast failed:", error.message);
  warnings.push(`National: ${error.message}`);
  national = previous?.national || null;
}

if (!regions && !national) {
  throw new Error(
    "Both NESO carbon-intensity calls failed and there is no previous carbon.json to preserve."
  );
}

const result = {
  version: "1.5.3",
  updated,
  forecastStart: start,
  source: "NESO Carbon Intensity API",
  sourceUrl: "https://api.carbonintensity.org.uk/",
  stale: warnings.length > 0,
  warnings,
  regions,
  national
};

await fs.writeFile(
  OUTPUT,
  JSON.stringify(result, null, 2) + "\n",
  "utf8"
);

console.log("Wrote data/carbon.json");
