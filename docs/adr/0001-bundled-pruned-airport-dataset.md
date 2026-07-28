# Airport coordinates come from a pruned, bundled FAA dataset

Logbooks record airport identifiers but no coordinates, so identifiers must be resolved against an external dataset before anything can be drawn. We generate a pruned lookup from the FAA ADIP `Airports.geojson` at development time and ship it as a static asset, rather than querying an API at runtime.

## Considered Options

- **Ship the raw 13 MB geojson** and filter in the browser — 19,559 features and 27 properties each, parsed on every load, to serve a few dozen lookups.
- **Runtime API lookup** — adds a network dependency, latency, a failure mode and possibly a key to an app that otherwise needs no network beyond map tiles.
- **Prune to only the identifiers in one logbook** — ~10 KB, but bakes one pilot's history into the build; any other logbook, or the same one after a flight to a new field, silently fails to resolve.

## Consequences

The generated file is keyed by both ICAO (`KIAD`) and FAA (`3CK`) identifier because logbooks mix both forms. Where an airport has both, the ICAO form is canonical and the FAA form is stored as a string alias pointing at it — otherwise `FDK` and `KFDK` become two airports, splitting visit counts and drawing a zero-length leg between a place and itself. 2,561 identifiers in the dataset are aliases of this kind. It keeps `TYPE_CODE == "AD"` only — heliports, seaplane bases and ultralight fields are dropped. 13 MB becomes ~892 KB, ~375 KB gzipped, for 13,162 airports under 15,723 identifiers.

Each record is `[lat, lon, name, city, state, elevationFt, flags]`, where `flags` packs `1` military or joint-use, `2` private-use, `4` has a published instrument approach. Elevation earns its place by answering "highest field landed at" (`summary().highest`); the private-use bit exists because 8,173 of the 13,162 airports are farm strips, and the unvisited-airports layer is unreadable without excluding them. The two extra fields cost ~11% gzipped. Note the source types differ — `MIL_CODE` is a string, `PRIVATEUSE` and `IAPEXISTS` are numbers — so the build script reads the latter two for truthiness; comparing them to `'1'` silently flags nothing.

The dataset is **not** US-only, despite being an FAA product: it carries 170 Canadian airports, 32 Mexican, 26 Bahamian, and a scattering across the Marshall Islands and Micronesia. Coverage outside those is still absent, and identifiers that do not resolve are skipped, which is accepted: see the approximation stance in CONTEXT.md.

The export does **not** reliably retain closed airports. Only 3 records carry `OPERSTATUS == "CLOSED"`; the FAA removes decommissioned fields outright, so `KISN` (closed 2019, replaced by `KXWA`) is simply absent. A logbook spanning decades will therefore contain identifiers that no longer exist anywhere in the dataset, and no build-script change recovers them — they surface as Unresolved Identifiers or not at all.

`Airports.geojson` is a build-time source, not a shipped asset, and is **not committed** — it is 13 MB that would sit in git history forever to support a regeneration expected roughly annually. `public/airports.json` is committed instead, so a fresh clone builds and runs without it.

To regenerate, search for the **Airports** layer at <https://adds-faa.opendata.arcgis.com/search>, download it as GeoJSON, save it as `Airports.geojson` in the repo root, and run `npm run airports`. The portal reorganises its dataset paths from time to time, so search rather than bookmarking a deep link; the layer is the one whose features carry `IDENT`, `ICAO_ID` and `TYPE_CODE` properties.
