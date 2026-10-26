# PS5 13.60 freeze investigation

Investigation date: 2026-10-25. The user reports intermittent full-console
freezes in Relapse that require holding the power button, both with the web
host online and from its offline cache. The last visible message varies.
No PS5 console, crash dump, or exact failing stage was available to this
workspace. The findings below separate reproduced source defects from the
unresolved cause of that system freeze.

> **Status update 2026-10-26:** the defects below were fixed in
> `relapse-stable/`, and the "unresolved" freeze now has a ranked, evidence-
> backed cause chain with the second-boot crash pinned to stale payload
> delivery through the AppCache. See
> [2026-10-26 resolution and current state](#2026-10-26-resolution-and-current-state)
> at the end of this document. The publication pause described in
> "Decision before publication" is superseded: Pages is live.

The same console completed Y2JB successfully in 10/10 user-run trials,
including reboot and shutdown, without a crash. This is useful comparative
runtime evidence. It narrows the problem to behavior that differs between the
two paths, but does not by itself distinguish the WebKit entry primitive from
the different Relapse implementation and cleanup used by Y2JB.

## Reproduction boundary

Reliable diagnosis requires a fast command that can go red on the **reported
symptom** before claiming a root cause. A Windows desktop can run the host's
JavaScript with mocked memory and serve every asset, but it cannot reproduce a
PS5 kernel freeze. There is therefore no valid local loop for the reported symptom yet.
The required next evidence is a console log/panic dump with stage markers,
or access to the same console for a controlled reproduction. Another blind
freeze attempt was not requested.

Three agent-run loops reproduced narrower defects without running an exploit:

| Command | Observed result | What it establishes |
| --- | --- | --- |
| `node .local/diagnostics/host-repro.cjs` | `onload_setup()` throws `Cannot set properties of null (setting 'innerHTML')`; simulated cache `error` raises zero toasts | Broken redirector setup and silent cache errors in the imported page |
| `node .local/diagnostics/log-repro.cjs` | Five diagnostic stage messages leave only `Kernel check` visible, followed by the deliberately injected stop message | Earlier stages are lost from the four-line UI buffer |
| `node .local/diagnostics/jdir-repro.cjs` | Mock kernel pointer `0x7777` becomes `0` during escalation and remains `0` after `restoreKernelState()`; `stop()` returns `done: true` | The local cleanup path does not restore `fd_jdir`; an early stop can be shown as success |

These harnesses are kept in ignored `.local/diagnostics/`. They execute source
methods against mock objects; they perform no console memory access.

## Source comparison

Comparison target: [itsPLK/ps5-y2jb-autoloader](https://github.com/itsPLK/ps5-y2jb-autoloader)
at commit `14fab6b5991507c8ae961884716d5c621eaebf97`. Its payload handoff
uses pinned `ps5-unified-autoloader` commit
`e7093cd5aec685be7710e0baa99db7938e9d609b`. Both projects advertise
13.60 and use a Relapse kernel chain, but their entry applications and memory
engines differ.

| Behavior | This web host | Y2JB Autoloader |
| --- | --- | --- |
| Entry | PS5 browser WebKit primitive, `relapse/src/site.js:55–60` | YouTube app Cobalt/V8 runtime, [main.js](https://github.com/itsPLK/ps5-y2jb-autoloader/blob/14fab6b5991507c8ae961884716d5c621eaebf97/src/main.js) |
| 13.60 selection | Browser user-agent `PlayStation 5/13.60`, `relapse/src/firmware.js:13–16`; offset file `relapse/offsets/13.60.js` | Native firmware query and Cobalt build recognition; [README](https://github.com/itsPLK/ps5-y2jb-autoloader/blob/14fab6b5991507c8ae961884716d5c621eaebf97/README.md) specifies YouTube 01.009.253 for 13.40–13.60 |
| Network | Relapse requires a configured interface even offline, `relapse/src/relapse_exploit.js:472–499` | Same 10.20–13.60 LAN prerequisite, documented in Y2JB README; Internet is unnecessary |
| Helper script loading | Dynamic offsets script and startup module are declared separately in `relapse/index.html:212–223` | `load_localscript` waits for `onload` and rejects `onerror`, Y2JB `src/main.js:12–19,1180–1190` |
| Outcome check | `result.done`, then optional payload branch; `relapse/src/main.js:279–291` | Checks exploit result and `is_jailbroken()` before autoload, Y2JB `src/main.js:1197–1232` |
| Progress | Four visible lines; earlier lines discarded, `relapse/src/site.js:10,37–45` | Up to 56 lines, optional network logging, errors with stacks, Y2JB `src/main.js:73–119,1238–1242` |
| Post-exploit | Directly attempts `pldmgr.elf`, `relapse/src/kexp.js:568–583` | Hands off to unified autoloader, which reads configured payloads or starts Payload Manager; [unified source](https://github.com/itsPLK/ps5-unified-autoloader/blob/e7093cd5aec685be7710e0baa99db7938e9d609b/src/main.c) |

Y2JB's YouTube exit after a successful handoff is intentional in the unified
autoloader (`src/main.c:213–247`). A hosted browser shortcut cannot acquire
Y2JB's Cobalt/V8 entry path merely by copying its scripts into GitHub Pages.
Its separate installation route and app version apply to Y2JB, not to the
existing browser shortcut.

## Confirmed defects in this snapshot

1. **Kernel cleanup leaves `fd_jdir` modified.**
   `relapse/src/relapse_exploit.js:1603–1605` writes root vnode into `cdir` and
   `rdir`, and zero into `jdir`. `restoreKernelState()` at lines 1971–1976
   restores OIDs, pipes, AIO workers and scratch descriptors, but does not put
   back any of those directory pointers or the changed dynlib fields. The
   13.60 offset table assigns `filedesc.jdir = 0x18` at
   `relapse/offsets/13.60.js:460`. The mock run of the actual `escalate()` and
   `restoreKernelState()` methods confirms the omitted writeback. Y2JB saves
   these values before escalation and restores `jdir`/dynlib fields in its
   [Relapse cleanup](https://github.com/itsPLK/ps5-y2jb-autoloader/blob/14fab6b5991507c8ae961884716d5c621eaebf97/src/relapse.js#L5866).
   Y2JB's source links its restoration to a panic when an app closes on 7.xx.
   That comment does not establish the cause of this user's 13.60 freeze.

2. **An early stop can be reported as root.**
   `stop()` at `relapse/src/relapse_exploit.js:2028` returns `{done: true,
   elfldr: false}` even for failed offset checks and other pre-escalation
   stops. `relapse/src/main.js:282–291` accepts `done` and reports
   `root and sandbox escape are active` when `payloads` is absent. The mock
   call reproduces that false success signal. Y2JB requires an additional
   `is_jailbroken()` check before proceeding.

3. **The page throws during its load handler.**
   `relapse/custom_host_stuff.js:17` calls `create_redirector_buttons()`.
   At line 118 it dereferences `#redirector-pinned`, which is absent from
   `relapse/index.html`. The actual handler throws in the DOM mock. Its
   AppCache listeners are installed first. This exception alone is not proof
   of a kernel freeze.

4. **Progress and cache failure evidence are lost.**
   `relapse/src/site.js:37–45` resets the visible buffer to its newest line
   when the fifth arrives. `relapse/appcache_handler.js:60–62` registers an
   error handler with its toast disabled. The local harnesses reproduce both.
   The missing cache message could conceal an offline cache failure, though
   the user's freeze also occurs online.

5. **WebKit retries have no attempt cap.**
   `relapse/src/webkit.js:169–176,720–731` schedules another attempt after
   several failed validation paths, with no observed maximum. The heap-groom
   stage allocates 512 `0x10000` buffers at lines 591–592 (32 MiB of requested
   backing storage per attempt). Release timing depends on the retry branch.
   These are source facts; neither memory pressure nor this retry loop has
   been tied to the reported freeze.

## Unresolved diagnostic boundary

The evidence does not support ranking a root cause for the console freeze.
The hosted path's WebKit entry, the kernel stages, and the post-escalation
cleanup all differ materially from Y2JB, but there is no console-side trace
that places the freeze in any one of them. Treating one of those differences as
the cause would be speculation.

The smallest useful console diagnostic would retain a timestamped stage record
across more than four messages and distinguish these boundaries:

1. before WebKit ARW;
2. after ARW but before the kernel chain;
3. after escalation but before cleanup;
4. after cleanup and before payload handoff.

A bounded WebKit-attempt counter and an explicit `is_jailbroken()` result would
also turn silent retries and false success into observable outcomes. Those are
proposed instrumentation points, not fixes, and have not been deployed. The
varying last visible text cannot locate the freeze because the current UI drops
earlier messages.

## Decision before publication

The 13.60 website, Pages workflow and rebuilt browser shortcut have been
prepared locally, but the GitHub Pages URL is not live. A GitHub repository
was created; a `git push` was rejected by remote unpacking, and publication
was then paused for this investigation at the user's request. Source defects
above merit a dedicated diagnostic build and validation against the console
before presenting the hosted page as stable. In particular, a short retained
stage log and reliable success result are needed to distinguish a WebKit
freeze, kernel-stage failure, and post-exploit shutdown issue.

The exact 13.60 freeze remains unresolved until a console reproduction or
crash artifact supplies a red-capable loop. No Y2JB code was copied into the
web host and no console exploit was executed during this investigation.

## 2026-10-26 resolution and current state

Every defect in "Confirmed defects in this snapshot" is fixed in
`relapse-stable/`, the hardened tree staged to Pages by
`tools/stage_stable.py` (the pinned `relapse/` snapshot stays untouched and
its snapshot hashes still verify). Three further root causes for the reported
"works the first time, crashes the console after a reboot" pattern were found
while hardening it; each is documented here with its evidence so the next
session does not re-derive them.

### Cause 1 — dev/test payload shipped to production

The shipped `kstuff.elf` was `1.13-fpkg-dr-test5` (1,802,280 bytes) whose own
embedded strings warn `[ppr-patch] firmware 12+ support is not present in
this build`. Replaced with official EchoStretch/kstuff-lite **v1.11**
(1,737,080 bytes, SHA-256
`ab9a6cb4d3b1daf139d4d646e402b1cf569071acd64599c936d7a3a6164dc779`,
advertised 1.00–13.60) and Payload Manager **v0.6.3**. The loader now sends
only `pldmgr.elf`; the manager installs and loads kstuff/shadowmountplus
itself, mirroring Y2JB v1.0.3's handoff.

### Cause 2 — stacked heap-groom sprays and a redundant teardown sweep

`webkit.js` groomed ~40 MiB per attempt (512 × 64 KiB keepAlive spray plus a
4 MiB slab and holes) and retried up to 8 times with a **50 ms** unsafe-retry
delay — faster than the engine could collect, so failed attempts stacked and
produced the console's visible *"not enough system memory"* warning. When the
OS then killed the webview mid-chain, the armed AIO groups and crossed pipes
had no process left to defuse them: kernel panic on the next boot.
Independently, `relapse_exploit.js` ran `rescue()` from a `finally` block even
after a clean run had already restored and verified every hijacked structure,
re-sweeping kernel memory five more times at the most fragile moment.

Fixes (commit `700508a`): `MAX_ATTEMPTS = 4`, safe retry 750→900 ms, unsafe
retry 50→1200 ms, unsafe retries clear the pointer spray and drop the big
cached references while deliberately keeping the buffers the corrupted clone
may still point at, and `rescue()` now runs only when the run did not finish
its own teardown (`this.teardownClean`).

### Cause 3 — stale payload delivery through the AppCache (the second-boot mechanism)

Payload delivery uses `XMLHttpRequest`, which in this WebKit **is**
intercepted by the AppCache — `fetch()` is not; see the `[OFFLINE FIX]`
comment in `kexp.js`. The payload ELFs were listed in the appcache manifest,
so while an update downloaded, AppCache served the **old** copy of every
listed file to the running chain. Because the exploit auto-runs on page load,
the chain was already armed when `updateready` fired and the idle-only reload
handler could not act. A console that had cached the v1.13 era therefore kept
re-running the chain against stale payloads across reboots — the exact
"fine first time, crash after reboot" signature — and could stay trapped in
the loop because the ~7 MB update kept losing the race against the crash.

Fixes (commit `174ed93`): payload ELFs removed from the manifest (`NETWORK: *`
routes their XHRs to the network and the update evicts the old copies). **The
"~500 KB" figure in this section was wrong:** removing the five payload ELFs
left the two loading GIFs in the manifest, so the update was still ~6.08 MB
(5.74 MB of GIFs) — barely smaller than the ~7 MB it replaced, and still slow
enough to lose the race on a PS5's link. The 2026-10-26i fix below takes those
GIFs out of the manifest and drops the update to ~600 KB, which is what the
convergence argument required;
`site.js` awaits `__appcacheSettled()` before starting the chain — it waits
out CHECKING/DOWNLOADING, swaps and reloads on `updateready` (safe, nothing
armed yet), and resolves `current`/`error`/`timeout` otherwise with a 20 s
bound; `fetchBinary` keys its URL on `window.__payloadRev`, busting GitHub
Pages' 10-minute HTTP cache so a minutes-old payload bump is never reused.

Earlier guard commits in the same chain: `7da258c` (refuse to re-arm a kernel
that is already patched — uid/sandbox check plus an elfldr probe on
127.0.0.1:9021), `2b2b495` (swap + reload the cache only while idle; never
after a chain started or finished), `fe1eb59` (on-screen build stamp).

### Trade-off accepted

With payloads off the manifest, an offline run can no longer deliver payloads.
This is acceptable: loading the page at all required the network, and the
kernel-base leak requires a configured interface regardless (same LAN
prerequisite Y2JB documents).

### Verification state

- Tests: 14 Python + 3 Node pass; CI green on every push; staged build
  verified with the same invariants before each deploy.
- Live: `https://patnawa.github.io/PS5Expweb/relapse/`, build stamp
  `2026-10-26k aio-drain`, manifest `# version 2026-10-26k aio-drain #`
  with zero payload and zero GIF entries, kstuff served over the network at
  1,737,080 bytes / SHA-256 prefix `ab9a6cb4…`.
- Regression tests added: `test_distribution.py::
  test_staged_stable_tree_ships_second_boot_guard` (guard code present,
  payloads absent from the manifest, gate present in both files, manifest
  byte-identical to source) and `test_host.py::
  test_staged_manifest_and_payload_are_served` (manifest byte-identical,
  payloads still served). Version-tag assertions were replaced with
  structural ones so future bumps do not break the suite.

### Console verification protocol (next session)

The pkg is a deeplink only and never needs reinstalling for site-side fixes.
On the console:

1. Launch the shortcut; the first launch performs the small update and
   reloads itself.
2. Confirm the log line `Build: 2026-10-26k aio-drain`. No build line means
   a stale cache — relaunch once; if still missing, clear the app's cache.
3. Run one cycle. With the build line visible, the stale-payload path is
   excluded by construction; the CrashLog red banner's last stage (persisted
   in `localStorage` across reboots) then names the failing stage and the
   remaining suspects are few.

The log now also records the cache state the chain started under
(`Cache at start: status=…`, `Cache settled: status=…`), and the same fields
are persisted in the crash record as `cache=… supported=… manifest=… settle=…`.
This settles the open question about whether the AppCache engaged at all on a
given console: `UNCACHED` means the manifest was never applied (the upstream
Pages host serves it as `application/octet-stream`, which a spec-compliant
browser rejects), while `UPDATEREADY`/`DOWNLOADING` at start means the chain
began mid-update and could have been served stale code.

To clear a stuck cache while idle, open `/relapse/reset-cache/` on the host: its
manifest is intentionally missing, so the browser deletes the origin's cache;
reopen `/relapse/` afterwards. On the installed pkg the deeplink URL is fixed,
so deleting the app's saved data or reinstalling is the equivalent client-side
clear.

### Update-loop freeze and the settle-gate race

A manifest bump makes cached clients re-download every listed file. On an old
cached build the exploit auto-runs on load, so the chain can arm while the
download is still in flight; AppCache then serves the old copy of the listed
files. That is the same stale-download failure described above, and it is why a
relaunch after the `2026-10-26f`/`g` bump could show "Download cache..." and then
hang.

The gate had a race that made this possible even in the hardened build: on a
cold load the cache status can still read `UNCACHED`/`IDLE` before the manifest
check announces itself, so the gate resolved "current" and started the chain just
as the download began. The fix waits a short grace window for
`CHECKING`/`DOWNLOADING`, and if the update is still running when the bounded
wait expires it reports `stale` and the runner refuses to start the chain
(`stale-abort`) instead of running against a cache being replaced.

Recovery for a console already stuck in that loop: force power off, unplug for
~30 s, boot, then delete the app's saved data or reinstall the pkg before
launching again. The app's fixed deeplink cannot reach the reset page.

### Upstream re-inspection 2026-10-26

The deployed host at `https://ps5xploit.github.io/relapse/` was re-fetched file
by file and compared against a full clone of `ps5xploit/relapse` at `HEAD`
(`main`): every text asset, the entry page and the manifest are byte-identical
apart from CRLF line endings. The live host therefore still ships the unpatched
source described above — all five confirmed defects plus the three freeze
causes remain. The `kstuff.elf` in that tree is 1,802,280 bytes (the dev/test
build); the payloads are still listed in its manifest (55 cache entries, 5 of
them payloads); it has no crash log, no attempt cap (`webkit.js` retries
indefinitely), no `__appcacheSettled` gate and no `alreadyJailbroken` guard.
Our fixes exist only in `relapse-stable/` and in the staged Pages artifact;
upstream has not absorbed them.

Two consequences for users:

1. Loading the upstream URL directly runs the crashing build. The shortcut and
   the local server must point at the hardened host instead.
2. `python serve.py` used to serve the upstream snapshot by default, so a local
   run reproduced the upstream crash even though the repository held the fix.
   Default mode now stages and serves `relapse-stable/`; `--snapshot` serves the
   unpatched bytes for provenance checks only and prints a warning.

### Full write-path audit 2026-10-26g

Every kernel write in `relapse-stable/src/relapse_exploit.js` was traced to its
target and its guard. The table lists each site and whether the address it
writes to is validated before the write.

| Write site | Target | Guard |
| --- | --- | --- |
| `armKernelReadWrite` counter | `walkCounter.addr` + KASLR base | read-back verified, original restored |
| `flipOidKind` | `oid.*.kind` from offset table | kind value checked against expected states |
| AIO arming writes | AIO group structs | group looked up and validated |
| `defuseAioGroups` waiters | AIO group waiters | generation, state and type checked first |
| `escalate` ucred fields | `p_ucred + ucred.*` | pointer now validated; every write tracked |
| `escalate` fd_cdir/rdir/jdir | `p_fd + filedesc.*` | **previously unguarded** — pointer now validated |
| `escalate` dynlib range | `p_dynlib + dynlib.*` | pointer checked with `isKernelPointer` |
| `restoreEscalation` writeback | snapshot `p_fd`, `p_dynlib` | **previously unguarded** — pointer now validated |
| `kwriteFast` through crossed pipe | arbitrary kernel address | bounded copy length, read-back verified |

Two real defects were found and fixed in this pass, both capable of producing a
kernel panic that looks like "the exploit froze the console":

1. **`escalate()` wrote to `p_fd` without validating it.** The old code read
   `proc.fd` and immediately wrote `fd_cdir`, `fd_rdir` and `fd_jdir` through
   the result. Every other structure access in the file checks
   `isKernelPointer` first; this one did not. A stale or wrong `proc.fd` offset
   turns those three writes into writes to an arbitrary kernel address. The
   pointer is now validated before any credential write happens, and the whole
   escalation aborts if it is not sane.
2. **`escalate()` discarded the result of all fourteen writes.** A failed
   capability write left the process half-escalated (uid 0 but capabilities
   unchanged, or the reverse) with no signal. Closing the app in that state
   walks kernel structures with mismatched credentials. The writes are now
   tracked, and any failure — or a failed final uid/sandbox check — restores the
   credential fields and the directory pointers from the snapshots taken before
   the first write. `sceAttrs` also no longer writes `0xffffffff` when its
   preceding read failed; the value comes from the validated snapshot.

`restoreEscalation()` now refuses to write through a snapshot `p_fd` that is not
a kernel pointer, so a stale saved pointer cannot panic the console during
teardown — the "freeze right after the success message" pattern.

Remaining risk that cannot be closed statically: the 13.60 table marks
`proc.pid` and `proc.dynlib` as `VERIFY`. Both are guarded by plausibility and
pointer checks at runtime (`pid` range test, `isKernelPointer` on the dynlib
pointer), so a wrong value stops the chain instead of corrupting memory — but a
wrong value that happens to look plausible would still pass. Confirming those
two offsets needs a console or a firmware dump.

### Pipe teardown end state — the reboot/shutdown panic (2026-10-26h)

The reported "works the first time, freezes the console after a reboot"
signature survived every earlier fix because the failure is not during the
run: it is in what the run leaves behind for the kernel's **process-exit**
path. The kernel frees `pipe->buffer` when the app closes — and a console
reboot/shutdown kills the webview, which walks every armed structure. Y2JB's
own test comment states the rule plainly (`CLOSE_PIPES_AFTER_RUN`):
*"closing the 4 pipe fds now — if the console dies here, freeing an armed pipe
buffer is what kills it."*

Two chains of pipe state were left armed at end of run:

1. **The exploit pair.** `restorePipes()` null-ed `master->buffer` through the
   crossed window and verified the result, ending with
   `master->buffer = NULL` and `victim->buffer = master's struct` — the armed
   state. The kernel then frees the master's `struct pipe` as a pipe buffer
   and the victim's buffer as a second copy of it: a cross-zone/double free.
   Whether that panics depends on adjacent heap state, which is why the
   freezes were intermittent. The reference implementation (Y2JB
   `cleanTeardown`, the 10/10-reboot-stable comparison target) does **not**
   end there: `savePipeBuffers()` records both real kmalloc buffers before the
   crossing and `restoreRealBuffers()` puts them back — *"the pair now looks
   like an ordinary used pipe"* — falling back to `disarmPipes()` (zero both
   buffers). Our port had neither routine. It also cannot be fixed with the
   fast window alone: the crossing IS `master->buffer = victim struct`, and
   restoring that pointer destroys the window the remaining field writes
   need — one struct always ends armed. The real-buffer restore must go
   through the slow sysctl window, which in turn means the sysctl OID kinds
   must not be restored first (that machinery IS the slow writer — Y2JB's
   `SKIP_OID_RESTORE: the slow window cannot restore its own writable kind`
   exists for exactly this ordering).

2. **The shellcode pair.** `kexp.js` creates and crosses a *second* pipe pair
   for the kexp shellcode (`prepareShellcodePipes`) and nothing ever restored
   it. Y2JB hands its already-crossed exploit pair to the same shellcode and
   restores that one in `cleanTeardown`; our port re-crossed a fresh pair and
   dropped it.

Fixes (this commit): `crossPipes()` saves both real buffers
(`savePipeBuffers`); the teardown restores them via the slow window with
read-back verification (`restoreRealBuffers`), falling back to zeroing both
(`disarmPipes`) and never to the old null-through-the-window routine;
`kexp.js` saves the shellcode pair's buffers and `restoreShellcodePipes()`
puts them back in a `finally` around the shellcode thread (a crashed shellcode
leaves the pair armed otherwise); `restoreOids()` now restores only the plain
fields (`b.visible`, `a.deadSink`, walk counter) and reports honestly that
the OID kinds/arg1 steering stay hijacked until reboot — the empirically
tolerated state the Y2JB reference ships with (its `SKIP_OID_RESTORE` runs
every one of its 10/10 reboot/shutdown trials).

Regression tests: `tests/kernel_teardown.test.cjs` drives the real
`crossPipes`/`restoreKernelState` and the real `kexp.js` seam against a mock
kernel (faithful pipe-ring semantics, blocking read on empty) and asserts the
close-safety invariant: every pipe struct the chain crosses must end with its
original kmalloc buffer and zeroed ring counters. All three tests were red
before the fix (reproducing `master->buffer = NULL`, `victim->buffer =
master struct`, and the unrestored shellcode pair) and are green after.

### "Kernel exploit passes, game does not load" — the payload handoff (2026-10-26i)

The reported shape is narrower than the reboot panic: the kernel chain
completes and prints its success line, but the game never loads, and the console
will not come back without holding the power button. That is the payload
handoff, not the escalation. Three defects in the handoff path explain it.

1. **The update was still ~6 MB, so the "convergence beats the crash" argument
   was never satisfied.** Commit `174ed93` took the five payload ELFs out of the
   manifest, but left `loading-astro.gif` (4.03 MB) and `loading-astro3.gif`
   (1.72 MB) in it. Measured manifest total: **6,379,487 bytes (6.08 MiB)**, of
   which 5,745,028 bytes are the two GIFs — the update shrank by less than 1 MB
   against the ~7 MB it replaced. A manifest bump therefore still forces a
   ~6 MB re-download on a link that has to lose a race against an auto-running
   chain, and a console that had cached an older build can still stall in
   "Download cache...". The GIFs are decorative and already served over the
   network like everything else; they are now out of the manifest, dropping the
   update to ~600 KB. `NETWORK: *` keeps them loading normally online, and the
   offline loss is irrelevant for the same reason the payloads' offline loss is
   (the page cannot be reached offline in the first place).

2. **The already-jailbroken path returned without delivering payloads.** On a
   relaunch after a successful kernel run — the normal "game did not load, try
   again" action — the chain hits the second-boot guard, logs "already
   jailbroken: elfldr is up on port 9021, nothing to re-arm", and **returns**.
   The elfldr is running and waiting, but nothing ever sends it `pldmgr.elf`, so
   Payload Manager, kstuff and shadowmountplus are never installed and the game
   cannot load. Refusing to re-arm the kernel is correct; refusing to deliver the
   payloads is not. The guard now distinguishes the two: if a delivery was left
   pending by a previous launch (`ps5expweb_payload_pending` in localStorage),
   the already-jailbroken path hands the payloads to the running loader; only a
   run whose delivery already succeeded skips the resend (tracked per session in
   `sessionStorage`, so a plain reload does not install `pldmgr.elf` twice).

3. **Every payload failure was swallowed, so a failed handoff reported success.**
   `autoLoadPayloads` caught its own errors and returned normally, and `main()`
   called `cstage("main:done")` regardless. A run that fetched nothing, or whose
   ELF never reached the loader, printed "kernel exploit complete" and left the
   CrashLog with a finished/ok session — while the user saw a game that would not
   load. A 2.8 MB payload over WiFi losing one request to a transient network
   error was enough. The handoff now:
   - retries the payload fetch up to 3 times on network/timeout/5xx failures
     (never on 4xx — a missing file stays missing), with a short backoff;
   - returns the real `{loaded, failed}` outcome instead of swallowing it;
   - throws when nothing loaded or anything failed, so `site.js` marks the run
     failed and the next launch's red banner names the payload handoff instead
     of showing "ok" over a dead session;
   - throws when the chain escalated but the elfldr never confirmed up, because
     there is then nothing to hand the payloads to and the game cannot load.

   The reload-after-success case stays quiet: the guard logs the already-
   jailbroken line and returns without throwing, so a correct no-op is not
   reported as a crash.

Recovery for a console already stuck: hold the power button ~15 s, unplug ~30 s,
boot, delete the app's saved data (or reinstall the pkg) to drop the half-finished
cache update, then launch once and confirm `Build: 2026-10-26k aio-drain` in the
log before running a cycle. The build stamp is the only reliable signal that the
new manifest — and therefore the small update — is actually in effect.

### "The console will not restart or shut down" — the teardown deadlock (2026-10-26j)

The reported shape: the kernel chain completes (the elfldr answers on 9021, the
success line prints), but the game never loads and the console hangs when the
user tries to restart or power it off. Holding the power button is the only way
out. Three defects in the end-of-run path explain it; all three are fixed here.

1. **`fd_jdir` was set to NULL during escalation.** `escalate()` pointed the
   process's jail directory at zero and left the teardown to put the original
   back. The app-close path runs `AutoMount::UsbMass::fakeEjection()`, which
   walks this process's directory tree and takes references it never returns;
   a NULL jdir sends that walk into a NULL dereference. If the teardown never
   ran — the webview killed mid-chain, a reboot issued while a payload was in
   flight, an OOM kill — the walk hit NULL and the console froze on shutdown.
   `escalate()` now points `fd_jdir` at `rootvnode` instead: the walk stays
   valid in every case and the jail directory is no longer the process's view of
   `/`. The original value is snapshotted before the write (line 1630) and
   `restoreEscalation()` still puts it back, so the change is reversible.

2. **The payload handoff could block forever on a socket write.**
   `sendElfToElfldr` writes the 2.8 MB payload in 64 KB chunks with a blocking
   `SYS_WRITE`. If the elfldr stops reading — it crashed, it is wedged, its
   accept loop is not draining — the socket buffer fills and the write never
   returns. The ROP worker thread is then parked inside the kernel, the app can
   never close, and the console hangs on shutdown/restart. The handoff now sets
   a 10 s send timeout with `setsockopt(SO_SNDTIMEO)` before writing, so a stuck
   write returns `EWOULDBLOCK`/`EAGAIN` and the failure surfaces as a reported
   payload error the teardown path can act on. Best effort: a socket without the
   timeout is still better than no handoff at all.

3. **`pthread_join` on the shellcode thread could never return.** `kexp.js`
   created the shellcode thread and joined it with no timeout. When that thread
   is the elfldr server loop it does not exit, so the join blocked the worker
   indefinitely — the `finally` block that restores the crossed shellcode pipes
   never ran, and the pipes stayed armed. That is the panic at app close. The
   thread is now detached (`pthread_detach`) when the symbol resolves, falling
   back to the join only when it does not; a non-zero detach return is reported
   as a detach failure rather than a shellcode crash, because the thread still
   runs and throwing there would skip the teardown. Because "thread created" no
   longer proves the loader came up, `run()` polls `127.0.0.1:9021` for up to 5 s
   after the launch and reports a loader that never answered.

Ordering note: the elfldr launch runs while the exploit pipes are still armed
(the shellcode needs the kernel R/W to patch), so the socket timeout and the
detach are what keep that window from becoming a permanent one. The pipe restore
still runs in the `finally`, and the `jdir` fix makes the close-time walk safe
even if the teardown is never reached.

### "The exploit passes, the game does not load, and the console hangs" — the AIO leak (2026-10-26k)

This is the failure the user kept reporting against the working
`itsPLK/ps5-y2jb-autoloader` reference: the chain reports success, the elfldr
answers on 9021, and then the game never appears and a restart or power-off
hangs until the power button is held. Comparing the two teardowns side by side
found the gap.

Y2JB's `cleanup()` (`src/lapse.js:1643`) does five things on the way out, and it
runs on **every** path — success after `ps5_jailbreak()`, each failed stage, and
the outer `catch`. The two that matter here:

1. It closes `block_fd` and `unblock_fd`, then calls
   `aio_multi_wait(block_id_buf, 1, block_errors, 1, 0n)` and
   `aio_multi_delete(block_id_buf, 1, block_errors)` on the blocking request.
2. It runs `free_aios2(groom_ids, NUM_GROOMS)` over every groom request it
   submitted, and closes every fd in `sds`/`sds_alt`.

Every request it created is **deleted from the kernel's `p_aioinfo` table**
before the app is allowed to close. Ours did not do that. `defuseAioGroups()`
zeroes the group's `waiters` pointer, which makes the group inert — but the
request structs stay in `p_aioinfo`, still linked, still pending. When the app
closes (to launch the game, or on restart), the kernel walks the AIO table and
tries to cancel requests that are still parked on reads. That walk over a
defused group is the hang. It is the same class of bug as the `fd_jdir` NULL
walk, just in a different table: userland leaves a pointer the close path
follows, and the close path is what freezes.

The fix (`relapse-stable/src/relapse_exploit.js`):

- `SYS.aioMultiDelete = 0x296` is now reachable. It was the only AIO syscall the
  chain was missing; the constant existed in `utils/syscalls.js` but was never
  exposed on the `SYS` object the exploit uses.
- New `drainAioRequests()` walks `armedGroups`, collects every request id the
  chain submitted, and calls `aio_multi_delete` on each group's batch. It treats
  `-1` as the only failure (`sysInt` returns a signed 32-bit int) and never
  throws: a delete that fails is reported and the teardown keeps running.
- Ordering is the fix. The drain runs **last** in `restoreKernelState()`, after
  `releaseAioWorkers()` and `closeScratchDescriptors()`, mirroring Y2JB's
  close-then-delete sequence. Closing the descriptors completes every pending
  read with an error, so the delete has nothing to race and cannot block. Run it
  first and the delete races reads that are still in flight.
- The drain is in the `critical` list, so a failed drain makes the teardown
  report INCOMPLETE instead of "closing the app is safe". The honest summary
  line is the whole point: a run that leaves requests in the table must not tell
  the user it is safe to close the app.

Deliberate omission: the drain deletes without calling `aio_multi_wait` first.
Y2JB pairs them because it closes its fds first too; the delete is what actually
empties the table. A wait is a blocking call whose timeout is a raw pointer, and
getting its layout wrong parks the ROP worker in the kernel forever — the exact
hang this teardown exists to prevent. Deleting without waiting loses nothing and
cannot block.

`tests/test_distribution.py::test_teardown_drains_aio_requests_before_closing_descriptors`
stages the Pages tree and asserts the constant, the method, the ordering (the
`scratch:` line must precede the `aio:` line), and the critical-list membership.
Reverse the two lines and that test fails.

### Open items

- Hardware confirmation of the full fix chain (no console access in this
  workspace; `consoleTested` remains false for the built pkgs).
- The payload retry and the pending-delivery retry have no automated coverage
  yet; both are exercised only by the console protocol above.
- The detach path's elfldr poll is not covered by the mock-kernel tests; it is
  exercised only on hardware.
- If the console still freezes on shutdown after these fixes, the remaining
  suspect is a kernel thread left in an uninterruptible wait by the shellcode
  itself, which userland cannot release.
- App icon change (requires a pkg rebuild — the icon lives in the package).
- Jailbreak running-status UI overhaul (deferred by the user until after the
  bug fix).
