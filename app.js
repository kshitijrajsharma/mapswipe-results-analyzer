"use strict";

const UNCLEAR_COLOR = "#9e9e9e";
const YES = 1;
const NO = 0;
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/i;
const PAGE = (u) => `https://mapswipe.org/en/projects/${u}/`;
const FIREBASE = (id) => `https://msf-mapswipe.firebaseio.com/v2/projects/${id}.json`;
const FALLBACK = [
  { value: 1, title: "Yes", iconColor: "#388E3C" },
  { value: 0, title: "No", iconColor: "#D32F2F" },
  { value: 2, title: "Not sure", iconColor: "#616161" },
  { value: 3, title: "Bad imagery", iconColor: "#9E9E9E" },
];

const state = { projects: new Map(), threshold: 0.5, fillOpacity: 0.35 };

const map = L.map("map", { maxZoom: 22 }).setView([10.5, -66.95], 12);
map.createPane("aoi").style.zIndex = 350;
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxNativeZoom: 19,
  maxZoom: 22,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const el = (id) => document.getElementById(id);
const els = {
  input: el("project-input"),
  add: el("add-button"),
  status: el("status"),
  threshold: el("threshold"),
  thresholdValue: el("threshold-value"),
  opacity: el("opacity"),
  opacityValue: el("opacity-value"),
  projects: el("projects"),
  exportAll: el("export-all"),
};

const setStatus = (m, k) => {
  els.status.textContent = m;
  els.status.className = "status" + (k ? " " + k : "");
};

const QuadKeyLayer = L.TileLayer.extend({
  getTileUrl(c) {
    let q = "";
    for (let i = c.z; i > 0; i--) {
      let d = 0;
      const m = 1 << (i - 1);
      if (c.x & m) d++;
      if (c.y & m) d += 2;
      q += d;
    }
    return this._url.replace(/\{quad_?key\}/i, q);
  },
});

function makeImagery(ts) {
  if (!ts || !ts.url) return null;
  const url = ts.url.split("{key}").join(ts.apiKey || "");
  const opts = { maxNativeZoom: 20, maxZoom: 22, zIndex: 5, attribution: ts.credits || "Project imagery" };
  return /\{quad_?key\}/i.test(url) ? new QuadKeyLayer(url, opts) : L.tileLayer(url, opts);
}

const AOI_OPTS = { pane: "aoi", interactive: false, style: { color: "#20365b", weight: 2, dashArray: "6 4", fill: false } };
function makeAoi(aoi) {
  if (aoi.geojson) return L.geoJSON(aoi.geojson, AOI_OPTS);
  if (aoi.bbox) return L.geoJSON({ type: "Feature", geometry: { type: "Polygon", coordinates: aoi.bbox } }, AOI_OPTS);
  return null;
}

async function resolveProject(input) {
  const m = input.match(ULID);
  if (!m) throw new Error("Paste a MapSwipe project URL or its 26-character ID.");
  const ulid = m[0].toUpperCase();
  const page = await fetch(PAGE(ulid));
  if (!page.ok) throw new Error(`Project page returned ${page.status}`);
  const doc = new DOMParser().parseFromString(await page.text(), "text/html");
  const node = doc.getElementById("__NEXT_DATA__");
  if (!node) throw new Error("Could not read project metadata (page format changed).");
  const pp = JSON.parse(node.textContent).props.pageProps;
  const exp = pp.exportAggregatedResultsWithGeometry;
  if (!exp || !exp.file || !exp.file.url) throw new Error("This project has no aggregated-results export yet.");

  let options = null, instruction = null, tileServer = null;
  const fb = await fetch(FIREBASE(pp.firebaseId || ulid));
  if (fb.ok) {
    const r = await fb.json();
    if (r) {
      options = r.customOptions || null;
      instruction = r.projectInstruction || null;
      tileServer = r.tileServer || null;
    }
  }
  const custom = Array.isArray(options) && options.length > 0;
  return {
    ulid,
    numeric_id: String(pp.id),
    name: pp.name,
    project_type: pp.projectType,
    instruction,
    geojson_url: exp.file.url,
    tile_server: tileServer,
    aoi: { url: (pp.exportAreaOfInterest && pp.exportAreaOfInterest.file && pp.exportAreaOfInterest.file.url) || null, bbox: (pp.aoiGeometry && pp.aoiGeometry.bbox) || null },
    options: custom ? options : FALLBACK,
    options_source: custom ? "firebase" : "fallback-defaults",
  };
}

async function gunzipJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return JSON.parse(pako.ungzip(new Uint8Array(await res.arrayBuffer()), { to: "string" }));
}

const shareOf = (p, v) => {
  const total = Number(p.total_count);
  if (!total) return 0;
  const s = p[`${v}_share`];
  return s !== undefined && s !== null ? Number(s) : Number(p[`${v}_count`] || 0) / total;
};

function winning(record, p) {
  let best = null;
  for (const o of record.options) {
    const s = shareOf(p, o.value);
    if (!best || s > best.share) best = { option: o, share: s };
  }
  return best;
}

function classify(record, p) {
  const yes = shareOf(p, YES), no = shareOf(p, NO);
  if (yes > state.threshold && yes >= no) return "accepted";
  if (no > state.threshold) return "rejected";
  return "unclear";
}

const colorOf = (record, v) => {
  const o = record.optionByValue.get(v);
  return o ? o.iconColor : UNCLEAR_COLOR;
};
const decisionColor = (record, d) =>
  d === "accepted" ? colorOf(record, YES) : d === "rejected" ? colorOf(record, NO) : UNCLEAR_COLOR;

const polyStyle = (record, f) => ({ color: "#37474f", weight: 1, fillColor: decisionColor(record, classify(record, f.properties)), fillOpacity: state.fillOpacity });
const dotStyle = (record, f) => ({ radius: 6, color: "#263238", weight: 1, fillColor: decisionColor(record, classify(record, f.properties)), fillOpacity: 0.9 });

function popup(record, p) {
  const total = Number(p.total_count) || 0;
  const rows = record.options
    .map((o) => {
      const c = Number(p[`${o.value}_count`] || 0);
      return `<div class="opt"><span>${o.title}</span><span>${c} (${total ? Math.round((c / total) * 100) : 0}%)</span></div>`;
    })
    .join("");
  return `<b>${record.name}</b><br><i>${record.instruction || ""}</i><br>Decision: <b>${classify(record, p)}</b><br>${rows}<hr style="margin:6px 0">Mappers: ${total}`;
}

function tally(record) {
  const c = { accepted: 0, rejected: 0, unclear: 0 };
  for (const f of record.geojson.features) c[classify(record, f.properties)]++;
  return c;
}

function restyleAll() {
  for (const record of state.projects.values()) {
    record.layer.setStyle((f) => polyStyle(record, f));
    for (const e of record.markers) e.marker.setStyle(dotStyle(record, e.feature));
  }
  renderProjects();
}

function renderProjects() {
  els.projects.innerHTML = "";
  for (const record of state.projects.values()) {
    const c = tally(record);
    const card = document.createElement("div");
    card.className = "project-card";
    card.innerHTML =
      `<div class="name">${record.name}</div>` +
      `<div class="meta">${record.project_type} · ${record.geojson.features.length} tasks${record.options_source === "fallback-defaults" ? " · default labels" : ""}</div>` +
      `<div class="counts"><span class="count-accepted">accepted ${c.accepted}</span><span class="count-rejected">rejected ${c.rejected}</span><span class="count-unclear">unclear ${c.unclear}</span></div>` +
      `<div class="layers">` +
      `<label><input type="checkbox" data-layer="results" ${record.showResults ? "checked" : ""}> results</label>` +
      `<label><input type="checkbox" data-layer="imagery" ${record.tile_server ? "" : "disabled"} ${record.showImagery ? "checked" : ""}> imagery</label>` +
      `<label><input type="checkbox" data-layer="aoi" ${record.aoiLayer ? "" : "disabled"} ${record.showAoi ? "checked" : ""}> AOI</label>` +
      `</div>` +
      `<div class="downloads">Download: <button class="link" data-dl="accepted">accepted</button><button class="link" data-dl="rejected">rejected</button><button class="link" data-dl="unclear">not sure</button><button class="link" data-csv>csv (all)</button><button class="link" data-remove>remove</button></div>`;

    card.querySelectorAll("[data-layer]").forEach((box) =>
      box.addEventListener("change", (ev) => toggleLayer(record, box.dataset.layer, ev.target.checked))
    );
    card.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => exportDecision([record], b.dataset.dl)));
    card.querySelector("[data-csv]").addEventListener("click", () => exportCsv(record));
    card.querySelector("[data-remove]").addEventListener("click", () => removeProject(record));
    els.projects.appendChild(card);
  }
  els.exportAll.disabled = state.projects.size === 0;
}

function toggleLayer(record, kind, on) {
  let layer = kind === "results" ? record.group : kind === "imagery" ? record.imageryLayer : record.aoiLayer;
  if (kind === "imagery" && on && !layer) layer = record.imageryLayer = makeImagery(record.tile_server);
  if (!layer) return;
  if (on) layer.addTo(map);
  else map.removeLayer(layer);
  if (kind === "results") record.showResults = on;
  if (kind === "imagery") record.showImagery = on;
  if (kind === "aoi") record.showAoi = on;
}

function removeProject(record) {
  [record.group, record.imageryLayer, record.aoiLayer].forEach((l) => l && map.removeLayer(l));
  state.projects.delete(record.numeric_id);
  renderProjects();
  writeUrl();
}

function centroid(g) {
  let sx = 0, sy = 0, n = 0;
  const walk = (c) => {
    if (typeof c[0] === "number") { sx += c[0]; sy += c[1]; n++; return; }
    c.forEach(walk);
  };
  walk(g.coordinates);
  return n ? [sx / n, sy / n] : [null, null];
}

function readable(record, p) {
  const total = Number(p.total_count) || 0;
  const out = { project: record.name, task_id: p.task_id, decision: classify(record, p), majority_answer: winning(record, p).option.title, total_mappers: total };
  for (const o of record.options) {
    const c = Number(p[`${o.value}_count`] || 0);
    out[`${o.title} (count)`] = c;
    out[`${o.title} (%)`] = total ? Math.round((c / total) * 100) : 0;
  }
  return out;
}

function download(name, text, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportDecision(records, decision) {
  const features = [];
  for (const record of records)
    for (const f of record.geojson.features)
      if (classify(record, f.properties) === decision)
        features.push({ type: "Feature", geometry: f.geometry, properties: readable(record, f.properties) });
  if (!features.length) return setStatus(`No ${decision} features at the current threshold.`, "error");
  const base = records.length === 1 ? `${decision}_${records[0].numeric_id}` : `${decision}_combined`;
  download(`${base}.geojson`, JSON.stringify({ type: "FeatureCollection", features }), "application/geo+json");
}

function exportCsv(record) {
  const rows = record.geojson.features.map((f) => {
    const [lon, lat] = centroid(f.geometry);
    return { ...readable(record, f.properties), centroid_lon: lon, centroid_lat: lat };
  });
  const head = Object.keys(rows[0]);
  const esc = (v) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [head.join(",")].concat(rows.map((r) => head.map((h) => esc(r[h])).join(","))).join("\n");
  download(`all_results_${record.numeric_id}.csv`, csv, "text/csv");
}

function fitAll() {
  let bounds = null;
  for (const record of state.projects.values()) {
    const b = record.group.getBounds();
    bounds = bounds ? bounds.extend(b) : b;
  }
  if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
}

async function loadProject(value) {
  const descriptor = await resolveProject(value);
  if (state.projects.has(descriptor.numeric_id)) throw new Error("Project already loaded");
  const geojson = await gunzipJson(descriptor.geojson_url);
  if (descriptor.aoi.url) descriptor.aoi.geojson = await gunzipJson(descriptor.aoi.url);

  const optionByValue = new Map(descriptor.options.map((o) => [o.value, o]));
  const record = { ...descriptor, geojson, optionByValue, markers: [], showResults: true, showImagery: false, showAoi: true, imageryLayer: null };
  record.layer = L.geoJSON(geojson, {
    style: (f) => polyStyle(record, f),
    onEachFeature: (f, l) => l.bindPopup(() => popup(record, f.properties)),
  });
  record.group = L.featureGroup([record.layer]);
  for (const f of geojson.features) {
    const [lon, lat] = centroid(f.geometry);
    if (lat === null) continue;
    const marker = L.circleMarker([lat, lon], dotStyle(record, f)).bindPopup(() => popup(record, f.properties));
    record.markers.push({ feature: f, marker });
    record.group.addLayer(marker);
  }
  record.group.addTo(map);
  record.aoiLayer = makeAoi(descriptor.aoi);
  if (record.aoiLayer) record.aoiLayer.addTo(map);

  state.projects.set(record.numeric_id, record);
  renderProjects();
  return record;
}

async function addProject(value) {
  const input = (value || els.input.value).trim();
  if (!input) return;
  els.add.disabled = true;
  setStatus("Loading project...");
  try {
    const record = await loadProject(input);
    els.input.value = "";
    setStatus(`Loaded ${record.geojson.features.length} tasks from "${record.name}".`, "ok");
    fitAll();
    writeUrl();
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    els.add.disabled = false;
  }
}

function writeUrl() {
  const params = new URLSearchParams();
  const ids = [...state.projects.values()].map((r) => r.ulid);
  if (ids.length) params.set("p", ids.join(","));
  params.set("t", els.threshold.value);
  params.set("o", els.opacity.value);
  history.replaceState(null, "", "?" + params.toString());
}

async function loadFromUrl() {
  const params = new URLSearchParams(location.search);
  const t = params.get("t");
  if (t !== null) {
    els.threshold.value = t;
    state.threshold = Number(t) / 100;
    els.thresholdValue.textContent = `${t}%`;
  }
  const o = params.get("o");
  if (o !== null) {
    els.opacity.value = o;
    state.fillOpacity = Number(o) / 100;
    els.opacityValue.textContent = `${o}%`;
  }
  const ids = (params.get("p") || "").split(",").filter(Boolean);
  for (const id of ids) {
    setStatus(`Loading ${id}...`);
    try {
      await loadProject(id);
    } catch (e) {
      setStatus(`${id}: ${e.message}`, "error");
    }
  }
  if (ids.length) {
    fitAll();
    setStatus(`Loaded ${state.projects.size} project(s).`, "ok");
  }
}

els.add.addEventListener("click", () => addProject());
els.input.addEventListener("keydown", (e) => e.key === "Enter" && addProject());
els.threshold.addEventListener("input", () => {
  state.threshold = Number(els.threshold.value) / 100;
  els.thresholdValue.textContent = `${els.threshold.value}%`;
  restyleAll();
  writeUrl();
});
els.opacity.addEventListener("input", () => {
  state.fillOpacity = Number(els.opacity.value) / 100;
  els.opacityValue.textContent = `${els.opacity.value}%`;
  restyleAll();
  writeUrl();
});
els.exportAll.addEventListener("click", () => exportDecision([...state.projects.values()], "accepted"));
el("panel-toggle").addEventListener("click", () => {
  document.body.classList.toggle("panel-collapsed");
  setTimeout(() => map.invalidateSize(), 200);
});
window.addEventListener("resize", () => map.invalidateSize());

loadFromUrl();
