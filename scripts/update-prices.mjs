import fs from "node:fs/promises";
import { chromium } from "playwright";

const ELEXON_API = "https://data.elexon.co.uk/bmrs/api/v1";
const NATIONAL_GAS = "https://data.nationalgas.com/reports/gas-day-summary";
const OUTPUT = new URL("../data/prices.json", import.meta.url);

// 1 therm = 29.307107 kWh = 0.029307107 MWh.
// A quote in pence/therm becomes GBP/MWh via:
// (pence / 100) / 0.029307107
const THERM_MWH = 0.029307107;

function pencePerThermToGBPPerMWh(value) {
  return (Number(value) / 100) / THERM_MWH;
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  for (const key of ["data", "items", "results", "result"]) {
    if (Array.isArray(value[key])) return value[key];
  }

  return [];
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadPrevious() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    return {};
  }
}

async function fetchElectricityPrice() {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const url = new URL(`${ELEXON_API}/balancing/pricing/market-index`);
  url.searchParams.set("from", fromDate.toISOString());
  url.searchParams.set("to", now.toISOString());

  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Elexon returned HTTP ${response.status}`);
  }

  const json = await response.json();
  const rows = rowsFrom(json);

  const candidates = rows
    .map((row) => ({
      price: numeric(row.price ?? row.marketIndexPrice ?? row.marketPrice),
      time: row.startTime ?? row.publishTime ?? row.settlementDate ?? "",
      provider: row.dataProvider ?? row.provider ?? row.marketIndexDataProvider ?? ""
    }))
    .filter((row) => Number.isFinite(row.price))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));

  if (!candidates.length) {
    throw new Error("Elexon returned no usable market-index prices");
  }

  const latest = candidates[candidates.length - 1];

  return {
    status: "ok",
    gbpPerMWh: latest.price,
    originalUnit: "GBP/MWh",
    provider: latest.provider || "Elexon Market Index Data",
    source: "Elexon Insights",
    sourceUrl: "https://bmrs.elexon.co.uk/market-index-prices"
  };
}

function findGasPriceInText(text) {
  const normalized = clean(text);

  const patterns = [
    {
      label: "System Average Price",
      regex: /system average price.{0,160}?(-?\d+(?:\.\d+)?)\s*(?:p\/therm|pence\/therm|p\/th)/i
    },
    {
      label: "SAP",
      regex: /\bSAP\b.{0,160}?(-?\d+(?:\.\d+)?)\s*(?:p\/therm|pence\/therm|p\/th)/i
    },
    {
      label: "Weighted Average Price",
      regex: /weighted average price.{0,160}?(-?\d+(?:\.\d+)?)\s*(?:p\/therm|pence\/therm|p\/th)/i
    },
    {
      label: "WAP",
      regex: /\bWAP\b.{0,160}?(-?\d+(?:\.\d+)?)\s*(?:p\/therm|pence\/therm|p\/th)/i
    }
  ];

  for (const item of patterns) {
    const match = normalized.match(item.regex);
    if (match) {
      return {
        label: item.label,
        pencePerTherm: Number(match[1])
      };
    }
  }

  // Fallback for CSV/XML/table output where the descriptor is separated.
  const generic = normalized.match(/(-?\d+(?:\.\d+)?)\s*(?:p\/therm|pence\/therm|p\/th)/i);

  if (generic) {
    return {
      label: "National Gas trading price",
      pencePerTherm: Number(generic[1])
    };
  }

  return null;
}

async function fetchGasPrice() {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 }
    });

    const page = await context.newPage();

    await page.goto(NATIONAL_GAS, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await page.waitForTimeout(8000);

    let found = findGasPriceInText(await page.locator("body").innerText());

    if (!found) {
      const possibleLinks = page.locator("a, button");
      const count = await possibleLinks.count();

      for (let i = 0; i < count && !found; i += 1) {
        const node = possibleLinks.nth(i);
        const text = clean(await node.innerText().catch(() => ""));

        if (!/download as csv|download.*csv|csv/i.test(text)) continue;

        try {
          const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
          await node.click({ timeout: 10000 });
          const download = await downloadPromise;
          const path = await download.path();

          if (path) {
            const fileText = await fs.readFile(path, "utf8");
            found = findGasPriceInText(fileText);
          }
        } catch {
          // Some links navigate directly rather than firing a browser download.
          const href = await node.getAttribute("href").catch(() => null);

          if (href) {
            const response = await context.request.get(new URL(href, NATIONAL_GAS).href, {
              timeout: 30000
            });

            if (response.ok()) {
              found = findGasPriceInText(await response.text());
            }
          }
        }
      }
    }

    if (!found || !Number.isFinite(found.pencePerTherm)) {
      throw new Error("No usable National Gas pence-per-therm price was found");
    }

    return {
      status: "ok",
      gbpPerMWh: Number(pencePerThermToGBPPerMWh(found.pencePerTherm).toFixed(2)),
      pencePerTherm: Number(found.pencePerTherm.toFixed(3)),
      originalUnit: "p/therm",
      label: found.label,
      source: "National Gas Transmission Data Portal",
      sourceUrl: NATIONAL_GAS,
      conversion: "GBP/MWh = (pencePerTherm / 100) / 0.029307107"
    };
  } finally {
    await browser.close();
  }
}

const previous = await loadPrevious();

let electricity;
let gas;

try {
  electricity = await fetchElectricityPrice();
  console.log(`Electricity: GBP ${electricity.gbpPerMWh}/MWh`);
} catch (error) {
  console.error("Electricity update failed:", error.message);

  electricity = previous.electricity?.status === "ok"
    ? {
        ...previous.electricity,
        warning: `Refresh failed: ${error.message}`
      }
    : {
        status: "unavailable",
        message: error.message,
        source: "Elexon Insights"
      };
}

try {
  gas = await fetchGasPrice();
  console.log(`Gas: ${gas.pencePerTherm} p/therm = GBP ${gas.gbpPerMWh}/MWh`);
} catch (error) {
  console.error("Gas update failed:", error.message);

  gas = previous.gas?.status === "ok"
    ? {
        ...previous.gas,
        warning: `Refresh failed: ${error.message}`
      }
    : {
        status: "unavailable",
        message: error.message,
        source: "National Gas Transmission Data Portal"
      };
}

const payload = {
  updated: new Date().toISOString(),
  currency: "GBP",
  displayUnit: "GBP/MWh",
  electricity,
  gas
};

await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log("Wrote data/prices.json");
