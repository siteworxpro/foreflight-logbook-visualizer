import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  airportStats,
  arc,
  distanceNm,
  legs,
  noDrops,
  parseLogbook,
  routes,
  summary,
  unvisited,
  type AirportDb,
  type AirportRecord,
} from './logbook.ts'

const db: AirportDb = {
  KMRB: [39.4, -77.98, 'Eastern WV Rgnl', 'Martinsburg', 'WV'],
  KCHO: [38.13, -78.45, 'Charlottesville', 'Charlottesville', 'VA'],
  KCJR: [38.52, -77.85, 'Culpeper Rgnl', 'Culpeper', 'VA'],
  KIAD: [38.94, -77.45, 'Washington Dulles Intl', 'Washington', 'DC'],
  KALB: [42.74, -73.8, 'Albany Intl', 'Albany', 'NY'],
  MRB: 'KMRB', // FAA identifier for the same airport
}

const logbook = (...flights: string[]) =>
  [
    'ForeFlight Logbook Import,This row is required',
    '',
    'Aircraft Table,,',
    'AircraftID,TypeCode,Year',
    'N1,P28A,',
    '',
    'Flights Table ,,,,',
    'Date,AircraftID,From,To,Route,TotalTime,Approach1,PIC,Night,CrossCountry,ActualInstrument,DualReceived',
    ...flights,
  ].join('\n')

test('a Local Flight is one Visit and no Legs', () => {
  const [f] = parseLogbook(logbook('2021-01-01,N1,KMRB,KMRB,'), db)
  assert.deepEqual(f.visits, ['KMRB'])
  assert.deepEqual(legs(f), [])
  assert.equal(f.type, 'P28A')
})

test('a Round Robin visits each Stop and draws a Leg between each pair', () => {
  const [f] = parseLogbook(logbook('2021-01-01,N1,KMRB,KMRB,KCHO KCJR'), db)
  assert.deepEqual(f.visits, ['KCHO', 'KCJR', 'KMRB'])
  assert.deepEqual(legs(f), [
    ['KMRB', 'KCHO'],
    ['KCHO', 'KCJR'],
    ['KCJR', 'KMRB'],
  ])
})

test('the origin is not a Visit', () => {
  const [f] = parseLogbook(logbook('2021-01-01,N1,KIAD,KALB,'), db)
  assert.deepEqual(f.visits, ['KALB'])
})

test('Filed Route entries that are navaids or typos are skipped', () => {
  const [f] = parseLogbook(logbook('2021-01-01,N1,KIAD,KALB,EMI DDUBS KOVK'), db)
  assert.deepEqual(f.visits, ['KALB'])
  assert.equal(legs(f).length, 1)
})

test('Routes are unordered — both directions collapse to one line', () => {
  const flights = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KALB,,1.5', '2021-01-02,N1,KALB,KIAD,,1.7'),
    db,
  )
  const [route] = routes(flights, db)
  assert.deepEqual(
    { a: route.a, b: route.b, count: route.count, hours: route.hours },
    { a: 'KALB', b: 'KIAD', count: 2, hours: 3.2 },
  )
  assert.ok(Math.abs(route.nm - 282) < 2, `KALB–KIAD should be ~282 nm, got ${route.nm}`)
})

test('an airport written in FAA form is the same airport as its ICAO form', () => {
  const [f] = parseLogbook(logbook('2021-01-01,N1,KCHO,KMRB,MRB'), db)
  // MRB and KMRB are one place: one visit, and no phantom zero-length leg between them.
  assert.deepEqual(f.visits, ['KMRB'])
  assert.deepEqual(legs(f), [['KCHO', 'KMRB']])
})

test('hours only accrue to a route from single-leg flights', () => {
  const flights = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KALB,,1.5', '2021-01-02,N1,KIAD,KALB,KCHO,9.9'),
    db,
  )
  const direct = routes(flights, db).find((r) => r.a === 'KALB' && r.b === 'KIAD')!
  // The multi-stop flight never flies KIAD–KALB directly, and its 9.9h is attributed nowhere.
  assert.equal(direct.count, 1)
  assert.equal(direct.hours, 1.5)
  assert.equal(routes(flights, db).find((r) => r.b === 'KCHO')!.hours, 0)
})

test('approaches are attributed to the airport they were flown at', () => {
  const [f] = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KMRB,,2.0,1;ILS OR LOC RWY 26;26;KMRB;;'),
    db,
  )
  assert.deepEqual(f.approaches, [{ airport: 'KMRB', name: 'ILS OR LOC RWY 26' }])
  assert.deepEqual(airportStats([f])[0].approaches, [['ILS OR LOC RWY 26', 1]])
})

test('summary totals distance, states and years', () => {
  const flights = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KALB,,1.5', '2024-06-02,N1,KALB,KIAD,,1.7'),
    db,
  )
  const s = summary(flights, db)
  assert.deepEqual(s.states, ['DC', 'NY'])
  assert.deepEqual(s.perYear, [
    ['2021', 1],
    ['2024', 1],
  ])
  assert.equal(s.byType[0][0], 'P28A')
  assert.ok(Math.abs(s.nm - 2 * distanceNm('KIAD', 'KALB', db)) < 0.01)
  // Recorded as a sorted pair so it matches the Route between the same airports.
  assert.deepEqual([s.longest!.a, s.longest!.b], ['KALB', 'KIAD'])
})

test('summary totals hours by category, and categories may overlap', () => {
  const flights = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KALB,,1.5,,1.5,0.4,1.5,,', '2021-01-02,N1,KALB,KIAD,,1.7,,1.7,,,0.6,'),
    db,
  )
  const s = summary(flights, db)
  assert.equal(s.hours, 3.2)
  assert.equal(s.time.pic, 3.2)
  // The 0.4 night hour is also inside the 1.5 cross-country hours — the parts overstate the whole.
  assert.equal(s.time.night, 0.4)
  assert.equal(s.time.xc, 1.5)
  assert.equal(s.time.actual, 0.6)
  assert.equal(s.time.dualReceived, 0)
})

test('a flight with no resolvable airports is dropped', () => {
  assert.deepEqual(parseLogbook(logbook('2017-01-09,N1,,,'), db), [])
})

test('airport stats carry visit count and date span', () => {
  const flights = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KALB,', '2024-06-02,N1,KALB,KIAD,', '2022-01-01,N1,KIAD,KALB,'),
    db,
  )
  const [top] = airportStats(flights)
  assert.deepEqual({ id: top.id, visits: top.visits, first: top.first, last: top.last }, {
    id: 'KALB',
    visits: 2,
    first: '2021-01-01',
    last: '2022-01-01',
  })
})

test('unvisited skips airports been to, aliases and private-use fields', () => {
  // KCJR is private-use (flag 2), KCHO has been landed at, MRB is an alias for KMRB.
  const field: AirportDb = {
    ...db,
    KCJR: [38.52, -77.85, 'Culpeper Rgnl', 'Culpeper', 'VA', 300, 2],
    KLXV: [39.22, -106.32, 'Lake County', 'Leadville', 'CO', 9934, 4],
  }
  const ids = unvisited(field, new Set(['KCHO'])).map(([id]) => id)
  assert.deepEqual(ids.sort(), ['KALB', 'KIAD', 'KLXV', 'KMRB'])
})

test('an airport only ever departed from is not offered as somewhere you have never been', () => {
  // One flight out of KIAD and never back: KIAD is no Visit, but the pilot was plainly there.
  const [f] = parseLogbook(logbook('2021-01-01,N1,KIAD,KALB,'), db)
  assert.deepEqual(f.visits, ['KALB'])
  // The map builds its set from seq, not visits, which is what keeps KIAD out of the grey layer.
  const ids = unvisited(db, new Set(f.seq)).map(([id]) => id)
  assert.ok(!ids.includes('KIAD'), 'a departure airport is somewhere you have been')
  assert.ok(ids.includes('KCJR'), 'an airport never touched is still offered')
})

test('summary reports the highest field landed at', () => {
  const field: AirportDb = { ...db, KLXV: [39.22, -106.32, 'Lake County', 'Leadville', 'CO', 9934, 4] }
  const flights = parseLogbook(
    logbook('2021-01-01,N1,KIAD,KLXV,,4.5', '2021-01-02,N1,KLXV,KIAD,,4.5'),
    field,
  )
  assert.deepEqual(summary(flights, field).highest, { id: 'KLXV', ft: 9934 })
  // A fixture that stops at state has no elevation, and must not out-rank a real one.
  assert.equal(summary(flights, db).highest!.ft, 0)
})

test('unresolved identifiers and airportless flights are reported, not silently dropped', () => {
  const drops = noDrops()
  const flights = parseLogbook(
    logbook(
      // Survives, but EMI and DDUBS cost it two stops.
      '2021-01-01,N1,KIAD,KALB,EMI DDUBS,1.5',
      // Nothing resolvable: a simulator session, invisible in every total.
      '2021-01-02,SIM,,,,2.4',
      // EMI again, on a second flight.
      '2021-01-03,N1,KALB,KIAD,EMI,1.7',
    ),
    db,
    drops,
  )
  assert.equal(flights.length, 2)
  assert.deepEqual([...drops.identifiers].sort(), [
    ['DDUBS', 1],
    ['EMI', 2],
  ])
  assert.equal(drops.rows, 1)
  assert.equal(drops.hours, 2.4)
})

test('a blank From or To is an empty column, not an unresolved identifier', () => {
  const drops = noDrops()
  parseLogbook(logbook('2021-01-01,N1,,KALB,'), db, drops)
  assert.equal(drops.identifiers.size, 0)
  assert.equal(drops.rows, 0)
})

test('an identifier written twice on one flight counts as one flight', () => {
  const drops = noDrops()
  parseLogbook(logbook('2021-01-01,N1,KIAD,KALB,EMI EMI'), db, drops)
  assert.deepEqual([...drops.identifiers], [['EMI', 1]])
})

test('a file that is not a ForeFlight export is rejected', () => {
  assert.throws(() => parseLogbook('name,value\na,1', db), /Not a ForeFlight logbook export/)
})

test('great-circle arc starts and ends at its airports and bows off the straight line', () => {
  const points = arc(db.KIAD, db.KALB)
  assert.deepEqual(points.at(0)!.map(Math.round), [39, -77])
  assert.deepEqual(points.at(-1)!.map(Math.round), [43, -74])
  const mid = points[16]
  const straight = (db.KIAD[0] + db.KALB[0]) / 2
  assert.ok(mid[0] > straight, 'arc should bow poleward of the straight-line midpoint')
})

// Counts below were derived independently (see docs/plan.md) before this parser existed.
test('the reference logbook derives the expected shape', { skip: !process.env.LOGBOOK }, () => {
  const airports: AirportDb = JSON.parse(readFileSync('public/airports.json', 'utf8'))
  const drops = noDrops()
  const real = parseLogbook(readFileSync(process.env.LOGBOOK!, 'utf8'), airports, drops)
  const totals = summary(real, airports)
  const legCount = real.reduce((n, f) => n + legs(f).length, 0)
  assert.equal(real.length, 1339) // 1397 rows, 58 with no resolvable airport
  // The 58 above, now self-checking, plus the hours they take off the Hours total.
  assert.equal(drops.rows, 58)
  assert.equal(Math.round(drops.hours * 10) / 10, 27.4)
  // 5 navaids and fixes, and 5 that look like airports — KISN among them, closed and since
  // removed from the FAA export, so its leg is simply gone.
  assert.equal(drops.identifiers.size, 10)
  assert.equal(drops.identifiers.get('KISN'), 1)
  assert.equal(legCount, 1249)
  assert.equal(routes(real, airports).length, 161)
  assert.equal(airportStats(real).length, 95) // 70 flown to, plus 25 reached only via a Filed Route
  assert.equal(Math.round(totals.nm), 306394)
  assert.equal(totals.states.length, 31)
  assert.deepEqual([totals.longest!.a, totals.longest!.b], ['KDEN', 'KMKE'])
  assert.ok(routes(real, airports).some((r) => r.a === totals.longest!.a && r.b === totals.longest!.b))
  assert.deepEqual(
    airportStats(real)
      .slice(0, 3)
      .map((s) => [s.id, s.visits]),
    [
      ['KIAD', 254],
      ['KGFK', 225],
      ['KORD', 108],
    ],
  )
})
