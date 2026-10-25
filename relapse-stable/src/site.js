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

async function run() {
  cstage("site:run");
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
    // Clean finish: clears the "open" marker so the next launch does not
    // report a crash that never happened.
    try {
      if (window.CrashLog) window.CrashLog.finish("ok");
    } catch (e) {}
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    // Si el mensaje ya se mostro antes (FAIL / STOP), no lo repetimos.
    if (!logBuffer.some((line) => line.includes(message))) {
      writeLog(message, "error");
    }
    try {
      if (window.CrashLog) window.CrashLog.finish("failed", message);
    } catch (e) {}
  });
