# Relapse inspection for PS5 13.60

Inspected 2026-10-25. The requested website is available locally in `relapse/`.
The imported snapshot was already present at commit `fcf52ff`; this change adds
verified local HTTP hosting and records the investigation. No console exploit
or bundled native payload was executed during inspection.

## Source identity and copy completeness

The [requested Bluesky post](https://bsky.app/profile/mour0ne.bsky.social/post/3mxjfk5x2gk2h)
was retrieved through Bluesky's public `app.bsky.feed.getPostThread` API because
the web reader could not open the app page. It is dated October 10, 2026 and
links to [the deployed Relapse host](https://ps5xploit.github.io/relapse/) and
a separate MediaFire PKG. The post advertises firmware 7.xx through 13.60.
Its record is retained in `sources/mour0ne-post.json`.

All 56 local files match the pre-existing SHA-256 provenance record in
`sources/mour0ne-snapshot.json`. A fresh HTTP download of each recorded URL
also matched all 56 hashes; results are in `sources/relapse-live-check.json`.
The cache manifest has 55 asset entries, all present locally. The manifest
itself is the 56th recorded file. This verifies a copy of the current deployed
host, not the precise version visible in the October 10 video. The deployed
manifest version is October 12. The video was not analyzed. A subsequent
user request added client inspection, documented in `../client/README.md` and
`sources/relapse-client-original.json`.

## REA evidence and scope

REA analyzed the downloaded JavaScript/HTML as inert text using
`analyze_javascript_application`, followed by a firmware module reference view.

- Parent evidence: `ev_139050045082650b3ebce4034a831074b5c43c15724074561a09e1af1b09d39b`.
- Summary evidence: `ev_afe22d61fc2552f0e28f3caea6f45693034d1fe2fe8f3039eafffa5357b7a492`.
- Firmware reference view: `ev_ed99c8a6ea35136b726188b07348d6c3698d47903b7f2f4c0c943f32ea66aca0`.
- Artifact digest: `2c450ac21e44cf3bfefe2f5c0c6a2902fdc899cd5bc3c6ebbde53d3e189663a6`.

Selected sources: `index.html`, `appcache_handler.js`, `custom_host_stuff.js`,
`src/firmware.js`, `src/site.js`, `src/main.js`, `src/kexp.js`, and
`offsets/13.60.js`. REA parsed seven JavaScript files with no parse failures.
Its graph is partial: 39 inventoried relevant files were outside the selected
analysis, dynamic relationships remain unresolved, and the two inline HTML
script bodies were not analyzed by REA. Those inline scripts and the cache
manifest were inspected directly. This is a focused host/startup inspection,
not a complete audit of the kernel chain or payload binaries.

The complete REA bundle is retained locally at `.local/relapse-rea-evidence.json`
(excluded from Git); the portable summary and its limitations are tracked in
`sources/relapse-rea-summary.json`. REA inventory/AST evidence establishes
source structure, not console runtime behavior.

## Observed startup and firmware selection

| Question | Evidence and result | Status |
| --- | --- | --- |
| Which page is for 13.60? | `relapse/index.html`; the root page belongs to the older 3.xx–4.xx host. | Answered |
| Is 13.60 selectable? | `src/firmware.js:4` includes 13.60 and extracts the version from the PS5 user agent at lines 13–16. | Answered in source and isolated detector checks |
| Is a matching table present? | `offsets/13.60.js:425–426` declares `window.KRW` and firmware 13.60. | Answered in source; offsets not validated against a firmware image |
| What starts the chain? | `src/site.js:80` checks firmware before requesting the WebKit primitive, then imports the kernel-chain module and calls `main`. | Static observation |
| Which loader is selected? | `src/kexp.js:23` defaults to `elfldr-ps5-1360.elf`. The local asset is included in the cache. | Answered in source |
| What loads afterward? | `src/main.js:279` requires chain completion; its payload branch invokes optional loading. `src/kexp.js:568–584` actually sends only `pldmgr.elf`. | Static observation |
| Is offline content complete? | All 55 manifest assets are present; binary downloads use relative `payloads/` URLs and XHR in `src/kexp.js:258`. | Asset completeness answered; offline execution unverified |
| Does it work on this user's PS5? | No console connection, firmware image, or console execution log was supplied. | Unresolved; hardware verification required |

Older comments mention automatically loading kstuff and shadowmountplus, but
that is not what the inspected optional-loading function does. Their presence
in the cache does not establish execution or firmware compatibility. No binary
decompilation or independent compatibility claim is made for these payloads.

## Local implementation

`serve.py` verifies snapshot hashes before listening. It redirects `/` to
`/relapse/`, keeps relative asset URLs intact, sends JavaScript with its proper
MIME type, and sends `.appcache3` as `text/cache-manifest`. Upstream provenance
records the manifest as `application/octet-stream`; the local server supplies
the manifest MIME rather than copying that header. It uses `no-cache` for
revalidation without adding `no-store`. Only recorded Relapse files are served;
repository metadata and directory listings are unavailable.

All imported Relapse bytes remain unchanged, preserving direct provenance.
The local server runs with Python's standard library and requires no package
installation. Its HTTP integration tests cover redirects, all asset bodies,
MIME types, HEAD requests, query strings, and paths outside the snapshot.

## Inherited issues and remaining limits

1. `custom_host_stuff.js:17` calls `create_redirector_buttons`, which dereferences
   `#redirector-pinned` at lines 118–119. The Relapse HTML does not contain this
   element or the rest of the redirector markup. This load handler can throw.
   Cache event listeners are registered earlier; the exploit module has a
   separate startup path. Its full runtime impact remains untested.
2. `appcache_handler.js:60–61` suppresses the cache error notification. A silent
   cache failure is possible; a complete HTTP asset check cannot prove that the
   PS5 has stored those assets offline.
3. `index.html:212–223` injects the firmware offset script dynamically and loads
   the startup module separately. There is no explicit readiness promise between
   them. A race is a static possibility, not an observed console failure.
4. The imported README says 10.60 is absent, while its firmware list, manifest,
   and files include 10.60. No claim about that firmware is needed for 13.60.
5. Desktop browser preview does not establish PS5 WebKit or Application Cache
   behavior. The post's loopback DNS setting is separate from the LAN web-server
   address and was not applied to any device.

## Checks performed

- Existing provenance: 56/56 local size and SHA-256 checks passed.
- Current upstream: 56/56 HTTP-fetched files matched the recorded hashes.
- Cache: 55/55 listed assets present and covered by provenance.
- `python -m unittest discover -s tests -v`: four tests passed, including all
  56 bodies fetched over a temporary local HTTP server.
- Isolated Node VM execution of only `src/firmware.js`: 13.60 accepted;
  desktop, unknown firmware, and missing version rejected (four checks passed).
- No exploit execution, native payload execution, console settings changes,
  or PKG installation performed. Publishing to GitHub Pages was subsequently
  authorized, with deployment configured in `.github/workflows/pages.yml`.
