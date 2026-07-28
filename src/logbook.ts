// Parsing and derivation for ForeFlight logbook exports. Terms are defined in CONTEXT.md.
// ponytail: naive comma split — every column read here (Date, AircraftID, From, To, Route,
// TypeCode) precedes PilotComments at index 51, the only quoted column. Switch to a
// quote-aware split if a column past 50 is ever needed.

/** `[lat, lon, name, city, state]` — the shape written by scripts/build-airports.mjs */
export type AirportRecord = [number, number, string, string, string]
/** Values are either an airport record or a string aliasing the canonical (ICAO) identifier. */
export type AirportDb = Record<string, AirportRecord | string>

/** The hour columns ForeFlight breaks out beside TotalTime, in the order a logbook page reads. */
const TIME_COLUMNS = {
  pic: 'PIC',
  sic: 'SIC',
  solo: 'Solo',
  xc: 'CrossCountry',
  night: 'Night',
  actual: 'ActualInstrument',
  sim: 'SimulatedInstrument',
  dualGiven: 'DualGiven',
  dualReceived: 'DualReceived',
} as const

export type TimeKey = keyof typeof TIME_COLUMNS
export type Hours = Record<TimeKey, number>

export const TIME_KEYS = Object.keys(TIME_COLUMNS) as TimeKey[]

const noHours = (): Hours => Object.fromEntries(TIME_KEYS.map((k) => [k, 0])) as Hours

export type Flight = {
  date: string
  tail: string
  type: string
  hours: number
  /** Hours by category. These overlap — a night cross-country counts in both. */
  time: Hours
  /** Resolved airports in order of travel, origin first. Drives Legs. */
  seq: string[]
  /** Resolved airports the pilot landed at: route stops plus the destination. Drives Visits. */
  visits: string[]
  /** Instrument approaches, which ForeFlight records against the airport they were flown at. */
  approaches: { airport: string; name: string }[]
}

export type Route = { a: string; b: string; count: number; hours: number; nm: number }
export type AirportStat = {
  id: string
  visits: number
  first: string
  last: string
  routes: string[]
  approaches: [string, number][]
}

/** One airport can be written two ways (FDK and KFDK). Collapse to the canonical identifier. */
export function canonical(id: string, db: AirportDb): string | undefined {
  const hit = db[id]
  if (typeof hit === 'string') return typeof db[hit] === 'object' ? hit : undefined
  return hit ? id : undefined
}

export function airport(id: string, db: AirportDb): AirportRecord | undefined {
  const key = canonical(id, db)
  return key ? (db[key] as AirportRecord) : undefined
}

const MAGIC = 'ForeFlight Logbook Import'

function table(lines: string[], name: string) {
  const start = lines.findIndex((l) => l.startsWith(`${name} Table`))
  if (start < 0) throw new Error(`Logbook has no ${name} Table`)
  const header = lines[start + 1].split(',').map((c) => c.trim())
  const rows: string[][] = []
  for (let i = start + 2; i < lines.length; i++) {
    const cells = lines[i].split(',')
    if (!cells[0]?.trim()) break
    rows.push(cells)
  }
  return { header, rows }
}

const reader = (header: string[]) => {
  const index = new Map(header.map((name, i) => [name, i]))
  return (row: string[], name: string) => row[index.get(name) ?? -1]?.trim() ?? ''
}

export function parseLogbook(text: string, db: AirportDb): Flight[] {
  const lines = text.split(/\r?\n/)
  if (!lines[0]?.startsWith(MAGIC)) throw new Error('Not a ForeFlight logbook export')

  const aircraft = table(lines, 'Aircraft')
  const at = reader(aircraft.header)
  const types = new Map(aircraft.rows.map((r) => [at(r, 'AircraftID'), at(r, 'TypeCode')]))

  const flights = table(lines, 'Flights')
  const ft = reader(flights.header)

  const resolve = (ids: string[]) =>
    ids.map((id) => canonical(id, db)).filter((id): id is string => !!id)

  return flights.rows.flatMap((row) => {
    // A Filed Route mixes airports with navaids and typos — keep only what resolves.
    // A stop repeated back-to-back is the same arrival written twice (`Route: FDK`, `To: KFDK`).
    const stops = ft(row, 'Route').split(/[\s,]+/)
    const visits = resolve([...stops, ft(row, 'To')]).filter((id, i, all) => id !== all[i - 1])
    const seq = resolve([ft(row, 'From')]).concat(visits)
    if (!seq.length) return []

    // ForeFlight packs an approach as `count;name;runway;airport;;`.
    const approaches = ['Approach1', 'Approach2', 'Approach3', 'Approach4', 'Approach5', 'Approach6']
      .map((c) => ft(row, c).split(';'))
      .filter(([, name, , at]) => name && at && canonical(at, db))
      .map(([, name, , at]) => ({ airport: canonical(at, db)!, name }))

    const tail = ft(row, 'AircraftID')
    return [
      {
        date: ft(row, 'Date'),
        tail,
        type: types.get(tail) ?? '',
        hours: Number(ft(row, 'TotalTime')) || 0,
        time: Object.fromEntries(
          TIME_KEYS.map((key) => [key, Number(ft(row, TIME_COLUMNS[key])) || 0]),
        ) as Hours,
        seq,
        visits,
        approaches,
      },
    ]
  })
}

export function legs(flight: Flight): [string, string][] {
  const out: [string, string][] = []
  for (let i = 1; i < flight.seq.length; i++) {
    const [a, b] = [flight.seq[i - 1], flight.seq[i]]
    if (a !== b) out.push([a, b]) // a Local Flight draws nothing
  }
  return out
}

/**
 * Routes are unordered pairs: KIAD→KALB and KALB→KIAD are one line.
 * Hours only accumulate from single-leg flights, where the logbook's TotalTime belongs to
 * exactly one route. A multi-stop flight's time cannot be split between its legs.
 */
export function routes(flights: Flight[], db: AirportDb = {}): Route[] {
  const found = new Map<string, Route>()
  for (const f of flights) {
    const flown = legs(f)
    for (const [a, b] of flown) {
      const [x, y] = [a, b].sort()
      const key = `${x}\t${y}`
      const route = found.get(key) ?? { a: x, b: y, count: 0, hours: 0, nm: distanceNm(x, y, db) }
      route.count++
      if (flown.length === 1) route.hours += f.hours
      found.set(key, route)
    }
  }
  return [...found.values()]
}

/** Great-circle distance in nautical miles. Zero when either airport is unknown. */
export function distanceNm(a: string, b: string, db: AirportDb): number {
  const [from, to] = [airport(a, db), airport(b, db)]
  if (!from || !to) return 0
  const rad = Math.PI / 180
  const [φ1, φ2] = [from[0] * rad, to[0] * rad]
  const [Δφ, Δλ] = [φ2 - φ1, (to[1] - from[1]) * rad]
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 3440.065 * 2 * Math.asin(Math.sqrt(h))
}

export function airportStats(flights: Flight[]): AirportStat[] {
  const stats = new Map<string, AirportStat>()
  const approaches = new Map<string, Map<string, number>>()
  const blank = (id: string, date: string): AirportStat => ({
    id,
    visits: 0,
    first: date,
    last: date,
    routes: [],
    approaches: [],
  })

  for (const f of flights) {
    for (const id of f.visits) {
      const s = stats.get(id) ?? blank(id, f.date)
      s.visits++
      if (f.date < s.first) s.first = f.date
      if (f.date > s.last) s.last = f.date
      stats.set(id, s)
    }
    for (const { airport: id, name } of f.approaches) {
      const flown = approaches.get(id) ?? new Map<string, number>()
      flown.set(name, (flown.get(name) ?? 0) + 1)
      approaches.set(id, flown)
    }
  }

  for (const { a, b } of routes(flights)) {
    stats.get(a)?.routes.push(b)
    stats.get(b)?.routes.push(a)
  }
  for (const [id, flown] of approaches) {
    const s = stats.get(id)
    if (s) s.approaches = [...flown].sort((x, y) => y[1] - x[1])
  }
  return [...stats.values()].sort((x, y) => y.visits - x.visits)
}

export type Summary = {
  nm: number
  hours: number
  time: Hours
  byType: [string, number][]
  longest: (Route & { date: string }) | null
  states: string[]
  perYear: [string, number][]
}

export function summary(flights: Flight[], db: AirportDb): Summary {
  const byType = new Map<string, number>()
  const perYear = new Map<string, number>()
  const states = new Set<string>()
  const time = noHours()
  let nm = 0
  let hours = 0
  let longest: (Route & { date: string }) | null = null

  for (const f of flights) {
    perYear.set(f.date.slice(0, 4), (perYear.get(f.date.slice(0, 4)) ?? 0) + 1)
    hours += f.hours
    for (const key of TIME_KEYS) time[key] += f.time[key]
    for (const id of f.visits) {
      const state = airport(id, db)?.[4]
      if (state) states.add(state)
    }
    for (const [a, b] of legs(f)) {
      const d = distanceNm(a, b, db)
      nm += d
      byType.set(f.type || '—', (byType.get(f.type || '—') ?? 0) + d)
      // Sorted, so the pair matches the Route of the same airports.
      if (d > (longest?.nm ?? 0)) {
        const [x, y] = [a, b].sort()
        longest = { a: x, b: y, nm: d, count: 1, hours: f.hours, date: f.date }
      }
    }
  }

  return {
    nm,
    hours,
    time,
    byType: [...byType].sort((x, y) => y[1] - x[1]),
    longest,
    states: [...states].sort(),
    perYear: [...perYear].sort(),
  }
}

/** Great-circle arc between two airports, as points for a Leaflet polyline. */
export function arc(from: AirportRecord, to: AirportRecord, steps = 32): [number, number][] {
  const rad = Math.PI / 180
  const [φ1, λ1, φ2, λ2] = [from[0] * rad, from[1] * rad, to[0] * rad, to[1] * rad]
  const d =
    2 *
    Math.asin(
      Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2),
    )
  if (!d) return [[from[0], from[1]]]
  const points: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
    const z = A * Math.sin(φ1) + B * Math.sin(φ2)
    points.push([Math.atan2(z, Math.hypot(x, y)) / rad, Math.atan2(y, x) / rad])
  }
  return points
}
