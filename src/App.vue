<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  airport,
  airportStats,
  arc,
  elevation,
  flags,
  IAP,
  legs,
  MIL,
  noDrops,
  PRIVATE,
  parseLogbook,
  routes,
  summary,
  unvisited,
  type AirportDb,
  type Flight,
  type Route,
  TIME_KEYS,
  type TimeKey,
} from './logbook'

// A Record, so adding a category to TIME_COLUMNS without labelling it fails to compile.
// Reading order comes from TIME_KEYS, which is already the order a logbook page runs.
const HOUR_LABELS: Record<TimeKey, string> = {
  pic: 'PIC',
  sic: 'SIC',
  solo: 'Solo',
  xc: 'Cross-country',
  night: 'Night',
  actual: 'Actual inst',
  sim: 'Sim inst',
  dualGiven: 'Dual given',
  dualReceived: 'Dual received',
}

const db = shallowRef<AirportDb>({})
const flights = shallowRef<Flight[]>([])
const dropped = shallowRef(noDrops())
const error = ref('')

// Most frequently written first: the identifier flown ten times is likelier to be a real airport
// the dataset is missing than a one-off typo.
const lost = computed(() => [...dropped.value.identifiers].sort((a, b) => b[1] - a[1]))

const from = ref('')
const to = ref('')
const excluded = ref(new Set<string>())
const tail = ref('')
const minFlights = ref(1)

type Selection =
  | { kind: 'airport'; id: string }
  | ({ kind: 'route' } & Route)
const selected = ref<Selection | null>(null)

const name = (id: string) => airport(id, db.value)?.[2] || id
// Named indices rather than a slice: the record grew an elevation and a flags field on the end.
const place = (id: string) => {
  const a = airport(id, db.value)
  return a ? [a[3], a[4]].filter(Boolean).join(', ') : ''
}
const feet = (id: string) => {
  const a = airport(id, db.value)
  return a ? elevation(a).toLocaleString() : ''
}

// Military fields are also flagged private-use, so the stronger label wins.
const badge = (id: string) => {
  const a = airport(id, db.value)
  const bits = a ? flags(a) : 0
  return bits & MIL ? 'Military' : bits & PRIVATE ? 'Private use' : ''
}
const at = (id: string) => {
  const a = airport(id, db.value)!
  return [a[0], a[1]] as [number, number]
}

const types = computed(() =>
  [...new Set(flights.value.map((f) => f.type || '—'))].sort((a, b) => a.localeCompare(b)),
)

const byDateAndType = computed(() =>
  flights.value.filter(
    (f) =>
      (!from.value || f.date >= from.value) &&
      (!to.value || f.date <= to.value) &&
      !excluded.value.has(f.type || '—'),
  ),
)

// Offer only tails that survive the other filters — a logbook can hold hundreds.
const tails = computed(() => [...new Set(byDateAndType.value.map((f) => f.tail))].sort())

const shown = computed(() =>
  byDateAndType.value.filter((f) => !tail.value || f.tail === tail.value),
)

const allRoutes = computed(() => routes(shown.value, db.value))
const shownRoutes = computed(() => allRoutes.value.filter((r) => r.count >= minFlights.value))
const stats = computed(() => airportStats(shown.value))
const busiestRoute = computed(() => Math.max(1, ...allRoutes.value.map((r) => r.count)))
const legCount = computed(() => shown.value.reduce((n, f) => n + legs(f).length, 0))
const totals = computed(() => summary(shown.value, db.value))

// The sparkline spans the whole logbook so the bars stay put while you scrub through years.
const timeline = computed(() => {
  const years = summary(flights.value, db.value).perYear
  const busiest = Math.max(1, ...years.map(([, n]) => n))
  return years.map(([year, n]) => ({ year, n, height: Math.round((100 * n) / busiest) }))
})

const miles = (nm: number) => Math.round(nm * 1.15078).toLocaleString()
const hours = (h: number) => h.toFixed(1)

const fade = ref(false)

// "Now" is the newest flight in view rather than today's date: filter down to 2008 and every
// airport would read as ancient, greying the whole map out.
const newest = computed(() => shown.value.reduce((max, f) => (f.date > max ? f.date : max), ''))
const lastFlight = computed(() => flights.value.reduce((max, f) => (f.date > max ? f.date : max), ''))

const YEAR_MS = 365.25 * 24 * 3600 * 1000

/** Teal when recently visited, washing out to grey across five years away. */
function dotColor(last: string) {
  if (!fade.value) return '#0f766e'
  const age = (Date.parse(newest.value) - Date.parse(last)) / YEAR_MS
  const t = Math.min(1, Math.max(0, age / 5))
  return `color-mix(in oklab, #0f766e, #94a3b8 ${Math.round(t * 100)}%)`
}

// An empty date box means unbounded, exactly as byDateAndType reads it.
const inRange = (year: string) =>
  (!from.value || year >= from.value.slice(0, 4)) && (!to.value || year <= to.value.slice(0, 4))

const playing = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

function stop() {
  playing.value = false
  clearInterval(timer)
}

// Holds the start date and walks the end date forward, so years pile up rather than scrub past.
function play() {
  if (playing.value) return stop()
  const years = timeline.value.map((y) => y.year)
  if (!years.length) return
  from.value = `${years[0]}-01-01`
  to.value = `${years[0]}-12-31`
  playing.value = true
  let i = 0
  timer = setInterval(() => {
    // Finish on the last flight rather than 31 December, so the range matches a freshly loaded file.
    if (++i >= years.length) {
      to.value = lastFlight.value
      return stop()
    }
    to.value = `${years[i]}-12-31`
  }, 700)
}

// A category the pilot never logged is noise, not a zero worth reading.
const breakdown = computed(() => TIME_KEYS.filter((key) => totals.value.time[key] >= 0.05))

function selectRoute(a: string, b: string) {
  const route = allRoutes.value.find((r) => r.a === a && r.b === b)
  if (route) selected.value = { kind: 'route', ...route }
}

const detail = computed(() =>
  selected.value?.kind === 'airport'
    ? stats.value.find((s) => s.id === (selected.value as { id: string }).id)
    : null,
)

async function load(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    stop()
    const drops = noDrops()
    flights.value = parseLogbook(await file.text(), db.value, drops)
    dropped.value = drops
    error.value = ''
    selected.value = null
    minFlights.value = 1
    excluded.value = new Set()
    tail.value = ''
    const dates = flights.value.map((f) => f.date).sort()
    ;[from.value, to.value] = [dates.at(0) ?? '', dates.at(-1) ?? '']
    fit()
  } catch (e) {
    error.value = (e as Error).message
    flights.value = []
    dropped.value = noDrops()
  }
}

let map: L.Map
const routeLayer = L.layerGroup()
const airportLayer = L.layerGroup()
// A FeatureGroup, not a LayerGroup: only a FeatureGroup republishes its members' events, which is
// what lets one hover handler stand in for five thousand bound tooltips.
const unvisitedLayer = L.featureGroup()
let dots: L.Canvas

function fit() {
  const points = stats.value.map((s) => at(s.id))
  if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.1))
}

/**
 * Every public-use airport the pilot has never landed at, as canvas dots — the map's answer to
 * "where haven't I been". Visited airports are DOM divIcons, which is comfortable at a few hundred
 * and hopeless at five thousand, so this layer goes to a canvas renderer in its own pane.
 */
function drawUnvisited() {
  unvisitedLayer.clearLayers()
  const seen = new Set(flights.value.flatMap((f) => f.seq))
  for (const [id, a] of unvisited(db.value, seen)) {
    const dot = L.circleMarker([a[0], a[1]], {
      renderer: dots,
      pane: 'unvisited',
      radius: 2,
      weight: 0,
      // A published approach means somewhere you could actually go on an instrument day.
      fillColor: flags(a) & IAP ? '#64748b' : '#cbd5e1',
      fillOpacity: 0.9,
    })
    Object.assign(dot, { id }).addTo(unvisitedLayer)
  }
}

// Bound once on the group: bindTooltip builds its Tooltip immediately, and five thousand of those
// is exactly the cost the canvas renderer was chosen to avoid. Build on first hover instead.
unvisitedLayer.on('mouseover', (e) => {
  const dot = e.propagatedFrom as L.CircleMarker & { id: string }
  if (!dot.getTooltip()) dot.bindTooltip(`${dot.id} — ${name(dot.id)} · ${feet(dot.id)} ft`)
  dot.openTooltip()
})

function draw() {
  routeLayer.clearLayers()
  airportLayer.clearLayers()

  // Width encodes flight count, so it is derived from the data rather than exposed as a control.
  const heaviest = Math.max(1, ...shownRoutes.value.map((r) => r.count))
  for (const route of shownRoutes.value) {
    L.polyline(arc(airport(route.a, db.value)!, airport(route.b, db.value)!), {
      color: '#c2410c',
      weight: 1 + 7 * Math.sqrt(route.count / heaviest),
      opacity: 0.45,
    })
      .on('click', () => (selected.value = { kind: 'route', ...route }))
      .bindTooltip(`${route.a} – ${route.b} · ${route.count} flights · ${Math.round(route.nm)} nm`)
      .addTo(routeLayer)
  }

  const mostVisited = Math.max(1, ...stats.value.map((s) => s.visits))
  for (const stat of stats.value) {
    const size = Math.round(22 + 26 * Math.sqrt(stat.visits / mostVisited))
    L.marker(at(stat.id), {
      icon: L.divIcon({
        className: 'airport-dot',
        html: `<span style="width:${size}px;height:${size}px;background:${dotColor(stat.last)}">${stat.visits}</span>`,
        iconSize: [size, size],
      }),
      zIndexOffset: stat.visits,
    })
      .on('click', () => (selected.value = { kind: 'airport', id: stat.id }))
      .bindTooltip(`${stat.id} — ${name(stat.id)} · ${stat.visits} visits · last ${stat.last}`)
      .addTo(airportLayer)
  }
}

onMounted(async () => {
  map = L.map('map', { zoomControl: false }).setView([39.5, -95], 4)
  L.control.zoom({ position: 'bottomright' }).addTo(map)

  // Below overlayPane (400), so routes and visited airports always sit on top of the grey field.
  map.createPane('unvisited').style.zIndex = '350'
  dots = L.canvas({ pane: 'unvisited', padding: 0.5 })

  // Light is the default because the arcs read best on it; the others answer "what was down there".
  const basemaps = {
    Light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap contributors © CARTO',
      maxZoom: 18,
    }),
    Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }),
    Terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenTopoMap (CC-BY-SA) © OpenStreetMap contributors',
      maxZoom: 17,
    }),
    Satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Esri, Maxar, Earthstar Geographics', maxZoom: 19 },
    ),
  }
  basemaps.Light.addTo(map)

  // The FAA cache only holds zoom 8–12, so the sectional is an overlay rather than a basemap:
  // zoom out past 8 and it drops away, leaving whatever basemap is underneath.
  const overlays = {
    // Off by default: the map's subject is where the pilot has been, not where they have not.
    'Unvisited airports': unvisitedLayer,
    'VFR sectional': L.tileLayer(
      'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'FAA Aeronautical Information Services',
        minZoom: 8,
        maxNativeZoom: 12,
        maxZoom: 18,
      },
    ),
  }
  L.control.layers(basemaps, overlays, { position: 'bottomright' }).addTo(map)

  routeLayer.addTo(map)
  airportLayer.addTo(map)
  db.value = await (await fetch('/airports.json')).json()
})

watch([shownRoutes, stats, fade], draw)
// Keyed on the whole logbook, not the filtered view: rebuilding five thousand dots on every
// timeline tick would stutter, and "never been there" does not change when you scrub a year.
watch([flights, db], drawUnvisited)
</script>

<template>
  <div id="map"></div>

  <aside class="panel filters">
    <h1>ForeFlight Logbook Visualizer</h1>

    <label class="file">
      <input type="file" accept=".csv" @change="load" />
      <span>Choose ForeFlight logbook…</span>
    </label>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- The map's totals are only as complete as what resolved. Say so rather than understate. -->
    <details v-if="lost.length || dropped.rows" class="dropped">
      <summary>
        Not on the map<template v-if="dropped.rows">
          — {{ dropped.rows.toLocaleString() }}
          {{ dropped.rows === 1 ? 'flight' : 'flights' }}</template
        ><template v-if="lost.length">, {{ lost.length }} unresolved</template>
      </summary>
      <p v-if="dropped.rows">
        {{ dropped.rows.toLocaleString() }} {{ dropped.rows === 1 ? 'flight' : 'flights' }}
        <template v-if="dropped.hours">({{ hours(dropped.hours) }} h) </template>
        record no airport — simulator sessions and routeless entries. Absent from every total here.
      </p>
      <template v-if="lost.length">
        <p>
          {{ lost.length }} {{ lost.length === 1 ? 'identifier' : 'identifiers' }} matched no
          airport. Navaids and fixes belong here; an airport does not — it means a missing leg.
        </p>
        <ul>
          <li v-for="[id, n] in lost" :key="id">{{ id }}<span v-if="n > 1"> ×{{ n }}</span></li>
        </ul>
      </template>
    </details>

    <template v-if="flights.length">
      <fieldset>
        <legend>Dates</legend>
        <input type="date" v-model="from" />
        <input type="date" v-model="to" />
      </fieldset>

      <fieldset>
        <legend>Aircraft</legend>
        <div class="types">
          <label v-for="type in types" :key="type">
            <input
              type="checkbox"
              :checked="!excluded.has(type)"
              @change="
                (e: Event) => {
                  const next = new Set(excluded)
                  const on = (e.target as HTMLInputElement).checked
                  on ? next.delete(type) : next.add(type)
                  excluded = next
                }
              "
            />
            {{ type }}
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Tail</legend>
        <select v-model="tail">
          <option value="">All {{ tails.length }} aircraft</option>
          <option v-for="id in tails" :key="id" :value="id">{{ id }}</option>
        </select>
      </fieldset>

      <fieldset>
        <legend>Flown at least {{ minFlights }}×</legend>
        <input type="range" min="1" :max="busiestRoute" v-model.number="minFlights" />
      </fieldset>

      <label class="toggle">
        <input type="checkbox" v-model="fade" />
        Fade airports by years since last visit
      </label>
    </template>
  </aside>

  <aside v-if="flights.length" class="panel stats">
    <div class="row">
      <dl>
        <div><dt>Hours</dt><dd>{{ hours(totals.hours) }}</dd></div>
        <div><dt>Flights</dt><dd>{{ shown.length.toLocaleString() }}</dd></div>
        <div><dt>Legs</dt><dd>{{ legCount.toLocaleString() }}</dd></div>
        <div><dt>Routes</dt><dd>{{ shownRoutes.length }}</dd></div>
        <div><dt>Airports</dt><dd>{{ stats.length }}</dd></div>
        <div :title="`${(totals.nm / 21639).toFixed(1)}× around the world`">
          <dt>Miles</dt>
          <dd>{{ miles(totals.nm) }}</dd>
        </div>
        <div :title="totals.states.join(' ')">
          <dt>States</dt>
          <dd>{{ totals.states.length }}</dd>
        </div>
        <div v-if="totals.longest" :title="`longest leg, flown ${totals.longest.date}`">
          <dt>Longest</dt>
          <dd>
            <button @click="selectRoute(totals.longest.a, totals.longest.b)">
              {{ Math.round(totals.longest.nm) }} nm
            </button>
          </dd>
        </div>
        <div v-if="totals.highest" :title="`${name(totals.highest.id)} — highest field landed at`">
          <dt>Highest</dt>
          <dd>
            <button @click="selected = { kind: 'airport', id: totals.highest.id }">
              {{ totals.highest.ft.toLocaleString() }} ft
            </button>
          </dd>
        </div>
      </dl>

      <button class="play" :title="playing ? 'Stop' : 'Play through the years'" @click="play">
        {{ playing ? '■' : '▶' }}
      </button>

      <ol class="timeline">
        <li v-for="y in timeline" :key="y.year">
          <button
            :class="{ lit: inRange(y.year) }"
            :style="{ height: `${y.height}%` }"
            :title="`${y.year} — ${y.n} flights`"
            @click="((from = `${y.year}-01-01`), (to = `${y.year}-12-31`))"
          ></button>
        </li>
      </ol>
    </div>

    <!-- Categories overlap — a night cross-country is counted in both — so they never sum to Hours. -->
    <dl v-if="breakdown.length" class="breakdown">
      <div v-for="key in breakdown" :key="key">
        <dt>{{ HOUR_LABELS[key] }}</dt>
        <dd>{{ hours(totals.time[key]) }}</dd>
      </div>
    </dl>
  </aside>

  <aside v-if="selected" class="panel detail">
    <button class="close" @click="selected = null" aria-label="Close">×</button>

    <template v-if="detail">
      <h2>{{ detail.id }}</h2>
      <p class="sub">
        {{ name(detail.id) }}<br />{{ place(detail.id) }}
        <span v-if="badge(detail.id)" class="badge">{{ badge(detail.id) }}</span>
      </p>
      <dl>
        <dt>Elevation</dt>
        <dd>{{ feet(detail.id) }} ft</dd>
        <dt>Visits</dt>
        <dd>{{ detail.visits }}</dd>
        <dt>First</dt>
        <dd>{{ detail.first }}</dd>
        <dt>Last</dt>
        <dd>{{ detail.last }}</dd>
        <dt>Routes</dt>
        <dd>{{ detail.routes.length }}</dd>
      </dl>

      <template v-if="detail.approaches.length">
        <h3>Approaches</h3>
        <ul class="approaches">
          <li v-for="[approach, n] in detail.approaches" :key="approach">
            {{ approach }} <span v-if="n > 1">×{{ n }}</span>
          </li>
        </ul>
      </template>
      <ul class="links">
        <li v-for="id in detail.routes" :key="id">
          <button @click="selected = { kind: 'airport', id }">{{ id }} — {{ name(id) }}</button>
        </li>
      </ul>
    </template>

    <template v-else-if="selected.kind === 'route'">
      <h2>{{ selected.a }} – {{ selected.b }}</h2>
      <p class="sub">{{ name(selected.a) }}<br />{{ name(selected.b) }}</p>
      <dl>
        <dt>Flights</dt>
        <dd>{{ selected.count }}</dd>
        <dt>Distance</dt>
        <dd>{{ Math.round(selected.nm) }} nm</dd>
        <template v-if="selected.hours">
          <dt>Hours</dt>
          <dd>{{ selected.hours.toFixed(1) }}</dd>
        </template>
      </dl>
      <p v-if="!selected.hours" class="note">
        No hours to total — this pair is only flown as part of multi-stop flights.
      </p>
    </template>

    <template v-else>
      <h2>{{ selected.id }}</h2>
      <p class="sub">{{ name(selected.id) }}<br />No visits match the current filters.</p>
    </template>
  </aside>
</template>

<style>
#map {
  position: absolute;
  inset: 0;
  background: #eef1f4;
}

.airport-dot span {
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #0f766e;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.3);
  cursor: pointer;
}

.panel {
  position: absolute;
  z-index: 500;
  top: 12px;
  width: 260px;
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 14px;
  border-radius: 10px;
  background: rgb(255 255 255 / 0.95);
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.18);
}

.filters {
  left: 12px;
}
.detail {
  right: 12px;
}

h1 {
  margin: 0 0 10px;
  font-size: 14px;
  letter-spacing: -0.1px;
}
h2 {
  margin: 0;
  font-size: 20px;
}

.file input {
  display: none;
}
.file span {
  display: block;
  padding: 7px;
  border: 1px dashed #9aa3ab;
  border-radius: 6px;
  text-align: center;
  cursor: pointer;
}

.error {
  color: #b91c1c;
}

.dropped {
  margin: 10px 0;
  color: #566;
  font-size: 12px;
}
.dropped summary {
  cursor: pointer;
}
.dropped p {
  margin: 6px 0;
}
.dropped ul {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dropped li {
  padding: 1px 5px;
  border-radius: 3px;
  background: #eef1f4;
  font-variant-numeric: tabular-nums;
}

/* Own bar along the bottom: starts clear of the filter panel, stops short of the zoom control. */
.stats {
  top: auto;
  bottom: 24px;
  left: 284px;
  right: auto;
  width: auto;
  max-width: calc(100% - 344px);
  max-height: none;
  overflow: visible;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.stats .row {
  display: flex;
  align-items: flex-end;
  gap: 22px;
}
.stats dl {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
}
.stats dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.stats dd {
  font-size: 20px;
  font-weight: 600;
  color: #0f766e;
  white-space: nowrap;
}
.stats button {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.stats .timeline {
  flex: none;
  width: 200px;
  height: 40px;
  margin: 0;
}

.stats .breakdown {
  gap: 2px 18px;
  padding-top: 9px;
  border-top: 1px solid #e6eaee;
}
.stats .breakdown dt {
  text-transform: none;
  letter-spacing: 0;
}
.stats .breakdown dd {
  font-size: 13px;
}

.timeline {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 34px;
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}
.timeline li {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.timeline button {
  width: 100%;
  min-height: 2px;
  border: 0;
  border-radius: 1px;
  background: #0f766e;
  opacity: 0.55;
  cursor: pointer;
}
.timeline button:hover,
.timeline button.lit {
  opacity: 1;
}

.play {
  width: 26px;
  height: 26px;
  border: 1px solid #dfe3e7;
  border-radius: 50%;
  background: #fff;
  color: #0f766e;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.toggle {
  display: block;
  color: #566;
  font-size: 12px;
}

h3 {
  margin: 14px 0 4px;
  font-size: 12px;
  color: #566;
}
.approaches {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
}
.note {
  margin: 8px 0 0;
  color: #566;
  font-size: 12px;
}

fieldset {
  margin: 0 0 10px;
  padding: 8px;
  border: 1px solid #dfe3e7;
  border-radius: 6px;
}
legend {
  padding: 0 4px;
  color: #566;
  font-size: 12px;
}
fieldset input[type='date'],
fieldset input[type='range'],
fieldset select {
  width: 100%;
}

.types {
  display: grid;
  grid-template-columns: 1fr 1fr;
  max-height: 130px;
  overflow: auto;
  font-size: 12px;
}

.sub {
  margin: 4px 0 12px;
  color: #566;
}
.badge {
  display: inline-block;
  margin-top: 4px;
  padding: 1px 6px;
  border-radius: 3px;
  background: #eef1f4;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0;
}
dt {
  color: #566;
}
dd {
  margin: 0;
  font-weight: 600;
}

.links {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.links button {
  padding: 2px 0;
  border: 0;
  background: none;
  color: #0f766e;
  cursor: pointer;
}

.close {
  float: right;
  border: 0;
  background: none;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
</style>
