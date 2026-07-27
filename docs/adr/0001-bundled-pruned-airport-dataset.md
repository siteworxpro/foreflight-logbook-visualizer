# Airport coordinates come from a pruned, bundled FAA dataset

Logbooks record airport identifiers but no coordinates, so identifiers must be resolved against an external dataset before anything can be drawn. We generate a pruned lookup from the FAA ADIP `Airports.geojson` at development time and ship it as a static asset, rather than querying an API at runtime.

## Considered Options

- **Ship the raw 13 MB geojson** and filter in the browser — 19,559 features and 27 properties each, parsed on every load, to serve a few dozen lookups.
- **Runtime API lookup** — adds a network dependency, latency, a failure mode and possibly a key to an app that otherwise needs no network beyond map tiles.
- **Prune to only the identifiers in one logbook** — ~10 KB, but bakes one pilot's history into the build; any other logbook, or the same one after a flight to a new field, silently fails to resolve.

## Consequences

The generated file is keyed by both ICAO (`KIAD`) and FAA (`3CK`) identifier because logbooks mix both forms. Where an airport has both, the ICAO form is canonical and the FAA form is stored as a string alias pointing at it — otherwise `FDK` and `KFDK` become two airports, splitting visit counts and drawing a zero-length leg between a place and itself. 2,563 airports in the dataset have both forms. It keeps `TYPE_CODE == "AD"` only — heliports, seaplane bases and ultralight fields are dropped — and deliberately **retains closed airports**, because a logbook spanning decades contains fields that no longer exist (`KISN` closed in 2019). 13 MB becomes ~940 KB, ~336 KB gzipped.

The dataset is US-only. Identifiers outside FAA coverage will not resolve and are skipped, which is accepted: see the approximation stance in CONTEXT.md.

`Airports.geojson` is a build-time source, not a shipped asset, and is **not committed** — it is 13 MB that would sit in git history forever to support a regeneration expected roughly annually. `public/airports.json` is committed instead, so a fresh clone builds and runs without it.

To regenerate, search for the **Airports** layer at <https://adds-faa.opendata.arcgis.com/search>, download it as GeoJSON, save it as `Airports.geojson` in the repo root, and run `npm run airports`. The portal reorganises its dataset paths from time to time, so search rather than bookmarking a deep link; the layer is the one whose features carry `IDENT`, `ICAO_ID` and `TYPE_CODE` properties.
