const API = "https://data.elexon.co.uk/bmrs/api/v1";
const PRICES_JSON = "data/prices.json";

const state = {
  demandMW: null,
  generationMW: null,
  powerPriceGBP: null,
  gasPriceGBP: null,
  gasRawPencePerTherm: null,
  powerSource: null,
  gasSource: null,
  priceUpdated: null,
  fuels: [],
  updated: null
};

const byId = (id) => document.getElementById(id);
const fmtGW = (mw) => `${(mw / 1000).toFixed(1)} GW`;
const fmtMW = (mw) => `${Math.round(mw).toLocaleString()} MW`;
const fmtGBP = (value) => `GBP ${Number(value).toFixed(2)}/MWh`;

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function getJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "items", "results", "result"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function numberFrom(obj, keys) {
  for (const key of keys) {
    const value = Number(obj?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function cleanFuelName(name) {
  const raw = String(name || "other")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim()
    .toLowerCase();

  const aliases = {
    ccgt: "gas",
    ocgt: "gas",
    "fossil gas": "gas",
    "natural gas": "gas",
    "wind offshore": "offshore wind",
    "wind onshore": "onshore wind"
  };
  return aliases[raw] || raw;
}

async function loadGeneration() {
  const attempts = [
    async () => rowsFrom(await getJson(`${API}/generation/outturn/current`)),
    async () => {
      const rows = rowsFrom(await getJson(`${API}/datasets/FUELINST`));
      const times = rows
        .map((r) => r.startTime || r.publishTime || r.datasetTime || r.time)
        .filter(Boolean)
        .sort();
      const latest = times[times.length - 1];
      return latest
        ? rows.filter((r) =>
            (r.startTime || r.publishTime || r.datasetTime || r.time) === latest
          )
        : rows;
    }
  ];

  let rows = [];
  for (const attempt of attempts) {
    try {
      rows = await attempt();
      if (rows.length) break;
    } catch (error) {
      console.warn("Generation request failed", error);
    }
  }

  const fuels = rows.map((row) => ({
    name: cleanFuelName(row.fuelType || row.psrType || row.productionType || row.name),
    mw: numberFrom(row, ["generation", "currentUsage", "quantity", "mw", "value"]) || 0,
    pct: numberFrom(row, ["percentage", "currentPercentage", "share"])
  })).filter((fuel) => fuel.mw > 0);

  if (!fuels.length) throw new Error("No generation values");

  state.fuels = fuels.sort((a, b) => b.mw - a.mw);
  state.generationMW = state.fuels.reduce((sum, fuel) => sum + fuel.mw, 0);
}

async function loadDemand() {
  const attempts = [
    async () => rowsFrom(await getJson(`${API}/datasets/INDO`)),
    async () => {
      const from = encodeURIComponent(isoHoursAgo(3));
      const to = encodeURIComponent(new Date().toISOString());
      return rowsFrom(await getJson(`${API}/demand/outturn?from=${from}&to=${to}`));
    }
  ];

  for (const attempt of attempts) {
    try {
      const rows = await attempt();
      const values = rows.map((row) => numberFrom(row, [
        "initialDemandOutturn",
        "demand",
        "nationalDemand",
        "transmissionSystemDemand",
        "value"
      ])).filter(Number.isFinite);

      if (values.length) {
        state.demandMW = values[values.length - 1];
        return;
      }
    } catch (error) {
      console.warn("Demand request failed", error);
    }
  }

  if (state.generationMW) state.demandMW = state.generationMW;
}

async function loadPrices() {
  try {
    const json = await getJson(`${PRICES_JSON}?t=${Date.now()}`, 6000);

    if (json?.electricity?.status === "ok") {
      const price = Number(json.electricity.gbpPerMWh);
      if (Number.isFinite(price)) {
        state.powerPriceGBP = price;
        state.powerSource = json.electricity.sourceLabel || json.electricity.source || "Elexon";
      }
    }

    if (json?.gas?.status === "ok") {
      const price = Number(json.gas.gbpPerMWh);
      const raw = Number(json.gas.pencePerTherm);

      if (Number.isFinite(price)) {
        state.gasPriceGBP = price;
        state.gasSource = json.gas.sourceLabel || json.gas.source || "UK NBP";
      }
      if (Number.isFinite(raw)) state.gasRawPencePerTherm = raw;
    }

    state.priceUpdated = json?.updated || null;
  } catch (error) {
    console.warn("Price file unavailable", error);
  }
}

function isLowCarbon(name) {
  return /wind|solar|nuclear|hydro|biomass|renew/.test(name);
}

function isFossil(name) {
  return /gas|coal|oil|fossil/.test(name);
}


function calculateGridPulse() {
  const demand = state.demandMW;
  const generation = state.generationMW;
  const power = state.powerPriceGBP;

  let lowCarbonPct = null;
  if (state.fuels.length && generation) {
    const low = state.fuels
      .filter((f) => /wind|solar|nuclear|hydro|biomass|renew/.test(f.name))
      .reduce((sum, f) => sum + f.mw, 0);
    lowCarbonPct = low / generation * 100;
  }

  let score = 50;

  if (Number.isFinite(lowCarbonPct)) {
    score += (lowCarbonPct - 40) * 0.55;
  }

  if (Number.isFinite(demand)) {
    if (demand < 25000) score += 12;
    else if (demand < 32000) score += 5;
    else if (demand > 42000) score -= 14;
    else if (demand > 36000) score -= 7;
  }

  if (Number.isFinite(power)) {
    if (power < 50) score += 14;
    else if (power < 80) score += 7;
    else if (power > 140) score -= 18;
    else if (power > 110) score -= 10;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let label = "Balanced";
  let title = "The grid looks balanced";
  let explanation = "Demand, generation mix and wholesale price are sitting in a fairly normal combination.";

  if (score >= 75) {
    label = "Clean";
    title = "A favourable grid right now";
    explanation = "Lower demand, cleaner generation and/or softer wholesale power prices are supporting the score.";
  } else if (score >= 58) {
    label = "Healthy";
    title = "The grid looks healthy";
    explanation = "Current conditions look relatively comfortable across demand, generation mix and power price.";
  } else if (score < 35) {
    label = "Tight";
    title = "The grid looks under pressure";
    explanation = "Higher demand, a more fossil-heavy mix and/or expensive wholesale power are weighing on conditions.";
  } else if (score < 48) {
    label = "Watch";
    title = "Market conditions are firmer";
    explanation = "At least one live signal is pushing conditions away from the dashboard's normal range.";
  }

  return { score, label, title, explanation, lowCarbonPct };
}

function renderGridPulse() {
  const pulse = calculateGridPulse();

  const scoreEl = byId("gridPulseScore");
  if (!scoreEl) return;

  scoreEl.textContent = pulse.score;
  byId("gridPulseBadge").textContent = pulse.label;
  byId("gridPulseTitle").textContent = pulse.title;
  byId("gridPulseExplanation").textContent = pulse.explanation;

  byId("pulseDemand").textContent =
    state.demandMW ? fmtGW(state.demandMW) : "-";

  byId("pulseLowCarbon").textContent =
    Number.isFinite(pulse.lowCarbonPct)
      ? `${pulse.lowCarbonPct.toFixed(0)}%`
      : "-";

  byId("pulsePrice").textContent =
    Number.isFinite(state.powerPriceGBP)
      ? fmtGBP(state.powerPriceGBP)
      : "-";
}

function render() {
  state.updated = new Date();

  byId("generationValue").textContent =
    state.generationMW ? fmtGW(state.generationMW) : "Unavailable";

  byId("generationSub").textContent =
    state.generationMW
      ? `${fmtMW(state.generationMW)} published generation`
      : "Generation feed unavailable";

  byId("demandValue").textContent =
    state.demandMW ? fmtGW(state.demandMW) : "Unavailable";

  byId("demandSub").textContent =
    state.demandMW
      ? `${fmtMW(state.demandMW)} latest published demand`
      : "Demand feed unavailable";

  const electricityText = Number.isFinite(state.powerPriceGBP)
    ? fmtGBP(state.powerPriceGBP)
    : "Unavailable";

  byId("powerPrice").textContent = electricityText;
  byId("powerPriceLarge").textContent = electricityText;
  byId("powerPriceSub").textContent = Number.isFinite(state.powerPriceGBP)
    ? "Latest valid GB short-term wholesale price"
    : "Price feed temporarily unavailable";

  byId("powerPriceExplain").textContent = Number.isFinite(state.powerPriceGBP)
    ? `Latest validated Elexon short-term GB wholesale price: ${electricityText}.`
    : "No recent valid electricity price has been published to the dashboard.";

  const gasText = Number.isFinite(state.gasPriceGBP)
    ? fmtGBP(state.gasPriceGBP)
    : "Unavailable";

  byId("gasPrice").textContent = gasText;
  byId("gasPriceLarge").textContent = gasText;
  byId("gasPriceSub").textContent = Number.isFinite(state.gasPriceGBP)
    ? "UK NBP gas benchmark"
    : "UK gas benchmark temporarily unavailable";

  byId("gasPriceExplain").textContent = Number.isFinite(state.gasPriceGBP)
    ? `Latest UK NBP benchmark converted to ${gasText}. Original quote: ${state.gasRawPencePerTherm?.toFixed(2) ?? "-"} p/therm.`
    : "No recent valid UK gas benchmark has been published to the dashboard.";

  if (byId("gasPriceType")) {
    byId("gasPriceType").textContent = state.gasSource || "UK NBP benchmark";
  }

  if (byId("gasUpdated")) {
    byId("gasUpdated").textContent = state.priceUpdated
      ? `Prices updated ${new Date(state.priceUpdated).toLocaleString()}`
      : "Waiting for price updater";
  }

  byId("mixTotal").textContent =
    state.generationMW ? fmtGW(state.generationMW) : "-";

  byId("generationTimestamp").textContent =
    `Updated ${state.updated.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    })}`;

  if (state.fuels.length && state.generationMW) {
    const maxMW = Math.max(...state.fuels.map((fuel) => fuel.mw));

    byId("fuelMix").innerHTML = state.fuels.slice(0, 12).map((fuel) => {
      const pct = Number.isFinite(fuel.pct)
        ? fuel.pct
        : (fuel.mw / state.generationMW) * 100;
      const width = Math.max(2, Math.min(100, (fuel.mw / maxMW) * 100));

      return `<div class="fuel-row">
        <span class="fuel-name">${fuel.name}</span>
        <span class="bar"><span style="width:${width}%"></span></span>
        <span class="fuel-value">${pct.toFixed(1)}%</span>
      </div>`;
    }).join("");

    const low = state.fuels
      .filter((fuel) => isLowCarbon(fuel.name))
      .reduce((sum, fuel) => sum + fuel.mw, 0);

    const fossil = state.fuels
      .filter((fuel) => isFossil(fuel.name))
      .reduce((sum, fuel) => sum + fuel.mw, 0);

    const lowPct = low / state.generationMW * 100;
    const fossilPct = fossil / state.generationMW * 100;
    const largest = state.fuels[0];

    byId("lowCarbonShare").textContent = `${lowPct.toFixed(0)}%`;
    byId("fossilShare").textContent = `${fossilPct.toFixed(0)}%`;
    byId("largestSource").textContent = largest.name;
    byId("mixHeadline").textContent = `${largest.name} is the largest source right now`;
    byId("mixExplanation").textContent =
      `${largest.name} is contributing about ${(largest.mw/state.generationMW*100).toFixed(0)}% of the generation shown. ` +
      `Around ${lowPct.toFixed(0)}% is classified as low-carbon.`;
  } else {
    byId("fuelMix").innerHTML =
      '<p class="muted">Generation mix temporarily unavailable.</p>';
  }

  byId("lastUpdated").textContent =
    `Last updated ${state.updated.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })}`;

  renderGridPulse();

  const liveCount = [
    Boolean(state.generationMW),
    Boolean(state.demandMW),
    Number.isFinite(state.powerPriceGBP),
    Number.isFinite(state.gasPriceGBP)
  ].filter(Boolean).length;

  if (liveCount) {
    byId("liveStatus").classList.add("live");
    byId("liveStatus").innerHTML =
      `<span class="dot"></span> ${liveCount}/4 data feeds connected`;
  } else {
    byId("liveStatus").classList.remove("live");
    byId("liveStatus").innerHTML =
      '<span class="dot"></span> Data feeds unavailable';
  }
}

async function refreshAll() {
  byId("refreshBtn").disabled = true;
  byId("refreshBtn").textContent = "Updating";

  state.demandMW = null;
  state.generationMW = null;
  state.powerPriceGBP = null;
  state.gasPriceGBP = null;
  state.gasRawPencePerTherm = null;
  state.fuels = [];

  await Promise.allSettled([loadGeneration(), loadPrices()]);
  await loadDemand().catch(() => {});

  render();

  byId("refreshBtn").disabled = false;
  byId("refreshBtn").textContent = "Refresh";
}

function addMessage(text, who = "bot") {
  const node = document.createElement("div");
  node.className = `message ${who}`;
  node.textContent = text;
  byId("chatMessages").appendChild(node);
  byId("chatMessages").scrollTop = byId("chatMessages").scrollHeight;
}

function answer(question) {
  const q = question.toLowerCase();
  const biggest = state.fuels[0];

  if (/gas price|gas market|therm|nbp/.test(q)) {
    if (!Number.isFinite(state.gasPriceGBP)) {
      return "The UK gas benchmark is temporarily unavailable.";
    }
    return `The current displayed UK NBP benchmark is ${fmtGBP(state.gasPriceGBP)}, converted from ${state.gasRawPencePerTherm.toFixed(2)} pence per therm.`;
  }

  if (/powering|generation|fuel|mix|wind|nuclear|solar/.test(q)) {
    if (!biggest || !state.generationMW) return "Generation data is unavailable.";
    return `${biggest.name} is the largest source at about ${(biggest.mw/state.generationMW*100).toFixed(0)}%. Total displayed generation is ${fmtGW(state.generationMW)}.`;
  }

  if (/demand|usage|using|high/.test(q)) {
    if (!state.demandMW) return "Demand data is unavailable.";
    return `Current displayed GB electricity demand is about ${fmtGW(state.demandMW)}.`;
  }

  if (/electricity price|price|mwh|wholesale/.test(q)) {
    if (!Number.isFinite(state.powerPriceGBP)) {
      return "The short-term GB wholesale electricity price is temporarily unavailable.";
    }
    return `The latest validated Elexon wholesale electricity price is ${fmtGBP(state.powerPriceGBP)}.`;
  }

  if (/grid pulse|pulse|score|clean|balanced|tight/.test(q)) {
    const pulse = calculateGridPulse();
    return `Grid Pulse is ${pulse.score}/100 (${pulse.label}). It combines demand, low-carbon generation share and wholesale electricity price into one simple dashboard signal. It is not an official grid metric.`;
  }

  return "Ask me about Grid Pulse, demand, generation, wholesale electricity, or the UK NBP gas benchmark.";
}

function ask(text) {
  const question = text.trim();
  if (!question) return;
  addMessage(question, "user");
  byId("chatInput").value = "";
  setTimeout(() => addMessage(answer(question), "bot"), 150);
}

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.scroll)
      .scrollIntoView({ behavior: "smooth" });
  });
});

byId("refreshBtn").addEventListener("click", refreshAll);
byId("chatLauncher").addEventListener("click", () => {
  byId("chatPanel").classList.add("open");
  byId("chatPanel").setAttribute("aria-hidden", "false");
  byId("chatInput").focus();
});
byId("chatClose").addEventListener("click", () => {
  byId("chatPanel").classList.remove("open");
  byId("chatPanel").setAttribute("aria-hidden", "true");
});
byId("chatSend").addEventListener("click", () => ask(byId("chatInput").value));
byId("chatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") ask(event.target.value);
});
document.querySelectorAll(".quick-questions button").forEach((button) => {
  button.addEventListener("click", () => ask(button.textContent));
});

refreshAll();
setInterval(refreshAll, 5 * 60 * 1000);
