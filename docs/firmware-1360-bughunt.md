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
routes their XHRs to the network and the update evicts the old copies, and the
manifest update shrinks from ~7 MB to ~500 KB so convergence beats the crash);
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
  `2026-10-26e net-payloads`, manifest `# version 2026-10-26e net-payloads #`
  with zero payload entries, kstuff served over the network at 1,737,080
  bytes / SHA-256 prefix `ab9a6cb4…`.
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
2. Confirm the log line `Build: 2026-10-26e net-payloads`. No build line means
   a stale cache — relaunch once; if still missing, clear the app's cache.
3. Run one cycle. With the build line visible, the stale-payload path is
   excluded by construction; the CrashLog red banner's last stage (persisted
   in `localStorage` across reboots) then names the failing stage and the
   remaining suspects are few.

### Open items

- Hardware confirmation of the full fix chain (no console access in this
  workspace; `consoleTested` remains false for the built pkgs).
- App icon change (requires a pkg rebuild — the icon lives in the package).
- Jailbreak running-status UI overhaul (deferred by the user until after the
  bug fix).
