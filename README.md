# CarGurus Comps for Inventory Plus

A Chrome/Edge extension for used-car appraisal. While you're on a vehicle in
**Inventory Plus**, click the toolbar button and it opens a **side panel** that
pulls **comparable CarGurus listings** — same year / make / model / trim, within
a mileage window and radius you set — and shows **CarGurus market value (IMV)**
plus the **list prices that would earn a “Good Deal” / “Great Deal” rating** if
you traded for the car and put it up for sale.

The dashboard lives in the browser's **side panel**, so it **stays open while you
switch tabs** (Inventory Plus ⇄ CarGurus ⇄ your CRM). When you move to a new
vehicle, click **↻ Read this tab** to pull its Year / Make / Model / Trim without
reopening.

## How it gets the data

It uses CarGurus' own public search endpoint (`/Cars/searchResults.action`),
called from inside a normal cargurus.com browser tab so it rides your regular
session. It does **not** scrape the page, and it does **not** try to defeat any
bot-check or CAPTCHA. If CarGurus ever shows a verification page, just clear it
in the CarGurus tab and search again.

Each comp comes back with: price, market value (IMV), $ above/below market,
deal rating, mileage, distance, dealer, VIN, and stock number.

## Install (Chrome or Edge — same steps)

1. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Turn on **Developer mode** (toggle, top-right in Chrome / left sidebar in Edge).
3. Click **Load unpacked** and select this folder:
   `C:\Users\tomsc\cargurus-comps-extension`
4. Pin the extension so the toolbar button is visible.

## First-time setup

1. Click the extension → **Settings**.
2. Set your **Dealership ZIP** (search center) and default **radius** / **mileage variance**.
3. Save.

## Daily use

1. Open the vehicle you're appraising in **Inventory Plus**.
2. Click the extension button to open the side panel. It auto-reads Year / Make /
   Model / Trim / Mileage (correct any field if needed). On later cars, click
   **↻ Read this tab** to re-read the vehicle you're now looking at.
3. Click **Find comps**.
4. Read the dashboard:
   - **Market value (IMV)** — CarGurus' average value for that car.
   - **List for “Good Deal”** / **List for “Great Deal”** — target retail prices
     to hit those ratings, derived from the live comp set.
   - The table lists matching comps with price, IMV, rating, **days on market**,
     distance, and dealer.
   - **Deal math (ACV build-up)** — type the **ACV** (what you're into the car
     for) and it builds up to the retail price and shows its **estimated CarGurus
     rating**, on a Great→Good→Fair→High→Over price ladder. Edit ACV or gross and
     the rating re-rates live; or click a rating to jump ACV to that list price.
   - **From Inventory Plus** — reads the store's own market numbers off the page:
     the **Target price** (TrueTarget), **units sold/mo** and **days-to-turn**
     (TrueScore Market).
   - **Competition** — how many comparable units are for sale within your radius,
     plus a distance breakdown (25 mi: 12 · 50 mi: 24 …) and how far the search
     had to expand to reach 10 comps.

### Deal math formula

`Retail sale price = ACV + Recon + Title fee + Dealer fee + Front-end gross`

ACV is the headline (the most to put in the car); recon, title, dealer fee, and
your gross stack on top to the retail price. The estimated rating classifies that
retail price against the comp set: **Great** and **Good** cutoffs come from the
comps' own ratings; **Fair / High / Over** are modeled bands (≈ market, +5%,
+10%), so the whole rating is labeled *estimated* — not an official CarGurus call.
Dealer fee and title fee are **blank by default** — set them once (in the popup or
Settings) and they're saved as store defaults.

### How it reaches ~10 comps

Your exact criteria (same year + trim + ±mileage + radius) often only turn up a
few cars. To give you a usable sample, the tool aims for **at least 10 comps**:
it shows every **exact** match first, then fills toward 10 with the closest
**widened** matches — nearest model years, then wider mileage, then a larger
radius — in that order. Widened rows are marked with a small “≈” and a lighter
shade. The match line shows the split, e.g. *“10 comps — 3 exact + 7 widened
(±1 model year, wider mileage)”*. Pricing is based on the exact comps whenever
there are at least three of them.

## If auto-read misses fields

Inventory Plus layouts vary. If a field doesn't auto-fill:

- Just type it into the popup (it still searches fine), **or**
- Lock it in permanently: **Settings → Inventory Plus field mapping**, paste a CSS
  selector for each field (right-click the value in Inventory Plus → Inspect →
  Copy → Copy selector).

## Notes & limits

- **Trim matching** is fuzzy (CarGurus trim names are messy). Uncheck **Match trim**
  in the popup to widen to all trims of that model.
- The market value and Good/Great targets are computed from the comps CarGurus
  returns for your search — a real market read, not a guaranteed CarGurus number.
- If CarGurus changes their endpoint or make IDs, the make list re-extracts itself
  from the live page; deeper changes may need a small update.
- Data source is the **public** CarGurus site (no dealer login required).

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `popup.html/.css/.js` | The dashboard UI + Inventory Plus reader |
| `background.js` | Opens/relays to a CarGurus tab |
| `content-cargurus.js` | Runs the CarGurus JSON search + matching + pricing |
| `cargurus-makes.js` | Make → CarGurus entity-ID map |
| `options.html/.js` | Settings (ZIP, radius, variance, field mapping) |
