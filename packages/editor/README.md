# Shared Serigraphica editor

This is the canonical React editor, canvas geometry, API contract, and Python
engine for the desktop app and the Berenice Michelow Studio browser adapter.
It does not import Electron, the Studio brand, web legal/privacy components,
filesystem APIs, or a browser runtime. Both hosts import `SerigraphicaEditor`
and `styles.css`, then inject a `SerigraphicaAPI` and optional `GuideStore`.

The desktop host lives in `src/renderer/main.tsx` and `desktopGuides.ts`.
The Python sidecar imports the engine directly from this package. Desktop
records retain the existing `serigraphica.manualOutlines.v3` storage format.
Export As and desktop filesystem access remain Electron responsibilities.

The website pins a verified copy of this package, with its upstream commit and
per-file SHA-256 hashes. Its browser adapter retains Pyodide, local file selection,
20 MB limits, photo-content guide matching, JPG/PNG downloads, Studio branding,
and privacy/legal links. No image data or compute moves to a server.

Edit this package for shared behavior. Do not edit the website's generated vendor
copy. The website's scheduled update workflow opens/updates a review PR when these
files change on Serigraphica main and explicitly starts the normal website CI.
An update is deployed only after its PR is merged. New shared files must also be
added to the website synchronization allowlist in `scripts/serigraphica-files.mjs`.
