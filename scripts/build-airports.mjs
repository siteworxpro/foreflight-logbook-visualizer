// Prunes the FAA ADIP export down to what the map needs.
// Run manually when the FAA publishes an update: node scripts/build-airports.mjs
// See docs/adr/0001-bundled-pruned-airport-dataset.md
import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'Airports.geojson'
const OUT = 'public/airports.json'

const { features } = JSON.parse(readFileSync(SOURCE, 'utf8'))
const airports = {}

for (const { properties: p, geometry } of features) {
  if (p.TYPE_CODE !== 'AD') continue // skip heliports, seaplane bases, ultralight fields
  const [lon, lat] = geometry.coordinates
  const record = [+lat.toFixed(5), +lon.toFixed(5), p.NAME ?? '', p.SERVCITY ?? '', p.STATE ?? '']
  // Logbooks mix ICAO (KIAD) and FAA (3CK) identifiers. One airport must stay one airport,
  // so the ICAO form is canonical and the FAA form becomes a string alias pointing at it.
  const canonical = p.ICAO_ID || p.IDENT
  if (!canonical) continue
  if (!(canonical in airports)) airports[canonical] = record
  if (p.IDENT && p.IDENT !== canonical && !(p.IDENT in airports)) airports[p.IDENT] = canonical
}

writeFileSync(OUT, JSON.stringify(airports))
console.log(`${OUT}: ${Object.keys(airports).length} identifiers, ${(readFileSync(OUT).length / 1024) | 0} KB`)
