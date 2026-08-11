import fs from "node:fs/promises";

const ELEXON_API = "https://data.elexon.co.uk/bmrs/api/v1";
const OUTPUT = new URL("../data/prices.json", import.meta.url);
const THERM_MWH = 0.029307107;

function toGBPPerMWh(pencePerTherm) {
  return (Number(pencePerTherm) / 100) / THERM_MWH;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "items", "results", "result"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 GB-Energy-Live/1.1",
      "Accept-Language": "en-GB,en;q=0.9"
    }
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function loadPrevious() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    return {};
  }
}

async function electricityPrice() {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

  const url = new URL(`${ELEXON_API}/balancing/pricing/market-index`);
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());

  const rows = rowsFrom(await fetchJson(url));

  const candidates = rows.map((row) => ({
    price: num(row.price ?? row.marketIndexPrice),
    volume: num(row.volume ?? row.marketIndexVolume),
    provider: String(
      row.dataProvider ??
      row.provider ??
      row.marketIndexDataProvider ??
      ""
    ),
    timestamp: String(
      row.startTime ??
      row.publishTime ??
      row.settlementDate ??
      ""
    )
  })).filter((row) =>
    Number.isFinite(row.price) &&
    Number.isFinite(row.volume) &&
    row.volume > 0 &&
    Date.parse(row.timestamp)
  );

  if (!candidates.length) {
    throw new Error("No Elexon MID record with positive market volume.");
  }

  candidates.sort((a, b) =>
    Date.parse(b.timestamp) - Date.parse(a.timestamp)
  );

  // For the newest settlement time, choose the provider with the largest
  // traded volume. This avoids accepting an inactive zero-volume MIDP row.
  const newestTime = candidates[0].timestamp;
  const newest = candidates
    .filter((row) => row.timestamp === newestTime)
    .sort((a, b) => b.volume - a.volume);

  const selected = newest[0];

  if (Date.now() - Date.parse(selected.timestamp) > 12 * 60 * 60 * 1000) {
    throw new Error(`Elexon price is stale: ${selected.timestamp}`);
  }

  return {
    status: "ok",
    gbpPerMWh: Number(selected.price.toFixed(2)),
    volumeMWh: Number(selected.volume.toFixed(3)),
    provider: selected.provider,
    observationTime: selected.timestamp,
    source: "Elexon Insights Market Index Data",
    sourceLabel: "Elexon short-term GB market",
    sourceUrl: "https://bmrs.elexon.co.uk/market-index-prices"
  };
}

function parseTradingEconomics(text) {
  const patterns = [
    /UK Gas rose to\s+([0-9]+(?:\.[0-9]+)?)\s+GBp\/thm/i,
    /UK Gas fell to\s+([0-9]+(?:\.[0-9]+)?)\s+GBp\/thm/i,
    /UK Gas(?:'s)? price[^0-9]{0,80}([0-9]+(?:\.[0-9]+)?)\s+GBp\/thm/i,
    /UK Natural Gas[^0-9]{0,120}([0-9]+(?:\.[0-9]+)?)\s+GBp\/thm/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseMarketWatch(text) {
  const patterns = [
    /Last Updated:[\s\S]{0,500}?([0-9]{2,4}\.[0-9]{2,4})\s*(?:p|GBp)/i,
    /ICE UK Natural Gas Continuous Contract[\s\S]{0,800}?([0-9]{2,4}\.[0-9]{2,4})/i,
    /Settlement Price[\s\S]{0,100}?([0-9]{2,4}\.[0-9]{2,4})p/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

async function gasPrice() {
  const sources = [
    {
      name: "Trading Economics UK Natural Gas benchmark",
      url: "https://tradingeconomics.com/commodity/uk-natural-gas",
      parser: parseTradingEconomics,
      delay: "Public benchmark page"
    },
    {
      name: "MarketWatch ICE UK Natural Gas continuous contract",
      url: "https://www.marketwatch.com/investing/future/gwm00?countrycode=uk",
      parser: parseMarketWatch,
      delay: "Delayed ICE-derived quote"
    }
  ];

  const errors = [];

  for (const source of sources) {
    try {
      const text = await fetchText(source.url);
      const value = source.parser(text);

      if (!Number.isFinite(value)) {
        throw new Error("No UK p/therm quote found in page.");
      }

      if (value < 5 || value > 2000) {
        throw new Error(`Implausible UK gas value: ${value}`);
      }

      return {
        status: "ok",
        gbpPerMWh: Number(toGBPPerMWh(value).toFixed(2)),
        pencePerTherm: Number(value.toFixed(3)),
        observationTime: new Date().toISOString(),
        source: source.name,
        sourceLabel: "UK NBP gas benchmark",
        sourceUrl: source.url,
        quoteStatus: source.delay,
        conversion: "GBP/MWh = (pencePerTherm / 100) / 0.029307107"
      };
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

const previous = await loadPrevious();

let electricity;
let gas;

try {
  electricity = await electricityPrice();
  console.log("Electricity OK:", electricity);
} catch (error) {
  console.error("Electricity failed:", error.message);
  electricity = previous.electricity?.status === "ok"
    ? { ...previous.electricity, stale: true, refreshWarning: error.message }
    : { status: "unavailable", message: error.message, source: "Elexon" };
}

try {
  gas = await gasPrice();
  console.log("Gas OK:", gas);
} catch (error) {
  console.error("Gas failed:", error.message);
  gas = previous.gas?.status === "ok"
    ? { ...previous.gas, stale: true, refreshWarning: error.message }
    : { status: "unavailable", message: error.message, source: "UK NBP benchmark" };
}

const result = {
  updated: new Date().toISOString(),
  currency: "GBP",
  displayUnit: "GBP/MWh",
  version: "1.1.0",
  electricity,
  gas
};

await fs.writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log("Wrote data/prices.json");
