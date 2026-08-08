// background.js (service worker)
// Coordinates between the popup and a cargurus.com tab. The actual CarGurus
// JSON calls happen inside content-cargurus.js (same-origin), so we just need a
// cargurus.com tab to exist and be ready, then relay the search spec to it.

const CG_URL = "https://www.cargurus.com/Cars/spt-used-cars";

// Clicking the toolbar button opens the dashboard in the side panel, which stays
// open while you switch tabs (a popup would close the moment the tab loses focus).
function enableSidePanelOnClick() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch (e) { /* older browser without sidePanel — falls back to no-op */ }
}
enableSidePanelOnClick();
chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnClick);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findCarGurusTab() {
  const tabs = await chrome.tabs.query({ url: "https://*.cargurus.com/*" });
  // Prefer a fully loaded tab.
  return tabs.find((t) => t.status === "complete") || tabs[0] || null;
}

function pingTab(tabId) {
  return new Promise((resolve) => {
    let done = false;
    try {
      chrome.tabs.sendMessage(tabId, { type: "PING_CG" }, (resp) => {
        void chrome.runtime.lastError; // swallow "no receiver"
        if (!done) { done = true; resolve(!!(resp && resp.ok)); }
      });
    } catch (e) {
      resolve(false);
    }
    setTimeout(() => { if (!done) { done = true; resolve(false); } }, 700);
  });
}

async function waitForContentScript(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingTab(tabId)) return true;
    await sleep(500);
  }
  return false;
}

async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["cargurus-makes.js", "content-cargurus.js"]
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function ensureCarGurusTab() {
  let tab = await findCarGurusTab();
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: CG_URL, active: false });
    created = true;
  }

  let ready = await waitForContentScript(tab.id, created ? 20000 : 3000);

  // Self-heal: a CarGurus tab opened BEFORE the extension loaded won't have the
  // helper script. Inject it programmatically, then retry.
  if (!ready && !created) {
    if (await injectContentScripts(tab.id)) {
      ready = await waitForContentScript(tab.id, 4000);
    }
  }

  // Last resort: reload the tab so the manifest content script auto-injects.
  if (!ready && !created) {
    try {
      await chrome.tabs.reload(tab.id);
      ready = await waitForContentScript(tab.id, 20000);
    } catch (e) { /* ignore */ }
  }

  if (!ready) {
    throw new Error(
      "Couldn't reach CarGurus. If a CarGurus tab is showing a verification/CAPTCHA page, open it and clear it, then try again."
    );
  }
  return tab.id;
}

function runSearchOnTab(tabId, spec) {
  return new Promise((resolve) => {
    let done = false;
    chrome.tabs.sendMessage(tabId, { type: "RUN_SEARCH", spec }, (resp) => {
      const err = chrome.runtime.lastError;
      if (done) return;
      done = true;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(resp || { ok: false, error: "No response from CarGurus tab." });
    });
    setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, error: "Search timed out." }); }
    }, 45000);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FIND_COMPS") {
    (async () => {
      try {
        const tabId = await ensureCarGurusTab();
        const result = await runSearchOnTab(tabId, msg.spec);
        // Persist last result so the popup can show it again after reopening.
        try { await chrome.storage.local.set({ lastResult: result, lastSpec: msg.spec, lastRun: Date.now() }); }
        catch (e) { /* ignore */ }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // async
  }

  if (msg && msg.type === "FOCUS_CG_TAB") {
    (async () => {
      const tab = await findCarGurusTab();
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      sendResponse({ ok: !!tab });
    })();
    return true;
  }
});
