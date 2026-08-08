// popup.js — reads the subject vehicle from the active tab, runs the CarGurus
// search via the background worker, and renders the comps dashboard.

const $ = (id) => document.getElementById(id);
const fmt$ = (n) => (Number.isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "—");
const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");

const DEFAULTS = {
  zip: "", radius: "100", variance: 10000, strictTrim: true, selectors: {},
  dealerFee: "", titleFee: "", targetGross: 2500, reconDefault: 2500, theme: "auto"
};

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

// Holds the most recent search pricing so Deal math can recompute live as the
// manager edits recon / fees without re-running the search.
let lastPricing = null;

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

  const out = { year: "", make: "", model: "", trim: "", mileage: "", source: "none", candidates: [] };

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

  return out;
}

// ---------------------------------------------------------------------------
async function loadDefaults() {
  const stored = await chrome.storage.local.get(["settings"]);
  const s = Object.assign({}, DEFAULTS, stored.settings || {});
  applyTheme(s.theme || "auto");
  if (s.zip) $("zip").value = s.zip;
  $("radius").value = s.radius || "100";
  $("variance").value = Number.isFinite(s.variance) ? s.variance : 10000;
  $("strictTrim").checked = s.strictTrim !== false;
  if (s.dealerFee !== "" && s.dealerFee != null) $("dealerFee").value = s.dealerFee;
  if (s.titleFee !== "" && s.titleFee != null) $("titleFee").value = s.titleFee;
  $("targetGross").value = Number.isFinite(s.targetGross) ? s.targetGross : 2500;
  $("recon").value = Number.isFinite(s.reconDefault) ? s.reconDefault : 2500;
  return s;
}

async function readActiveTab(settings, opts = {}) {
  const status = $("readStatus");
  // On a manual re-read (the button), clear the old car first so stale fields
  // from the previous appraisal don't linger if the new tab is missing some.
  if (opts.manual) {
    ["year", "make", "model", "trim", "mileage"].forEach((id) => { $(id).value = ""; });
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
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readSubjectVehicle,
      args: [settings.selectors || {}]
    });
    const v = (res && res.result) || {};
    if (v.year) $("year").value = v.year;
    if (v.make) $("make").value = v.make;
    if (v.model) $("model").value = v.model;
    if (v.trim) $("trim").value = v.trim;
    if (v.mileage) $("mileage").value = v.mileage;

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
    mileage: parseInt($("mileage").value.replace(/[^\d]/g, ""), 10) || null,
    zip: $("zip").value.replace(/[^\d]/g, ""),
    radius: parseInt($("radius").value, 10) || 100,
    mileageVariance: parseInt($("variance").value, 10) || 10000,
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

  const { comps, pricing, counts, widenNotes = [], pricingExactBased, usedRadius } = result;

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

  // Summary cards
  $("summary").innerHTML =
    card("Market value (IMV)", fmt$(pricing.subjectImv), "CarGurus avg for this car") +
    card("List for “Good Deal”", fmt$(pricing.goodDealPrice), "≤ this shows Good", "good") +
    card("List for “Great Deal”", fmt$(pricing.greatDealPrice), "≤ this shows Great", "great");

  // Match line
  const rc = pricing.ratingCounts || {};
  const rcStr = Object.entries(rc).map(([k, v]) => v + " " + k).join(" · ");
  const widened = comps.length - counts.exact;
  $("matchline").innerHTML =
    "<b>" + comps.length + "</b> comps — <b>" + counts.exact + "</b> exact" +
    (widened > 0 ? " + <b>" + widened + "</b> widened (" + esc(widenNotes.join(", ")) + ")" : "") +
    " · asking <b>" + fmt$(pricing.lowAsking) + "</b>–<b>" + fmt$(pricing.highAsking) + "</b>" +
    " · median <b>" + fmt$(pricing.medianAsking) + "</b>" +
    (Number.isFinite(pricing.medianDaysOnMarket) ? " · median <b>" + pricing.medianDaysOnMarket + " days</b> on market" : "") +
    (pricingExactBased ? "" : "<br><i>Pricing based on all shown comps (few exact matches).</i>") +
    (rcStr ? "<br>" + rcStr : "");

  // Table
  const tb = $("compTable").querySelector("tbody");
  tb.innerHTML = "";
  for (const c of comps) {
    const tr = document.createElement("tr");
    if (!c.exact) tr.className = "widened";
    const tag = c.exact ? "" : " <span class='wtag' title='Widened to reach 10 comps'>≈</span>";
    tr.innerHTML =
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

  // Competition / market supply line
  renderMarket(result);

  // Deal math (recomputes live from lastPricing)
  lastPricing = pricing;
  renderDealMath();
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

function renderDealMath() {
  const el = $("maxbuy");
  if (!lastPricing) { el.innerHTML = ""; return; }
  const recon = num($("recon").value);
  const dealerFee = num($("dealerFee").value);
  const titleFee = num($("titleFee").value);
  const targetGross = num($("targetGross").value);

  const scenarios = [
    { label: "Great Deal", price: lastPricing.greatDealPrice, cls: "great" },
    { label: "Good Deal", price: lastPricing.goodDealPrice, cls: "good rec" },
    { label: "Market (IMV)", price: lastPricing.subjectImv, cls: "" }
  ];

  let rows = "";
  for (const s of scenarios) {
    const maxBuy = Number.isFinite(s.price) ? s.price + dealerFee - recon - titleFee - targetGross : null;
    rows +=
      "<tr class='" + s.cls + "'>" +
      "<td>" + esc(s.label) + (s.cls.includes("rec") ? " <span class='rectag'>recommended</span>" : "") + "</td>" +
      "<td class='num'>" + fmt$(s.price) + "</td>" +
      "<td class='num big'>" + fmt$(maxBuy) + "</td>" +
      "</tr>";
  }
  el.innerHTML =
    "<table class='dmtable'><thead><tr><th>List it as</th><th class='num'>List price</th>" +
    "<th class='num'>Max buy for " + fmt$(targetGross) + " gross</th></tr></thead><tbody>" + rows + "</tbody></table>";

  renderTopBuy(recon, dealerFee, titleFee, targetGross);
}

// Prominent headline number: the max buy at the recommended (Good Deal) list price.
function renderTopBuy(recon, dealerFee, titleFee, targetGross) {
  const el = $("topbuy");
  if (!lastPricing) { el.hidden = true; return; }
  const usingGood = Number.isFinite(lastPricing.goodDealPrice);
  const listPrice = usingGood ? lastPricing.goodDealPrice : lastPricing.subjectImv;
  if (!Number.isFinite(listPrice)) { el.hidden = true; return; }
  const maxBuy = listPrice + dealerFee - recon - titleFee - targetGross;
  el.hidden = false;
  el.innerHTML =
    "<div class='tb-k'>Max buy to clear " + esc(fmt$(targetGross)) + " gross</div>" +
    "<div class='tb-v'>" + esc(fmt$(maxBuy)) + "</div>" +
    "<div class='tb-sub'>listing at the " + (usingGood ? "Good Deal" : "market") + " price of " +
    esc(fmt$(listPrice)) + (recon ? " · recon " + esc(fmt$(recon)) : " · set recon below") + "</div>";
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
      zip: spec.zip, radius: String(spec.radius), variance: spec.mileageVariance, strictTrim: $("strictTrim").checked
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
  await readActiveTab(currentSettings);
  $("findBtn").addEventListener("click", findComps);
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("themeBtn").addEventListener("click", cycleTheme);
  $("printBtn").addEventListener("click", printComps);
  $("readBtn").addEventListener("click", () => readActiveTab(currentSettings || DEFAULTS, { manual: true }));

  // Deal math recomputes live; fee/title/target are saved as store defaults.
  ["recon", "dealerFee", "titleFee", "targetGross"].forEach((id) => {
    $(id).addEventListener("input", () => {
      renderDealMath();
      if (id !== "recon") persistDealDefaults();
    });
  });
})();
