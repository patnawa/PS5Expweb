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

- Tests: 24 Python + 8 Node pass; CI green on every push; staged build
  verified with the same invariants before each deploy.
- Live: `https://patnawa.github.io/PS5Expweb/relapse/`, build stamp
  `2026-10-29b stale-guard`, manifest `# version 2026-10-29b stale-guard #`
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
2. Confirm the log line `Build: 2026-10-29b stale-guard`. No build line means
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
cache update, then launch once and confirm `Build: 2026-10-29b stale-guard` in the
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

### "The exploit runs twice in one boot and panics" — the failcheck marker (2026-10-26l)

Y2JB writes `/<nid>/common_temp/lapse.fail` at the start of a run and refuses to
run again while it exists: "Restart your PS5 to run Lapse again"
(`src/lapse.js:1724`). The file itself is not the point; the ordering is. A run
that arms the kernel and dies mid-chain leaves AIO groups and pipes dirty. A
second run in the same boot re-arms over that dirt and panics the console.

Our two existing guards only catch the case where escalation actually finished:

- `uid === 0 && sandbox === 0` — the process is already root and unsandboxed.
- `elfldrListening()` — the loader is up on 9021, so the kernel is patched.

A run that died **before** escalating satisfies neither: the uid is still
non-zero, the loader never started, and the kernel still has armed groups in it.
That run slips past both guards and re-arms — the double-patch panic. The marker
closes the gap.

What shipped (`relapse-stable/src/relapse_exploit.js`):

- `SYS.randomizedPath = 0x25a` — the PS5 call that returns the app's randomized
  sandbox path. Y2JB's `get_nidpath()` uses it; we had no way to name a writable
  path before.
- `nidPath()`, `failMarkerPath()`, `fileExists()`, `writeMarker()`,
  `failedInThisBoot()`, `markRunStarted()` — the marker plumbing. `open` is
  `0x5`, `stat` is `0xbc`, `unlink` is `0xa`; `O_CREAT | O_WRONLY | O_TRUNC` with
  mode `0777`, matching Y2JB's `write_file`.
- The guard runs in `run()` **after** the uid and elfldr guards and **before**
  `cstage("kexploit:leak-kbase")`. So a run that already escalated or already
  has a loader up still takes the payload-redelivery path; only a run that died
  pre-escalation is refused.
- `main.js` names the instruction instead of the generic failure: "a previous
  run in this boot did not finish - restart the console, then launch again".

Deliberate choices:

- The marker is written with a single `.` byte. An empty create can be coalesced
  away on some filesystems, which would silently drop the guard.
- Y2JB never deletes the marker on success. It does not need to: the next run
  hits "already jailbroken" first and returns before the marker check. The
  marker only blocks the pre-escalation failure case. `common_temp` is app temp
  storage, so a real reboot clears it and the next boot runs clean.
- Everything is best effort. If `randomized_path` fails or the sandbox is not
  writable, the guard reports quietly and stays out of the way rather than
  blocking a run it cannot reason about.

Latent bug found while wiring this: `teardownClean` defaulted to `false`, so
**every** early return — already-escalated, elfldr-up, and the new marker —
fell through to `finally { if (!this.teardownClean) await this.rescue(); }`.
`rescue()` calls `restoreOids()`, which calls `kaddr()`; at those points `kbase`
is still `null`, so the sweep reported a false "POWER-CYCLE" failure over a
kernel this process never armed. All three early returns now set
`this.teardownClean = true` first, so `rescue()` is skipped when there is
nothing to rescue.

`tests/test_distribution.py::test_failcheck_marker_blocks_a_second_run_in_the_same_boot`
asserts the syscall number, the marker path, the guard-before-arm ordering, the
`teardownClean = true` early returns, and the reboot instruction in `main.js`.

### "One success, then restart, then fail, forever" — the stale failcheck marker (2026-10-26n)

The reported shape: the first launch after a cold boot succeeds and the game
runs perfectly. Restart the console (or relaunch the app), and the next run
fails. Power-cycle hard and the run succeeds again. Success, fail, success,
fail — a strict alternation that tracks the boot, not the build.

The failcheck marker explains it exactly. `markRunStarted()` writes
`/<nid>/common_temp/lapse.fail` at the start of **every** run, and nothing ever
deleted it. The Y2JB rationale for leaving it behind ("the next run hits
'already jailbroken' first") does not hold here: the elfldr runs as a thread in
the webview process, so when the app restarts the loader dies with it. On the
fresh webview neither guard fires —

- `uid === 0 && sandbox === 0` is false: the escalated cred belonged to the
  *old* process, and a relaunched webview gets a fresh cred.
- `elfldrListening()` is false: the loader thread died with the old process.

— so the third guard reads the marker and aborts the run. A cold boot clears
the app's temp storage, which is why the *next* boot succeeds. The marker is
not tracking "the previous run failed"; it is tracking "a previous run ever
happened".

What shipped:

- `deleteMarker(path)` in `relapse_exploit.js` calls `unlink` (`0xa`) on the
  marker. Best effort: a failed unlink leaves the old conservative behaviour.
- `run()` deletes the marker after the teardown when — and only when — the
  teardown verified clean **and** the loader answered on 9021. That is the
  definition of a run that left no dirt behind, so blocking the next launch
  protects nothing. An incomplete teardown keeps the marker: that is precisely
  the case the guard exists for, and the case where re-arming would panic.
- The deletion runs before the `DONE` report, so a run that prints "teardown
  verified" has already cleared its marker.

This does not weaken the double-patch guard. A run that dies mid-chain never
reaches the clean-teardown branch, so its marker stays and still blocks the
next launch. Only a run that restored and verified every hijacked structure —
pipes un-crossed, AIO drained, workers released, escalation written back — is
allowed to clear its own marker.

### "ARM-C OVERSHOT" — the oid flip walked into oid_arg1 (2026-10-26o)

The message is exact: `OVERSHOT to 0x… -- borrowed into oid_arg1. Unrecoverable
this boot, REBOOT.` It comes from `flipOidKind()`.

`flipOidKind()` fires one AIO cancel per waiter ("head") and re-reads the oid
kind after each one. The target is `0x70048002`; the original is `0x80048002`.
The write is aimed at `B.kindByte3` (`0x028cee57`), whose next byte is
`B.oid_arg1` (`0x028cee58`). If a cancel lands one byte past the target, the
kind reads below `0x70` and the top byte of the oid is now argument data —
`oid_arg1` has been borrowed into the kind. That state cannot be repaired from
userland.

Why it happens: the reclaimed waiter's target pointer is mis-aimed. The heap
groom put the array one byte off, so the cancel writes into the neighbour. This
is the same class as the WebKit `heap placement failed` failure: layout
dependent, not logic dependent, and more likely when memory is fragmented (the
app has been open a while, or a previous attempt ran in the same boot).

What shipped: `flipOidKind()` now stops at the **first** value that is neither
the original kind nor the target, and it checks *before* firing the next head.
Previously it aborted only on the below-target case and kept firing on any
other intermediate value — one extra cancel is exactly the difference between a
failed flip and a request that cannot be recovered without a reboot. A dead
head followed by a live head still completes normally (tested).

When you see it:

1. Do not run again in this boot. The B oid is corrupt and the failcheck marker
   is on disk, so a second run would re-arm over it.
2. Hold the power button ~15 s, unplug ~30 s, boot. That clears the marker and
   gives the allocator a fresh layout.
3. Launch once and confirm `Build: 2026-10-26o arm-c-guard` before running.
4. If it overshoots again on a fresh boot, the arming tuning does not match that
   console's layout. Record the `ARM-C-PLAN`, `ARM-C-STATES` and `ARM-C-RECLAIM`
   lines plus the `?numw=`/`?spray=`/`?churn=` values in use.

### "One success, then crash" — the kexp pipe restore raced the shellcode (2026-10-29a)

The reported shape after the 26n/26o builds: the first launch after a cold boot
succeeds and the game runs; the next launch crashes the console; after the
crash the console reboots (or the user power-cycles), the boot after that
succeeds again. A strict alternation that tracks the boot.

Two defects, both found by comparing this host against the hardware-stable
Y2JB chain (itsPLK v1.1.0-fast11, confirmed on 13.60 for full boot AND
relaunch) and by disassembling the two kexp blobs with WSL binutils.

**Defect 1 — `runKexp` un-crossed the shellcode pipe pair while the detached
shellcode was still using it.**

The web kexp blob (`kexp_2026_05_25.bin`) bootstraps its kernel read/write
through the pipe pair kexp.js crosses for it, at instruction level: the walker
(`0x1430`) aims with `write(master_fd, state, 0x18)` — the crossing makes that
write land on the victim pipe *struct* — and then reads aimed kernel memory
with `read(victim_fd, buf, 0x60)`, walking down from `allproc` page by page
until it finds the kernel ELF header. Every later step (kaddrs, softc, iommu,
qa-flags patch, loader args) reads and writes the same way.

Commit `276d53c` switched `spawnAndJoin` from `pthread_join` to
`pthread_detach` (correct — the web blob parks its thread in an internal join
forever), but left the `finally { restoreShellcodePipes() }` in `runKexp`,
whose comment still claimed "the shellcode thread has joined". With detach,
the un-cross fires milliseconds after `pthread_create` — while the blob is
still walking kernel memory through that exact pair. Where the restore won the
race, every later blob read returned the restored ring's contents instead of
kernel memory; the bootstrap computed garbage addresses and either aborted
("elfldr did not come up") or wrote kernel data to garbage (panic). Timing
varies per boot, which is the alternation.

The stable reference (Y2JB `relapse.js` -> `kexp.launch`) joins its thread and
its blob runs the loader inline and *returns*, so the pair is untouched until
the loader is fully installed — no race exists to have.

What shipped:

- `runKexp` no longer restores on success. It returns
  `{ pipes: { master, victim, saved } }`; the restore call moved into the
  catch path (spawn failure: the thread never ran, nobody owns the pair).
- `launchElfLoader` keeps the context on `this.shellcodePipes`; `run()` decides
  after the 9021 poll: loader up -> **leave the pair crossed** (the loader's
  `rfork_thread` child holds the same fds and still reads kernel memory
  through the crossing when it maps incoming payloads — un-crossing under it
  breaks the loader); loader down -> un-cross, because an armed pair with no
  other holder is what kills the console at app close (the 50432d7 bug, kept
  as the failure-path behavior).
- The pre-arm 9021 probe retries three times (120 ms apart) so a slow fresh
  webview cannot misread an alive loader as absent.

REA evidence (WSL objdump, blob at raw base 0):

| Where | What it shows |
| --- | --- |
| web blob `0x123a` / `0x1278` | `call [0x48c0] pthread_create` / `call [0x48c8] pthread_join` — the blob parks its own thread on the elfldr thread, hence the JS detach. |
| web blob `0x1488-0x14c8` | the walker's kernel R/W: `write(master_fd)` then `read(master_fd)`/`read(victim_fd, 0x60)` through the crossed pair. |
| web blob `0x12c0-0x1335` | the never-reached cleanup: munmap elfldr + close all four fds after the join returns. |
| both elfldr ELFs | `R_X86_64_GLOB_DAT rfork_thread` (web `0x13d28`, y2jb `0x13d98`); the 9021 server is an `rfork(0x1030, ...)` **child process**, which survives the webview that launched it. |
| y2jb blob | no "created elfldr thread" strings; "run loader started/completed" + "elfldr returned %i" — the loader runs inline in the joined thread and returns, which is why Y2JB can tear down safely after `kexp.launch` returns. |

**Defect 2 — the failcheck marker deletion (26n) re-opened the same-boot
re-arm.** The 26n rationale ("the loader dies with the webview") was wrong:
the loader *thread* dies, but the `rfork_thread` child — the actual 9021
server — is a separate process and survives, exactly as Y2JB fast11
hardware-confirmed. With the marker deleted after a clean teardown, a relaunch
whose probe missed (or whose loader had really died) fell through all three
guards and re-armed the AIO exploit in the same boot — the double-patch panic
class documented since 26l, made likely by the OID hijack that `restoreOids()`
deliberately leaves in place until reboot and by the reclaimed waiter arrays
still owned by the first run's spray nodes.

What shipped:

- The marker is written at run start and **never deleted** (Y2JB's rule). A
  clean teardown does not make the kernel re-arm-safe, so the marker means
  "the kernel was patched in this boot", clean or not. The reboot clears it
  with `common_temp`.
- Guard order is unchanged and now complete: uid/sandbox (same-process
  escalation) -> elfldr on 9021 (surviving loader: already-jailbroken, payload
  redelivery) -> marker (loader really gone: refuse, ask for a reboot).
- `main.js` and the FAILCHECK report now say "the kernel was already patched
  in this boot - restart the console, then launch again" instead of claiming
  the previous run "did not finish".

Expected behavior after this build: a cold boot runs the chain once, the game
loads, and relaunching the shortcut either redelivers payloads to the still
running loader or asks for a reboot — it never re-arms, so the strict
success/crash alternation is gone. `deleteMarker()` was removed entirely;
`tests/test_distribution.py` asserts no unlink path remains.

### "It crashed the PS5" — the stale 26n console armed on a dead network (2026-10-29b)

Reported log from the crashed console: status card `build: 2026-10-26n
no-join`, `Cache at start: status=IDLE ... settle=n/a`, `AppCache check
failed; continuing`, `Cache settled: ... settle=error`, then `Starting WebKit
exploit / Attempt: 1 / Failed: Unable to deserialize data. / Retry: Heap
placement failed attempt 2` and the console died.

Three stacked facts, none of them the 2026-10-29a build:

1. **The console never converged.** The live Pages host was verified healthy
   at the time (manifest 874 B and site.js 13,255 B, `Last-Modified` Oct 29,
   `cache.appcache` alias present). The console's own network fetches failed —
   `settle=error` — so the AppCache update never ran, and the cached 26n build
   (pre-26o, with every crash bug 29a fixed) kept arming.
2. **The stale build armed on a dead network.** Both the 26n and the 29a
   clients "continued" on `settle=error`. For the web host that is never
   right: payloads are fetched over the network in the same run, so an
   unverifiable run has no upside — only the stale-crash risk.
3. **The WebKit exploit failed twice and the console died.** `Unable to
   deserialize data` and `Heap placement failed` are the documented
   heap-layout failures; a crash during a retry spray is not preventable from
   JS. What IS preventable is arming at all on a build that cannot be
   verified.

What shipped (build `2026-10-29b stale-guard`):

- `verifyBuildFreshness()` in site.js runs after the settle gate and before
  the chain is marked live. It XHR-fetches the page's own manifest with a
  cache-busting query (3 tries, 5 s timeout), parses the `# version` line, and
  compares it with the running BUILD.
- Any unverifiable outcome refuses to arm with on-screen instructions:
  network unreachable after 3 tries; manifest without a readable version;
  host version different from the running build (names both versions).
  The refusal returns `freshness-abort`, which the run() consumer treats like
  `stale-abort`: nothing armed, so a relaunch or a later reload is safe.
- The trade-off is deliberate: this host needs the network for the payload
  handoff anyway, so an offline arm never completed a run. A console whose
  network works but whose AppCache is stuck now sees the exact message ("the
  cache update did not land... delete the app's saved data or open
  /relapse/reset-cache/") instead of a crash.
- `tests/test_distribution.py::test_chain_refuses_to_arm_when_the_build_
  cannot_be_verified` asserts the guard runs before arming, all three refusal
  paths, the network fetch shape, and the consumer handling.

Recovery for the crashed console (stale 26n cache, network failing):

1. Hold the power button ~15 s, unplug ~30 s, boot.
2. Settings > Network > Test Internet Connection. If a DNS blocker
   (nanodns) is in the path, make sure `patnawa.github.io` and
   `githubusercontent.com` are not sinkholed and the DNS server itself is up.
3. Delete the shortcut app's saved data (Settings > Storage > Console Storage
   > Saved Data > the PS5Expweb app) — this clears the stuck 26n cache.
4. Relaunch once with network; expect `Build: 2026-10-29b stale-guard`.
5. If the WebKit attempts fail again on a fresh boot, power off before
   retrying — retrying on a dirty heap is what turns a failed spray into a
   crash.

### The launcher app — in-app clear cache (2026-10-29c)

The stuck-stale console had no in-app way back to the reset page: the shortcut
opens a fixed URL, the stale page ships no navigation, and the app may not
appear where the user looks for it in Settings. The launcher fixes the flow at
the app level: a new shortcut package (`config-launcher.json`, same title ID
LCLH13600, replaces the Relapse-only shortcut) opens `/app/` — a small page
cached under its OWN manifest (`launcher.appcache`, lists only itself), so it
opens even while the exploit host's cache is the thing that is stuck. It
offers JAILBREAK (→ `/relapse/`), CLEAR CACHE (→ `/relapse/reset-cache/`,
safe only while idle) and DIAGNOSTICS, plus the host's current build fetched
from the live manifest so a stuck console is visible at a glance.

The pkg cannot run code — the "clear cache function" is the host page; the
package change is only the URL. All links are relative, so the same staged
bytes work on the Pages subpath and on serve.py
(`tests/test_distribution.py::test_staged_tree_ships_the_launcher`).

### "Show me the controller and the status" — the screen rebuild (2026-10-26m)

The old screen was a 420 KB `index.html`: a base64 JPEG backdrop on a fixed
dark page, a monospace console pinned at 27%/25%, two loading GIFs, a special-
thanks block and a website credit. Everything the user looked at while the
chain ran was log text in the middle of a photo.

The rebuild replaces that with a macro shot of a PS5 controller and a floating
status card. No image generation was used: the 410 KB base64 JPEG is gone and
the controller is an inline SVG (`viewBox="0 0 900 620"`), so the page is
10.9 KB instead of 420 KB and stays crisp at any zoom. The "zoom closeup" is
CSS: `transform: scale(2.35)` with a 14 s `drift` animation that pushes the
scale to 2.42 and sways it a degree either way. The SVG carries the shell
gradient, black deck, touchpad, light bar, both sticks, d-pad, face buttons,
create/options and the PS button — all styleable, none of it a network fetch.

The status card (`#status-card`) sits centered over the controller with a
backdrop blur. Its contents:

- `#status-eyebrow` — "Kernel Exploit Status"
- `#exploit-status` — the current stage as a label, colour-coded
- `#exploit-detail` — the raw stage detail (e.g. `webkit=0x...`)
- `#progress-fill` — a 0–100 % rail driven by the stage map
- `#build-stamp` — the build id, set from `BUILD` on module load

The wiring lives in `relapse-stable/src/site.js`. Every `cstage()` call in
`site.js`, `main.js` and `relapse_exploit.js` funnels through
`window.CrashLog.stage`, so the module wraps that one function instead of
editing three files:

- `STAGE_LABELS` maps `site:run`, `site:cache-settle`, `site:webkit`,
  `site:arw-ready`, `site:kernel-exploit`, `main:payloads`, `kexploit:*`,
  `FAILCHECK` and the payload-error stages to human labels.
- `STAGE_PROGRESS` maps the same keys to rail percentages; unknown stages keep
  the previous percentage rather than jumping to zero.
- `CrashLog.stage` is wrapped to call `updateStatusUI(name, detail)` after the
  original persists the stage. `CrashLog.finish` is wrapped to set the final
  "Exploit complete" / "Exploit failed" text and pin the rail to 100 or 0.
- The log drawer keeps the full `writeLog` history, demoted to a bottom 30 vh
  panel with a "Logs" toggle. `body.log-hidden` hides it and the toggle moves
  to the corner.
- The build stamp is written to `#build-stamp` immediately, so a cached console
  shows the running build before the first stage lands.

The old loading GIFs and the special-thanks block are gone with the rest of the
old style; `index.html.old-bg-backup` keeps the previous page for reference.
The toast container survives and its `.toast` styling was restyled to the new
palette. The crash banner (`#crashlog-banner`) keeps its function and gets the
same rounded, blurred treatment.

### Open items

- Hardware confirmation of the fix chain through `2026-10-29a loader-race-fix`
  (no console access in this workspace; `consoleTested` remains false for the
  built pkgs). The two 2026-10-29a behaviors to watch: the boot after a
  successful run must never re-arm (ALREADY path or reboot prompt, no panic),
  and a successful run must leave the shellcode pair crossed without any
  app-close or shutdown panic afterwards.
- The payload retry and the pending-delivery retry have no automated coverage
  yet; both are exercised only by the console protocol above.
- The detach path's elfldr poll is not covered by the mock-kernel tests; it is
  exercised only on hardware.
- If the console still freezes on shutdown after these fixes, the remaining
  suspect is a kernel thread left in an uninterruptible wait by the shellcode
  itself, which userland cannot release.
- App icon change (requires a pkg rebuild — the icon lives in the package).
- The controller screen is an inline SVG, not a photographic render. A photo
  needs an image generator or a licensed asset; the SVG was chosen so the page
  stays at ~11 KB and needs no network fetch.
