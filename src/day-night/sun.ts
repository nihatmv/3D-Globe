// Where the sun is overhead at a given moment: the subsolar point.
//
// NOAA / Astronomical Almanac low-precision solar coordinates: accurate to
// about 0.01° between 1950 and 2050, far finer than a pixel on the globe.
// No library, no API: just the Earth's orbit and rotation.

const RAD = Math.PI / 180;

export interface SubsolarPoint {
  lat: number; // = solar declination
  lng: number;
}

const mod360 = (x: number) => ((x % 360) + 360) % 360;

export function subsolarPoint(date: Date): SubsolarPoint {
  // Days since the J2000.0 epoch (2000-01-01 12:00 TT; UTC is close enough here).
  const n = date.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0;

  const meanLongitude = mod360(280.46 + 0.9856474 * n);
  const meanAnomaly = mod360(357.528 + 0.9856003 * n) * RAD;
  // Where the sun sits along its apparent path around the sky.
  const eclipticLng =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD; // tilt of Earth's axis

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLng));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLng), Math.cos(eclipticLng));

  // Greenwich sidereal time: how far the Earth has turned under the stars.
  const gmst = mod360(280.46061837 + 360.98564736629 * n);

  let lng = rightAscension / RAD - gmst;
  lng = mod360(lng + 180) - 180;
  return { lat: declination / RAD, lng };
}
