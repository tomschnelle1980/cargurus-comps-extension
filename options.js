const $ = (id) => document.getElementById(id);

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  document.documentElement.setAttribute("data-theme", settings.theme || "auto");
  $("zip").value = settings.zip || "";
  $("radius").value = settings.radius || "100";
  $("variance").value = Number.isFinite(settings.variance) ? settings.variance : 10000;
  $("dealerFee").value = settings.dealerFee || "";
  $("titleFee").value = settings.titleFee || "";
  $("reconDefault").value = Number.isFinite(settings.reconDefault) ? settings.reconDefault : 2500;
  $("minGross").value = Number.isFinite(settings.minGross) ? settings.minGross : 2000;
  $("margin30").value = Number.isFinite(settings.margin30) ? settings.margin30 : 10;
  $("margin50").value = Number.isFinite(settings.margin50) ? settings.margin50 : 8;
  $("margin80").value = Number.isFinite(settings.margin80) ? settings.margin80 : 7;
  const sel = settings.selectors || {};
  $("selYear").value = sel.year || "";
  $("selMake").value = sel.make || "";
  $("selModel").value = sel.model || "";
  $("selTrim").value = sel.trim || "";
  $("selMileage").value = sel.mileage || "";
}

async function save() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const next = Object.assign({}, settings, {
    zip: $("zip").value.replace(/[^\d]/g, ""),
    radius: $("radius").value,
    variance: parseInt($("variance").value, 10) || 10000,
    dealerFee: $("dealerFee").value.replace(/[^\d]/g, ""),
    titleFee: $("titleFee").value.replace(/[^\d]/g, ""),
    reconDefault: parseInt($("reconDefault").value, 10) || 2500,
    minGross: parseInt(String($("minGross").value).replace(/[^\d]/g, ""), 10) || 2000,
    margin30: parseFloat($("margin30").value) || 10,
    margin50: parseFloat($("margin50").value) || 8,
    margin80: parseFloat($("margin80").value) || 7,
    selectors: {
      year: $("selYear").value.trim(),
      make: $("selMake").value.trim(),
      model: $("selModel").value.trim(),
      trim: $("selTrim").value.trim(),
      mileage: $("selMileage").value.trim()
    }
  });
  await chrome.storage.local.set({ settings: next });
  const s = $("saved");
  s.hidden = false;
  setTimeout(() => (s.hidden = true), 1600);
}

$("save").addEventListener("click", save);
load();
