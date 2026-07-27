# ForeFlight Logbook Visualizer — agreed design

Outcome of the design session on 2026-07-27. Terms in **bold** are defined in [CONTEXT.md](../CONTEXT.md).

## Shape

Vue 3 + Vite SPA, no backend ([ADR-0002](./adr/0002-client-only-no-backend.md)). Pilot picks a ForeFlight CSV, it is parsed in the browser, everything renders from memory. Deployed locally only for now.

## Airport resolution

Build-time script prunes FAA `Airports.geojson` (13 MB) to `public/airports.json` (~940 KB, ~336 KB gz), keyed by both ICAO and FAA identifier, `TYPE_CODE == "AD"` only, closed airports retained, carrying `lat, lon, name, city, state` ([ADR-0001](./adr/0001-bundled-pruned-airport-dataset.md)).

Resolution is best-effort: an **Identifier** that does not resolve is skipped silently. Measured against the reference logbook that is ~6 missed and ~3 phantom entries out of ~2,400 — under 0.4%, accepted.

## Parsing

ForeFlight exports only — a fixed two-table format (Aircraft Table, Flights Table), each with a marker row and a header row. Locate the markers, index columns by header name.

Naive `split(',')` is sufficient: every column used (`Date`, `AircraftID`, `From`, `To`, `Route`, and `TypeCode` from the Aircraft Table) precedes the only quoted column, `PilotComments` at index 51. Ceiling noted in code — switch to a quote-aware split if a column past 50 is ever needed.

Reject files whose first line is not `ForeFlight Logbook Import` rather than rendering an empty map.

## Derivation

For each **Flight**: `[From] + resolvable Filed Route tokens + [To]`, drop unresolvable entries, then

- **Visits** — one per **Stop** (`To` plus route stops). The `From` airport is not a visit.
- **Legs** — one per consecutive distinct pair. Same-airport pairs produce nothing.
- **Routes** — legs collapsed into unordered airport pairs, carrying a count.

One airport has one identity: `FDK` and `KFDK` resolve to the same **Airport**, and a stop repeated back-to-back (`Route: FDK`, `To: KFDK`) is one arrival, not two.

Reference logbook yields 1,339 flights → 1,249 legs → 161 routes, across 95 airports (70 flown to directly, plus 25 reached only via a **Filed Route**).

## Map

Leaflet + CARTO Positron tiles. Great-circle arcs, not straight lines.

- **Routes layer** — one line per **Route**, width scaled from the data (`min..max` → `1..8 px`). Not a user control: the width *is* the flight count, so a slider would make it lie.
- **Airports layer** — circle marker per **Airport**, sized and numbered by **Visit** count.

## Statistics

All recompute under the filters.

- **Summary strip** — distance flown, as miles and as times around the world; states visited; longest leg, clickable through to its **Route**. Distance is computed great-circle from coordinates, because the logbook's own `Distance` column is `0.00` on 96% of rows.
- **Timeline sparkline** — flights per year across the whole logbook, so the bars stay put while filtering. Clicking a bar sets the date range to that year.
- **Route hours** — `TotalTime` summed per **Route**, but only from single-leg flights (930 of 1,397 in the reference logbook), where the time belongs to exactly one route. A multi-stop flight's time cannot be split between its legs, so it is attributed nowhere and the panel says so.
- **Approaches** — listed by name and count on the airport panel. 108 across 32 airports in the reference logbook.

Reference logbook totals: 352,592 mi (14.2× around the world), 31 states, longest leg KDEN–KMKE at 776 nm.

## Filters

Recompute every statistic and both layers.

- Date range (2001–2026 in the reference logbook)
- Aircraft type (895 of 1,397 reference flights are E145 — this separates airline flying from GA in one click)
- Minimum flights per **Route** (161 routes at ≥1, 16 at ≥20)
- Tail number — a single-select, because isolating one airplane is the actual use; the list narrows to tails surviving the other filters

## Interaction

Click an **Airport** → panel with name, city/state, visit count, first and last visit date, routes from there, and approaches flown. Click a **Route** → both endpoints, flight count, distance and hours. Filters float top-left, detail panel right, map fills the rest.

## Deferred

- **Corridor heatmap.** An airport heatmap over ~95 points is just blurrier dots; the corridor version is a genuinely different view and can come later (`leaflet.heat`, 4 KB).
- **IndexedDB persistence** so a reload keeps the logbook.

## Known dead ends

- **Ground dwell time.** `TimeIn`/`TimeOut` exist on 64/1,397 flights, all post-2020, yielding 45 chainable gaps — most of them multi-day. Not computable, cut.
- **The `Distance` column** is `0.00` on 1,338/1,397 rows. Distance is computed great-circle from coordinates instead.
- **Stats with no data behind them.** `IFR` filled on 0.4% of rows, `Holds` 1%, `InstructorName` 0.4%, `Solo` 5%. Not enough to say anything.
- **`Filed Route` as an itinerary.** It is a navigation route: it contains navaids (`EMI`, `DDUBS`), and rows with zero landings still list airports. Treating resolvable tokens as **Stops** is a deliberate approximation, not an inference from the data.
