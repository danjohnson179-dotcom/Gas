import fs from "node:fs/promises";

const ELEXON_API = "https://data.elexon.co.uk/bmrs/api/v1";
const NATIONAL_GAS_API = "https://api.nationalgas.com/operationaldata/v1";
const OUTPUT = new URL("../data/prices.json", import.meta.url);

const THERM_MWH = 0.029307107;

function pencePerThermToGBPPerMWh(value) {
  return (Number(value) / 100) / THERM_MWH;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "items", "results", "result"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 250)}`);
  }

  return response.json();
}

async function loadPrevious() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    return {};
  }
}

function validTimestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

async function fetchElectricityPrice() {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const url = new URL(`${ELEXON_API}/balancing/pricing/market-index`);
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", now.toISOString());

  const json = await fetchJson(url);
  const rows = rowsFrom(json);

  const candidates = rows.map((row) => {
    const price = finiteNumber(row.price ?? row.marketIndexPrice);
    const volume = finiteNumber(row.volume ?? row.marketIndexVolume);
    const provider = String(
      row.dataProvider ??
      row.provider ??
      row.marketIndexDataProvider ??
      ""
    ).toUpperCase();

    const timestamp =
      row.startTime ??
      row.publishTime ??
      row.settlementDate ??
      row.createdDate ??
      "";

    return { price, volume, provider, timestamp };
  }).filter((row) =>
    Number.isFinite(row.price) &&
    Number.isFinite(row.volume) &&
    row.volume > 0 &&
    validTimestamp(row.timestamp) > 0
  );

  if (!candidates.length) {
    throw new Error("No Elexon market-index record with positive traded volume was returned.");
  }

  // Prefer APX if there is a current APX observation, then use the latest timestamp.
  candidates.sort((a, b) => {
    const aPreferred = a.provider.includes("APX") ? 1 : 0;
    const bPreferred = b.provider.includes("APX") ? 1 : 0;

    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    return validTimestamp(b.timestamp) - validTimestamp(a.timestamp);
  });

  const latest = candidates[0];

  // Reject stale observations older than 12 hours.
  const ageMs = Date.now() - validTimestamp(latest.timestamp);
  if (ageMs > 12 * 60 * 60 * 1000) {
    throw new Error(`Latest valid Elexon price is stale: ${latest.timestamp}`);
  }

  return {
    status: "ok",
    gbpPerMWh: Number(latest.price.toFixed(2)),
    originalPrice: latest.price,
    originalUnit: "GBP/MWh",
    provider: latest.provider || "Elexon Market Index Data",
    volumeMWh: Number(latest.volume.toFixed(3)),
    observationTime: latest.timestamp,
    source: "Elexon Insights",
    sourceUrl: "https://bmrs.elexon.co.uk/market-index-prices"
  };
}

function flattenCatalogue(node, output = []) {
  if (Array.isArray(node)) {
    for (const item of node) flattenCatalogue(item, output);
    return output;
  }

  if (!node || typeof node !== "object") return output;

  if (node.publicationId && node.name) {
    output.push({
      publicationId: String(node.publicationId),
      name: String(node.name),
      parent: String(node.parent || "")
    });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") flattenCatalogue(value, output);
  }

  return output;
}

function scoreGasPriceItem(item) {
  const name = `${item.name} ${item.parent}`.toLowerCase();
  let score = 0;

  if (name.includes("system average price")) score += 100;
  if (/\bsap\b/.test(name)) score += 80;
  if (name.includes("average price")) score += 50;
  if (name.includes("price")) score += 25;
  if (name.includes("balancing")) score += 15;
  if (name.includes("system")) score += 10;

  // Avoid clearly unrelated price data.
  if (name.includes("capacity")) score -= 50;
  if (name.includes("entry")) score -= 15;
  if (name.includes("exit")) score -= 15;

  return score;
}

async function discoverGasPricePublication() {
  const catalogue = await fetchJson(
    `${NATIONAL_GAS_API}/publications/catalogue`
  );

  const entries = flattenCatalogue(catalogue)
    .map((item) => ({ ...item, score: scoreGasPriceItem(item) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!entries.length || entries[0].score < 50) {
    throw new Error("Could not identify a System Average Price publication in the National Gas catalogue.");
  }

  console.log("National Gas price catalogue candidate:", entries[0]);

  return entries[0];
}

async function fetchGasPrice() {
  const publication = await discoverGasPricePublication();

  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const body = {
    fromDate: isoDate(yesterday),
    toDate: isoDate(today),
    publicationIds: [publication.publicationId],
    latestValue: "Y"
  };

  const response = await fetchJson(
    `${NATIONAL_GAS_API}/publications/gasday`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const groups = Array.isArray(response) ? response : rowsFrom(response);

  const values = [];

  for (const group of groups) {
    const publications = Array.isArray(group.publications)
      ? group.publications
      : [];

    for (const item of publications) {
      const value = finiteNumber(item.value);

      if (!Number.isFinite(value)) continue;

      values.push({
        pencePerTherm: value,
        applicableAt: item.applicableAt || "",
        applicableFor: item.applicableFor || "",
        generatedTimeStamp: item.generatedTimeStamp || item.createdDate || ""
      });
    }
  }

  if (!values.length) {
    throw new Error(
      `National Gas publication ${publication.publicationId} returned no numeric values.`
    );
  }

  values.sort((a, b) => {
    const aTime = validTimestamp(a.generatedTimeStamp || a.applicableAt);
    const bTime = validTimestamp(b.generatedTimeStamp || b.applicableAt);
    return bTime - aTime;
  });

  const latest = values[0];

  // Basic sanity guard for pence/therm. It still allows highly stressed markets.
  if (latest.pencePerTherm <= -100 || latest.pencePerTherm > 2000) {
    throw new Error(
      `National Gas returned an implausible p/therm value: ${latest.pencePerTherm}`
    );
  }

  return {
    status: "ok",
    gbpPerMWh: Number(
      pencePerThermToGBPPerMWh(latest.pencePerTherm).toFixed(2)
    ),
    pencePerTherm: Number(latest.pencePerTherm.toFixed(3)),
    originalUnit: "p/therm",
    publicationId: publication.publicationId,
    publicationName: publication.name,
    observationTime:
      latest.generatedTimeStamp ||
      latest.applicableAt ||
      latest.applicableFor,
    source: "National Gas Transmission REST API",
    sourceUrl: "https://data.nationalgas.com/apis/rest-apis",
    conversion:
      "GBP/MWh = (pencePerTherm / 100) / 0.029307107"
  };
}

const previous = await loadPrevious();

let electricity;
let gas;

try {
  electricity = await fetchElectricityPrice();
  console.log(
    `Electricity: GBP ${electricity.gbpPerMWh}/MWh from ${electricity.provider}, volume ${electricity.volumeMWh} MWh`
  );
} catch (error) {
  console.error("Electricity update failed:", error.message);

  electricity = previous.electricity?.status === "ok"
    ? {
        ...previous.electricity,
        stale: true,
        refreshWarning: error.message
      }
    : {
        status: "unavailable",
        message: error.message,
        source: "Elexon Insights"
      };
}

try {
  gas = await fetchGasPrice();
  console.log(
    `Gas: ${gas.pencePerTherm} p/therm = GBP ${gas.gbpPerMWh}/MWh`
  );
} catch (error) {
  console.error("Gas update failed:", error.message);

  gas = previous.gas?.status === "ok"
    ? {
        ...previous.gas,
        stale: true,
        refreshWarning: error.message
      }
    : {
        status: "unavailable",
        message: error.message,
        source: "National Gas Transmission REST API"
      };
}

const payload = {
  updated: new Date().toISOString(),
  currency: "GBP",
  displayUnit: "GBP/MWh",
  version: "1.0.3",
  electricity,
  gas
};

await fs.writeFile(
  OUTPUT,
  JSON.stringify(payload, null, 2) + "\n",
  "utf8"
);

console.log("Wrote data/prices.json");
