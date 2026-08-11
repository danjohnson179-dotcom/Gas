const API = "https://data.elexon.co.uk/bmrs/api/v1";

const state = {
  demandMW: null,
  generationMW: null,
  powerPrice: null,
  fuels: [],
  updated: null,
  dataSource: "live"
};

const $ = (id) => document.getElementById(id);
const fmtGW = mw => `${(mw / 1000).toFixed(1)} GW`;
const fmtMW = mw => `${Math.round(mw).toLocaleString()} MW`;

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function unwrap(x) {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== "object") return [];
  for (const key of ["data", "items", "results", "result"]) {
    if (Array.isArray(x[key])) return x[key];
  }
  return [];
}

function num(obj, keys) {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

async function loadGeneration() {
  let rows = [];
  try {
    const j = await getJson(`${API}/generation/actual/per-type/day-total`);
    rows = unwrap(j);
  } catch (_) {}

  if (!rows.length) {
    const to = new Date().toISOString();
    const from = isoHoursAgo(2);
    const j = await getJson(`${API}/generation/actual/per-type?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const raw = unwrap(j);
    const latestTime = raw.map(r => r.startTime || r.startTimeUtc || r.settlementDate || "").sort().pop();
    rows = latestTime ? raw.filter(r => (r.startTime || r.startTimeUtc || r.settlementDate || "") === latestTime) : raw.slice(-20);
  }

  const fuels = rows.map(r => ({
    name: String(r.psrType || r.fuelType || r.productionType || r.name || "other").replaceAll("_"," ").toLowerCase(),
    mw: num(r, ["currentUsage", "quantity", "generation", "mw", "value", "halfHourUsage", "lastHalfHourUsage"]) ?? 0,
    pct: num(r, ["currentPercentage", "percentage", "share", "lastHalfHourPercentage"])
  })).filter(x => x.mw > 0);

  if (!fuels.length) throw new Error("No generation rows");
  state.fuels = fuels.sort((a,b) => b.mw - a.mw);
  state.generationMW = fuels.reduce((s,f) => s + f.mw, 0);
}

async function loadDemand() {
  const to = new Date().toISOString();
  const from = isoHoursAgo(2);
  const candidates = [
    `${API}/demand/actual/total?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    `${API}/demand/outturn?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  ];

  for (const url of candidates) {
    try {
      const j = await getJson(url);
      const rows = unwrap(j);
      const vals = rows.map(r => num(r, ["demand", "initialDemandOutturn", "transmissionSystemDemand", "nationalDemand", "value", "quantity"])).filter(Number.isFinite);
      if (vals.length) {
        state.demandMW = vals[vals.length - 1];
        return;
      }
    } catch (_) {}
  }

  state.demandMW = state.generationMW;
}

async function loadPrice() {
  const to = new Date().toISOString();
  const from = isoHoursAgo(24);
  const url = `${API}/balancing/pricing/market-index?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const j = await getJson(url);
  const rows = unwrap(j);
  const priced = rows.map(r => ({
    p: num(r, ["price", "marketIndexPrice"]),
    t: r.startTime || r.settlementDate || r.publishTime || ""
  })).filter(x => Number.isFinite(x.p));
  if (!priced.length) throw new Error("No market price");
  state.powerPrice = priced[priced.length - 1].p;
}

function friendlyFuel(name) {
  const map = {
    "natural gas": "gas", "fossil gas": "gas", "ccgt": "gas",
    "wind offshore": "offshore wind", "wind onshore": "onshore wind",
    "other renewable": "other renewables", "biomass": "biomass"
  };
  return map[name] || name;
}

function isLowCarbon(name) {
  return /wind|solar|nuclear|hydro|biomass|renew/.test(name);
}

function isFossil(name) {
  return /gas|coal|oil|fossil/.test(name);
}

function render() {
  state.updated = new Date();

  $("generationValue").textContent = state.generationMW ? fmtGW(state.generationMW) : "Unavailable";
  $("generationSub").textContent = state.generationMW ? `${fmtMW(state.generationMW)} published generation` : "Could not load generation";

  $("demandValue").textContent = state.demandMW ? fmtGW(state.demandMW) : "Unavailable";
  $("demandSub").textContent = state.demandMW === state.generationMW
    ? "Approx. from current generation"
    : `${fmtMW(state.demandMW)} latest published demand`;

  const p = Number.isFinite(state.powerPrice) ? `Â£${state.powerPrice.toFixed(2)}/MWh` : "Unavailable";
  $("powerPrice").textContent = p;
  $("powerPriceLarge").textContent = p;
  $("powerPriceSub").textContent = Number.isFinite(state.powerPrice) ? "Latest Elexon market index" : "Market data unavailable";
  $("powerPriceExplain").textContent = Number.isFinite(state.powerPrice)
    ? `The latest available market index price is Â£${state.powerPrice.toFixed(2)} per MWh.`
    : "Elexon's price feed could not be loaded in this browser right now.";

  $("mixTotal").textContent = state.generationMW ? fmtGW(state.generationMW) : "â";
  $("generationTimestamp").textContent = `Updated ${state.updated.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`;

  if (state.fuels.length) {
    const max = Math.max(...state.fuels.map(f => f.mw));
    $("fuelMix").innerHTML = state.fuels.slice(0,10).map(f => {
      const pct = f.pct ?? (f.mw/state.generationMW*100);
      return `<div class="fuel-row">
        <span class="fuel-name">${friendlyFuel(f.name)}</span>
        <span class="bar" title="${pct.toFixed(1)}%"><span style="width:${Math.min(100,(f.mw/max)*100)}%"></span></span>
        <span class="fuel-value">${pct.toFixed(1)}%</span>
      </div>`;
    }).join("");

    const low = state.fuels.filter(f => isLowCarbon(f.name)).reduce((s,f)=>s+f.mw,0);
    const fossil = state.fuels.filter(f => isFossil(f.name)).reduce((s,f)=>s+f.mw,0);
    const lowPct = state.generationMW ? low/state.generationMW*100 : 0;
    const fossilPct = state.generationMW ? fossil/state.generationMW*100 : 0;
    const largest = state.fuels[0];

    $("lowCarbonShare").textContent = `${lowPct.toFixed(0)}%`;
    $("fossilShare").textContent = `${fossilPct.toFixed(0)}%`;
    $("largestSource").textContent = friendlyFuel(largest.name);
    $("mixHeadline").textContent = `${friendlyFuel(largest.name)} is the largest source right now`;
    $("mixExplanation").textContent =
      `${friendlyFuel(largest.name)} is contributing about ${(largest.mw/state.generationMW*100).toFixed(0)}% of the generation shown. ` +
      `The dashboard currently classifies about ${lowPct.toFixed(0)}% as low-carbon.`;
  } else {
    $("fuelMix").innerHTML = `<p class="muted">Live fuel-mix data is temporarily unavailable.</p>`;
    $("mixHeadline").textContent = "Live generation mix unavailable";
    $("mixExplanation").textContent = "Try Refresh. The page will never invent a live fuel mix when the public API does not respond.";
  }

  $("lastUpdated").textContent = `Last updated ${state.updated.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"})}`;
  $("liveStatus").classList.add("live");
  $("liveStatus").innerHTML = `<span class="dot"></span> Live public data`;
}

async function refreshAll() {
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "â» Updating";
  $("liveStatus").classList.remove("live");
  $("liveStatus").innerHTML = `<span class="dot"></span> Updating`;

  const results = await Promise.allSettled([
    loadGeneration(),
    loadPrice()
  ]);

  await loadDemand().catch(()=>{});
  render();

  const failed = results.filter(r => r.status === "rejected").length;
  if (failed) {
    $("liveStatus").innerHTML = `<span class="dot"></span> Live data â¢ ${failed} feed issue${failed>1?"s":""}`;
  }
  $("refreshBtn").disabled = false;
  $("refreshBtn").textContent = "â» Refresh";
}

function addMessage(text, who="bot") {
  const el = document.createElement("div");
  el.className = `message ${who}`;
  el.textContent = text;
  $("chatMessages").appendChild(el);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function answer(q) {
  const s = q.toLowerCase();
  const biggest = state.fuels[0];
  const demand = state.demandMW;
  const gen = state.generationMW;

  if (/powering|generation|fuel|mix|renewable|wind|gas|nuclear|solar/.test(s)) {
    if (!biggest || !gen) return "The live generation mix is unavailable at the moment. Use Refresh and I will explain it as soon as the API responds.";
    const pct = biggest.mw/gen*100;
    return `${friendlyFuel(biggest.name)} is the largest source in the current mix at roughly ${pct.toFixed(0)}%. Total published generation is about ${fmtGW(gen)}.`;
  }
  if (/demand|usage|using|high/.test(s)) {
    if (!demand) return "I do not have a live demand value right now.";
    let context = "That is a normal grid-scale figure, but whether it is unusually high depends on time of day, season and weather.";
    if (demand > 40000) context = "That is relatively high for GB and is often seen around busy winter or evening periods.";
    if (demand < 25000) context = "That is relatively low for GB and is more typical of quieter overnight or low-demand periods.";
    return `Current displayed electricity demand is about ${fmtGW(demand)}. ${context}`;
  }
  if (/price|mwh|wholesale|expensive|cheap/.test(s)) {
    if (!Number.isFinite(state.powerPrice)) return "The wholesale electricity price feed is unavailable right now. The gas card links directly to National Gas for its current Gas Day price data.";
    return `The latest electricity market index shown is Â£${state.powerPrice.toFixed(2)}/MWh. That is a wholesale market signal, not the price on a household bill. Retail bills also include networks, policy costs, supplier costs, taxes and hedging.`;
  }
  if (/gas price|gas market|therm/.test(s)) {
    return "For gas, this release links to National Gas's live Gas Day page instead of scraping or inventing a figure. Their page includes current market price information alongside supply, demand and linepack.";
  }
  if (/source|api|where|data/.test(s)) {
    return "Electricity data comes from Elexon's public Insights API with no API key. The gas market link goes to National Gas's official data portal.";
  }
  if (/hello|hi|hey/.test(s)) {
    return "Hi. Ask me about current demand, the generation mix, wholesale electricity prices, or where the data comes from.";
  }
  return "I can explain the live demand, generation mix, wholesale electricity price, gas-data source, or what any of the units mean. Try asking âwhat is powering GB?â";
}

function ask(text) {
  const q = text.trim();
  if (!q) return;
  addMessage(q, "user");
  $("chatInput").value = "";
  setTimeout(() => addMessage(answer(q), "bot"), 160);
}

document.querySelectorAll("[data-scroll]").forEach(btn => {
  btn.addEventListener("click", () => document.getElementById(btn.dataset.scroll).scrollIntoView({behavior:"smooth"}));
});

$("refreshBtn").addEventListener("click", refreshAll);
$("chatLauncher").addEventListener("click", () => {
  $("chatPanel").classList.add("open");
  $("chatPanel").setAttribute("aria-hidden","false");
  $("chatInput").focus();
});
$("chatClose").addEventListener("click", () => {
  $("chatPanel").classList.remove("open");
  $("chatPanel").setAttribute("aria-hidden","true");
});
$("chatSend").addEventListener("click", () => ask($("chatInput").value));
$("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") ask(e.target.value); });
document.querySelectorAll(".quick-questions button").forEach(btn => btn.addEventListener("click", () => ask(btn.textContent)));

refreshAll();
setInterval(refreshAll, 5 * 60 * 1000);
