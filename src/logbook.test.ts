import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  airportStats,
  arc,
  distanceNm,
  legs,
  parseLogbook,
  routes,
  summary,
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
  const real = parseLogbook(readFileSync(process.env.LOGBOOK!, 'utf8'), airports)
  const totals = summary(real, airports)
  const legCount = real.reduce((n, f) => n + legs(f).length, 0)
  assert.equal(real.length, 1339) // 1397 rows, 58 with no resolvable airport
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
