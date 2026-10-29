# PS5Expweb shortcut client

The package artwork (icon0/pic0/pic1) is the project design rendered by
`tools/design_artwork.py` into `client/artwork/`; `tools/prepare_client.py`
overlays it onto the rebuilt shortcut automatically (dimensions are validated
against the original package). Re-render the design with
`python tools/design_artwork.py` and rebuild the package to pick up changes.

Target: https://patnawa.github.io/PS5Expweb/diagnostics/

[Download the diagnostic package](https://github.com/patnawa/PS5Expweb/releases/tag/v2026-10-29).
Local file: build/diagnostic-client-release/PS5Expweb-Diagnostics.pkg.
See [development and validation notes](../docs/diagnostic-app.md).

This is a rebuilt browser shortcut using metadata and artwork from the supplied
`mPS5XPLOIT-RELAPSE.pkg`. It has a separate title ID, `LCLD13600`, and title
`PS5Expweb - Diagnostics`. The original client is unchanged. This diagnostic
shortcut opens our own static page and does not launch Relapse or any payload.

The original package's `param.json` points `deeplinkUri` at the online host.
Its supplemental filesystem listing declares an empty `eboot.bin`. That matches
the shortcut mechanism documented by [ps5-browser-app](https://github.com/kvnhrt/ps5-browser-app):
the console opens the metadata URL. The shortcut does not embed the website.
Once this package is installed, changes published at its URL appear when the
app reloads with network access. Website changes do not require rebuilding
the package unless the target URL changes. GitHub Pages requires Internet;
use an HTTP URL reachable on your LAN in the config for local hosting, then
rebuild a separate package. A PS5 loopback address cannot reach your PC.

## Build

Python 3.9+, Git, and .NET 10 SDK are required. The packer is pinned to a specific
source commit; no Sony SDK is used. From the project root:

```powershell
git clone https://github.com/kvnhrt/ps5-browser-app.git .local/ps5-browser-app
git -C .local/ps5-browser-app checkout d427877157b5ffdf90847a0c3ad54c7025100f55
python tools/prepare_client.py
dotnet run --project tools/client-builder -c Release -- build build/client-source build/client-release
```

In the current workspace, a verified portable SDK is available at
`.local/dotnet-sdk/dotnet.exe`; use that path in place of `dotnet` if no global
SDK is installed. Both source and output directories must be new. To rebuild
for a different host, edit `client/config.json`, prepare a new source directory
with `python tools/prepare_client.py build/client-source-new`, and pass that
directory plus a new output directory to the builder.

The generated `inspection.json` records the actual packaged metadata, SHA-256,
structural validation, filesystem listing (when available), and build warnings.
Inspect any existing package without installing it:

```powershell
dotnet run --project tools/client-builder -c Release -- inspect mPS5XPLOIT-RELAPSE.pkg build/original-inspection.json
```

The linked [LibProsperoPkg](https://github.com/SvenGDK/LibProsperoPKG) dependency
is GPL-3.0-or-later; its source, LICENSE and NOTICE are retained in the pinned
checkout. Original artwork is reused from the user-supplied package. Metadata,
filesystem structures and integrity information are rebuilt, not hex-patched.

## Limits

The original is a format-3 FIH debug package, not a ZIP application. REA does
not support that outer format in this session; REA inspected the extracted
supplemental ZIP, while LibProsperoPkg parsed the outer container. The original
encrypted filesystem could not be decrypted with the library's default debug
passcode. The empty executable finding comes from its supplemental metadata,
not independently decrypted executable bytes. This build reconstructs the
documented shortcut from readable metadata/artwork rather than claiming a full
decrypted clone of the original client.

The general native-launch check may reject the deliberately empty executable;
that is distinct from the URL shortcut mechanism. Structural package acceptance
is not cryptographic or console validation. Installation, browser launch, and
offline caching on this PS5 13.60 have not been tested. A debug package requires
a console capable of installing it; the shortcut alone does not enable package
installation on a stock console.
