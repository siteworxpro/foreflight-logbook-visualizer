# The logbook is parsed in the browser and never uploaded

The pilot supplies their own ForeFlight export at runtime, and every statistic the app shows is a pure derivation from that one file. We parse it in the browser with `FileReader` and keep it in memory only — there is no server, no upload endpoint, no account and no storage.

## Considered Options

- **Upload to a backend** — would enable sharing, cross-device access and history, but requires a backend that does not exist, plus auth, storage and a privacy posture for what is 25 years of one person's movements, tail numbers, instructor names and personal comments.
- **Persist to IndexedDB** — same privacy properties as in-memory, and removes the need to re-pick the file after a reload. Deferred, not rejected; it is a small additive change (`idb-keyval`) that traps nothing.

## Consequences

The entire privacy surface disappears: there is nothing to breach because nothing is stored or transmitted. The app deploys as static files anywhere, including `file://`.

The cost is that a page reload loses the loaded logbook. Accepted for now.

The one remaining third-party network dependency is map tiles (CARTO), which reveal the map area being viewed but carry no logbook data.
