# Diagnostic app v0.1.0

Site: https://patnawa.github.io/PS5Expweb/diagnostics/

[Download the package](https://github.com/patnawa/PS5Expweb/releases/tag/diagnostics-v0.1.0).
Local package: `build/diagnostic-client-release/PS5Expweb-Diagnostics.pkg`.
Title: PS5Expweb - Diagnostics. Title ID: `LCLD13600`.
SHA-256: `98d18b21453607c5bf4bf3c1004afb00eeb0c42dc57b2c844739c34821b7cbdc`.

The original package is unchanged. The new package points at our diagnostic
page and does not start Relapse or payloads. Structural validation passed;
installation and URL launch on console remain untested. The generic native
launch check reports false because the shortcut has an empty executable.
The package requires a console already capable of installing debug packages.

The active GitHub Pages source is branch `diagnostic-site`. Only the standalone
diagnostic website is published on that branch. Earlier notes describing Pages
as unpublished or the client URL as `/relapse/` describe the previous build.

For development, edit `diagnostics/`, start `python serve.py --port 8082`, and
preview `http://127.0.0.1:8082/diagnostics/` on the PC. To stage a new standalone
deployment, run `python tools/stage_diagnostics.py build/diagnostic-site-new`.
Commit the staged website files on branch `diagnostic-site` and push that branch.
The package keeps the same URL, so published website updates do not require a
new package. Reload the app with Internet access to load published changes.

For a LAN-only package, set the URL in `client/config.json` to the PC's reachable
HTTP address ending in `/diagnostics/`, then prepare and build in new output
directories as documented in `client/README.md`. A LAN target requires a new
package; the GitHub-targeted package cannot load unpublished local edits.
