// popup.js — reads the subject vehicle from the active tab, runs the CarGurus
// search via the background worker, and renders the comps dashboard.

const $ = (id) => document.getElementById(id);
const fmt$ = (n) => (Number.isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "—");
const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
// A big radius means the "Nationwide" option; show that instead of "5000 mi".
const NATIONWIDE_MI = 5000;
const radLabel = (mi) => (Number(mi) >= NATIONWIDE_MI ? "nationwide" : mi + " mi");

const DEFAULTS = {
  zip: "", radius: "100", variance: 15000, strictTrim: true, includeDelivery: true, selectors: {},
  dealerFee: "", titleFee: "", targetGross: 2500, reconDefault: 2500, theme: "auto",
  // Gross-profit rule: a floor plus a margin (% of retail) by retail-price band.
  // Editable per store in Settings.
  minGross: 2000, margin30: 10, margin50: 8, margin80: 7
};

// Front-end gross rule. Margin is a percent of the retail (sale) price; the band
// is chosen by that retail price, with a hard dollar floor under every deal.
function minGrossOf(s) { return Number.isFinite(s && s.minGross) ? s.minGross : 2000; }
function marginPctFor(retail, s) {
  s = s || {};
  if (retail >= 80000) return Number.isFinite(s.margin80) ? s.margin80 : 7;
  if (retail >= 50000) return Number.isFinite(s.margin50) ? s.margin50 : 8;
  if (retail >= 30000) return Number.isFinite(s.margin30) ? s.margin30 : 10;
  return 0; // under $30k: just the dollar floor
}
// Suggested gross for a KNOWN retail price (gross = margin% × retail, floored).
function grossForRetail(retail, s) {
  const m = marginPctFor(retail, s) / 100;
  const g = m > 0 ? Math.round(retail * m) : 0;
  return Math.max(minGrossOf(s), g);
}
// Suggested gross from the cost basis (ACV + recon + title + dealer), where the
// retail price = costBasis + gross. Solved by a few fixed-point passes so the
// band is chosen consistently with the resulting retail.
function ruleGross(costBasis, s) {
  let gross = minGrossOf(s);
  for (let i = 0; i < 3; i++) {
    const retail = costBasis + gross;
    const m = marginPctFor(retail, s) / 100;
    gross = m > 0 ? Math.max(minGrossOf(s), Math.round(costBasis * m / (1 - m))) : minGrossOf(s);
  }
  return gross;
}

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
// True once the user types their own front-end gross, so the margin rule stops
// auto-filling it. Reset on each new search.
let grossUserEdited = false;
// Inventory Plus market data (TrueScore Market + TrueTarget) read off the page.
let subjectExtra = null;
// The last search result (comps + competition + fallback flags), for the
// market-speed, confidence, and buy-to-hit widgets.
let currentResult = null;
// Listings sitting this long are aspirational (overpriced) anchors; the user can
// drop them from pricing with a toggle.
const STALE_DAYS = 90;
let excludeStale = false;
const isStale = (c) => Number.isFinite(c.daysOnMarket) && c.daysOnMarket >= STALE_DAYS;
// Raw listings scanned on the last search (shown in the match line).
let lastScanned = 0;

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
                target: "", turn: "", volume: "", market: "", recon: "", source: "none", candidates: [] };

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

  // 3) Mileage. A number is either comma-grouped ("12,345") or a plain 2-6 digit
  // run ("885", "12345") — the plain form MUST allow 2-3 digits so a nearly-new
  // car's 3-digit odometer (e.g. 885) is read instead of falling through to a
  // stray graph-axis number like "2,000". Prefer the labeled "Odometer:" /
  // "Mileage:" value; only then fall back to a loose "N mi" match.
  const body = document.body ? document.body.innerText : "";
  const MI = "(\\d{1,3}(?:,\\d{3})+|\\d{2,6})";
  let m = body.match(new RegExp("odometer[^\\d]{0,10}" + MI, "i"));
  if (!m) m = body.match(new RegExp("mileage[^\\d]{0,10}" + MI, "i"));
  if (!m) m = body.match(new RegExp(MI + "\\s*(?:mi\\b|miles\\b)", "i"));
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

  // 6) Reconditioning $ from the Inventory Plus "Calculations" screen. Match the
  // exact "Reconditioning" field (not "Recondition Est"/"Recondition") and read
  // the dollar value from that row's input (or the nearest number beside it).
  try {
    const parseDollar = (s) => {
      const mt = String(s || "").match(/\$?\s*([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/);
      return mt ? mt[1].replace(/[^\d.]/g, "") : "";
    };
    const rowValue = (el) => {
      // Climb to the smallest ancestor that holds an <input>, and read it.
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        const inp = node.querySelector && node.querySelector("input");
        if (inp) { const d = parseDollar(inp.value); if (d) return d; }
        node = node.parentElement;
      }
      // Otherwise scan the following siblings for an input or a bare number.
      let sib = el.nextElementSibling;
      for (let i = 0; i < 4 && sib; i++) {
        const inp = sib.querySelector ? sib.querySelector("input") : null;
        if (inp) { const d = parseDollar(inp.value); if (d) return d; }
        const d = parseDollar(sib.textContent);
        if (d) return d;
        sib = sib.nextElementSibling;
      }
      return "";
    };
    const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z]/g, "");
    const cands = Array.from(document.querySelectorAll("label,span,div,td,th,p,strong,b"));
    for (const el of cands) {
      // Only the element's OWN direct text, so a big wrapper doesn't match.
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
      if (norm(own) !== "reconditioning") continue;
      const d = rowValue(el);
      if (d) { out.recon = d; break; }
    }
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
  $("targetGross").value = minGrossOf(s); // starting value; the margin rule fills it once comps load
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
                target: "", turn: "", volume: "", market: "", recon: "", source: "none" };
    for (const r of (results || [])) {
      const o = r && r.result;
      if (!o) continue;
      ["year", "make", "model", "trim", "mileage", "bodyStyle", "target", "turn", "volume", "market", "recon"].forEach((k) => {
        if (!v[k] && o[k]) v[k] = o[k];
      });
      if (v.source === "none" && o.source && o.source !== "none") v.source = o.source;
    }
    subjectExtra = { target: v.target, turn: v.turn, volume: v.volume, market: v.market, recon: v.recon };

    if (v.year) $("year").value = v.year;
    if (v.make) $("make").value = v.make;
    if (v.model) $("model").value = v.model;
    if (v.trim) $("trim").value = v.trim;
    if (v.mileage) $("mileage").value = v.mileage;
    $("bodyStyle").value = v.bodyStyle || "any";
    centerMileageWindow($("mileage").value);

    // Reconditioning: carry over the Inventory Plus number when there's real
    // money there; otherwise fall back to the store's default recon.
    const pageRecon = parseInt(String(v.recon).replace(/[^\d]/g, ""), 10);
    const defRecon = Number.isFinite(settings.reconDefault) ? settings.reconDefault : 2500;
    $("recon").value = Number.isFinite(pageRecon) && pageRecon > 0 ? pageRecon : defRecon;

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
let subjectTrim = "";

const normTrim = (s) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const DOOR_WORDS = new Set(["2", "4", "door", "dr", "2dr", "4dr", "2door", "4door", "wd", "4wd", "2wd", "awd", "rwd", "fwd"]);

// Keys of comps for a chosen trim value ("*ALL*" = all fuzzy-matching trims).
// preferExact tightens to same-trim comps that also matched year/mileage/distance.
function trimToKeys(v, preferExact) {
  let base;
  if (v === "*ALL*") {
    base = currentComps.filter((c) => c.trimMatched);
    if (!base.length) base = currentComps.slice();
  } else {
    base = currentComps.filter((c) => normTrim(c.trim) === v);
  }
  if (preferExact) {
    const ex = base.filter((c) => c.exact);
    if (ex.length >= 3) base = ex;
  }
  // Drop stale (long-sitting) listings from the priced set when the toggle is on,
  // but never leave the selection empty.
  if (excludeStale) {
    const fresh = base.filter((c) => !isStale(c));
    if (fresh.length) base = fresh;
  }
  return new Set(base.map((c) => c._key));
}

// Smart default trim: among trims that fuzzy-match the subject, prefer the one
// with the fewest extra qualifier tokens (so "Rubicon 4-Door" beats "Rubicon
// 392" / "Rubicon X"), then the most common.
function chooseDefaultTrim(entries) {
  const subj = normTrim(subjectTrim).split(" ").filter(Boolean);
  const matched = entries.filter(([, e]) => e.matched);
  // Nothing actually matched the subject trim — don't silently commit to a
  // random most-common trim (e.g. price a "450h+ Luxury" off "350 AWD"). Show
  // all trims so the mix is visible and the trim warning is honest.
  if (!matched.length) return "*ALL*";
  const pool = matched;
  let best = "*ALL*", bestScore = Infinity;
  for (const [key, e] of pool) {
    const extras = key.split(" ").filter(Boolean).filter((t) => !subj.includes(t) && !DOOR_WORDS.has(t)).length;
    const score = extras * 1000 - e.count; // fewest extras, then most common
    if (score < bestScore) { bestScore = score; best = key; }
  }
  return best;
}

// Build the trim-filter <select> from the comps; returns the default value and
// hides the control when there's only one trim (nothing to choose).
function populateTrimFilter() {
  const wrap = $("trimFilterWrap"), sel = $("trimFilter");
  if (!sel) return "*ALL*";
  const map = new Map();
  for (const c of currentComps) {
    const key = normTrim(c.trim || "");
    if (!key) continue;
    const e = map.get(key) || { name: (c.trim || "").trim(), count: 0, matched: false };
    e.count++;
    if (c.trimMatched) e.matched = true;
    map.set(key, e);
  }
  const entries = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  const def = chooseDefaultTrim(entries);
  const allCount = currentComps.filter((c) => c.trimMatched).length || currentComps.length;
  let html = "<option value='*ALL*'>All matching trims (" + allCount + ")</option>";
  for (const [key, e] of entries) {
    html += "<option value='" + esc(key) + "'>" + esc(e.name) + " (" + e.count + ")</option>";
  }
  sel.innerHTML = html;
  sel.value = def;
  if (wrap) wrap.hidden = entries.length <= 1;
  return def;
}

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

// Ordinary-least-squares slope/intercept for y = slope·x + intercept.
function linFit(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const d = n * sxx - sx * sx;
  if (!d) return null;
  const slope = (n * sxy - sx * sy) / d;
  return { slope, intercept: (sy - slope * sx) / n };
}

function computePricingLocal(comps, subjMiles) {
  const withImv = comps.filter((c) => Number.isFinite(c.expectedPrice) && c.expectedPrice > 0);
  const prices = comps.map((c) => c.price).filter(Number.isFinite);
  const rawImv = medP(withImv.map((c) => c.expectedPrice)) || medP(prices);

  // Mileage-adjust the market value to THIS car's odometer: fit price-vs-mileage
  // across the comps and shift the median by the subject's distance from the
  // comps' median mileage. Guarded — needs ≥5 comps, a real (negative) slope,
  // and a clamp so a thin/odd sample can't swing it wildly.
  let subjectImv = rawImv, mileageAdjusted = false, perMile = null;
  const milePts = comps
    .filter((c) => Number.isFinite(c.mileage) && c.mileage > 0)
    .map((c) => ({ x: c.mileage, y: (Number.isFinite(c.expectedPrice) && c.expectedPrice > 0) ? c.expectedPrice : c.price }))
    .filter((p) => Number.isFinite(p.y) && p.y > 0);
  if (rawImv && Number.isFinite(subjMiles) && subjMiles > 0 && milePts.length >= 5) {
    const fit = linFit(milePts);
    const midMiles = medP(milePts.map((p) => p.x));
    if (fit && fit.slope < 0 && Number.isFinite(midMiles)) {
      let adj = rawImv + fit.slope * (subjMiles - midMiles);
      adj = Math.max(rawImv * 0.85, Math.min(rawImv * 1.15, adj)); // clamp ±15%
      subjectImv = Math.round(adj);
      mileageAdjusted = Math.abs(subjectImv - rawImv) >= 250; // only flag a meaningful shift
      perMile = fit.slope;
    }
  }

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
    rawImv: rawImv ? Math.round(rawImv) : null,
    mileageAdjusted, perMile,
    goodDealPrice: subjectImv ? Math.round(subjectImv * goodRatio) : null,
    greatDealPrice: subjectImv ? Math.round(subjectImv * greatRatio) : null,
    medianDaysOnMarket: doms.length ? Math.round(medP(doms)) : null,
    medianAsking: medP(prices),
    lowAsking: prices.length ? Math.min(...prices) : null,
    highAsking: prices.length ? Math.max(...prices) : null,
    ratingCounts: comps.reduce((m, c) => { const l = RATING_LABEL_P[c.dealRating] || "No Analysis"; m[l] = (m[l] || 0) + 1; return m; }, {}),
    basis: withImv.length,
    n: comps.length
  };
}

function selectedComps() {
  return currentComps.filter((c) => selectedKeys.has(c._key));
}

function syncSelAll() {
  const selAll = $("selAll");
  if (!selAll) return;
  const list = displayedComps();
  const total = list.length;
  const n = list.filter((c) => selectedKeys.has(c._key)).length;
  selAll.checked = total > 0 && n === total;
  selAll.indeterminate = n > 0 && n < total;
}

// The comps shown in the table: only the trim chosen in the filter, so other
// trims (Rubicon 392 / X / 4xe) don't clutter the list. "*ALL*" shows all.
function displayedComps() {
  const v = ($("trimFilter") && $("trimFilter").value) || "*ALL*";
  if (v === "*ALL*") return currentComps;
  return currentComps.filter((c) => normTrim(c.trim) === v);
}

function renderCompTable() {
  const list = displayedComps();
  const tb = $("compTable").querySelector("tbody");
  tb.innerHTML = "";
  for (const c of list) {
    const checked = selectedKeys.has(c._key);
    const tr = document.createElement("tr");
    tr.className = (c.exact ? "" : "widened") + (checked ? "" : " excluded");
    const tag = c.exact ? "" : " <span class='wtag' title='Different year or mileage'>≈</span>";
    tr.innerHTML =
      "<td class='use'><input type='checkbox' class='rowsel' data-key='" + c._key + "'" + (checked ? " checked" : "") + " aria-label='Include this comp in pricing' /></td>" +
      "<td>" + c.year + tag + " " + esc(c.model) + "<div class='trim'>" + esc(c.trim || "—") + "</div></td>" +
      "<td class='num'>" + fmtN(c.mileage) + "</td>" +
      "<td class='num'>" + fmt$(c.price) + "</td>" +
      "<td class='num'>" + fmt$(c.expectedPrice) + "</td>" +
      "<td><span class='rating " + (c.dealRating || "") + "'>" + ratingLabel(c.dealRating) + "</span></td>" +
      "<td class='num'>" + (Number.isFinite(c.daysOnMarket)
        ? (isStale(c) ? "<span class='stale' title='On the market " + c.daysOnMarket + "+ days — likely overpriced'>" + c.daysOnMarket + "</span>" : c.daysOnMarket)
        : "—") + "</td>" +
      "<td class='num'>" + (Number.isFinite(c.distance) ? c.distance + " mi" : "—") + "</td>" +
      "<td>" + (c.url ? "<a href='" + c.url + "' target='_blank' rel='noopener'>" + esc(c.dealer || c.city || "view") + "</a>" : esc(c.dealer || c.city || "—")) + "</td>";
    tb.appendChild(tr);
  }
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
      const keys = displayedComps().map((c) => c._key);
      if (on) keys.forEach((k) => selectedKeys.add(k)); else keys.forEach((k) => selectedKeys.delete(k));
      renderCompTable();
      applySelection(false);
    };
  }
}

function updateMatchline() {
  const el = $("matchline");
  if (!el) return;
  const list = displayedComps();
  const v = ($("trimFilter") && $("trimFilter").value) || "*ALL*";
  const trimName = v === "*ALL*" ? "matching" : (list[0] ? (list[0].trim || "") : subjectTrim);
  el.innerHTML =
    "<b>" + list.length + "</b> " + esc(trimName) + " comp" + (list.length === 1 ? "" : "s") + " found" +
    (Number.isFinite(lastScanned) && lastScanned > 0 ? " · scanned " + lastScanned + " listings" : "") +
    "<br><span class='hint'>Uncheck any row to drop it; use the Priced trim menu above to switch trims.</span>";
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
  const subjMiles = currentSpec && Number.isFinite(currentSpec.mileage) ? currentSpec.mileage : num($("mileage").value);
  currentPricing = computePricingLocal(sel, subjMiles);
  renderChips(currentPricing);
  if (note) note.innerHTML = "Pricing from <b>" + sel.length + "</b> of <b>" + displayedComps().length + "</b> shown comps.";
  // Re-seed the ACV to the Good-Deal buy on a fresh search, and on any selection
  // change UNLESS the user has typed/jumped their own ACV (then keep theirs). The
  // gross for that retail comes from the store's margin rule.
  if (resetAcv) { acvUserEdited = false; grossUserEdited = false; }
  if ((resetAcv || !acvUserEdited) && Number.isFinite(currentPricing.goodDealPrice)) {
    const s = currentSettings || DEFAULTS;
    const retail = currentPricing.goodDealPrice;
    const feesExGross = num($("recon").value) + num($("dealerFee").value) + num($("titleFee").value);
    if (!grossUserEdited) $("targetGross").value = grossForRetail(retail, s);
    const gross = num($("targetGross").value);
    $("acv").value = Math.max(0, Math.round(retail - feesExGross - gross)).toLocaleString("en-US");
  }
  renderDealMath();
}

// How much to trust the number: based on how many comps priced it and whether
// the trim/year had to be widened. Returns {level, label, why}.
function pricingConfidence(p) {
  const n = p && Number.isFinite(p.n) ? p.n : 0;
  const fb = currentResult && (currentResult.trimFallback || currentResult.yearFallback);
  if (fb || n < 4) {
    return { level: "low", label: "Low", why: fb ? "priced off other trims/years" : "only " + n + " comp" + (n === 1 ? "" : "s") };
  }
  if (n >= 8) return { level: "high", label: "High", why: n + " comps" };
  return { level: "medium", label: "Medium", why: n + " comps" };
}

// Top summary chips (Market IMV, comp asking range, median ask, AVG DOL).
function renderChips(p) {
  const el = $("chips");
  if (!el) return;
  if (!p || !Number.isFinite(p.subjectImv)) { el.innerHTML = ""; return; }
  const dol = Number.isFinite(p.medianDaysOnMarket) ? String(p.medianDaysOnMarket) : "—";
  const conf = pricingConfidence(p);
  const imvTitle = p.mileageAdjusted
    ? "Adjusted to this car's mileage (raw market " + fmt$(p.rawImv) + ")"
    : "CarGurus market value";
  const imvTag = p.mileageAdjusted ? " <span class='chip-tag'>mi-adj</span>" : "";
  el.innerHTML =
    "<span class='chip' title='" + esc(imvTitle) + "'>Market (IMV) <b>" + fmt$(p.subjectImv) + "</b>" + imvTag + "</span>" +
    "<span class='chip'>Comps asking <b>" + fmt$(p.lowAsking) + "–" + fmt$(p.highAsking) + "</b></span>" +
    "<span class='chip' title='Median comp asking price'>Median ask <b>" + fmt$(p.medianAsking) + "</b></span>" +
    "<span class='chip' title='Average Days On Lot'>AVG DOL <b>" + dol + "</b></span>" +
    "<span class='chip conf-" + conf.level + "' title='Based on " + esc(conf.why) + "'>Confidence <b>" + conf.label + "</b></span>";
}

// Market-speed label from days-to-turn (Inventory Plus' own metric).
function speedTag(turnDays) {
  if (!Number.isFinite(turnDays) || turnDays <= 0) return null;
  if (turnDays <= 30) return { label: "🔥 Hot", cls: "hot" };
  if (turnDays <= 60) return { label: "Balanced", cls: "warm" };
  return { label: "🐢 Slow", cls: "slow" };
}

// Inventory Plus market panel (target price, sold/mo, days-to-turn).
function renderIpx() {
  const el = $("ipx");
  if (!el) return;
  const x = subjectExtra || {};
  const reconN = parseInt(String(x.recon || "").replace(/[^\d]/g, ""), 10);
  const hasRecon = Number.isFinite(reconN) && reconN > 0;
  if (!(x.target || x.turn || x.volume || hasRecon)) { el.hidden = true; return; }
  el.hidden = false;
  const tgt = (x.target && !/^\s*(n\/?a|—|-)\s*$/i.test(x.target)) ? x.target : null;
  const mkt = x.market ? " <span class='src'>· " + esc(x.market) + "</span>" : "";
  const turnN = parseInt(String(x.turn || "").replace(/[^\d]/g, ""), 10);
  const spd = speedTag(turnN);
  const reconTile = hasRecon
    ? "<div class='ipx-stat'><div class='ipx-v'>$" + fmtN(reconN) + "</div><div class='ipx-k'>Recon (carried in)</div></div>"
    : "";
  el.innerHTML =
    "<div class='ipx-h'>From Inventory Plus" + mkt +
      (spd ? " <span class='spd " + spd.cls + "'>" + spd.label + "</span>" : "") + "</div>" +
    "<div class='ipx-grid'>" +
      "<div class='ipx-stat'><div class='ipx-v" + (tgt ? "" : " empty") + "'>" + (tgt ? esc(tgt) : "—") + "</div>" +
        "<div class='ipx-k'>Inventory+ Target" + (tgt ? "" : "<span>not set · rare car</span>") + "</div></div>" +
      "<div class='ipx-stat'><div class='ipx-v'>" + esc(x.volume || "—") + "<span class='u'>/mo</span></div><div class='ipx-k'>Sold in market</div></div>" +
      "<div class='ipx-stat'><div class='ipx-v'>" + esc(x.turn || "—") + "<span class='u'> days</span></div><div class='ipx-k'>Avg to turn</div></div>" +
      reconTile +
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
    const samples = (result.sampleModels || []);
    empty.innerHTML =
      "<b>No matching comps found.</b><br>" +
      "Fetched " + counts.rawFetched + " " + spec.make +
      " listings out to " + radLabel(usedRadius || spec.radius) + ", but none matched <b>" +
      [spec.model, spec.trim].filter(Boolean).join(" ") + "</b>" +
      ".<br>Try a bigger radius, or uncheck “Match trim”." +
      (samples.length
        ? "<br><br><span class='hint'>CarGurus returned models · trims like:<br>" + samples.map(esc).join("<br>") + "</span>"
        : "");
    empty.hidden = false;
    return;
  }

  $("empty").hidden = true;
  $("results").hidden = false;
  currentResult = result;
  renderWarnBanner(result, spec);

  // Key each comp and pick the default selection. Mirror the server's pricing
  // basis: with >=3 exact comps, start with only the exact ones checked (widened
  // rows unchecked) so the headline value isn't skewed by other trims.
  currentComps = comps.map((c, i) => Object.assign(c, { _key: "i" + i }));
  currentSpec = spec;
  subjectTrim = (spec.trim || "").trim();
  // Trim filter drives the default selection: price against one CarGurus trim
  // (e.g. "Rubicon 4-Door 4WD"), not every "Rubicon*" variant.
  const defTrim = populateTrimFilter();
  selectedKeys = trimToKeys(defTrim, true);

  // Match line + comp table (table shows only the chosen trim).
  lastScanned = Number.isFinite(counts.rawFetched) ? counts.rawFetched : 0;
  renderCompTable();
  updateMatchline();

  // Competition / market supply line
  renderMarket(result);
  // Inventory Plus market panel (from the page read)
  renderIpx();

  // Chips + deal math from the current selection; seed ACV to the Good-Deal buy.
  applySelection(true);
}

// Loud, unmissable banner when the comp set isn't the exact trim/year — so a
// wrong-trim or wrong-year price can't quietly drive an appraisal.
function renderWarnBanner(result, spec) {
  const el = $("warnBanner");
  if (!el) return;
  const msgs = [];
  if (result.trimFallback && spec.trim) {
    msgs.push("<b>No “" + esc(spec.trim) + "” listings found.</b> These comps are other " +
      esc(spec.model || "model") + " trims, so this price may not fit your exact trim. " +
      "Use the “Priced trim” menu, widen the radius/mileage, or treat the number as a rough guide.");
  }
  if (result.yearFallback && spec.year) {
    msgs.push("<b>No " + esc(String(spec.year)) + " listings found.</b> Showing the nearest model years — values can be off for a brand-new car.");
  }
  if (!msgs.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = msgs.map((m) => "<div class='wb-row'>⚠ " + m + "</div>").join("");
}

function renderMarket(result) {
  const el = $("market");
  const comp = result.competition;
  const buckets = result.distanceBuckets || [];
  if (!comp) { el.innerHTML = ""; return; }
  const widened = result.usedRadius > comp.radius;
  const notes = (result.widenNotes || []);
  // Months of supply = comps for sale locally ÷ units sold/month (Inventory Plus).
  // Only meaningful for a bounded radius, so skip it for a nationwide search.
  let supply = "";
  const vol = subjectExtra ? parseInt(String(subjectExtra.volume || "").replace(/[^\d]/g, ""), 10) : NaN;
  if (Number.isFinite(vol) && vol > 0 && comp.withinRadius > 0 && comp.radius < NATIONWIDE_MI) {
    const mo = comp.withinRadius / vol;
    const tag = mo <= 1.5 ? ["🔥 hot", "hot"] : mo <= 3 ? ["balanced", "warm"] : ["🐢 slow", "slow"];
    supply = "<br><span class='supply " + tag[1] + "'>~" + (mo < 1 ? mo.toFixed(1) : Math.round(mo * 10) / 10) +
      " months' supply (" + comp.withinRadius + " for sale ÷ " + vol + " sold/mo) · " + tag[0] + " market</span>";
  }
  el.innerHTML =
    "<b>Competition:</b> " + comp.withinRadius + " comparable unit" + (comp.withinRadius === 1 ? "" : "s") +
    " for sale within " + radLabel(comp.radius) +
    (widened ? " · expanded to <b>" + radLabel(result.usedRadius) + "</b> to reach " + result.counts.used + " comps" : "") +
    supply +
    (buckets.length ? "<br><span class='buckets'>" + buckets.map((b) => b.mi + " mi: <b>" + b.count + "</b>").join(" · ") + "</span>" : "") +
    (notes.length ? "<br><span class='widen'>⚠ Widened: " + notes.map(esc).join(" · ") + "</span>" : "");
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

  const recon = num($("recon").value), dealer = num($("dealerFee").value), title = num($("titleFee").value);
  const acv = acvVal();
  // Front-end gross: the store's margin rule fills it from the retail price
  // (floored at the minimum) unless the user has typed their own gross.
  let gross;
  if (grossUserEdited) {
    gross = num($("targetGross").value);
  } else {
    gross = ruleGross(acv + recon + title + dealer, currentSettings || DEFAULTS);
    $("targetGross").value = gross;
  }
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

  // price ladder — each band is clickable to set the ACV so retail lands there.
  const segs = [["Great", LMIN, greatCeil, "var(--great)", greatCeil], ["Good", greatCeil, goodCeil, "var(--good)", goodCeil],
                ["Fair", goodCeil, fairCeil, "var(--fair)", fairCeil], ["High", fairCeil, highCeil, "var(--high)", highCeil],
                ["Over", highCeil, LMAX, "var(--over)", highCeil]];
  $("ladderBar").innerHTML = segs.map(([lab, lo, hi, col, price]) => {
    const w = Math.max(0, (hi - lo) / span * 100);
    return "<div class='seg' role='button' tabindex='0' data-retail='" + price +
      "' title='Set ACV so retail = " + fmt$(price) + "' style='width:" + w + "%;background:" + col + "'>" +
      (w > 9 ? lab : "") + "</div>";
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

  // Buy-to-hit: each rating button shows the ACV you'd have to buy at (backing
  // out fees + the rule gross) to LIST at that price — the whole buy range at a
  // glance.
  const feesExGross = recon + title + dealer;
  const buyFor = (retail) => Math.max(0, Math.round(retail - feesExGross - grossForRetail(retail, currentSettings || DEFAULTS)));
  if ($("qGreat")) $("qGreat").textContent = "buy " + fmt$(buyFor(greatCeil)) + " · list " + fmt$(greatCeil);
  if ($("qGood")) $("qGood").textContent = "buy " + fmt$(buyFor(goodCeil)) + " · list " + fmt$(goodCeil);
  if ($("qMarket")) $("qMarket").textContent = "buy " + fmt$(buyFor(imv)) + " · list " + fmt$(imv);

  // Listing-friendly rounded retail suggestion (ends in 95).
  const ls = $("listSuggest");
  if (ls) {
    const nice = sale > 1000 ? Math.round(sale / 500) * 500 - 5 : sale;
    ls.textContent = nice > 0 && Math.abs(nice - sale) >= 5 ? "list ≈ " + fmt$(nice) : "";
  }
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

// Guard any await so a hung Chrome call can't freeze the panel on one stage.
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
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
  let ready = await waitForCG(tab.id, created ? 20000 : 4000);

  // An existing tab that won't answer is almost always an orphaned content
  // script — left over from reloading the extension while the tab was open — or
  // a stale page. Reloading it re-injects a fresh, connected content script.
  if (!ready && !created) {
    stage("Reloading CarGurus…");
    try {
      await withTimeout(chrome.tabs.reload(tab.id), 3000).catch(() => {});
      ready = await waitForCG(tab.id, 20000);
    } catch (e) { /* ignore */ }
  }

  // Last resort: re-inject directly. Time-boxed so this step can never hang the
  // panel the way an un-guarded executeScript could.
  if (!ready) {
    stage("Preparing CarGurus…");
    try {
      await withTimeout(
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["cargurus-makes.js", "content-cargurus.js"] }),
        8000
      );
      ready = await waitForCG(tab.id, 5000);
    } catch (e) { /* ignore */ }
  }

  // Still nothing (created tab that never became ready): one reload attempt.
  if (!ready) {
    stage("Reloading CarGurus…");
    try {
      await withTimeout(chrome.tabs.reload(tab.id), 3000).catch(() => {});
      ready = await waitForCG(tab.id, 20000);
    } catch (e) { /* ignore */ }
  }

  if (!ready) {
    // Bring the CarGurus tab to the front so the user can see/clear a CAPTCHA.
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) { /* ignore */ }
    throw new Error("Couldn't reach CarGurus. I brought its tab to the front — if it shows a “verify you're human”/CAPTCHA page, clear it, then click Find comps again. Otherwise close every cargurus.com tab and click Find comps to open a fresh one.");
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

// Build the printable comp pool: the SAME comps you're looking at, but hard-
// filtered to a mileage window around the subject and sorted by closest mileage
// (then nearest, then cheapest) — so the handout shows genuinely similar cars,
// not the cheapest high-mileage ones. Widens the window only if too few qualify.
function buildPrintPool(comps, spec) {
  const subj = Number.isFinite(spec.mileage) ? spec.mileage : null;
  // Prefer the priced trim so the handout isn't a mix of trims.
  let pool = spec.trim ? comps.filter((c) => c.trimMatched) : comps.slice();
  if (pool.length < 4) pool = comps.slice();

  // Start from the mileage slider window (or ±10k around the subject if the
  // slider is wide open). Widen symmetrically only until we have a usable count.
  const wideOpen = !(Number.isFinite(spec.minMileage) && Number.isFinite(spec.maxMileage)) ||
    (spec.minMileage <= 0 && spec.maxMileage >= 200000);
  let lo = wideOpen ? (subj != null ? Math.max(0, subj - 10000) : 0) : spec.minMileage;
  let hi = wideOpen ? (subj != null ? subj + 10000 : Infinity) : spec.maxMileage;
  const half = Math.max(2500, Math.round((hi - lo) / 2));
  const near = (c) => (subj == null || !Number.isFinite(c.mileage)) ? Infinity : Math.abs(c.mileage - subj);
  const inWin = (c, l, h) => !Number.isFinite(c.mileage) || (c.mileage >= l && c.mileage <= h);

  let chosen = pool, wlo = lo, whi = hi, widened = 0;
  if (subj != null) {
    for (let step = 0; step <= 3; step++) {
      wlo = Math.max(0, lo - half * step);
      whi = hi + half * step;
      const within = pool.filter((c) => inWin(c, wlo, whi));
      chosen = within; widened = step;
      if (within.length >= 6) break;
    }
  }
  chosen = chosen.slice().sort((a, b) =>
    (near(a) - near(b)) ||                     // closest mileage first
    ((a.distance || 0) - (b.distance || 0)) || // then nearest
    ((a.price || 0) - (b.price || 0))          // then cheapest
  ).slice(0, 24);
  return { list: chosen, lo: Math.round(wlo), hi: Number.isFinite(whi) ? Math.round(whi) : null, widened };
}

async function printComps() {
  const spec = gatherSpec();
  const problem = validate(spec);
  if (problem) { const e = $("err"); e.textContent = problem; e.hidden = false; return; }
  $("err").hidden = true;

  const btn = $("printBtn");
  const status = $("printStatus");
  btn.disabled = true;

  try {
    // Print the comps you're already looking at (they honor your radius, trim,
    // and mileage window). Only run a fresh search if you haven't found comps yet.
    let comps = (currentComps && currentComps.length) ? currentComps.slice() : null;
    let radiusUsed = (currentResult && currentResult.usedRadius) || spec.radius;
    if (!comps) {
      status.textContent = "Searching…";
      const result = await searchComps(Object.assign({}, spec, { targetCount: 40 }), (m) => { status.textContent = m; });
      if (!result || !result.ok) { status.textContent = (result && result.error) || "Search failed."; return; }
      comps = (result.comps || []).slice();
      radiusUsed = result.usedRadius || spec.radius;
    }

    const { list, lo, hi, widened } = buildPrintPool(comps, spec);
    if (!list.length) { status.textContent = "No comparable listings found."; return; }
    await chrome.storage.local.set({
      printData: {
        subject: { year: spec.year, make: spec.make, model: spec.model, trim: spec.trim, mileage: spec.mileage },
        zip: spec.zip,
        radius: radiusUsed,
        mileageLo: lo,
        mileageHi: hi,
        mileageWidened: widened > 0,
        comps: list,
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
      titleFee: $("titleFee").value.replace(/[^\d]/g, "")
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

  // Trim filter: show only that trim's comps in the table and price against them.
  $("trimFilter").addEventListener("change", () => {
    selectedKeys = trimToKeys($("trimFilter").value, true);
    renderCompTable();
    updateMatchline();
    applySelection(true);
  });

  // Stale-listing toggle: drop 90+ day listings from the priced set.
  const staleBox = $("excludeStale");
  if (staleBox) staleBox.addEventListener("change", () => {
    excludeStale = staleBox.checked;
    selectedKeys = trimToKeys(($("trimFilter") && $("trimFilter").value) || "*ALL*", true);
    renderCompTable();
    applySelection(false);
  });

  // Deal-math build-up: ACV is editable; the tier buttons and the ladder bands
  // jump the ACV so the retail price lands at that rating. Back into the ACV from
  // the target retail, applying the store margin rule for the gross at that price.
  function jumpAcvTo(retail) {
    if (!Number.isFinite(retail)) return;
    const s = currentSettings || DEFAULTS;
    const feesExGross = num($("recon").value) + num($("dealerFee").value) + num($("titleFee").value);
    grossUserEdited = false;
    $("targetGross").value = grossForRetail(retail, s);
    $("acv").value = Math.max(0, Math.round(retail - feesExGross - num($("targetGross").value))).toLocaleString("en-US");
    acvUserEdited = true;
    renderDealMath();
  }

  // Typing marks ACV as user-set so comp toggles won't overwrite it.
  $("acv").addEventListener("input", () => { acvUserEdited = true; renderDealMath(); });
  $("acv").addEventListener("blur", () => { $("acv").value = acvVal().toLocaleString("en-US"); });
  $("quick").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !currentPricing) return;
    const map = { great: currentPricing.greatDealPrice, good: currentPricing.goodDealPrice, market: currentPricing.subjectImv };
    jumpAcvTo(map[b.dataset.k]);
  });
  // Clicking (or Enter/Space on) a ladder band jumps ACV to that price point.
  const ladderJump = (e) => {
    const seg = e.target.closest(".seg[data-retail]");
    if (!seg || !currentPricing) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    jumpAcvTo(parseInt(seg.dataset.retail, 10));
  };
  $("ladderBar").addEventListener("click", ladderJump);
  $("ladderBar").addEventListener("keydown", ladderJump);

  // Deal math recomputes live. Dealer/title fees are saved as store defaults;
  // recon is per-vehicle; a hand-typed gross overrides the margin rule.
  ["recon", "dealerFee", "titleFee", "targetGross"].forEach((id) => {
    $(id).addEventListener("input", () => {
      if (id === "targetGross") grossUserEdited = true;
      renderDealMath();
      if (id === "dealerFee" || id === "titleFee") persistDealDefaults();
    });
  });
})();
