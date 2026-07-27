<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  airport,
  airportStats,
  arc,
  legs,
  parseLogbook,
  routes,
  summary,
  type AirportDb,
  type Flight,
  type Route,
} from './logbook'

const db = shallowRef<AirportDb>({})
const flights = shallowRef<Flight[]>([])
const error = ref('')

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
const place = (id: string) => airport(id, db.value)?.slice(3).filter(Boolean).join(', ') ?? ''
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
    flights.value = parseLogbook(await file.text(), db.value)
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
  }
}

let map: L.Map
const routeLayer = L.layerGroup()
const airportLayer = L.layerGroup()

function fit() {
  const points = stats.value.map((s) => at(s.id))
  if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.1))
}

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
        html: `<span style="width:${size}px;height:${size}px">${stat.visits}</span>`,
        iconSize: [size, size],
      }),
      zIndexOffset: stat.visits,
    })
      .on('click', () => (selected.value = { kind: 'airport', id: stat.id }))
      .bindTooltip(`${stat.id} — ${name(stat.id)} · ${stat.visits} visits`)
      .addTo(airportLayer)
  }
}

onMounted(async () => {
  map = L.map('map', { zoomControl: false }).setView([39.5, -95], 4)
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 18,
  }).addTo(map)
  routeLayer.addTo(map)
  airportLayer.addTo(map)
  db.value = await (await fetch('/airports.json')).json()
})

watch([shownRoutes, stats], draw)
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

    <template v-if="flights.length">
      <p class="summary">
        {{ shown.length }} flights · {{ legCount }} legs · {{ shownRoutes.length }} routes ·
        {{ stats.length }} airports
      </p>

      <div class="totals">
        <strong>{{ miles(totals.nm) }} mi</strong>
        <span>{{ (totals.nm / 21639).toFixed(1) }}× around the world</span>
        <strong>{{ totals.states.length }} states</strong>
        <span :title="totals.states.join(' ')">{{ totals.states.join(' ') }}</span>
        <template v-if="totals.longest">
          <strong>{{ Math.round(totals.longest.nm) }} nm</strong>
          <span :title="`longest leg, flown ${totals.longest.date}`">
            longest —
            <button @click="selectRoute(totals.longest.a, totals.longest.b)">
              {{ totals.longest.a }}–{{ totals.longest.b }}
            </button>
          </span>
        </template>
      </div>

      <ol class="timeline">
        <li v-for="y in timeline" :key="y.year">
          <button
            :style="{ height: `${y.height}%` }"
            :title="`${y.year} — ${y.n} flights`"
            @click="((from = `${y.year}-01-01`), (to = `${y.year}-12-31`))"
          ></button>
        </li>
      </ol>

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
    </template>
  </aside>

  <aside v-if="selected" class="panel detail">
    <button class="close" @click="selected = null" aria-label="Close">×</button>

    <template v-if="detail">
      <h2>{{ detail.id }}</h2>
      <p class="sub">{{ name(detail.id) }}<br />{{ place(detail.id) }}</p>
      <dl>
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
.summary {
  margin: 10px 0;
  color: #566;
  font-size: 12px;
}

.totals {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 8px;
  align-items: baseline;
  margin-bottom: 10px;
  font-size: 11px;
  color: #566;
}
.totals strong {
  font-size: 13px;
  color: #0f766e;
  white-space: nowrap;
}
.totals span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.totals button {
  padding: 0;
  border: 0;
  background: none;
  color: #0f766e;
  font: inherit;
  cursor: pointer;
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
.timeline button:hover {
  opacity: 1;
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
