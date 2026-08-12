// content-cargurus.js
// Runs on cargurus.com. Receives a search spec from the background worker,
// calls CarGurus' own JSON search endpoint (same-origin, so it uses the normal
// browser session), matches comps, computes pricing, and returns the result.
//
// This is NOT scraping the page DOM. It calls /Cars/searchResults.action, the
// same JSON endpoint the CarGurus site uses. All fields (price, expectedPrice =
// market value/IMV, dealRating, mileage, distance, trim) come straight from it.

(() => {
  "use strict";

  // Guard against double-injection (manifest auto-inject + background self-heal),
  // which would otherwise register the message listener twice.
  if (window.__cgCompsLoaded) return;
  window.__cgCompsLoaded = true;

  const RATING_LABEL = {
    GREAT_PRICE: "Great Deal",
    GOOD_PRICE: "Good Deal",
    FAIR_PRICE: "Fair Deal",
    HIGH_PRICE: "High Priced",
    OVERPRICED: "Overpriced",
    NO_PRICE_ANALYSIS: "No Analysis",
    NO_ANALYSIS: "No Analysis",
    UNCERTAIN: "No Analysis"
  };
  const RATING_RANK = {
    GREAT_PRICE: 5, GOOD_PRICE: 4, FAIR_PRICE: 3, HIGH_PRICE: 2, OVERPRICED: 1
  };

  const norm = (s) =>
    (s || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // Classify a listing's body style from whatever text we have (raw fields +
  // trim/model). Convertible synonyms include Cabriolet/Roadster; returns null
  // when nothing identifiable is present (so it's treated as "unknown", not a
  // mismatch).
  function bodyStyleOf(text) {
    const t = " " + norm(text) + " ";
    if (/ (convertible|cabriolet|cabrio|roadster|spyder|spider) /.test(t)) return "convertible";
    if (/ (coupe) /.test(t)) return "coupe";
    if (/ (wagon|estate|touring|avant|sportwagen|allroad) /.test(t)) return "wagon";
    if (/ (hatchback|hatch) /.test(t)) return "hatchback";
    if (/ (minivan) /.test(t)) return "van";
    if (/ (pickup|crew cab|extended cab|regular cab|quad cab|double cab|king cab|supercab|supercrew|crewmax) /.test(t)) return "truck";
    if (/ (suv|crossover) /.test(t)) return "suv";
    if (/ (van) /.test(t)) return "van";
    if (/ (sedan|saloon) /.test(t)) return "sedan";
    return null;
  }

  // Resolve a make name to CarGurus' "m<id>" entity.
  function resolveMakeEntity(makeName) {
    const makes = self.CARGURUS_MAKES || {};
    const aliases = self.CARGURUS_MAKE_ALIASES || {};
    if (!makeName) return null;

    // exact
    if (makes[makeName]) return makes[makeName];

    const n = norm(makeName);
    if (aliases[n] && makes[aliases[n]]) return makes[aliases[n]];

    // normalized match against known makes
    for (const name of Object.keys(makes)) {
      if (norm(name) === n) return makes[name];
    }
    // startsWith / contains fallback (e.g. "Mercedes" -> "Mercedes-Benz")
    for (const name of Object.keys(makes)) {
      const nn = norm(name);
      if (nn.startsWith(n) || n.startsWith(nn)) return makes[name];
    }
    // last resort: re-extract from the live page HTML (in case the shipped
    // list is stale) and retry once.
    try {
      const html = document.documentElement.outerHTML;
      const re = /\{"name":"([^"]+)","label":"([^"]+)","value":"(m\d+)"[^}]*\}/g;
      let m;
      while ((m = re.exec(html))) {
        if (norm(m[2]) === n || norm(m[2]).startsWith(n)) return m[3];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Resolve the model entity (e.g. Jeep Wrangler = "d494") by reading modelId off
  // a listing whose modelName EXACTLY matches the subject model — exact so we get
  // the gas "Wrangler" (d494), not "Wrangler 4xe" (d3134), a different model. The
  // modelId is already in "d<id>" form, so it's used as-is.
  async function resolveModelEntity(makeEntity, q, modelName) {
    if (!modelName) return null;
    const target = norm(modelName);
    let offset = 0;
    for (let page = 0; page < 4; page++) {
      let rows;
      try { rows = await fetchListingsPage(makeEntity, q, offset); }
      catch (e) { break; }
      if (!rows.length) break;
      for (const r of rows) {
        if (r && r.modelName && norm(r.modelName) === target &&
            typeof r.modelId === "string" && /^d\d+$/.test(r.modelId)) {
          return r.modelId;
        }
      }
      offset += rows.length;
    }
    return null;
  }


  // q = { zip, radius, startYear, endYear, minMileage, maxMileage, includeDelivery }
  async function fetchListingsPage(entity, q, offset) {
    const params = new URLSearchParams({
      "entitySelectingHelper.selectedEntity": entity,
      zip: String(q.zip),
      distance: String(q.radius),
      sortType: "DEAL_SCORE",
      sortDir: "ASC",
      maxResults: "100",
      offset: String(offset)
    });
    if (q.startYear) params.set("startYear", String(q.startYear));
    if (q.endYear) params.set("endYear", String(q.endYear));
    if (Number.isFinite(q.minMileage)) params.set("minMileage", String(Math.max(0, q.minMileage)));
    if (Number.isFinite(q.maxMileage)) params.set("maxMileage", String(q.maxMileage));
    // Match CarGurus' own toggle: include nationwide-delivery listings (cars
    // beyond the radius that ship to the area) so counts line up with the site.
    params.set("isDeliveryEnabled", q.includeDelivery === false ? "false" : "true");

    // Hard timeout on the network call itself. A CarGurus bot-check page can hold
    // the connection open indefinitely; without this the whole search hangs.
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch("/Cars/searchResults.action?" + params.toString(), {
        headers: { accept: "application/json" },
        credentials: "include",
        signal: ctrl.signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") {
        throw new Error("CarGurus didn't respond within 20s (it may be showing a verification page).");
      }
      throw e;
    } finally {
      clearTimeout(killer);
    }
    if (!res.ok) throw new Error("CarGurus returned HTTP " + res.status + ".");
    // Detect a verification/HTML interstitial instead of the JSON we expect.
    const ctype = res.headers.get("content-type") || "";
    const body = await res.text();
    if (!/json/i.test(ctype) || /^\s*</.test(body)) {
      throw new Error("CarGurus returned a verification/HTML page instead of data. Open cargurus.com, clear any “verify you’re human” prompt, then search again.");
    }
    let data;
    try { data = JSON.parse(body); }
    catch (e) { throw new Error("CarGurus returned an unreadable response (possible verification page)."); }
    return Array.isArray(data) ? data : [];
  }

  // Page through the make within the year/mileage/radius window. CarGurus returns
  // a small page per call, so we keep advancing the offset until an empty page or
  // no new rows. matchFn/want let us stop early once we've collected enough of the
  // model we actually care about (we search by make, so most rows are other models).
  async function fetchAllListings(entity, q, matchFn, want) {
    const all = [];
    const seen = new Set();
    let offset = 0, matched = 0;
    const MAX_PAGES = 25; // safety cap
    for (let page = 0; page < MAX_PAGES; page++) {
      let rows;
      try {
        rows = await fetchListingsPage(entity, q, offset);
      } catch (e) {
        if (all.length) break; // keep whatever we already have
        throw e;
      }
      if (!rows.length) break;         // reached the end of the result set
      let added = 0;
      for (const r of rows) {
        if (r && r.id && !seen.has(r.id)) {
          seen.add(r.id);
          all.push(r);
          added++;
          if (matchFn && matchFn(r)) matched++;
        }
      }
      if (added === 0) break;          // offset returned only dupes -> end
      offset += rows.length;
      if (matchFn && want && matched >= want) break; // enough of the target model
    }
    return all;
  }

  function modelMatches(subjectModel, compModel) {
    const s = norm(subjectModel);
    const c = norm(compModel);
    if (!s || !c) return false;
    if (s === c) return true;
    // tolerate spacing/hyphen differences: "c class" == "c-class" == "cclass".
    if (s.replace(/ /g, "") === c.replace(/ /g, "")) return true;
    // word-prefix match so "Silverado" matches "Silverado 1500", but NOT a
    // loose substring (which wrongly matched "CLA" to "C-Class", "SQ5" to "Q5").
    const st = s.split(" ").filter(Boolean);
    const ct = c.split(" ").filter(Boolean);
    const short = st.length <= ct.length ? st : ct;
    const long = st.length <= ct.length ? ct : st;
    return short.length > 0 && short.every((t, i) => long[i] === t);
  }

  function trimMatches(subjectTrim, compTrim, model) {
    // CarGurus often lists the trim WITHOUT the model name (e.g. GLC 300 shows a
    // trim of "300 4MATIC"), while Inventory Plus includes it ("GLC 300"). Strip
    // the model tokens from both so the trim "core" is what gets compared.
    const modelTokens = norm(model).split(" ").filter(Boolean);
    const stripModel = (t) => {
      let n = norm(t);
      for (const m of modelTokens) n = n.replace(new RegExp("\\b" + m + "\\b", "g"), " ");
      return n.replace(/\s+/g, " ").trim();
    };
    const s = stripModel(subjectTrim);
    const c = stripModel(compTrim);
    if (!s) return true;        // no subject trim -> don't filter on trim
    if (!c) return false;
    if (s === c) return true;
    // token overlap: every meaningful subject-trim token appears in comp trim
    const stop = new Set(["4matic", "awd", "fwd", "rwd", "sedan", "coupe", "suv", "4dr", "2dr"]);
    const sTokens = s.split(" ").filter(t => t && !stop.has(t));
    if (!sTokens.length) return c.includes(s) || s.includes(c);
    return sTokens.every(t => c.includes(t));
  }

  const median = (nums) => {
    const a = nums.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const avg = (nums) => {
    const a = nums.filter(Number.isFinite);
    return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
  };

  function shapeComp(r) {
    return {
      id: r.id,
      year: r.carYear,
      make: r.makeName,
      model: r.modelName,
      trim: r.trimName || "",
      // Detected body style, checking several possible CarGurus fields plus the
      // trim/model text so it works regardless of the exact field name.
      body: bodyStyleOf([r.bodyTypeName, r.bodyStyleName, r.bodyType, r.bodyStyle, r.body, r.trimName, r.modelName].filter(Boolean).join(" ")),
      mileage: r.mileage,
      price: r.price,
      totalPrice: r.totalPrice || r.price,
      expectedPrice: r.expectedPrice,          // CarGurus market value (IMV)
      priceDifferential: r.priceDifferential,  // + = below market, per CarGurus sign
      dealRating: r.dealRating,
      dealLabel: RATING_LABEL[r.dealRating] || "No Analysis",
      dealScore: r.dealScore,
      daysOnMarket: r.daysOnMarket,
      distance: Math.round((r.distance || 0) * 10) / 10,
      city: r.sellerCity,
      dealer: r.dealerName,
      isFranchise: r.isFranchiseDealer,
      sellerType: r.sellerType,
      vin: r.vin,
      stock: r.stockNumber,
      photo: (r.originalPictureData && r.originalPictureData.url) || null,
      url: r.id ? ("https://www.cargurus.com/details/" + r.id) : null
    };
  }

  // Build pricing guidance for the subject vehicle from the matched comp cloud.
  function computePricing(comps) {
    const withImv = comps.filter(c => Number.isFinite(c.expectedPrice) && c.expectedPrice > 0);
    const prices = comps.map(c => c.price).filter(Number.isFinite);

    // Subject market value ~= median of CarGurus market values for these comps.
    const subjectImv = median(withImv.map(c => c.expectedPrice)) || median(prices);

    // Empirically derive the price-vs-market ratio at which CarGurus still
    // shows each rating, using the comps themselves.
    const ratioByRating = {};
    for (const c of withImv) {
      const ratio = c.price / c.expectedPrice;
      const rank = RATING_RANK[c.dealRating];
      if (!rank) continue;
      (ratioByRating[c.dealRating] = ratioByRating[c.dealRating] || []).push(ratio);
    }
    // Highest price/market ratio that still earned each rating (the ceiling).
    const ceilRatio = (rating) => {
      const arr = ratioByRating[rating];
      return arr && arr.length ? Math.max(...arr) : null;
    };

    let greatRatio = ceilRatio("GREAT_PRICE");
    let goodRatio = ceilRatio("GOOD_PRICE");
    if (goodRatio == null && greatRatio != null) goodRatio = greatRatio;
    // Fallbacks based on CarGurus' typical thresholds if the cloud is thin.
    if (greatRatio == null) greatRatio = 0.94; // ~6%+ below market
    if (goodRatio == null) goodRatio = 0.98;   // ~2%+ below market

    const greatPrice = subjectImv ? Math.round(subjectImv * greatRatio) : null;
    const goodPrice = subjectImv ? Math.round(subjectImv * goodRatio) : null;

    // Also give a straight market read from the comp asking prices.
    const goodOrBetter = comps.filter(c => (RATING_RANK[c.dealRating] || 0) >= 4);
    const doms = comps.map(c => c.daysOnMarket).filter(Number.isFinite);
    return {
      subjectImv: subjectImv ? Math.round(subjectImv) : null,
      medianDaysOnMarket: doms.length ? Math.round(median(doms)) : null,
      avgDaysOnMarket: doms.length ? Math.round(avg(doms)) : null,
      goodDealPrice: goodPrice,
      greatDealPrice: greatPrice,
      medianAsking: median(prices),
      avgAsking: prices.length ? Math.round(avg(prices)) : null,
      lowAsking: prices.length ? Math.min(...prices) : null,
      highAsking: prices.length ? Math.max(...prices) : null,
      goodOrBetterMaxAsking: goodOrBetter.length ? Math.max(...goodOrBetter.map(c => c.price)) : null,
      ratingCounts: comps.reduce((m, c) => { m[c.dealLabel] = (m[c.dealLabel] || 0) + 1; return m; }, {}),
      basis: withImv.length
    };
  }

  async function runSearch(spec) {
    const entity = resolveMakeEntity(spec.make);
    if (!entity) {
      return { ok: false, error: 'Could not match make "' + spec.make + '" to a CarGurus make. Check the make field.' };
    }

    const target = Number.isFinite(spec.targetCount) ? spec.targetCount : 10;
    const hasMiles = Number.isFinite(spec.mileage) && spec.mileage > 0;
    const Y = spec.year || null;

    // Mileage window comes from the range slider (explicit min/max). Fall back to
    // a symmetric ±15k around the subject if not supplied.
    let winMin = Number.isFinite(spec.minMileage) ? spec.minMileage : null;
    let winMax = Number.isFinite(spec.maxMileage) ? spec.maxMileage : null;
    if ((winMin == null || winMax == null) && hasMiles) {
      const V = Number.isFinite(spec.mileageVariance) ? spec.mileageVariance : 15000;
      winMin = Math.max(0, spec.mileage - V);
      winMax = spec.mileage + V;
    }
    // A full-range slider (0 .. very high) means "no mileage constraint".
    const hasWindow = Number.isFinite(winMin) && Number.isFinite(winMax) &&
      winMax > winMin && !(winMin <= 0 && winMax >= 200000);

    // Broad fetch window so "wider mileage" widening has candidates beyond the
    // user's window (half a window on each side). Years: subject +/- 2.
    const startYear = Y ? Y - 2 : null;
    const endYear = Y ? Y + 2 : null;
    const halfW = hasWindow ? Math.max(2500, Math.round((winMax - winMin) / 2)) : null;
    const minMileage = hasWindow ? Math.max(0, winMin - halfW) : null;
    const maxMileage = hasWindow ? winMax + halfW : null;

    // Radius ladder: start at the requested radius, widen only if we come up short.
    const ladder = [spec.radius, 100, 150, 200, 300, 500]
      .filter((v) => Number.isFinite(v) && v >= spec.radius);
    const radii = [...new Set(ladder)].sort((a, b) => a - b);

    // Body style is a hard filter: a convertible appraisal must not pull in
    // sedans/coupes. Comps whose body style we can't identify are kept (unknown
    // != mismatch), so we only drop a comp we can positively tell is different.
    const wantBody = spec.bodyStyle && spec.bodyStyle !== "any" ? String(spec.bodyStyle).toLowerCase() : null;
    const includeDelivery = spec.includeDelivery !== false;

    // Scope to the specific model when we can resolve its entity, so pages come
    // back as (e.g.) gas Wranglers rather than all Jeeps — far more of the right
    // comps in far fewer pages. Falls back to the make search.
    let searchEntity = entity;
    if (spec.model) {
      const me = await resolveModelEntity(entity, { zip: spec.zip, radius: spec.radius, startYear, endYear, minMileage, maxMileage, includeDelivery }, spec.model);
      if (me) searchEntity = me;
    }
    const scopedToModel = searchEntity !== entity;

    let pool = [];
    let usedRadius = spec.radius;
    let rawFetched = 0;
    let sampleModels = []; // distinct "model | trim" from the fetch, for the no-match message
    // When searching by make, page until we've collected plenty of the target
    // model; when already scoped to the model, page through the whole result set.
    const modelMatchFn = (r) => modelMatches(spec.model, (r && r.modelName) || "");
    for (const radius of radii) {
      usedRadius = radius;
      let raw = await fetchAllListings(searchEntity, { zip: spec.zip, radius, startYear, endYear, minMileage, maxMileage, includeDelivery }, scopedToModel ? null : modelMatchFn, scopedToModel ? 0 : 150);
      // Safety net: if scoping to the model returned nothing, fall back to the
      // make search so we never regress to zero comps.
      if (scopedToModel && raw.length === 0) {
        raw = await fetchAllListings(entity, { zip: spec.zip, radius, startYear, endYear, minMileage, maxMileage, includeDelivery }, modelMatchFn, 150);
      }
      rawFetched = raw.length;
      if (!sampleModels.length && raw.length) {
        sampleModels = [...new Set(raw.map((r) => ((r && r.modelName) || "?") + " · " + ((r && r.trimName) || "?")))].slice(0, 12);
      }
      pool = raw
        .map(shapeComp)
        .filter((c) => modelMatches(spec.model, c.model))
        .filter((c) => !wantBody || !c.body || c.body === wantBody)
        // When delivery listings are included, keep cars beyond the radius (they
        // ship to the area), matching CarGurus. Otherwise cap at the radius.
        .filter((c) => includeDelivery || !Number.isFinite(c.distance) || c.distance <= radius);
      if (pool.length >= target) break;
    }

    // Score every model-matched comp by closeness to the subject, and tag which
    // ones meet the ORIGINAL strict criteria (exact) vs. were widened in.
    const scored = pool.map((c) => {
      const yearDiff = Y && Number.isFinite(c.year) ? Math.abs(c.year - Y) : 0;
      const mileDiff = hasMiles && Number.isFinite(c.mileage) ? Math.abs(c.mileage - spec.mileage) : 0;
      const trimOk = trimMatches(spec.trim, c.trim, spec.model);
      const inWindow = !hasWindow || (Number.isFinite(c.mileage) && c.mileage >= winMin && c.mileage <= winMax);
      const exact =
        (!Y || c.year === Y) &&
        (!spec.trim || trimOk) &&
        inWindow &&
        (!Number.isFinite(c.distance) || c.distance <= spec.radius);
      return Object.assign(c, { yearDiff, mileDiff, trimMatched: trimOk, exact });
    });

    scored.sort((a, b) =>
      (b.exact - a.exact) ||                 // exact matches first
      (b.trimMatched - a.trimMatched) ||     // then same trim
      (a.yearDiff - b.yearDiff) ||           // then closest model year
      (a.mileDiff - b.mileDiff) ||           // then closest mileage
      ((a.distance || 0) - (b.distance || 0)) // then nearest
    );

    const exactCount = scored.filter((s) => s.exact).length;
    // Keep the whole matched set (capped for sanity) so the trim counts and
    // pricing reflect the real market, not just the first ~10 comps. Prefer the
    // trim-matched pool (e.g. every "Rubicon *") so the table isn't cluttered
    // with unrelated trims; fall back to the full pool for rare cars that come
    // up short. `target` still governs how far the radius ladder widens above.
    let matchedPool = spec.trim ? scored.filter((c) => c.trimMatched) : scored.slice();
    if (matchedPool.length < target) matchedPool = scored.slice();
    const comps = matchedPool.slice(0, 150);

    // Price off the exact comps when we have a solid few; otherwise the whole set.
    const exactComps = comps.filter((c) => c.exact);
    const pricingBasis = exactComps.length >= 3 ? exactComps : comps;

    // Describe how (if at all) the search was widened to reach the target.
    const widenNotes = [];
    if (comps.some((c) => c.yearDiff > 0)) {
      const maxY = Math.max(...comps.map((c) => c.yearDiff));
      widenNotes.push("±" + maxY + " model year" + (maxY > 1 ? "s" : ""));
    }
    if (spec.trim && comps.some((c) => !c.trimMatched)) widenNotes.push("other trims");
    if (hasWindow && comps.some((c) => Number.isFinite(c.mileage) && (c.mileage < winMin || c.mileage > winMax))) widenNotes.push("wider mileage");
    if (usedRadius > spec.radius) widenNotes.push(usedRadius + " mi radius");

    // Competition / market supply: the true comparable set (same model, and same
    // trim if one was given), across the searched years — bucketed by distance.
    let comparable = scored.filter((c) => (!spec.trim || c.trimMatched));
    // Safety net: if trim filtering leaves nothing (e.g. odd trim naming), fall
    // back to the model-matched pool so the counts reflect the cars we show.
    if (spec.trim && comparable.length === 0) comparable = scored;
    const thresholds = [25, 50, 75, 100, 150, 200, 300, 500].filter((t) => t <= usedRadius);
    if (!thresholds.length || thresholds[thresholds.length - 1] !== usedRadius) thresholds.push(usedRadius);
    const distanceBuckets = thresholds.map((mi) => ({
      mi,
      count: comparable.filter((c) => Number.isFinite(c.distance) && c.distance <= mi).length
    }));
    const competition = {
      radius: spec.radius,
      withinRadius: comparable.filter((c) => Number.isFinite(c.distance) && c.distance <= spec.radius).length,
      usedRadius,
      withinUsed: comparable.length
    };

    // Cheapest comparable listings for the printable customer handout. Prefer the
    // exact model year; only fall back to adjacent years if too few same-year exist.
    const sameYear = comparable.filter((c) => !Y || c.year === Y);
    const printPool = sameYear.length >= 4 ? sameYear : comparable;
    const cheapest = printPool
      .filter((c) => Number.isFinite(c.price) && c.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 24);

    return {
      ok: true,
      spec,
      entity,
      usedRadius,
      target,
      cheapest,
      sampleModels,
      counts: {
        rawFetched,
        pool: pool.length,
        exact: exactCount,
        used: comps.length
      },
      widenNotes,
      distanceBuckets,
      competition,
      pricingExactBased: exactComps.length >= 3,
      comps,
      pricing: computePricing(pricingBasis)
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "RUN_SEARCH") {
      runSearch(msg.spec)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true; // async response
    }
    if (msg && msg.type === "PING_CG") {
      sendResponse({ ok: true });
      return false;
    }
  });
})();
