import Globe from "globe.gl";

// Shape of public/globe.json, written by `jobscan globe-export`.
interface Job {
  title: string;
  company: string;
  url: string;
  source: string;
  posted_at: string;
  location_raw: string;
  skills: string[];
  hq_source: "text" | "inferred";
  hq_confidence: string | null;
  hiring_regions: string[];
  hiring_countries: string[];
  timezone_note: string | null;
}

interface City {
  id: string;
  city: string | null;
  country: string | null;
  country_code: string | null;
  lat: number;
  lng: number;
  precision: "city" | "region" | "country";
  approx: boolean;
  jobs: Job[];
}

type Ring = number[][];
interface CountryGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: Ring[] | Ring[][];
}

interface GlobeData {
  generated: string;
  totals: {
    jobs: number;
    plotted: number;
    not_located: number;
    unknown_hq: number;
    not_geocoded: number;
    points: number;
    companies: number;
  };
  cities: City[];
}

// Mirrors --stated / --inferred in style.css.
const COLOR = { text: "#3987e5", inferred: "#d95926" };
const MAX_CHIPS = 8;
// Hubs with at least this many jobs get a name on the globe; below it the
// labels pile up over central Europe.
const LABEL_MIN_JOBS = 3;
const SOURCE_LABEL: Record<string, string> = {
  hackernews: "HN Who's Hiring",
  weworkremotely: "We Work Remotely",
  remoteok: "RemoteOK",
  remotive: "Remotive",
  arbeitnow: "Arbeitnow",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Scraped URLs are untrusted; only link out to http(s).
function safeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function labelCandidates(cities: City[]): City[] {
  return cities.filter((c) => !c.approx && c.jobs.length >= LABEL_MIN_JOBS);
}

// Great-circle angle between two points, in degrees.
function arcDegrees(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  const cos =
    Math.sin(aLat * r) * Math.sin(bLat * r) + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.cos((aLng - bLng) * r);
  return Math.acos(Math.min(1, Math.max(-1, cos))) / r;
}

// Labels are fixed-size HTML, so which ones fit depends on the camera. Show a
// label only when it faces the viewer (not near the horizon), then place the
// biggest hubs first, in screen space: a label is skipped if its box would
// overlap one already shown or a panel. Zooming in spreads the hubs apart and
// the smaller ones appear.
const LABEL_MAX_ARC = 70;
const LABEL_GAP = 4; // px of air between labels

interface Box { l: number; t: number; r: number; b: number }
const overlaps = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

function placeName(c: City): string {
  return c.city ?? c.country ?? "Unknown";
}

function inferredShare(c: City): number {
  return c.jobs.filter((j) => j.hq_source === "inferred").length / c.jobs.length;
}

function pointColor(c: City): string {
  const hex = inferredShare(c) > 0.5 ? COLOR.inferred : COLOR.text;
  if (!c.approx) return hex;
  // Region- and country-level points are drawn translucent: the location is
  // only a centroid.
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.4)`;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function hiringLine(j: Job): string {
  // "US" can arrive as both a region and a country code; show it once.
  const parts = [...new Set([...j.hiring_regions, ...j.hiring_countries])];
  const where = parts.length ? parts.join(", ") : j.location_raw || "";
  return [where, j.timezone_note].filter(Boolean).join(" · ");
}

function tooltip(c: City): string {
  const companies = [...new Set(c.jobs.map((j) => j.company).filter(Boolean))];
  const shown = companies.slice(0, 3).map(esc).join(", ");
  const more = companies.length > 3 ? ` +${companies.length - 3}` : "";
  const where = c.city && c.country ? `${esc(c.city)}, ${esc(c.country)}` : esc(placeName(c));
  const n = c.jobs.length;
  return `<div class="tip"><strong>${where}</strong><span class="n">${n}</span> job${n === 1 ? "" : "s"}${
    shown ? ` · ${shown}${more}` : ""
  }</div>`;
}

// ---- panel ---------------------------------------------------------------

function renderJob(j: Job): HTMLLIElement {
  const li = el("li", "job");

  const h = el("h3", "job-title");
  const href = safeUrl(j.url);
  if (href) {
    const a = el("a", undefined, j.title);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    h.append(a);
  } else {
    h.textContent = j.title;
  }
  li.append(h);

  const meta = el("p", "job-meta");
  meta.append(el("span", "company", j.company || "Unknown company"));
  const bits = [formatDate(j.posted_at), SOURCE_LABEL[j.source] ?? j.source].filter(Boolean);
  for (const b of bits) meta.append(el("span", "sep", "·"), el("span", undefined, b));
  if (j.hq_source === "inferred") {
    const badge = el("span", "badge badge-inferred", "HQ inferred");
    badge.title = `The posting doesn't state an HQ; placed from knowledge of the company (${j.hq_confidence ?? "?"} confidence).`;
    meta.append(badge);
  }
  li.append(meta);

  const hiring = hiringLine(j);
  if (hiring) li.append(el("p", "hiring", `Hires from: ${hiring}`));

  if (j.skills.length) {
    const chips = el("div", "chips");
    for (const s of j.skills.slice(0, MAX_CHIPS)) chips.append(el("span", "chip", s));
    if (j.skills.length > MAX_CHIPS) chips.append(el("span", "chip chip-more", `+${j.skills.length - MAX_CHIPS}`));
    li.append(chips);
  } else {
    li.append(el("p", "no-stack", "No stack named in the posting"));
  }
  return li;
}

function openPanel(c: City): void {
  $("panel-title").textContent = placeName(c);
  const companies = new Set(c.jobs.map((j) => j.company.toLowerCase())).size;
  const where =
    c.precision === "country"
      ? "Country-level location"
      : c.precision === "region"
        ? `Region-level location${c.country ? `, ${c.country}` : ""}`
        : c.country ?? "";
  $("panel-sub").textContent = [
    where,
    `${c.jobs.length} job${c.jobs.length === 1 ? "" : "s"}`,
    `${companies} compan${companies === 1 ? "y" : "ies"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const list = $("panel-jobs");
  list.replaceChildren(...c.jobs.map(renderJob));
  list.scrollTop = 0;
  $("panel").hidden = false;
}

// ---- base map ------------------------------------------------------------

// Countries are painted once into an equirectangular image and wrapped on the
// globe as a texture. As 3D polygons they cost ~530 draw calls a frame and
// made every mouse move raycast against hundreds of meshes; as a texture they
// cost one draw call and nothing to hover.
const MAP = { w: 4096, h: 2048, ocean: "#0a1628", land: "#1c2c44", border: "#4a6488" };

async function paintCountries(): Promise<string> {
  const res = await fetch("/data/countries.geojson");
  const geo: { features: { geometry: CountryGeometry }[] } = await res.json();
  const canvas = document.createElement("canvas");
  canvas.width = MAP.w;
  canvas.height = MAP.h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = MAP.ocean;
  ctx.fillRect(0, 0, MAP.w, MAP.h);

  const path = new Path2D();
  const x = (lng: number) => ((lng + 180) / 360) * MAP.w;
  const y = (lat: number) => ((90 - lat) / 180) * MAP.h;
  for (const f of geo.features) {
    const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
    for (const rings of polys) {
      for (const ring of rings) {
        ring.forEach(([lng, lat], i) => (i ? path.lineTo(x(lng), y(lat)) : path.moveTo(x(lng), y(lat))));
        path.closePath();
      }
    }
  }
  ctx.fillStyle = MAP.land;
  ctx.fill(path, "evenodd");
  ctx.strokeStyle = MAP.border;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.stroke(path);

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
}

// ---- globe ---------------------------------------------------------------

let onHubLabelClick: (c: City) => void = () => {};

function hubLabel(c: City, registry: Map<City, HTMLElement>): HTMLElement {
  const node = el("button", "hub-label", c.city ?? "");
  registry.set(c, node);
  // Size follows job count, within a legible range.
  node.style.fontSize = `${Math.min(15, 10.5 + Math.sqrt(c.jobs.length) * 0.5).toFixed(1)}px`;
  node.title = `${c.city}: ${c.jobs.length} jobs`;
  node.addEventListener("click", () => onHubLabelClick(c));
  return node;
}

// Retina screens would otherwise render 4x the pixels; past 1.5 the globe
// looks the same and the GPU does far less work.
const MAX_PIXEL_RATIO = 1.5;
// Stop rendering this long after the last interaction; any input resumes it.
const IDLE_MS = 4000;

async function main(): Promise<void> {
  const status = $("status");
  let data: GlobeData;
  try {
    const res = await fetch("/globe.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    status.innerHTML =
      "No <code>public/globe.json</code> yet. Run <code>jobscan locate</code> then <code>jobscan globe-export</code>.";
    return;
  }
  status.hidden = true;

  const t = data.totals;
  const stats: [string, number][] = [
    ["Jobs", t.plotted],
    ["Companies", t.companies],
    ["Places", t.points],
    ["Unplaced", t.jobs - t.plotted],
  ];
  $("stats").replaceChildren(
    ...stats.map(([label, value]) => {
      const d = el("div");
      d.append(el("dd", undefined, value.toLocaleString()), el("dt", undefined, label));
      if (label === "Unplaced") {
        d.title = `${t.unknown_hq} with no known HQ, ${t.not_geocoded} not geocoded, ${t.not_located} not yet processed`;
      }
      return d;
    }),
  );

  const container = $("globe");
  const jobs = (d: object) => (d as City).jobs.length;
  // Bars stay short: tall ones read as sticks near the limb and hide the land
  // they are meant to point at. √ scaling, radius capped, because one hub has
  // ~20x the jobs of the next tier.
  const barAltitude = (d: object) => 0.006 + Math.sqrt(jobs(d)) * 0.012;

  const hubs = labelCandidates(data.cities);
  const labelNodes = new Map<City, HTMLElement>();

  const globe = new Globe(container, { animateIn: true, rendererConfig: { powerPreference: "high-performance" } })
    .backgroundColor("#05070b")
    .backgroundImageUrl("/textures/night-sky.png")
    .showAtmosphere(true)
    .atmosphereColor("#5b9cf0")
    .atmosphereAltitude(0.18)
    .pointsData(data.cities)
    .pointLat("lat")
    .pointLng("lng")
    .pointColor((d) => pointColor(d as City))
    .pointAltitude(barAltitude)
    .pointRadius((d) => Math.min(0.55, 0.16 + Math.sqrt(jobs(d)) * 0.045))
    // Name the hubs on the globe itself, so a place is readable without
    // hovering. HTML, not 3D text: 26 text meshes were 88% of the scene's
    // triangles, while DOM labels cost the GPU nothing, stay crisp at any
    // zoom and render every character ("Wrocław", not "Wroc?aw").
    .htmlElementsData(hubs)
    .htmlLat("lat")
    .htmlLng("lng")
    .htmlAltitude((d) => barAltitude(d))
    .htmlTransitionDuration(0)
    .htmlElement((d) => hubLabel(d as City, labelNodes))
    // Visibility is decided by updateLabels() below, from the camera.
    .htmlElementVisibilityModifier(() => {})
    .pointResolution(12)
    .pointsMerge(false)
    .pointsTransitionDuration(1200)
    .pointLabel((d) => tooltip(d as City))
    .ringColor(() => (t: number) => `rgba(143,193,255,${1 - t})`)
    .ringMaxRadius(4)
    .ringPropagationSpeed(2.5)
    .ringRepeatPeriod(900)
    .onPointHover((d) => {
      container.style.cursor = d ? "pointer" : "grab";
    });

  // Dev builds expose the instance so render stats can be read from a browser.
  if (import.meta.env.DEV) (window as unknown as { __globe: unknown }).__globe = globe;

  globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));

  // globe.gl's default globe material is a three.js MeshPhongMaterial. Until
  // the map texture is painted the globe shows as plain ocean.
  const ocean = globe.globeMaterial() as unknown as { color: { set(c: string): void }; shininess: number };
  ocean.color.set(MAP.ocean);
  ocean.shininess = 8;
  paintCountries()
    .then((url) => {
      ocean.color.set("#ffffff"); // the texture carries the colours now
      globe.globeImageUrl(url);
    })
    .catch(() => {});

  const sizes = new Map<City, { w: number; h: number }>();
  const updateLabels = (pov: { lat: number; lng: number; altitude: number }) => {
    const box = container.getBoundingClientRect();
    // Panels are obstacles: a label under the header or the job list is noise.
    const taken: Box[] = [".hud", ".legend", ".panel:not([hidden])"]
      .map((sel) => document.querySelector(sel)?.getBoundingClientRect())
      .filter((r): r is DOMRect => !!r && r.width > 0)
      .map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom }));

    for (const c of hubs) {
      const node = labelNodes.get(c);
      if (!node) continue;
      let show = arcDegrees(c.lat, c.lng, pov.lat, pov.lng) <= LABEL_MAX_ARC;
      if (show) {
        let size = sizes.get(c);
        if (!size || !size.w) sizes.set(c, (size = { w: node.offsetWidth, h: node.offsetHeight }));
        const p = globe.getScreenCoords(c.lat, c.lng, 0);
        // Mirrors .hub-label: centred on the point, lifted 120% of its height.
        const cx = box.left + p.x;
        const cy = box.top + p.y - size.h * 1.2;
        const b = {
          l: cx - size.w / 2 - LABEL_GAP,
          r: cx + size.w / 2 + LABEL_GAP,
          t: cy - size.h / 2 - LABEL_GAP,
          b: cy + size.h / 2 + LABEL_GAP,
        };
        show = !taken.some((o) => overlaps(o, b));
        if (show) taken.push(b);
      }
      node.classList.toggle("behind", !show);
    }
  };
  globe.onZoom(updateLabels);

  const controls = globe.controls();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.35;
  controls.enableDamping = true;
  // Stop spinning once someone starts exploring; it never restarts on its own.
  controls.addEventListener("start", () => (controls.autoRotate = false));

  // Render only while something can change: during auto-rotate, and for a few
  // seconds after any input (long enough for damping and fly-to transitions).
  // An idle globe otherwise redraws 60 times a second for nothing.
  let idleTimer = 0;
  let paused = false;
  const wake = () => {
    if (paused) {
      globe.resumeAnimation();
      paused = false;
    }
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (controls.autoRotate) return wake();
      globe.pauseAnimation();
      paused = true;
    }, IDLE_MS);
  };
  for (const ev of ["pointerdown", "pointermove", "wheel", "touchstart"]) {
    container.addEventListener(ev, wake, { passive: true });
  }
  wake();

  // Open on the densest hub so the first frame has something to look at.
  const lead = data.cities[0];
  globe.pointOfView({ lat: lead ? lead.lat : 30, lng: lead ? lead.lng : 0, altitude: 2.3 });
  requestAnimationFrame(() => updateLabels(globe.pointOfView()));

  // Keep the selected point clear of the panel: shift the globe left of the
  // side panel on desktop, above the bottom sheet on phones.
  const isPhone = () => window.matchMedia("(max-width: 720px)").matches;
  const offsetForPanel = (open: boolean) => {
    const off: [number, number] = !open ? [0, 0] : isPhone() ? [0, -window.innerHeight * 0.26] : [-210, 0];
    globe.globeOffset(off);
    document.body.classList.toggle("panel-open", open);
  };

  const select = (c: City) => {
    wake();
    controls.autoRotate = false;
    offsetForPanel(true);
    requestAnimationFrame(() => updateLabels(globe.pointOfView()));
    globe.ringsData([{ lat: c.lat, lng: c.lng }]);
    globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: 1.4 }, reduceMotion ? 0 : 1000);
    openPanel(c);
  };
  const close = () => {
    wake();
    $("panel").hidden = true;
    globe.ringsData([]);
    offsetForPanel(false);
    requestAnimationFrame(() => updateLabels(globe.pointOfView()));
  };

  globe.onPointClick((d) => select(d as City));
  onHubLabelClick = select;
  $("panel-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());

  $("top-cities").replaceChildren(
    // Country-only points are centroids, not hubs; keep them out of the shortcuts.
    ...data.cities.filter((c) => !c.approx).slice(0, 6).map((c) => {
      const b = el("button", undefined, placeName(c));
      b.append(el("b", undefined, String(c.jobs.length)));
      b.addEventListener("click", () => select(c));
      return b;
    }),
  );

  const resize = () => {
    wake();
    globe.width(window.innerWidth).height(window.innerHeight);
    offsetForPanel(!$("panel").hidden);
  };
  window.addEventListener("resize", resize);
  resize();
}

main();
