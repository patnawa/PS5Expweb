/* Durable crash log for the PS5 browser host.
 *
 * Why this exists: when the kernel chain freezes the console, the on-screen
 * log dies with the process and nothing survives. This logger writes every
 * line to localStorage synchronously, so whatever ran before the freeze is
 * already on disk. A 2s heartbeat records "still alive at T+Ns, last stage X",
 * so the next launch can show exactly where the previous run stopped.
 *
 * Storage layout:
 *   ps5expweb_crashlog_v1  -> { session, lines[] }   (full record, bounded)
 *   ps5expweb_crashlog_hb  -> compact heartbeat      (cheap, written often)
 *
 * On load: if the stored session is still open, the page died without
 * finishing -> render a banner with the last stage and a Copy-log button.
 *
 * Classic script, ES5-safe syntax: it must run before the module graph and
 * cannot depend on anything the exploit defines.
 */
(function () {
  "use strict";

  var KEY = "ps5expweb_crashlog_v1";
  var KEY_HB = "ps5expweb_crashlog_hb";
  var MAX_LINES = 400;
  var HEARTBEAT_MS = 2000;

  var session = null;
  var lines = [];
  var timer = null;
  var storageOk = true;

  function nowIso() {
    try {
      return new Date().toISOString();
    } catch (e) {
      return "";
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ session: session, lines: lines }));
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
  }

  function saveHeartbeat() {
    if (!session) return;
    // Keep the in-memory copy fresh too, but only rewrite the compact key:
    // re-serialising the whole 400-line ring every 2s would cost real time
    // on the console's WebKit and add jank to the exploit itself.
    session.heartbeatMs = Date.now() - session.startMs;
    session.heartbeatIso = nowIso();
    try {
      localStorage.setItem(
        KEY_HB,
        JSON.stringify({
          startMs: session.startMs,
          lastStage: session.lastStage,
          ms: session.heartbeatMs,
          iso: session.heartbeatIso,
          open: session.open,
          cache: session.cache || null,
        }),
      );
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
  }

  function readPrev() {
    var prev = null;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") prev = parsed;
      }
    } catch (e) {
      storageOk = false;
    }
    return prev;
  }

  var lastSaveMs = 0;
  var SAVE_INTERVAL_MS = 1000;

  function append(line, type) {
    var t = type || "log";
    var entry = {
      t: nowIso(),
      ms: session ? Date.now() - session.startMs : null,
      type: t,
      line: String(line),
    };
    lines.push(entry);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);

    // Persisting the whole ring on every line is real work on the console's
    // WebKit. Stages, errors, finish markers and crumbs always flush; ordinary
    // lines batch to at most once a second. A freeze still leaves every
    // completed stage on disk, which is what matters for diagnosis.
    var now = Date.now();
    var force =
      t === "stage" || t === "error" || t === "done" || t === "crumb";
    if (force || now - lastSaveMs >= SAVE_INTERVAL_MS) {
      lastSaveMs = now;
      save();
    }

    try {
      console.log("[CrashLog " + Math.round(entry.ms) + "ms] " + entry.line);
    } catch (e) {}
    return entry;
  }

  var CrashLog = {
    stage: function (name, detail) {
      if (!session) return;
      session.lastStage = String(name);
      session.stageMs = Date.now() - session.startMs;
      append("STAGE " + name + (detail ? ": " + detail : ""), "stage");
      saveHeartbeat();
    },

    info: function (message, type) {
      if (!session) return;
      append(message, type || "log");
    },

    error: function (message) {
      if (!session) return;
      append("ERROR " + message, "error");
      saveHeartbeat();
    },

    heartbeat: function () {
      if (!session || !session.open) return;
      saveHeartbeat();
    },

    /* Record the appcache state the chain started under. Written once, after
       the settle wait, so a freeze leaves "cache=UPDATEREADY/DOWNLOADING" next
       to the last stage instead of an unexplained missing build stamp. */
    cache: function (info) {
      if (!session) return;
      session.cache = info;
      save();
      saveHeartbeat();
    },

    finish: function (status, detail) {
      if (!session) return;
      append("FINISH " + status + (detail ? ": " + detail : ""), "done");
      session.open = false;
      session.status = String(status || "ok");
      session.endMs = Date.now() - session.startMs;
      session.lastStage = "finished";
      save();
      saveHeartbeat();
      CrashLog.stopHeartbeat();
    },

    startHeartbeat: function () {
      if (timer) return;
      try {
        timer = setInterval(CrashLog.heartbeat, HEARTBEAT_MS);
      } catch (e) {
        timer = null;
      }
    },

    stopHeartbeat: function () {
      if (!timer) return;
      try {
        clearInterval(timer);
      } catch (e) {}
      timer = null;
    },

    dump: function () {
      return { session: session, lines: lines.slice(), storageOk: storageOk };
    },

    text: function () {
      var d = CrashLog.dump();
      var out = [];
      var i;
      out.push("# PS5Expweb crash log");
      if (d.session) {
        var s = d.session;
        out.push(
          "status=" + s.status +
          " open=" + s.open +
          " lastStage=" + s.lastStage +
          " stageMs=" + Math.round(s.stageMs || 0) +
          " heartbeatMs=" + Math.round(s.heartbeatMs || 0),
        );
        out.push("started=" + s.startIso + " ua=" + (s.meta && s.meta.ua ? s.meta.ua : "?") +
          " fw=" + (s.meta && s.meta.fw ? s.meta.fw : "?"));
        if (s.cache) {
          out.push(
            "cache=" + (s.cache.statusName || "?") +
            " supported=" + s.cache.supported +
            " manifest=" + s.cache.manifest +
            " settle=" + (s.cache.settle || "n/a") +
            " online=" + s.cache.online,
          );
        }
        if (s.endMs != null) out.push("endedMs=" + Math.round(s.endMs));
      }
      out.push("---");
      for (i = 0; i < d.lines.length; i++) {
        var e = d.lines[i];
        out.push("[" + Math.round(e.ms) + "ms] " + String(e.type).toUpperCase() + " " + e.line);
      }
      if (!d.storageOk)
        out.push("(localStorage unavailable: this log is memory-only and will NOT survive a freeze)");
      return out.join("\n");
    },

    /* Read the record left by the previous page load. Called before begin(). */
    peek: function () {
      var prev = readPrev();
      if (!prev || !prev.session) return null;
      var s = prev.session;
      var ls = Array.isArray(prev.lines) ? prev.lines : [];
      // The full record's heartbeat only updates on real log lines; the
      // compact key is written every 2s. Merge it so the banner reports how
      // long the run actually stayed alive before it stopped.
      try {
        var raw = localStorage.getItem(KEY_HB);
        if (raw) {
          var hb = JSON.parse(raw);
          if (hb && hb.startMs === s.startMs) {
            s.heartbeatMs = hb.ms;
            s.heartbeatIso = hb.iso;
            s.lastStage = hb.lastStage || s.lastStage;
            s.open = hb.open === true;
            if (hb.cache) s.cache = hb.cache;
          }
        }
      } catch (e) {
        storageOk = false;
      }
      return { crashed: s.open === true, session: s, lines: ls };
    },

    begin: function (meta) {
      var prev = readPrev();
      var previous = prev && prev.session ? prev.session : null;
      session = {
        startMs: Date.now(),
        startIso: nowIso(),
        open: true,
        status: "running",
        lastStage: "boot",
        stageMs: 0,
        heartbeatMs: 0,
        heartbeatIso: nowIso(),
        meta: meta || {},
        previous: previous,
        storageOk: true,
      };
      lines = [];
      save();
      saveHeartbeat();
      CrashLog.startHeartbeat();
      append("CrashLog armed; a freeze leaves the last stage on disk", "stage");
      return session;
    },

    showCrashBanner: function (info) {
      try {
        if (!info || !info.crashed) return;
        var existing = document.getElementById("crashlog-banner");
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        var s = info.session;
        var last = info.lines.length ? info.lines[info.lines.length - 1] : null;

        var box = document.createElement("div");
        box.id = "crashlog-banner";
        box.style.cssText =
          "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
          "background:#2a0b0b;color:#ffd7d7;border-top:3px solid #d33;" +
          "padding:8px 12px;font:12px/1.45 monospace;white-space:pre-wrap;" +
          "max-height:42vh;overflow:auto;text-align:left;";

        var head = document.createElement("div");
        head.textContent =
          "PREVIOUS RUN DID NOT FINISH\n" +
          "last stage: " + s.lastStage + " at " + Math.round(s.stageMs || 0) + "ms" +
          "  (alive " + Math.round(s.heartbeatMs || 0) + "ms)" +
          (last ? "\nlast line: " + last.line : "");
        box.appendChild(head);

        var bar = document.createElement("div");
        bar.style.cssText = "margin-top:6px;";

        var copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy log";
        copy.style.cssText =
          "padding:4px 10px;font:12px monospace;cursor:pointer;margin-right:8px;" +
          "background:#3a1414;color:#ffd7d7;border:1px solid #d33;border-radius:3px;";
        copy.onclick = function () {
          var txt = CrashLog.text();
          var done = function () { copy.textContent = "Copied"; };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(txt).then(done, function () { copy.textContent = "Copy failed"; });
            } else {
              var ta = document.createElement("textarea");
              ta.value = txt;
              ta.style.cssText = "position:fixed;left:-9999px;";
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              done();
            }
          } catch (e) {
            copy.textContent = "Copy failed";
          }
        };

        var dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.textContent = "Dismiss";
        dismiss.style.cssText = copy.style.cssText;
        dismiss.onclick = function () {
          if (box.parentNode) box.parentNode.removeChild(box);
        };

        bar.appendChild(copy);
        bar.appendChild(dismiss);
        box.appendChild(bar);

        (document.body || document.documentElement).appendChild(box);
      } catch (e) {}
    },
  };

  window.CrashLog = CrashLog;

  /* Boot: report the previous run, then arm a new one. Placed after
     firmware.js so the firmware string is available for the record. */
  try {
    var prev = CrashLog.peek();
    if (prev) CrashLog.showCrashBanner(prev);
    CrashLog.begin({
      ua: navigator.userAgent,
      fw: window.fw_str || "",
      href: String(location.href),
      prevCrashed: !!(prev && prev.crashed),
      prevStage: prev && prev.session ? prev.session.lastStage : null,
    });
  } catch (e) {
    try {
      console.log("[CrashLog] boot failed: " + e);
    } catch (e2) {}
  }

  /* Anything that escapes the exploit's own handlers still gets recorded. */
  try {
    window.addEventListener("error", function (ev) {
      try {
        CrashLog.error(
          (ev && ev.message ? ev.message : "window error") +
            " @ " + (ev && ev.filename ? ev.filename : "?") +
            ":" + (ev && ev.lineno ? ev.lineno : "?"),
        );
      } catch (e) {}
    });
    window.addEventListener("unhandledrejection", function (ev) {
      try {
        var r = ev && ev.reason;
        CrashLog.error("unhandled rejection: " + (r && r.message ? r.message : String(r)));
      } catch (e) {}
    });
  } catch (e) {}
})();
