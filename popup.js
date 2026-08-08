// popup.js — reads the subject vehicle from the active tab, runs the CarGurus
// search via the background worker, and renders the comps dashboard.

const $ = (id) => document.getElementById(id);
const fmt$ = (n) => (Number.isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "—");
const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");

const DEFAULTS = {
  zip: "", radius: "100", variance: 15000, strictTrim: true, includeDelivery: true, selectors: {},
  dealerFee: "", titleFee: "", targetGross: 2500, reconDefault: 2500, theme: "auto"
};

// Mileage range slider bounds + the default ± window centered on the subject.
const MILE_MAX = 200000;
let mileVariance = 15000;
let mileUpdate = () => {};

const THEMES = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "🌗 Auto", light: "☀️ Light", dark: "🌙 Dark" };

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("themeBtn");
  if (btn) btn.textContent = THEME_LABEL[theme] || THEME_LABEL.auto;
}

async function cycleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
  const settings = (await chrome.storage.local.get("settings")).settings || {};
  settings.theme = next;
  await chrome.storage.local.set({ settings });
}

// Pricing from the currently-selected comps; deal math recomputes live from it.
let currentPricing = null;
// True once the user types/jumps their own ACV, so selection changes stop
// re-seeding it. Reset on each new search.
let acvUserEdited = false;
// Inventory Plus market data (TrueScore Market + TrueTarget) read off the page.
let subjectExtra = null;

// Cached settings so the "Read this tab" button can re-read on demand. The panel
// stays open across tab switches, so this lets you pull a fresh vehicle without
// reopening (which is what used to trigger the auto-read).
let currentSettings = null;

// ---------------------------------------------------------------------------
// Subject-vehicle reader (injected into the Inventory Plus tab).
// Pure function: no external references. Tries configured CSS selectors first,
// then falls back to heuristics over page text.
// ---------------------------------------------------------------------------
function readSubjectVehicle(selectors) {
  const txt = (el) => (el && (el.value || el.textContent) || "").trim();
  const bySel = (sel) => { try { return sel ? txt(document.querySelector(sel)) : ""; } catch (e) { return ""; } };

  const out = { year: "", make: "", model: "", trim: "", mileage: "", bodyStyle: "",
                target: "", turn: "", volume: "", market: "", source: "none", candidates: [] };

  // Body style from a piece of text (convertible=cabriolet=roadster, etc.).
  const detectBody = (s) => {
    const t = " " + String(s || "").toLowerCase() + " ";
    if (/convertible|cabriolet|cabrio|roadster|spyder|spider|drop\s?top/.test(t)) return "convertible";
    if (/coupe/.test(t)) return "coupe";
    if (/wagon|estate|touring|avant|sportwagen|allroad|shooting brake/.test(t)) return "wagon";
    if (/hatchback/.test(t)) return "hatchback";
    if (/minivan|mini van/.test(t)) return "van";
    if (/pickup|crew cab|extended cab|regular cab|quad cab|double cab|king cab|super ?cab|supercrew|crewmax/.test(t)) return "truck";
    if (/\bsuv\b|sport utility|crossover/.test(t)) return "suv";
    if (/\bvan\b/.test(t)) return "van";
    if (/sedan|saloon|4dr|four door/.test(t)) return "sedan";
    return "";
  };

  // 1) Configured selectors win.
  if (selectors && Object.keys(selectors).length) {
    out.year = bySel(selectors.year);
    out.make = bySel(selectors.make);
    out.model = bySel(selectors.model);
    out.trim = bySel(selectors.trim);
    out.mileage = bySel(selectors.mileage).replace(/[^\d]/g, "");
    if (out.year || out.make || out.model) { out.source = "selectors"; return out; }
  }

  // 2) Heuristic: find a "YYYY Make Model ..." heading.
  const KNOWN_MAKES = ["Mercedes-Benz","Mercedes","BMW","Audi","Lexus","Toyota","Honda","Ford","Chevrolet","GMC","Ram","RAM","Jeep","Dodge","Chrysler","Nissan","INFINITI","Infiniti","Acura","Hyundai","Kia","Genesis","Subaru","Mazda","Volkswagen","Volvo","Porsche","Land Rover","Range Rover","Jaguar","Cadillac","Buick","Lincoln","Tesla","Mitsubishi","MINI","Mini","Fiat","Alfa Romeo","Maserati","Bentley","Rolls-Royce","Ferrari","Lamborghini","McLaren","Aston Martin","Rivian","Lucid","Polestar"];
  const makeAlt = KNOWN_MAKES.map((m) => m.replace(/[-\s]/g, "[-\\s]?")).join("|");
  const titleRe = new RegExp("\\b(19|20)\\d{2}\\s+(" + makeAlt + ")\\b", "i");

  const nodes = Array.from(document.querySelectorAll("h1,h2,h3,[class*='title' i],[class*='vehicle' i],[class*='heading' i],title"));
  const strings = [];
  for (const n of nodes) { const t = txt(n); if (t && t.length < 120) strings.push(t); }
  strings.push(document.title);

  let hit = "";
  for (const s of strings) { if (titleRe.test(s)) { hit = s; out.candidates.push(s); break; } }
  if (!hit) { for (const s of strings.slice(0, 8)) out.candidates.push(s); }

  if (hit) {
    const ym = hit.match(/\b((?:19|20)\d{2})\b/);
    if (ym) out.year = ym[1];
    const mk = hit.match(new RegExp("(" + makeAlt + ")", "i"));
    if (mk) {
      out.make = mk[1].replace(/\s+/g, " ").trim();
      const after = hit.slice(hit.indexOf(mk[1]) + mk[1].length).trim().replace(/\|.*$/, "").trim();
      const parts = after.split(/\s+/).filter(Boolean);

      // Most models are one word, but some are not ("Model 3", "Grand Cherokee",
      // "Range Rover Sport"). Naively taking parts[0] as the model breaks those:
      // Tesla "Model 3" becomes model "Model" + trim "3 ...", which then matches
      // EVERY Tesla "Model _" (Model S/X/Y) and buries the real trim. Keep known
      // multi-word models whole (longest first) so model/trim split correctly.
      const MULTIWORD_MODELS = {
        "Tesla": ["Model 3", "Model S", "Model X", "Model Y"],
        "Jeep": ["Grand Cherokee L", "Grand Cherokee", "Grand Wagoneer L", "Grand Wagoneer"],
        "Land Rover": ["Range Rover Velar", "Range Rover Evoque", "Range Rover Sport", "Range Rover", "Discovery Sport"],
        "Range Rover": ["Range Rover Velar", "Range Rover Evoque", "Range Rover Sport", "Range Rover"],
        "Hyundai": ["Santa Cruz", "Santa Fe", "Ioniq 5", "Ioniq 6", "Ioniq"],
        "Alfa Romeo": ["Giulia", "Stelvio"],
        "Ford": ["Mustang Mach-E"],
        "Chevrolet": ["Silverado 1500", "Silverado 2500HD", "Silverado 3500HD"],
        "GMC": ["Sierra 1500", "Sierra 2500HD", "Sierra 3500HD"]
      };
      const lc = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const makeKey = { "mercedes": "Mercedes-Benz", "mercedes benz": "Mercedes-Benz",
                        "landrover": "Land Rover", "land rover": "Land Rover" }[lc(out.make)] || out.make;
      const afterLc = lc(after);
      let modelHit = null;
      for (const name of (MULTIWORD_MODELS[makeKey] || [])) {
        const nlc = lc(name);
        if (afterLc === nlc || afterLc.startsWith(nlc + " ")) { modelHit = name; break; }
      }

      if (modelHit) {
        out.model = modelHit;
        out.trim = parts.slice(modelHit.split(/\s+/).length).join(" ").trim();
      } else {
        if (parts.length) out.model = parts[0];
        if (parts.length > 1) out.trim = parts.slice(1).join(" ").trim();
      }
    }
    out.source = "heuristic";
  }

  // 3) Mileage: look for "12,345 mi" / "Mileage: 12,345" / "Odometer".
  const body = document.body ? document.body.innerText : "";
  let m = body.match(/(?:odometer|mileage|miles)\D{0,12}([\d]{1,3}(?:,\d{3})+|\d{4,6})/i);
  if (!m) m = body.match(/([\d]{1,3}(?:,\d{3})+|\d{4,6})\s*(?:mi\b|miles\b)/i);
  if (m) out.mileage = m[1].replace(/[^\d]/g, "");

  // 4) Body style from the vehicle heading — used to drop wrong body styles
  // (e.g. sedans/coupes when appraising a convertible).
  out.bodyStyle = detectBody(hit);

  // 5) Inventory Plus market widgets. Class names are auto-generated (React/MUI),
  // so key off stable ids (#trueScoreMarket-container, #mainScoreLbl, #retail)
  // and the stat label text ("Turn", "Volume/Mo.").
  try {
    let tsRoot = document.querySelector("#trueScoreMarket-container");
    if (!tsRoot) {
      const h = Array.from(document.querySelectorAll("h6")).find((n) => /truescore market/i.test(n.textContent || ""));
      tsRoot = h ? h.parentElement : null;
    }
    if (tsRoot) {
      tsRoot.querySelectorAll("p").forEach((pn) => {
        const lab = (pn.textContent || "").trim().toLowerCase();
        const h6 = pn.parentElement && pn.parentElement.querySelector("h6");
        const val = h6 ? (h6.textContent || "").trim() : "";
        if (/turn/.test(lab)) out.turn = val;
        else if (/volume/.test(lab)) out.volume = val;
      });
      const scoreLbl = document.getElementById("mainScoreLbl");
      if (scoreLbl && scoreLbl.parentElement) {
        const mh = scoreLbl.parentElement.querySelector("h6");
        if (mh) out.market = (mh.textContent || "").trim();
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const tgt = document.querySelector("#retail .value") || document.querySelector("#truemarket .value");
    if (tgt) { const c = tgt.cloneNode(true); c.querySelectorAll(".subtitle").forEach((s) => s.remove()); out.target = (c.textContent || "").trim(); }
  } catch (e) { /* ignore */ }

  return out;
}

// ---------------------------------------------------------------------------
async function loadDefaults() {
  const stored = await chrome.storage.local.get(["settings"]);
  const s = Object.assign({}, DEFAULTS, stored.settings || {});
  applyTheme(s.theme || "auto");
  if (s.zip) $("zip").value = s.zip;
  $("radius").value = s.radius || "100";
  $("strictTrim").checked = s.strictTrim !== false;
  $("includeDelivery").checked = s.includeDelivery !== false;
  mileVariance = Number.isFinite(s.variance) ? s.variance : 15000;
  if (s.dealerFee !== "" && s.dealerFee != null) $("dealerFee").value = s.dealerFee;
  if (s.titleFee !== "" && s.titleFee != null) $("titleFee").value = s.titleFee;
  $("targetGross").value = Number.isFinite(s.targetGross) ? s.targetGross : 2500;
  $("recon").value = Number.isFinite(s.reconDefault) ? s.reconDefault : 2500;
  return s;
}

// Dual-handle mileage range slider: two overlaid range inputs kept from crossing,
// with a fill bar between them and a live "X–Y mi" label.
function setupMileageSlider() {
  const lo = $("mileMin"), hi = $("mileMax"), fill = $("mrFill"), label = $("mrLabel");
  if (!lo || !hi) return;
  mileUpdate = () => {
    let a = Number(lo.value), b = Number(hi.value);
    if (a > b) { const t = a; a = b; b = t; }
    const pctA = (a / MILE_MAX) * 100;
    const pctB = (b / MILE_MAX) * 100;
    if (fill) { fill.style.left = pctA + "%"; fill.style.width = Math.max(0, pctB - pctA) + "%"; }
    if (label) {
      label.textContent = (a <= 0 && b >= MILE_MAX)
        ? "Any mileage"
        : a.toLocaleString("en-US") + "–" + b.toLocaleString("en-US") + " mi";
    }
  };
  lo.addEventListener("input", () => { if (Number(lo.value) > Number(hi.value)) lo.value = hi.value; mileUpdate(); });
  hi.addEventListener("input", () => { if (Number(hi.value) < Number(lo.value)) hi.value = lo.value; mileUpdate(); });
  mileUpdate();
}

// Recenter the window on the subject's mileage (±mileVariance, default 15k).
function centerMileageWindow(subjectMiles) {
  const lo = $("mileMin"), hi = $("mileMax");
  if (!lo || !hi) return;
  const V = Number.isFinite(mileVariance) ? mileVariance : 15000;
  const m = parseInt(String(subjectMiles).replace(/[^\d]/g, ""), 10);
  const snap = (x) => Math.round(x / 5000) * 5000;
  if (Number.isFinite(m) && m > 0) {
    lo.value = Math.max(0, snap(m - V));
    hi.value = Math.min(MILE_MAX, snap(m + V));
  } else {
    lo.value = 0; hi.value = MILE_MAX;
  }
  mileUpdate();
}

async function readActiveTab(settings, opts = {}) {
  const status = $("readStatus");
  // On a manual re-read (the button), clear the old car first so stale fields
  // from the previous appraisal don't linger if the new tab is missing some.
  if (opts.manual) {
    ["year", "make", "model", "trim", "mileage"].forEach((id) => { $(id).value = ""; });
    $("bodyStyle").value = "any";
    status.textContent = "Reading…";
    status.className = "pill";
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || /^chrome|^edge|^about:/.test(tab.url || "")) {
      status.textContent = "Enter vehicle";
      status.className = "pill";
      return;
    }
    // Read every frame (the vehicle heading and the Inventory Plus widgets may
    // live in different frames), then merge: first non-empty value per field.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: readSubjectVehicle,
      args: [settings.selectors || {}]
    });
    const v = { year: "", make: "", model: "", trim: "", mileage: "", bodyStyle: "",
                target: "", turn: "", volume: "", market: "", source: "none" };
    for (const r of (results || [])) {
      const o = r && r.result;
      if (!o) continue;
      ["year", "make", "model", "trim", "mileage", "bodyStyle", "target", "turn", "volume", "market"].forEach((k) => {
        if (!v[k] && o[k]) v[k] = o[k];
      });
      if (v.source === "none" && o.source && o.source !== "none") v.source = o.source;
    }
    subjectExtra = { target: v.target, turn: v.turn, volume: v.volume, market: v.market };

    if (v.year) $("year").value = v.year;
    if (v.make) $("make").value = v.make;
    if (v.model) $("model").value = v.model;
    if (v.trim) $("trim").value = v.trim;
    if (v.mileage) $("mileage").value = v.mileage;
    $("bodyStyle").value = v.bodyStyle || "any";
    centerMileageWindow($("mileage").value);

    if (v.source === "selectors" || v.source === "heuristic") {
      status.textContent = "Read from page ✓";
      status.className = "pill ok";
    } else {
      status.textContent = "Couldn't auto-read — enter it";
      status.className = "pill warn";
    }
  } catch (e) {
    status.textContent = "Enter vehicle";
    status.className = "pill";
  }
}

function gatherSpec() {
  return {
    year: parseInt($("year").value, 10) || null,
    make: $("make").value.trim(),
    model: $("model").value.trim(),
    trim: $("strictTrim").checked ? $("trim").value.trim() : "",
    bodyStyle: $("bodyStyle").value || "any",
    includeDelivery: $("includeDelivery").checked,
    mileage: parseInt($("mileage").value.replace(/[^\d]/g, ""), 10) || null,
    zip: $("zip").value.replace(/[^\d]/g, ""),
    radius: parseInt($("radius").value, 10) || 100,
    minMileage: parseInt($("mileMin").value, 10),
    maxMileage: parseInt($("mileMax").value, 10),
    targetCount: 10
  };
}

function validate(spec) {
  if (!spec.make) return "Enter the make.";
  if (!spec.model) return "Enter the model.";
  if (!spec.zip || spec.zip.length < 5) return "Enter a 5-digit search ZIP.";
  return null;
}

function ratingLabel(r) {
  return ({ GREAT_PRICE: "Great", GOOD_PRICE: "Good", FAIR_PRICE: "Fair", HIGH_PRICE: "High", OVERPRICED: "Over" })[r] || "—";
}

// --- Comp selection & client-side re-pricing -------------------------------
// Each comp row has a checkbox; Market IMV / Good / Great and the deal math are
// computed from ONLY the checked comps, so an appraiser can drop a higher-trim
// or outlier listing that would skew the value. Mirrors the server-side
// computePricing so the numbers match when the same comps are selected.
let currentComps = [];
let currentSpec = null;
let selectedKeys = new Set();

const RATING_RANK_P = { GREAT_PRICE: 5, GOOD_PRICE: 4, FAIR_PRICE: 3, HIGH_PRICE: 2, OVERPRICED: 1 };
const RATING_LABEL_P = {
  GREAT_PRICE: "Great Deal", GOOD_PRICE: "Good Deal", FAIR_PRICE: "Fair Deal",
  HIGH_PRICE: "High Priced", OVERPRICED: "Overpriced",
  NO_PRICE_ANALYSIS: "No Analysis", NO_ANALYSIS: "No Analysis", UNCERTAIN: "No Analysis"
};
const medP = (nums) => {
  const a = nums.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function computePricingLocal(comps) {
  const withImv = comps.filter((c) => Number.isFinite(c.expectedPrice) && c.expectedPrice > 0);
  const prices = comps.map((c) => c.price).filter(Number.isFinite);
  const subjectImv = medP(withImv.map((c) => c.expectedPrice)) || medP(prices);

  const ratioByRating = {};
  for (const c of withImv) {
    if (!RATING_RANK_P[c.dealRating]) continue;
    (ratioByRating[c.dealRating] = ratioByRating[c.dealRating] || []).push(c.price / c.expectedPrice);
  }
  const ceilRatio = (r) => { const arr = ratioByRating[r]; return arr && arr.length ? Math.max(...arr) : null; };
  let greatRatio = ceilRatio("GREAT_PRICE");
  let goodRatio = ceilRatio("GOOD_PRICE");
  if (goodRatio == null && greatRatio != null) goodRatio = greatRatio;
  if (greatRatio == null) greatRatio = 0.94;
  if (goodRatio == null) goodRatio = 0.98;

  const doms = comps.map((c) => c.daysOnMarket).filter(Number.isFinite);
  return {
    subjectImv: subjectImv ? Math.round(subjectImv) : null,
    goodDealPrice: subjectImv ? Math.round(subjectImv * goodRatio) : null,
    greatDealPrice: subjectImv ? Math.round(subjectImv * greatRatio) : null,
    medianDaysOnMarket: doms.length ? Math.round(medP(doms)) : null,
    medianAsking: medP(prices),
    lowAsking: prices.length ? Math.min(...prices) : null,
    highAsking: prices.length ? Math.max(...prices) : null,
    ratingCounts: comps.reduce((m, c) => { const l = RATING_LABEL_P[c.dealRating] || "No Analysis"; m[l] = (m[l] || 0) + 1; return m; }, {}),
    basis: withImv.length
  };
}

function selectedComps() {
  return currentComps.filter((c) => selectedKeys.has(c._key));
}

function syncSelAll() {
  const selAll = $("selAll");
  if (!selAll) return;
  const total = currentComps.length;
  const n = selectedKeys.size;
  selAll.checked = total > 0 && n === total;
  selAll.indeterminate = n > 0 && n < total;
}

// Recompute pricing + chips + deal math from the checked comps. resetAcv=true
// on a fresh search seeds ACV to the Good-Deal buy; false keeps the user's ACV.
function applySelection(resetAcv) {
  const sel = selectedComps();
  syncSelAll();
  const note = $("selnote");
  if (!sel.length) {
    currentPricing = null;
    renderChips(null);
    if (note) note.innerHTML = "<b>No comps selected.</b> Check at least one row to price this car.";
    renderDealMath();
    return;
  }
  currentPricing = computePricingLocal(sel);
  renderChips(currentPricing);
  if (note) note.innerHTML = "Pricing from <b>" + sel.length + "</b> of <b>" + currentComps.length + "</b> selected comps.";
  // Re-seed the ACV to the Good-Deal buy on a fresh search, and on any selection
  // change UNLESS the user has typed/jumped their own ACV (then keep theirs).
  if (resetAcv) acvUserEdited = false;
  if ((resetAcv || !acvUserEdited) && Number.isFinite(currentPricing.goodDealPrice)) {
    const costs = num($("recon").value) + num($("dealerFee").value) + num($("titleFee").value) + num($("targetGross").value);
    $("acv").value = Math.max(0, Math.round(currentPricing.goodDealPrice - costs)).toLocaleString("en-US");
  }
  renderDealMath();
}

// Top summary chips (Market IMV, comp asking range, median ask, AVG DOL).
function renderChips(p) {
  const el = $("chips");
  if (!el) return;
  if (!p || !Number.isFinite(p.subjectImv)) { el.innerHTML = ""; return; }
  const dol = Number.isFinite(p.medianDaysOnMarket) ? String(p.medianDaysOnMarket) : "—";
  el.innerHTML =
    "<span class='chip' title='CarGurus market value'>Market (IMV) <b>" + fmt$(p.subjectImv) + "</b></span>" +
    "<span class='chip'>Comps asking <b>" + fmt$(p.lowAsking) + "–" + fmt$(p.highAsking) + "</b></span>" +
    "<span class='chip' title='Median comp asking price'>Median ask <b>" + fmt$(p.medianAsking) + "</b></span>" +
    "<span class='chip' title='Average Days On Lot'>AVG DOL <b>" + dol + "</b></span>";
}

// Inventory Plus market panel (target price, sold/mo, days-to-turn).
function renderIpx() {
  const el = $("ipx");
  if (!el) return;
  const x = subjectExtra || {};
  if (!(x.target || x.turn || x.volume)) { el.hidden = true; return; }
  el.hidden = false;
  const tgt = (x.target && !/^\s*(n\/?a|—|-)\s*$/i.test(x.target)) ? x.target : null;
  const mkt = x.market ? " <span class='src'>· " + esc(x.market) + "</span>" : "";
  el.innerHTML =
    "<div class='ipx-h'>From Inventory Plus" + mkt + "</div>" +
    "<div class='ipx-grid'>" +
      "<div class='ipx-stat'><div class='ipx-v" + (tgt ? "" : " empty") + "'>" + (tgt ? esc(tgt) : "—") + "</div>" +
        "<div class='ipx-k'>Inventory+ Target" + (tgt ? "" : "<span>not set · rare car</span>") + "</div></div>" +
      "<div class='ipx-stat'><div class='ipx-v'>" + esc(x.volume || "—") + "<span class='u'>/mo</span></div><div class='ipx-k'>Sold in market</div></div>" +
      "<div class='ipx-stat'><div class='ipx-v'>" + esc(x.turn || "—") + "<span class='u'> days</span></div><div class='ipx-k'>Avg to turn</div></div>" +
    "</div>";
}

function render(result, spec) {
  $("loading").hidden = true;
  $("err").hidden = true;

  if (!result || !result.ok) {
    const err = $("err");
    err.textContent = (result && result.error) || "Search failed.";
    err.hidden = false;
    $("results").hidden = true;
    $("empty").hidden = true;
    return;
  }

  const { comps, counts, widenNotes = [], usedRadius } = result;

  if (!comps.length) {
    $("results").hidden = true;
    const empty = $("empty");
    empty.innerHTML =
      "<b>No matching comps found.</b><br>" +
      "Fetched " + counts.rawFetched + " " + spec.make +
      " listings out to " + (usedRadius || spec.radius) + " mi, but none matched <b>" +
      [spec.model, spec.trim].filter(Boolean).join(" ") + "</b>" +
      ".<br>Try a bigger radius, or uncheck “Match trim”.";
    empty.hidden = false;
    return;
  }

  $("empty").hidden = true;
  $("results").hidden = false;

  // Key each comp and pick the default selection. Mirror the server's pricing
  // basis: with >=3 exact comps, start with only the exact ones checked (widened
  // rows unchecked) so the headline value isn't skewed by other trims.
  currentComps = comps.map((c, i) => Object.assign(c, { _key: "i" + i }));
  currentSpec = spec;
  const exactCount = currentComps.filter((c) => c.exact).length;
  const initialSel = exactCount >= 3 ? currentComps.filter((c) => c.exact) : currentComps;
  selectedKeys = new Set(initialSel.map((c) => c._key));

  // Match line (describes the found set; live pricing details live in #selnote)
  const widened = comps.length - counts.exact;
  $("matchline").innerHTML =
    "<b>" + comps.length + "</b> comps found — <b>" + counts.exact + "</b> exact" +
    (widened > 0 ? " + <b>" + widened + "</b> widened (" + esc(widenNotes.join(", ")) + ")" : "") +
    "<br><span class='hint'>Tip: uncheck any row (e.g. a higher trim) to drop it from the pricing above.</span>";

  // Table
  const tb = $("compTable").querySelector("tbody");
  tb.innerHTML = "";
  for (const c of currentComps) {
    const checked = selectedKeys.has(c._key);
    const tr = document.createElement("tr");
    tr.className = (c.exact ? "" : "widened") + (checked ? "" : " excluded");
    const tag = c.exact ? "" : " <span class='wtag' title='Widened to reach 10 comps'>≈</span>";
    tr.innerHTML =
      "<td class='use'><input type='checkbox' class='rowsel' data-key='" + c._key + "'" + (checked ? " checked" : "") + " aria-label='Include this comp in pricing' /></td>" +
      "<td>" + c.year + tag + " " + esc(c.model) + "<div class='trim'>" + esc(c.trim || "—") + "</div></td>" +
      "<td class='num'>" + fmtN(c.mileage) + "</td>" +
      "<td class='num'>" + fmt$(c.price) + "</td>" +
      "<td class='num'>" + fmt$(c.expectedPrice) + "</td>" +
      "<td><span class='rating " + (c.dealRating || "") + "'>" + ratingLabel(c.dealRating) + "</span></td>" +
      "<td class='num'>" + (Number.isFinite(c.daysOnMarket) ? c.daysOnMarket : "—") + "</td>" +
      "<td class='num'>" + (Number.isFinite(c.distance) ? c.distance + " mi" : "—") + "</td>" +
      "<td>" + (c.url ? "<a href='" + c.url + "' target='_blank' rel='noopener'>" + esc(c.dealer || c.city || "view") + "</a>" : esc(c.dealer || c.city || "—")) + "</td>";
    tb.appendChild(tr);
  }

  // Wire per-row checkboxes + the header select-all.
  tb.querySelectorAll(".rowsel").forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.getAttribute("data-key");
      if (cb.checked) selectedKeys.add(key); else selectedKeys.delete(key);
      const tr = cb.closest("tr");
      if (tr) tr.classList.toggle("excluded", !cb.checked);
      applySelection(false);
    });
  });
  const selAll = $("selAll");
  if (selAll) {
    selAll.onchange = () => {
      const on = selAll.checked;
      selectedKeys = new Set(on ? currentComps.map((c) => c._key) : []);
      tb.querySelectorAll(".rowsel").forEach((cb) => {
        cb.checked = on;
        const tr = cb.closest("tr");
        if (tr) tr.classList.toggle("excluded", !on);
      });
      applySelection(false);
    };
  }

  // Competition / market supply line
  renderMarket(result);
  // Inventory Plus market panel (from the page read)
  renderIpx();

  // Chips + deal math from the current selection; seed ACV to the Good-Deal buy.
  applySelection(true);
}

function renderMarket(result) {
  const el = $("market");
  const comp = result.competition;
  const buckets = result.distanceBuckets || [];
  if (!comp) { el.innerHTML = ""; return; }
  const widened = result.usedRadius > comp.radius;
  el.innerHTML =
    "<b>Competition:</b> " + comp.withinRadius + " comparable unit" + (comp.withinRadius === 1 ? "" : "s") +
    " for sale within " + comp.radius + " mi" +
    (widened ? " · expanded to <b>" + result.usedRadius + " mi</b> to reach " + result.counts.used + " comps" : "") +
    (buckets.length ? "<br><span class='buckets'>" + buckets.map((b) => b.mi + " mi: <b>" + b.count + "</b>").join(" · ") + "</span>" : "");
}

const acvVal = () => num($("acv").value);

// The ACV build-up: from the ACV you type, add costs + gross to get the retail
// price, classify its estimated CarGurus tier, and draw the ladder / bar / receipt.
function renderDealMath() {
  // Remind the user to set store fees (they are $0 until entered).
  const warn = $("feeWarn");
  if (warn) {
    const missing = [];
    if (!$("dealerFee").value.trim()) missing.push("dealer fee");
    if (!$("titleFee").value.trim()) missing.push("title fee");
    if (missing.length) {
      warn.textContent = "⚠ Your " + missing.join(" and ") + " " + (missing.length > 1 ? "are" : "is") +
        " blank ($0). Set " + (missing.length > 1 ? "them" : "it") + " here or in Settings — saved once, they stick.";
      warn.hidden = false;
    } else { warn.hidden = true; }
  }

  const badge = $("tier"), saleOut = $("saleOut");
  const p = currentPricing;
  if (!p || !Number.isFinite(p.subjectImv)) {
    if (badge) { badge.textContent = "—"; badge.style.removeProperty("--tc"); }
    if (saleOut) saleOut.textContent = "—";
    $("buildBar").innerHTML = ""; $("receipt").innerHTML = "";
    $("ladderBar").innerHTML = ""; $("markerVal").textContent = "—";
    $("tickLo").textContent = ""; $("tickHi").textContent = "";
    return;
  }

  const recon = num($("recon").value), dealer = num($("dealerFee").value),
        title = num($("titleFee").value), gross = num($("targetGross").value);
  const acv = acvVal();
  const sale = acv + recon + title + dealer + gross;

  const imv = p.subjectImv;
  const greatCeil = Number.isFinite(p.greatDealPrice) ? p.greatDealPrice : Math.round(imv * 0.94);
  const goodCeil = Number.isFinite(p.goodDealPrice) ? p.goodDealPrice : Math.round(imv * 0.98);
  const fairCeil = Math.round(imv * 1.05), highCeil = Math.round(imv * 1.10);
  const LMIN = Math.round(imv * 0.80), LMAX = Math.round(imv * 1.15);
  const span = Math.max(1, LMAX - LMIN);

  // estimated tier of the resulting retail price
  const tier = sale <= greatCeil ? "great" : sale <= goodCeil ? "good" :
               sale <= fairCeil ? "fair" : sale <= highCeil ? "high" : "over";
  const TIER = { great: ["Great Deal", "var(--great)"], good: ["Good Deal", "var(--good)"],
                 fair: ["Fair Deal", "var(--fair)"], high: ["High Priced", "var(--high)"],
                 over: ["Overpriced", "var(--over)"] };
  badge.textContent = TIER[tier][0];
  badge.style.setProperty("--tc", TIER[tier][1]);
  saleOut.textContent = fmt$(sale);

  // price ladder
  const segs = [["Great", LMIN, greatCeil, "var(--great)"], ["Good", greatCeil, goodCeil, "var(--good)"],
                ["Fair", goodCeil, fairCeil, "var(--fair)"], ["High", fairCeil, highCeil, "var(--high)"],
                ["Over", highCeil, LMAX, "var(--over)"]];
  $("ladderBar").innerHTML = segs.map(([lab, lo, hi, col]) => {
    const w = Math.max(0, (hi - lo) / span * 100);
    return "<div class='seg' style='width:" + w + "%;background:" + col + "'>" + (w > 9 ? lab : "") + "</div>";
  }).join("");
  $("tickLo").textContent = fmt$(LMIN); $("tickHi").textContent = fmt$(LMAX);
  const pct = Math.max(0, Math.min(100, (sale - LMIN) / span * 100));
  $("marker").style.left = pct + "%"; $("markerVal").textContent = fmt$(sale);

  // build-up bar (proportions of the retail price)
  const denom = sale > 0 ? sale : 1;
  const parts = [["var(--acv)", acv, "ACV"], ["#c07f2e", recon, "Recon"], ["#9a6b3a", title, "Title"],
                 ["#7a684a", dealer, "Fee"], ["var(--profit)", gross, "Profit"]];
  $("buildBar").innerHTML = parts.map(([col, v, lab]) => {
    const w = Math.max(0, v) / denom * 100;
    return "<span style='width:" + w + "%;background:" + col + "'>" + (w > 11 ? fmt$(v) : (w > 6 ? lab : "")) + "</span>";
  }).join("");

  // receipt
  $("receipt").innerHTML =
    "<div class='dm-row acv'><div class='k'><span class='dot' style='background:var(--acv)'></span>ACV <small>into the car</small></div><div class='v'>" + fmt$(acv) + "</div></div>" +
    "<div class='dm-row cost'><div class='k'><span class='dot' style='background:#c07f2e'></span>Reconditioning</div><div class='v'><span class='plus'>+</span>" + fmt$(recon) + "</div></div>" +
    "<div class='dm-row cost'><div class='k'><span class='dot' style='background:#9a6b3a'></span>Title fee</div><div class='v'><span class='plus'>+</span>" + fmt$(title) + "</div></div>" +
    "<div class='dm-row cost'><div class='k'><span class='dot' style='background:#7a684a'></span>Dealer / doc fee</div><div class='v'><span class='plus'>+</span>" + fmt$(dealer) + "</div></div>" +
    "<div class='dm-row profit'><div class='k'><span class='dot' style='background:var(--profit)'></span>Front-end gross <small>profit</small></div><div class='v'><span class='plus'>+</span>" + fmt$(gross) + "</div></div>" +
    "<div class='dm-row total'><div class='k'>Retail sale price</div><div class='v'>" + fmt$(sale) + "</div></div>";

  // quick-jump button sublabels
  if ($("qGreat")) $("qGreat").textContent = "list " + fmt$(greatCeil);
  if ($("qGood")) $("qGood").textContent = "list " + fmt$(goodCeil);
  if ($("qMarket")) $("qMarket").textContent = "list " + fmt$(imv);
}

function num(v) { const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10); return Number.isFinite(n) ? n : 0; }

function card(k, v, sub, cls) {
  return "<div class='card " + (cls || "") + "'><div class='k'>" + esc(k) + "</div><div class='v'>" + esc(v) + "</div><div class='sub'>" + esc(sub || "") + "</div></div>";
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------------------------------------------------------------------------
// Search orchestration — run entirely from the panel (a persistent page), NOT
// the background service worker. Chrome can suspend the worker mid-search and
// drop its reply, which left the panel spinning forever. The panel isn't
// suspended, and every step reports a live stage so a stall is visible.
// ---------------------------------------------------------------------------
const CG_START_URL = "https://www.cargurus.com/Cars/spt-used-cars";

// Update the spinner's label so the user (and a screenshot) can see the stage.
function showStage(msg) {
  $("err").hidden = true;
  $("results").hidden = true;
  $("empty").hidden = true;
  const l = $("loading");
  l.hidden = false;
  const span = l.querySelector("span");
  if (span) span.textContent = msg || "Searching CarGurus…";
}

function pingCG(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      chrome.tabs.sendMessage(tabId, { type: "PING_CG" }, (resp) => {
        void chrome.runtime.lastError; // swallow "no receiver"
        finish(!!(resp && resp.ok));
      });
    } catch (e) { finish(false); }
    setTimeout(() => finish(false), 800);
  });
}

async function waitForCG(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingCG(tabId)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureCarGurusTab(stage) {
  stage("Looking for a CarGurus tab…");
  const tabs = await chrome.tabs.query({ url: "https://*.cargurus.com/*" });
  let tab = tabs.find((t) => t.status === "complete") || tabs[0] || null;
  let created = false;
  if (!tab) {
    stage("Opening CarGurus in the background…");
    tab = await chrome.tabs.create({ url: CG_START_URL, active: false });
    created = true;
  }

  stage("Waiting for CarGurus to load…");
  let ready = await waitForCG(tab.id, created ? 25000 : 4000);

  if (!ready) {
    stage("Preparing CarGurus…");
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["cargurus-makes.js", "content-cargurus.js"] });
      ready = await waitForCG(tab.id, 5000);
    } catch (e) { /* ignore */ }
  }
  if (!ready) {
    stage("Reloading CarGurus…");
    try {
      await chrome.tabs.reload(tab.id);
      ready = await waitForCG(tab.id, 25000);
    } catch (e) { /* ignore */ }
  }
  if (!ready) {
    // Bring the CarGurus tab to the front so the user can see/clear a CAPTCHA.
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) { /* ignore */ }
    throw new Error("Couldn't reach CarGurus. I brought the CarGurus tab to the front — if it's showing a “verify you're human”/CAPTCHA page, clear it, come back here, and click Find comps again.");
  }
  return tab.id;
}

function runSearchOnTab(tabId, spec) {
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("CarGurus took over 2 minutes to answer. It may be showing a verification page — open cargurus.com, clear it, then retry."));
    }, 120000);
    try {
      chrome.tabs.sendMessage(tabId, { type: "RUN_SEARCH", spec }, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error("Lost contact with the CarGurus tab: " + err.message));
        resolve(resp || { ok: false, error: "No response from the CarGurus tab." });
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(to); reject(e); }
    }
  });
}

async function searchComps(spec, stage) {
  const tabId = await ensureCarGurusTab(stage);
  stage("Searching CarGurus…");
  const result = await runSearchOnTab(tabId, spec);
  try { await chrome.storage.local.set({ lastResult: result, lastSpec: spec, lastRun: Date.now() }); } catch (e) { /* ignore */ }
  return result;
}

async function findComps() {
  const spec = gatherSpec();
  const problem = validate(spec);
  if (problem) { const e = $("err"); e.textContent = problem; e.hidden = false; return; }
  $("err").hidden = true;

  // persist settings
  await chrome.storage.local.set({
    settings: Object.assign((await chrome.storage.local.get("settings")).settings || {}, {
      zip: spec.zip, radius: String(spec.radius),
      strictTrim: $("strictTrim").checked, includeDelivery: $("includeDelivery").checked
    })
  });

  $("findBtn").disabled = true;
  showStage("Starting…");
  try {
    const result = await searchComps(spec, showStage);
    render(result, spec);
  } catch (e) {
    render({ ok: false, error: String((e && e.message) || e) }, spec);
  } finally {
    $("findBtn").disabled = false;
  }
}

async function printComps() {
  const spec = gatherSpec();
  const problem = validate(spec);
  if (problem) { const e = $("err"); e.textContent = problem; e.hidden = false; return; }
  $("err").hidden = true;

  const btn = $("printBtn");
  const status = $("printStatus");
  btn.disabled = true;

  // Force a 500-mi search and a big pool so we surface the truly cheapest comps.
  const printSpec = Object.assign({}, spec, { radius: 500, targetCount: 40 });

  try {
    const result = await searchComps(printSpec, (m) => { status.textContent = m; });
    if (!result || !result.ok) { status.textContent = (result && result.error) || "Search failed."; return; }
    const cheapest = (result.cheapest || []).slice(0, 24);
    if (!cheapest.length) { status.textContent = "No comparable listings found."; return; }
    await chrome.storage.local.set({
      printData: {
        subject: { year: spec.year, make: spec.make, model: spec.model, trim: spec.trim, mileage: spec.mileage },
        zip: spec.zip,
        radius: 500,
        comps: cheapest,
        theme: document.documentElement.getAttribute("data-theme") || "auto"
      }
    });
    status.textContent = "Opening printable page…";
    chrome.tabs.create({ url: chrome.runtime.getURL("print.html") });
    setTimeout(() => { status.textContent = ""; }, 2500);
  } catch (e) {
    status.textContent = String((e && e.message) || e);
  } finally {
    btn.disabled = false;
  }
}

async function persistDealDefaults() {
  const cur = (await chrome.storage.local.get("settings")).settings || {};
  await chrome.storage.local.set({
    settings: Object.assign(cur, {
      dealerFee: $("dealerFee").value.replace(/[^\d]/g, ""),
      titleFee: $("titleFee").value.replace(/[^\d]/g, ""),
      targetGross: num($("targetGross").value)
    })
  });
}

(async function init() {
  currentSettings = await loadDefaults();
  setupMileageSlider();
  await readActiveTab(currentSettings);
  $("findBtn").addEventListener("click", findComps);
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("themeBtn").addEventListener("click", cycleTheme);
  $("printBtn").addEventListener("click", printComps);
  $("readBtn").addEventListener("click", () => readActiveTab(currentSettings || DEFAULTS, { manual: true }));
  // Editing the subject mileage recenters the range window (±15k default).
  $("mileage").addEventListener("change", () => centerMileageWindow($("mileage").value));

  // Deal-math build-up: ACV is editable; quick buttons jump ACV to a rating.
  // Typing or jumping marks ACV as user-set so comp toggles won't overwrite it.
  $("acv").addEventListener("input", () => { acvUserEdited = true; renderDealMath(); });
  $("acv").addEventListener("blur", () => { $("acv").value = acvVal().toLocaleString("en-US"); });
  $("quick").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !currentPricing) return;
    const map = { great: currentPricing.greatDealPrice, good: currentPricing.goodDealPrice, market: currentPricing.subjectImv };
    const target = map[b.dataset.k];
    if (!Number.isFinite(target)) return;
    const costs = num($("recon").value) + num($("dealerFee").value) + num($("titleFee").value) + num($("targetGross").value);
    $("acv").value = Math.max(0, Math.round(target - costs)).toLocaleString("en-US");
    acvUserEdited = true;
    renderDealMath();
  });

  // Deal math recomputes live; fee/title/target are saved as store defaults.
  ["recon", "dealerFee", "titleFee", "targetGross"].forEach((id) => {
    $(id).addEventListener("input", () => {
      renderDealMath();
      if (id !== "recon") persistDealDefaults();
    });
  });
})();
