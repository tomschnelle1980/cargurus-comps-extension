// print.js — renders the printable "comparable units" handout. Shows the cheapest
// comparable listings as a selectable gallery; only the checked ones print.

const $ = (id) => document.getElementById(id);
const fmt$ = (n) => (Number.isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "—");
const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let COMPS = [];
const DEFAULT_SELECT = 6;

const titleOf = (c) => [c.year, c.make, c.model, c.trim].filter(Boolean).join(" ");
function locationOf(c) {
  const bits = [];
  if (c.city) bits.push(c.city);
  if (Number.isFinite(c.distance)) bits.push(Math.round(c.distance) + " mi away");
  return bits.join(" · ");
}

function cardHTML(c, i, checked) {
  const photo = c.photo
    ? "<img src='" + esc(c.photo) + "' alt='" + esc(titleOf(c)) + "' draggable='false' onerror=\"this.parentNode.innerHTML='<div class=&quot;noimg&quot;>Photo unavailable</div>'\">"
    : "<div class='noimg'>No photo</div>";
  return (
    "<div class='pcard " + (checked ? "selected" : "excluded") + "' data-i='" + i + "' draggable='true'>" +
    "<label class='pick noprint'><input type='checkbox' data-i='" + i + "'" + (checked ? " checked" : "") + "> Include</label>" +
    "<span class='drag noprint' title='Drag to reorder'>⠿</span>" +
    "<div class='pphoto'>" + photo + "</div>" +
    "<div class='pbody'>" +
    "<div class='pprice'>" + esc(fmt$(c.price)) + "</div>" +
    "<div class='ptitle'>" + esc(titleOf(c)) + "</div>" +
    "<div class='pmeta'>" + esc(fmtN(c.mileage)) + " miles" +
    (locationOf(c) ? " · " + esc(locationOf(c)) : "") + "</div>" +
    (c.dealer ? "<div class='pdealer'>" + esc(c.dealer) + "</div>" : "") +
    "</div></div>"
  );
}

function selectedCount() {
  return document.querySelectorAll(".pcard.selected").length;
}

function refreshState() {
  const n = selectedCount();
  $("printNow").textContent = "Print (" + n + " selected)";
  $("printNow").disabled = n === 0;
  $("selHint").textContent = n === 0
    ? "Select at least one unit to print."
    : n + " of " + COMPS.length + " selected — only checked units will print.";
}

function setCard(i, checked) {
  const card = document.querySelector(".pcard[data-i='" + i + "']");
  const box = document.querySelector("input[data-i='" + i + "']");
  if (!card) return;
  card.classList.toggle("selected", checked);
  card.classList.toggle("excluded", !checked);
  if (box) box.checked = checked;
}

let dragEl = null;

function renderGrid() {
  const grid = $("grid");
  grid.innerHTML = COMPS.map((c, i) => cardHTML(c, i, i < DEFAULT_SELECT)).join("");

  grid.addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox]");
    if (!box) return;
    setCard(box.getAttribute("data-i"), box.checked);
    refreshState();
  });

  // Drag-to-reorder. Print output follows the card order in the DOM.
  grid.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".pcard");
    if (!card) return;
    dragEl = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  grid.addEventListener("dragend", () => {
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
  });
  grid.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragEl) return;
    const target = e.target.closest(".pcard");
    if (!target || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    const before =
      e.clientY < rect.top + rect.height / 2 ||
      (e.clientY < rect.bottom && e.clientX < rect.left + rect.width / 2);
    grid.insertBefore(dragEl, before ? target : target.nextSibling);
  });

  refreshState();
}

function formatDate() {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

async function init() {
  const { printData } = await chrome.storage.local.get("printData");
  if (!printData || !Array.isArray(printData.comps) || !printData.comps.length) {
    $("subject").textContent = "No data";
    $("meta").textContent = "Run a search in the extension, then click “Print comparable units.”";
    $("printNow").disabled = true;
    return;
  }
  COMPS = printData.comps;
  const s = printData.subject || {};
  const subjectLine = [s.year, s.make, s.model, s.trim].filter(Boolean).join(" ");
  $("subject").textContent = subjectLine +
    (Number.isFinite(s.mileage) ? " · " + fmtN(s.mileage) + " miles" : "");
  $("meta").textContent =
    "Cheapest comparable units for sale within " + (printData.radius || 500) + " miles" +
    (printData.zip ? " of " + printData.zip : "") + " · " + formatDate() + " · Source: CarGurus.com";
  $("footer").textContent =
    "Actual retail listings for comparable vehicles. Prices, mileage, and availability shown as listed on " +
    "CarGurus.com as of " + formatDate() + " and are subject to change.";

  renderGrid();

  $("selectCheapest").addEventListener("click", () => {
    COMPS.forEach((_, i) => setCard(i, i < DEFAULT_SELECT));
    refreshState();
  });
  $("clearAll").addEventListener("click", () => {
    COMPS.forEach((_, i) => setCard(i, false));
    refreshState();
  });
  $("printNow").addEventListener("click", () => { if (selectedCount()) window.print(); });
}

init();
