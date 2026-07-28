# ForeFlight Logbook Visualizer

Maps a pilot's ForeFlight logbook onto a map and derives statistics from it — where they have flown, how often, and in what.

## Language

**Logbook**:
A single ForeFlight CSV export supplied by the pilot at runtime. Contains an Aircraft Table and a Flights Table.
_Avoid_: Log, import, file

**Flight**:
One row of the Flights Table — one logged operation in one aircraft on one date.
_Avoid_: Trip, entry, record

**Identifier**:
The raw airport string as written in the logbook (`KIAD`, `3CK`). May be ICAO or FAA form, and may be absent or wrong.
_Avoid_: Airport code, ICAO, tail (tail is an aircraft)

**Airport**:
A physical place with coordinates, resolved from an **Identifier** against the airport dataset. Identifiers are what the pilot wrote; Airports are what exists. One airport has one identity even when written two ways — `FDK` and `KFDK` are the same Airport, never two.
_Avoid_: Field, station, destination

**Unresolved Identifier**:
An **Identifier** with no matching **Airport** in the dataset — a typo, a navaid, or a field the dataset never had or has since removed. It has no coordinates and is skipped, but it is counted and shown: only the pilot can tell a navaid, which belongs here, from an airport, which means a lost **Leg**.
_Avoid_: Invalid airport, bad data

**Filed Route**:
The pilot's planned navigation route for a **Flight**, as written in the logbook's `Route` column. A mix of airports, navaids and typos — not an itinerary.
_Avoid_: Route (a Route is a map line), flight plan

**Stop**:
An **Airport** the pilot landed at on a **Flight**. A flight's stops are its `To` airport plus any identifier in its **Filed Route** that resolves to an **Airport**. The `From` airport is not a stop.
_Avoid_: Waypoint, leg, destination

**Visit**:
One **Flight** arriving at one **Stop**. A flight that departs and returns to the same airport is one visit there, not two.
_Avoid_: Landing, touchdown, trip

**Leg**:
One drawn connection between two consecutive, distinct **Airports** on a single **Flight**. A **Local Flight** produces no legs.
_Avoid_: Hop, segment, sector

**Route**:
An unordered pair of **Airports** the pilot has flown between, carrying the count of **Legs** flown between them. Direction is not distinguished — one line on the map, however many times flown in either direction.
_Avoid_: Path, connection, city pair

**Approach**:
One instrument approach procedure flown on a **Flight**, recorded by name against the **Airport** it was flown at (`ILS OR LOC RWY 26` at `KMRB`). Unlike landings, an approach carries its own airport, so it attributes exactly.
_Avoid_: Instrument procedure, IAP

**Local Flight**:
A **Flight** that departs and returns to the same **Airport** and has no intermediate **Stops** — pattern work or local practice. It produces one **Visit** and no **Legs**, so it appears on the map as a heavier dot and nothing else.
_Avoid_: Round trip, pattern, circuit

**Round Robin**:
A **Flight** that departs and returns to the same **Airport** but lands at intermediate **Stops** along the way. It is not a **Local Flight**: it produces a **Visit** at each stop and at the origin, and a **Leg** between each consecutive pair. `KMRB → KCHO → KCJR → KMRB` is three visits and three legs.
_Avoid_: Local flight, out-and-back

## Flagged ambiguities

- **"Times at an airport"** means **Visit** count — how many times the pilot arrived. It does not mean ground dwell time, which the logbook cannot support.
- **Route** vs **Filed Route** — the logbook's `Route` column is a planned navigation route; a **Route** in this app is a map line between two airports the pilot actually connected. Never use the bare word for the former.
- Resolution is deliberately approximate: a **Filed Route** entry is treated as a landing without proof that one occurred. The map is for interest, not for currency or legal record. Approximate is not the same as silent, though — an **Unresolved Identifier**, and a flight with no resolvable airport at all, are both reported rather than quietly dropped.
