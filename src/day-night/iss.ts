// The ISS, positioned for any moment: past, present or sped-up.
//
// A live position API only knows "now", but this page can show any time. So
// the ISS is computed from its published orbit (a TLE, "two-line element set")
// with the SGP4 model via satellite.js. At normal speed a free live API is
// polled as a check, and its small difference from the model is applied as a
// correction so the dot sits where the station actually is.
//
// Sources, all free, no key, browser-callable (CORS *):
//   CelesTrak                          orbit elements, refreshed every few hours
//   api.wheretheiss.at                 fallback orbit elements + live position

import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from "satellite.js";

const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE";
const WTIA_TLE = "https://api.wheretheiss.at/v1/satellites/25544/tles";
const WTIA_NOW = "https://api.wheretheiss.at/v1/satellites/25544";

const EARTH_RADIUS_KM = 6371;

export interface IssPosition {
  lat: number;
  lng: number;
  altKm: number;
  speedKmh: number;
}

export interface LiveFix {
  lat: number;
  lng: number;
  altKm: number;
  speedKmh: number;
  at: number; // ms since epoch
}

async function fetchTle(): Promise<[string, string]> {
  try {
    const text = await (await fetch(CELESTRAK)).text();
    const lines = text.split("\n").map((l) => l.trim());
    const l1 = lines.find((l) => l.startsWith("1 "));
    const l2 = lines.find((l) => l.startsWith("2 "));
    if (l1 && l2) return [l1, l2];
  } catch {
    // fall through to the second source
  }
  const j = await (await fetch(WTIA_TLE)).json();
  return [j.line1, j.line2];
}

export class IssTracker {
  private satrec: SatRec | null = null;
  private loadedAt = 0;
  // Live fix minus model, applied while showing "now". Kept small by design:
  // a fresh TLE agrees with the live API to within a few km.
  private dLat = 0;
  private dLng = 0;
  lastFix: LiveFix | null = null;
  lastError = "";

  get ready(): boolean {
    return this.satrec !== null;
  }

  async loadOrbit(): Promise<void> {
    try {
      const [l1, l2] = await fetchTle();
      this.satrec = twoline2satrec(l1, l2);
      this.loadedAt = Date.now();
      this.lastError = "";
    } catch (e) {
      this.lastError = "Couldn't load the ISS orbit";
      throw e;
    }
  }

  orbitAgeMs(): number {
    return this.loadedAt ? Date.now() - this.loadedAt : Infinity;
  }

  /** Model position at any time, or null if SGP4 can't propagate it. */
  modelAt(t: number): IssPosition | null {
    if (!this.satrec) return null;
    const date = new Date(t);
    const pv = propagate(this.satrec, date);
    if (!pv) return null;
    const geo = eciToGeodetic(pv.position, gstime(date));
    const v = pv.velocity;
    return {
      lat: degreesLat(geo.latitude),
      lng: degreesLong(geo.longitude),
      altKm: geo.height,
      // Speed relative to Earth's centre, the figure usually quoted (~27,600 km/h).
      speedKmh: Math.hypot(v.x, v.y, v.z) * 3600,
    };
  }

  /** Position to draw: the model, corrected by the latest live fix when live. */
  at(t: number, live: boolean): IssPosition | null {
    const p = this.modelAt(t);
    if (!p || !live || !this.lastFix) return p;
    const lng = ((p.lng + this.dLng + 540) % 360) - 180;
    return { ...p, lat: p.lat + this.dLat, lng };
  }

  /** Poll the live API once and update the correction. */
  async pollLive(): Promise<LiveFix | null> {
    try {
      const j = await (await fetch(WTIA_NOW)).json();
      const fix: LiveFix = {
        lat: j.latitude,
        lng: j.longitude,
        altKm: j.altitude,
        speedKmh: j.velocity,
        at: j.timestamp * 1000,
      };
      const m = this.modelAt(fix.at);
      if (m) {
        this.dLat = fix.lat - m.lat;
        this.dLng = ((fix.lng - m.lng + 540) % 360) - 180;
      }
      this.lastFix = fix;
      this.lastError = "";
      return fix;
    } catch {
      this.lastError = "Live ISS feed unreachable, showing the orbit model";
      return null;
    }
  }

  /** Distance between the live fix and the model at the same instant, in km. */
  modelErrorKm(): number | null {
    if (!this.lastFix) return null;
    const m = this.modelAt(this.lastFix.at);
    if (!m) return null;
    return greatCircleKm(m.lat, m.lng, this.lastFix.lat, this.lastFix.lng);
  }
}

export function altitudeInGlobeRadii(altKm: number): number {
  return altKm / EARTH_RADIUS_KM;
}

function greatCircleKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
