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

const BUILD = "2026-10-26f cache-report";

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
  .then(() => {
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
