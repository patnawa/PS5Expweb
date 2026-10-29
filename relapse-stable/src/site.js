import { establishPrimitive } from "./webkit.js";
import { installWindowP } from "./utils/mem.js";

const output = document.getElementById("console");

// ============================================================
// LOG BUFFER: solo se muestran 4 lineas a la vez.
// Cuando llega la 5a, se vacia el bloque y empieza uno nuevo.
// ============================================================
const LOG_MAX_LINES = 56;
let logBuffer = [];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderBuffer() {
  if (!output) return;
  output.innerHTML = logBuffer
    .map((l) => '<div class="log-line">' + escapeHtml(l) + "</div>")
    .join("");
}

function writeLog(message, type = "log", replace = false) {
  const formatted = String(message);

  // Mirror every screen line into the durable log so a freeze leaves the last
  // stage on disk. CrashLog is a classic script loaded before this module.
  try {
    if (window.CrashLog) window.CrashLog.info(formatted, type);
  } catch (e) {}

  if (replace && logBuffer.length > 0) {
    // Reemplaza la ultima linea del buffer actual
    logBuffer[logBuffer.length - 1] = formatted;
    renderBuffer();
    return;
  }

  logBuffer.push(formatted);

  // Keep the newest lines instead of dropping the whole history when the
  // buffer overflows. The original reset to [formatted], so the last visible
  // text was the only clue about where a run stopped.
  if (logBuffer.length > LOG_MAX_LINES) {
    logBuffer = logBuffer.slice(-LOG_MAX_LINES);
  }

  renderBuffer();
}

function writeEvent(name, detail, type) {
  writeLog(detail == null || detail === "" ? name : `${name}: ${detail}`, type);
}

window.writeLog = writeLog;
window.jb = { mark: writeEvent };

async function getPrimitive() {
  writeLog("Starting WebKit exploit");
  const primitive = installWindowP(await establishPrimitive(writeEvent));
  if (!primitive || typeof primitive.read8 !== "function")
    throw new Error("Memory primitive unavailable");

  writeLog("ARW ready", "success");
  return primitive;
}

function getWebKitBase() {
  const ctor = globalThis.__ps5NativeCtor;
  if (typeof ctor !== "number" || typeof OFFSET_wk_host_constructor_candidates === "undefined")
    throw new Error("WebKit base inputs are unavailable");

  for (const offset of OFFSET_wk_host_constructor_candidates) {
    const base = ctor - offset;
    if (base >= 0x800000000 && base < 0x900000000 && base % 0x4000 === 0)
      return base;
  }

  throw new Error("WebKit base not found");
}

function cstage(name, detail) {
  try {
    if (window.CrashLog) window.CrashLog.stage(name, detail);
  } catch (e) {}
}

const BUILD = "2026-10-29a loader-race-fix";

// ---- PS5 UI status wiring -------------------------------------------------
// The new screen shows the kernel exploit stage in a floating card instead of
// relying on the log drawer. Every cstage() call funnels through
// window.CrashLog.stage, so wrapping it here catches stages reported from
// site.js, main.js and relapse_exploit.js without touching those files.
const STAGE_LABELS = {
  "site:run": "Starting exploit",
  "site:cache-settle": "Checking cache",
  "site:cache-status": "Cache ready",
  "site:webkit": "WebKit exploit",
  "site:arw-ready": "Memory primitive ready",
  "site:kernel-exploit": "Kernel exploit",
  "site:done": "Complete",
  "main:prepare-rop": "Preparing ROP chain",
  "main:rop-ready": "ROP chain ready",
  "main:kernel-exploit": "Running kernel exploit",
  "main:kernel-result": "Kernel result",
  "main:payloads": "Loading payloads",
  "main:payloads-done": "Payloads loaded",
  "main:done": "Complete",
  "kexploit:leak-kbase": "Leaking kernel base",
  "kexploit:pin-core": "Pinning core",
  "kexploit:escalate": "Escalating",
  "kexploit:arm-aio": "Arming AIO",
  "kexploit:teardown": "Teardown",
  "FAILCHECK": "Previous run did not finish",
  "main:payloads-error": "Payload load failed",
  "main:payloads-partial": "Some payloads failed",
};

const STAGE_PROGRESS = {
  "site:run": 2,
  "site:cache-settle": 5,
  "site:cache-status": 8,
  "site:webkit": 12,
  "site:arw-ready": 20,
  "site:kernel-exploit": 25,
  "main:prepare-rop": 30,
  "main:rop-ready": 35,
  "main:kernel-exploit": 40,
  "kexploit:leak-kbase": 45,
  "kexploit:pin-core": 50,
  "kexploit:escalate": 60,
  "kexploit:arm-aio": 70,
  "kexploit:teardown": 80,
  "main:payloads": 85,
  "main:payloads-done": 92,
  "main:done": 98,
  "site:done": 100,
  "FAILCHECK": 0,
  "main:payloads-error": 0,
  "main:payloads-partial": 85,
};

function setStatusText(text, cls) {
  const el = document.getElementById("exploit-status");
  if (!el) return;
  el.textContent = text;
  el.className = cls || "";
}

function setStatusDetail(text) {
  const el = document.getElementById("exploit-detail");
  if (el) el.textContent = text || "";
}

function setProgress(pct) {
  const el = document.getElementById("progress-fill");
  if (el) el.style.width = Math.max(0, Math.min(100, pct)) + "%";
}

function updateStatusUI(name, detail) {
  const key = String(name || "");
  const label = STAGE_LABELS[key] || key;
  const pct = STAGE_PROGRESS[key];
  if (pct !== undefined) setProgress(pct);
  let cls = "is-running";
  if (key === "site:done" || key === "main:done") cls = "is-ok";
  else if (key === "FAILCHECK" || key === "main:payloads-error") cls = "is-err";
  else if (key === "main:payloads-partial") cls = "is-warn";
  setStatusText(label, cls);
  setStatusDetail(detail || "");
}

function setFinalStatus(ok, detail) {
  setStatusText(ok ? "Exploit complete" : "Exploit failed", ok ? "is-ok" : "is-err");
  setStatusDetail(detail || "");
  setProgress(ok ? 100 : 0);
}

window.updateStatusUI = updateStatusUI;

// Wrap CrashLog.stage/finish so every cstage call updates the card.
try {
  const CL = window.CrashLog;
  if (CL && typeof CL.stage === "function") {
    const origStage = CL.stage.bind(CL);
    CL.stage = function (name, detail) {
      try { origStage(name, detail); } catch (e) {}
      try { updateStatusUI(name, detail); } catch (e) {}
    };
  }
  if (CL && typeof CL.finish === "function") {
    const origFinish = CL.finish.bind(CL);
    CL.finish = function (status, detail) {
      try { origFinish(status, detail); } catch (e) {}
      try { setFinalStatus(String(status || "").toLowerCase() === "ok", detail); } catch (e) {}
    };
  }
} catch (e) {}

// Set the build stamp immediately, and keep the log drawer toggle working.
try {
  const stamp = document.getElementById("build-stamp");
  if (stamp) stamp.textContent = "build: " + BUILD;
  const toggle = document.getElementById("console-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      document.body.classList.toggle("log-hidden");
      toggle.textContent = document.body.classList.contains("log-hidden") ? "Show logs" : "Logs";
    });
  }
} catch (e) {}

// Payload revision key for fetchBinary's cache-buster. Bump whenever the
// shipped ELFs change so consoles never reuse an HTTP-cached old payload.
window.__payloadRev = "kstuff-1.11-pldmgr-0.6.3-elfldr-1360";

// ------------------------------------------------------------
// CACHE REPORT: what the appcache actually did this run. A stale cache leaves
// almost no trace -- the only symptom is a missing build stamp, which cannot
// tell "old code" from "old payload" from "cache never engaged at all". This
// records the status the chain started under so the crash log can name it.
// ------------------------------------------------------------
const CACHE_STATUS_NAMES = [
  "UNCACHED",
  "IDLE",
  "CHECKING",
  "DOWNLOADING",
  "UPDATEREADY",
  "OBSOLETE",
];

function cacheReport(settle) {
  const ac = window.applicationCache;
  return {
    build: BUILD,
    href: String(location.href),
    origin: String(location.origin || ""),
    manifest: document.documentElement.getAttribute("manifest") || null,
    supported: !!ac,
    status: ac ? ac.status : null,
    statusName: ac ? CACHE_STATUS_NAMES[ac.status] || String(ac.status) : "unsupported",
    online: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
    settle: settle || null,
    payloadRev: window.__payloadRev || null,
  };
}

window.__cacheReport = cacheReport;

function cacheSummary(report) {
  return (
    "status=" + report.statusName +
    " supported=" + report.supported +
    " manifest=" + report.manifest +
    " origin=" + report.origin +
    " settle=" + (report.settle || "n/a")
  );
}

async function run() {
  cstage("site:run");
  writeLog("Build: " + BUILD, "info");
  // Status before the settle wait. On a stale-cache console this already reads
  // UPDATEREADY/DOWNLOADING; on a cache that never engaged it reads UNCACHED.
  const initialCache = cacheReport();
  writeLog("Cache at start: " + cacheSummary(initialCache), "info");
  // Never start a chain while an appcache update is in flight. While an update
  // downloads, AppCache serves the OLD copy of every listed file, so a chain
  // that starts mid-update would run stale code while the network already has
  // the fix -- the exact second-boot crash pattern. Wait for the cache to
  // settle first; if an update landed, the page reloads itself (safe while
  // idle) and this run never continues on stale code.
  cstage("site:cache-settle");
  let settle = "unsupported";
  try {
    if (typeof window.__appcacheSettled === "function") {
      settle = await window.__appcacheSettled();
    }
  } catch (e) {
    settle = "error";
  }
  if (settle === "updated") writeLog("AppCache updated before run", "info");
  else if (settle === "cached") writeLog("AppCache downloaded before run", "info");
  else if (settle === "timeout") writeLog("AppCache check timed out; continuing", "warn");
  else if (settle === "error") writeLog("AppCache check failed; continuing", "warn");

  // Settled status: this is the state the chain actually starts under. Store
  // the structured report in the crash log so a freeze names the cache state
  // instead of leaving "missing build stamp" as the only clue.
  const settledCache = cacheReport(settle);
  try {
    if (window.CrashLog && typeof window.CrashLog.cache === "function")
      window.CrashLog.cache(settledCache);
  } catch (e) {}
  writeLog("Cache settled: " + cacheSummary(settledCache), "info");
  cstage("site:cache-status", settledCache.statusName + "/" + (settle || "n/a"));

  // The update was still downloading when the bounded wait expired. Starting
  // the chain here is what freezes the console: AppCache would serve the old
  // copy of the files while the download replaces them. Abort without arming
  // anything and leave __exploitDone false so the cache handler can still
  // reload once the update finishes (safe: no chain ran).
  if (settle === "stale") {
    window.__exploitRunning = false;
    const message =
      "Cache update still downloading; refusing to start the chain. " +
      "Wait for the update to finish or reboot and relaunch.";
    writeLog(message, "error");
    try {
      if (window.CrashLog) window.CrashLog.finish("failed", "cache update did not finish");
    } catch (e) {}
    return "stale-abort";
  }

  // Tell the cache handler a chain is live: a reload from here on would re-run
  // the exploit against an already-patched kernel and panic the console.
  window.__exploitRunning = true;
  const rejection = window.firmware.rejection();
  if (rejection)
    throw new Error(rejection);
  writeLog("Credits: ntfargo, ufm42, Sonic_Iso, Jordy, TheFlow, SlidyBat, Flatz, cow, nhk, bollarz, Sleirsgoevy, EchoStretch, EarthOnion");
  writeLog(`Agent: ${navigator.userAgent}`);
  writeLog(`Firmware: ${window.fw_str}`);
  cstage("site:webkit");
  const primitive = await getPrimitive();
  const webkitBase = getWebKitBase();
  writeLog(`WebKit base: 0x${webkitBase.toString(16)}`);
  cstage("site:arw-ready", "webkit=0x" + webkitBase.toString(16));

  cstage("site:kernel-exploit");
  await import("./relapse_exploit.js");
  await main(primitive);
  cstage("site:done");
}

run()
  .then((result) => {
    if (result === "stale-abort") {
      // No chain ran. Leave __exploitDone false so the cache handler may still
      // reload once the pending update finishes; that reload is safe because
      // nothing was armed.
      window.__exploitRunning = false;
      return;
    }
    // The chain finished: a cache reload from here would re-arm a patched
    // kernel, so mark the run complete and never auto-reload after this.
    window.__exploitRunning = false;
    window.__exploitDone = true;
    // Clean finish: clears the "open" marker so the next launch does not
    // report a crash that never happened.
    try {
      if (window.CrashLog) window.CrashLog.finish("ok");
    } catch (e) {}
  })
  .catch((error) => {
    window.__exploitRunning = false;
    window.__exploitDone = true;
    const message = error instanceof Error ? error.message : String(error);
    // Si el mensaje ya se mostro antes (FAIL / STOP), no lo repetimos.
    if (!logBuffer.some((line) => line.includes(message))) {
      writeLog(message, "error");
    }
    try {
      if (window.CrashLog) window.CrashLog.finish("failed", message);
    } catch (e) {}
  });
