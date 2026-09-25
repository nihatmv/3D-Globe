# Remote Job Globe

A 3D globe of remote tech postings, each placed at its company's headquarters.
Built with [globe.gl](https://github.com/vasturiano/globe.gl) on top of the
`jobscan` scraper in `../Linkedin-scraper`, which owns the data.

```
jobscan fetch → locate → globe-export  →  public/globe.json  →  this page
```

## Run it

From `../Linkedin-scraper` (load the API key first: `set -a && source .env && set +a`):

```bash
.venv/bin/python -m jobscan fetch                # pull postings (as before)
.venv/bin/python -m jobscan analyze --no-llm     # skills, for the stack chips
.venv/bin/python -m jobscan locate --dry-run     # count + cost, nothing sent
.venv/bin/python -m jobscan locate               # Claude extracts HQ + regions, then geocode
.venv/bin/python -m jobscan globe-export         # writes ../3D-Job-Globe/public/globe.json
```

Then here:

```bash
npm install
npm run dev
```

## How locations are found

**HQ extraction.** `locate` sends each tech posting to Claude Haiku 4.5 with
the title, company, location field and the first 4,000 characters of the
description. It returns the company HQ, the hiring regions (Anywhere, US,
EMEA, Europe…), any named countries, and timezone constraints.

Most postings don't state an HQ, only where they hire ("Anywhere in the World",
"REMOTE (US & Canada)"). When the text is silent, the model may name the HQ
from its knowledge of the company, and that answer is stored as
`hq_source='inferred'` with a confidence. Inferred HQs are drawn orange;
HQs stated in the text are blue. When the model doesn't recognise a company,
it returns `unknown` and the job isn't plotted. It is counted under
**Unplaced** instead.

**Geocoding.** HQ place names go to OpenStreetMap Nominatim at 1 request per
second. Every answer is cached in the `geocode_cache` table, including misses,
so each place is looked up once. Each hit keeps Nominatim's place type. When a
"city" turns out to be a state or district ("Arizona"), or can't be placed at all,
the point falls back to the region or the country centroid. These points are
drawn translucent and kept out of Top hubs.

Both stages are cached (`job_location`, `geocode_cache`), so re-running
`locate` after a new `fetch` pays only for new postings. A full first run over
~700 postings costs about $1.50.

## On the globe

- One point per HQ location. Height and size grow with the number of jobs.
- Hover shows the place, job count and companies. Click flies there and lists
  every job: role, company, posting date, source, stack, and hiring regions.
- The **Top hubs** buttons jump to the largest locations. Esc closes the panel.

Hiring regions are already extracted and exported (`hiring_regions`,
`hiring_countries` per job) for the planned arcs, but they aren't drawn yet.

The globe draws countries from Natural Earth's 1:110m outlines (public domain),
stored in `public/data/countries.geojson`. The star background is taken from
the `three-globe` package's examples. Both are served locally, so the page
makes no CDN calls. Hubs with 3 or more jobs are named on the globe, biggest
first. A name is skipped if it would overlap another label or a panel, so
zooming in reveals the smaller hubs.

## Performance

Measured with the renderer's own counters (`window.__globe` in dev builds):

| | Before | After |
|---|---|---|
| Draw calls per frame | 1,367 | 143 |
| Triangles per frame | 304,585 | 23,520 |
| Geometries held on GPU | 591 | 4 |
| Canvas on a retina screen | 2880×1800 | 2160×1350 |
| Frames rendered while idle | 60/s | 0 |

What changed, and why:

- **Countries are one texture, not 176 meshes.** They are painted once into
  a 4096×2048 canvas and wrapped on the globe. Country-name hover went with
  the meshes.
- **City labels are HTML, not 3D text.** The 26 text meshes were 88% of all
  triangles.
- **Pixel ratio capped at 1.5.** Past that, a globe looks the same and costs
  more.
- **The render loop pauses** 4 s after the last input (auto-rotate keeps it
  running). Any pointer, wheel or touch input resumes it.
- **No `backdrop-filter` on panels.** Blurring a live WebGL canvas re-runs
  every frame.

To check frame rate on your machine: in Chrome DevTools, open ⋮ → More tools →
Rendering → Frame rendering stats.

# Day & Night Earth

A second page, `/day-night.html`, linked from the job globe's header. It shows
the Earth's real day/night regions and the ISS, in real time or sped up.

```bash
npm run dev    # then open http://localhost:5173/day-night.html
```

No API keys and no paid services. Nothing here touches the Claude API.

## How it works

- **The sun:** `src/day-night/sun.ts` computes the subsolar point (where
  the sun is directly overhead) from the date. It uses NOAA's low-precision
  solar formulas, accurate to about 0.01°, with no library and no API. Checked
  against the 2026 equinox (latitude 0.00°) and the solstices (±23.44°).
- **The globe:** a custom shader blends a day texture (NASA Blue Marble)
  and a night texture (city lights) by the sun's angle at each point. The blend
  spans ±6° around the day/night line (civil twilight), with a warm tint on the
  edge. The whole Earth is one draw call.
- **The ISS:** `src/day-night/iss.ts` computes the station's position for
  whatever time is shown, from its published orbit (TLE) with the SGP4 model
  (`satellite.js`). That keeps it in sync with the sun at 60× or 1000× or on
  the slider, which a live-only feed can't do. At 1× it also polls a live
  position every 5 s and corrects the model to it. Measured difference between
  model and live: about 0.5 km.
- **The trail:** the last 20 minutes of orbit, recomputed from the model,
  so it's complete as soon as the page loads.

| Source | Used for | Frequency |
|---|---|---|
| [CelesTrak](https://celestrak.org) | ISS orbit (TLE) | on load, then every 2 h |
| [wheretheiss.at](https://wheretheiss.at) | live ISS position; backup orbit source | every 5 s, only at 1× "now" with the tab visible |

If either source is unreachable, the ISS is hidden with a note and
day/night keeps working.

## Controls

- **Play/pause:** also the Space key.
- **Speed:** 1× · 60× · 1000×. At 1000× a full day takes 86 seconds.
- **Slider:** ±24 h from now.
- **Now:** back to real time at 1×.
- **Follow ISS:** keeps the camera over the station. Dragging the globe
  stops following.

The badge shows **LIVE** (real time), **SIMULATED** (sped up or scrubbed) or
**PAUSED**.

## Performance

| | |
|---|---|
| Draw calls per frame | 5 |
| Triangles per frame | ~17,500 |
| Frames drawn at 1× while idle | ~3/s, not 60 |

At 1× the day/night line moves 0.25° a minute, so the sun, ISS and clock
update once a second and the globe renders a single frame for each update. It
renders continuously only while you interact or while time runs at 60× or
1000×. Pixel ratio is capped at 1.5, as on the job globe.
