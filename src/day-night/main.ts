import Globe from "globe.gl";
import {
  AdditiveBlending,
  CanvasTexture,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  Vector3,
} from "three";

import { IssTracker, altitudeInGlobeRadii, type IssPosition } from "./iss";
import { subsolarPoint } from "./sun";

// ---- tuning --------------------------------------------------------------

const MAX_PIXEL_RATIO = 1.5; // past this a globe looks the same and costs more
const TRAIL_MINUTES = 20; // ISS trail length, in simulated time
const TRAIL_STEP_S = 20;
const LIVE_POLL_MS = 5000; // wheretheiss.at allows ~1 request/second
const ORBIT_REFRESH_MS = 2 * 3600_000;
// At 1x the day/night line moves 0.25° a minute, so redrawing once a second
// is indistinguishable from 60 times a second.
const SLOW_TICK_MS = 1000;
const FAST_TRAIL_MS = 100; // trail geometry refresh cap when sped up
const INTERACT_GRACE_MS = 3000; // keep rendering this long after input

// ---- day/night shader ----------------------------------------------------

// Blends the day and night textures by the angle between each point's
// surface normal and the sun. Normals are taken in world space and the sun
// direction is given in the same space, so nothing has to follow the camera.
const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    // cos of the sun's angle from the zenith: 1 at noon, 0 on the terminator.
    float cosSun = dot(normalize(vNormal), sunDirection);

    vec3 day = texture2D(dayTexture, vUv).rgb;
    vec3 night = texture2D(nightTexture, vUv).rgb;

    // Low sun near the terminator: the day side dims gently toward dusk.
    day *= mix(0.55, 1.0, smoothstep(0.0, 0.35, cosSun));
    // City lights: the texture's dark-blue land tint is pushed down and the
    // bright lights pushed up (squared term), plus a faint blue floor so
    // oceans aren't pure black.
    night = night * night * 1.9 + night * 0.25 + vec3(0.004, 0.007, 0.016);

    // sin(6°) ≈ 0.105: blend across civil twilight, not a hard line.
    float dayMix = smoothstep(-0.105, 0.105, cosSun);
    vec3 color = mix(night, day, dayMix);

    // Warm band along the terminator, strongest right on it.
    float dusk = 1.0 - smoothstep(0.0, 0.12, abs(cosSun));
    color += vec3(1.0, 0.45, 0.16) * dusk * 0.12;

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ---- small helpers -------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function arcDegrees(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  const cos =
    Math.sin(aLat * r) * Math.sin(bLat * r) + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.cos((aLng - bLng) * r);
  return Math.acos(Math.min(1, Math.max(-1, cos))) / r;
}

const fmtLat = (v: number) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? "N" : "S"}`;
const fmtLng = (v: number) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? "E" : "W"}`;

function fmtOffset(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 30_000) return "now";
  const mins = Math.round(abs / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const text = d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  return ms > 0 ? `${text} ahead of now` : `${text} ago`;
}

const utcFmt = new Intl.DateTimeFormat(undefined, {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const localFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

// A soft radial glow for the ISS, drawn once into a small canvas.
function glowSprite(): Sprite {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.14, "rgba(255,255,255,1)");
  grad.addColorStop(0.24, "rgba(160,246,255,0.9)");
  grad.addColorStop(0.5, "rgba(127,240,255,0.25)");
  grad.addColorStop(1, "rgba(127,240,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(c),
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      // Fixed on-screen size: a dot the same size at every zoom, not a
      // speck when zoomed out and a blob when zoomed in.
      sizeAttenuation: false,
    }),
  );
  sprite.scale.set(0.045, 0.045, 1); // fraction of the viewport height
  return sprite;
}

// ---- page ----------------------------------------------------------------

interface Marker {
  kind: "iss" | "sun";
  lat: number;
  lng: number;
  alt: number;
  node: HTMLElement;
}

async function main(): Promise<void> {
  const container = $("globe");

  // Time state. `sim` is the moment shown; it advances at `speed` while playing.
  const state = { sim: Date.now(), speed: 1, playing: true, follow: false, dragging: false };
  const offset = () => state.sim - Date.now();
  const isLive = () => state.playing && state.speed === 1 && Math.abs(offset()) < 5000;

  const loader = new TextureLoader();
  const [dayTexture, nightTexture] = await Promise.all([
    loader.loadAsync("/textures/earth-day.jpg"),
    loader.loadAsync("/textures/earth-night.jpg"),
  ]);

  const material = new ShaderMaterial({
    uniforms: {
      dayTexture: { value: dayTexture },
      nightTexture: { value: nightTexture },
      sunDirection: { value: new Vector3(1, 0, 0) },
    },
    vertexShader,
    fragmentShader,
  });

  const issObject = { lat: 0, lng: 0, alt: 0.066 };
  const issSprite = glowSprite();
  const markers: Marker[] = [
    { kind: "sun", lat: 0, lng: 0, alt: 0.01, node: markerNode("marker marker-sun", "☀ Sun overhead") },
    { kind: "iss", lat: 0, lng: 0, alt: 0.066, node: markerNode("marker marker-iss", "ISS") },
  ];
  const trail = { points: [] as { lat: number; lng: number; alt: number }[] };

  const tzLng = -new Date().getTimezoneOffset() / 4; // rough longitude of the viewer's timezone

  const globe = new Globe(container, { animateIn: true, rendererConfig: { powerPreference: "high-performance" } })
    .backgroundColor("#05070b")
    .backgroundImageUrl("/textures/night-sky.png")
    .globeMaterial(material)
    .showAtmosphere(true)
    .atmosphereColor("#7fb4ff")
    .atmosphereAltitude(0.16)
    // ISS glow
    .objectsData([])
    .objectLat("lat")
    .objectLng("lng")
    .objectAltitude("alt")
    .objectThreeObject(() => issSprite)
    // ISS trail: fades from transparent (oldest) to bright (now)
    .pathsData([])
    .pathPoints("points")
    .pathPointLat("lat")
    .pathPointLng("lng")
    .pathPointAlt("alt")
    .pathColor(() => ["rgba(127,240,255,0)", "rgba(127,240,255,0.85)"])
    .pathStroke(1.4)
    .pathResolution(1)
    .pathTransitionDuration(0)
    // Labels for the ISS and the subsolar point
    .htmlElementsData(markers)
    .htmlLat("lat")
    .htmlLng("lng")
    .htmlAltitude("alt")
    .htmlElement((d) => (d as Marker).node)
    .htmlTransitionDuration(0)
    .htmlElementVisibilityModifier(() => {}); // decided by updateMarkerVisibility()

  globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  const maxAniso = globe.renderer().capabilities.getMaxAnisotropy();
  dayTexture.anisotropy = nightTexture.anisotropy = Math.min(4, maxAniso);

  // Phones: pull back so the whole globe fits the narrow screen, and lift it
  // above the ISS card and time controls.
  const isPhone = () => window.matchMedia("(max-width: 720px)").matches;
  globe.pointOfView({ lat: 15, lng: tzLng, altitude: isPhone() ? 4.3 : 2.4 });

  // ---- rendering budget ---------------------------------------------------
  // globe.gl redraws every frame by default. Here it runs only while
  // something moves on screen: input, a camera transition, or sped-up time.
  // At 1x it sleeps and is woken once a second for a single frame.
  let activeUntil = performance.now() + 2500; // intro animation
  let pulseFrames = 0;
  let running = true;
  const keepAwake = (ms: number) => (activeUntil = Math.max(activeUntil, performance.now() + ms));
  const pulse = () => (pulseFrames = 2);
  for (const ev of ["pointerdown", "pointermove", "wheel", "touchstart"]) {
    container.addEventListener(ev, () => keepAwake(INTERACT_GRACE_MS), { passive: true });
  }

  const controls = globe.controls();
  controls.enableDamping = true;
  // A drag means "let me look around": stop following the ISS.
  controls.addEventListener("start", () => setFollow(false));

  // ---- updates ------------------------------------------------------------

  const iss = new IssTracker();
  let issPos: IssPosition | null = null;
  let lastTrailAt = 0;

  function updateSun(t: number) {
    const s = subsolarPoint(new Date(t));
    const c = globe.getCoords(s.lat, s.lng, 0);
    (material.uniforms.sunDirection.value as Vector3).set(c.x, c.y, c.z).normalize();
    markers[0].lat = s.lat;
    markers[0].lng = s.lng;
  }

  function updateIss(t: number, force: boolean) {
    issPos = iss.at(t, isLive());
    if (!issPos) {
      globe.objectsData([]);
      globe.pathsData([]);
      return;
    }
    issObject.lat = issPos.lat;
    issObject.lng = issPos.lng;
    issObject.alt = altitudeInGlobeRadii(issPos.altKm);
    globe.objectsData([issObject]);
    markers[1].lat = issPos.lat;
    markers[1].lng = issPos.lng;
    markers[1].alt = issObject.alt;

    // The trail is recomputed from the orbit, so it's complete immediately and
    // correct at any speed. Rebuilding it is capped when time runs fast.
    const now = performance.now();
    if (force || now - lastTrailAt >= FAST_TRAIL_MS) {
      lastTrailAt = now;
      const pts: { lat: number; lng: number; alt: number }[] = [];
      for (let s = -TRAIL_MINUTES * 60; s <= 0; s += TRAIL_STEP_S) {
        const p = iss.at(t + s * 1000, isLive());
        if (p) pts.push({ lat: p.lat, lng: p.lng, alt: altitudeInGlobeRadii(p.altKm) });
      }
      trail.points = pts;
      globe.pathsData([trail]);
    }

    if (state.follow) {
      const pov = globe.pointOfView();
      globe.pointOfView({ lat: issPos.lat, lng: issPos.lng, altitude: pov.altitude }, 0);
    }
  }

  function updateMarkerVisibility() {
    const pov = globe.pointOfView();
    for (const m of markers) {
      const hidden = (m.kind === "iss" && !issPos) || arcDegrees(m.lat, m.lng, pov.lat, pov.lng) > 80;
      m.node.classList.toggle("behind", hidden);
    }
    globe.htmlElementsData(markers);
  }
  globe.onZoom(() => updateMarkerVisibility());

  function updateIssCard() {
    const note = $("iss-note");
    if (!issPos) {
      note.textContent = iss.lastError || "Loading orbit…";
      for (const id of ["iss-lat", "iss-lng", "iss-alt", "iss-speed"]) $(id).textContent = "–";
      return;
    }
    $("iss-lat").textContent = fmtLat(issPos.lat);
    $("iss-lng").textContent = fmtLng(issPos.lng);
    $("iss-alt").textContent = `${Math.round(issPos.altKm)} km`;
    $("iss-speed").textContent = `${Math.round(issPos.speedKmh).toLocaleString()} km/h`;
    if (isLive() && iss.lastFix) {
      const age = Math.max(0, Math.round((Date.now() - iss.lastFix.at) / 1000));
      const err = iss.modelErrorKm();
      note.textContent =
        `Live position from wheretheiss.at, ${age}s ago.` +
        (err !== null ? ` Orbit model agrees within ${err < 1 ? err.toFixed(1) : Math.round(err)} km.` : "");
    } else if (isLive()) {
      note.textContent = iss.lastError || "Computed from its orbit. Checking the live feed…";
    } else {
      note.textContent = "Computed from its orbit for the time shown.";
    }
  }

  let lastClock = "";
  function updateClock() {
    const d = new Date(state.sim);
    const utc = `${utcFmt.format(d)} UTC`;
    if (utc !== lastClock) {
      lastClock = utc;
      $("utc").textContent = utc;
      $("local").textContent = localFmt.format(d);
    }
    const badge = $("badge");
    const live = isLive();
    const label = live ? "LIVE" : state.playing ? "SIMULATED" : "PAUSED";
    if (badge.textContent !== label) badge.textContent = label;
    badge.classList.toggle("sim", !live);
    const off = offset();
    $("offset").textContent = fmtOffset(off);
    if (!state.dragging) {
      const slider = $<HTMLInputElement>("slider");
      const v = String(Math.max(-1440, Math.min(1440, Math.round(off / 60_000))));
      if (slider.value !== v) slider.value = v;
    }
  }

  // ---- main loop ----------------------------------------------------------
  // A cheap rAF loop owns time; globe.gl's own render loop is paused and
  // resumed around it.
  let lastFrame = performance.now();
  let lastSlowTick = 0;
  let dirty = true; // force an update after any control change

  function frame(now: number) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (state.playing) state.sim += dt * state.speed;

    const fast = state.playing && state.speed > 1;
    const slowDue = now - lastSlowTick >= SLOW_TICK_MS;
    if (fast || dirty || slowDue) {
      if (slowDue) lastSlowTick = now;
      updateSun(state.sim);
      updateIss(state.sim, dirty || slowDue);
      updateMarkerVisibility();
      updateClock();
      if (slowDue || dirty) updateIssCard();
      dirty = false;
      if (!fast) pulse();
    }

    const wantRun = fast || now < activeUntil || pulseFrames > 0 || state.follow;
    if (pulseFrames > 0) pulseFrames--;
    if (wantRun && !running) {
      globe.resumeAnimation();
      running = true;
    } else if (!wantRun && running) {
      globe.pauseAnimation();
      running = false;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- ISS data -----------------------------------------------------------

  const loadOrbit = () =>
    iss
      .loadOrbit()
      .then(() => {
        dirty = true;
        if (isLive()) iss.pollLive().then(() => (dirty = true));
      })
      .catch(() => (dirty = true));
  loadOrbit();
  setInterval(loadOrbit, ORBIT_REFRESH_MS);

  // Poll the live feed only while showing "now"; a hidden tab doesn't poll.
  setInterval(() => {
    if (iss.ready && isLive() && !document.hidden) iss.pollLive().then(() => (dirty = true));
  }, LIVE_POLL_MS);

  // ---- controls -----------------------------------------------------------

  const speedButtons = [...document.querySelectorAll<HTMLButtonElement>(".speeds button")];
  const playBtn = $<HTMLButtonElement>("play");

  function syncControls() {
    for (const b of speedButtons) b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === state.speed));
    playBtn.textContent = state.playing ? "❚❚" : "▶";
    playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Play");
    dirty = true;
    keepAwake(300);
  }

  for (const b of speedButtons) {
    b.addEventListener("click", () => {
      state.speed = Number(b.dataset.speed);
      state.playing = true;
      syncControls();
    });
  }
  playBtn.addEventListener("click", () => {
    state.playing = !state.playing;
    syncControls();
  });
  $("now").addEventListener("click", () => {
    state.sim = Date.now();
    state.speed = 1;
    state.playing = true;
    syncControls();
    if (iss.ready) iss.pollLive().then(() => (dirty = true));
  });

  const slider = $<HTMLInputElement>("slider");
  slider.addEventListener("input", () => {
    state.dragging = true;
    state.sim = Date.now() + Number(slider.value) * 60_000;
    dirty = true;
    keepAwake(300);
  });
  slider.addEventListener("change", () => (state.dragging = false));

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      state.playing = !state.playing;
      syncControls();
    }
  });

  const followBtn = $<HTMLButtonElement>("iss-follow");
  function setFollow(on: boolean) {
    if (state.follow === on) return;
    state.follow = on;
    followBtn.setAttribute("aria-pressed", String(on));
    followBtn.textContent = on ? "Following ISS" : "Follow ISS";
    if (on && issPos) {
      globe.pointOfView({ lat: issPos.lat, lng: issPos.lng, altitude: 1.6 }, 900);
      keepAwake(1200);
    }
  }
  followBtn.addEventListener("click", () => setFollow(!state.follow));

  const resize = () => {
    globe.width(window.innerWidth).height(window.innerHeight);
    globe.globeOffset(isPhone() ? [0, -window.innerHeight * 0.17] : [0, 0]);
    keepAwake(300);
  };
  window.addEventListener("resize", resize);
  resize();

  // Dev builds expose the instance so render stats can be read from a browser.
  if (import.meta.env.DEV) (window as unknown as { __globe: unknown }).__globe = globe;
}

function markerNode(cls: string, text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = cls;
  node.textContent = text;
  return node;
}

main();
