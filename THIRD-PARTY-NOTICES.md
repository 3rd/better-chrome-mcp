# Third-party notices

Third-party components retain their own licenses and attribution.

## Adapted Chrome diagnostics

Parts of the performance, Lighthouse, heap-snapshot, and frontend-adapter implementation are adapted from [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp).

Copyright 2025 Google LLC. Licensed under Apache-2.0. Existing file notices are retained. This project's frontend adapter adds packaged diagnostic-bundle loading and build metadata. The distribution includes the Apache-2.0 license in `dist/licenses/Apache-2.0.txt`.

## Bundled dependencies

The build includes a patched FastMCP transport and patched Chrome DevTools Frontend diagnostic bundles:

- FastMCP 4.15.1: Copyright 2024 Frank Fiegel, MIT license. The patch extends tool admission and session-scoped resource handling.
- Chrome DevTools Frontend 1.0.1708524: Copyright 2014 The Chromium Authors, BSD-style license. The patch corrects network-formatter legends and units.

Patch sources are in [patches](patches/). This package is not an official Google or Chrome DevTools release.
