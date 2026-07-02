/**
 * Solar position for the 2D shade simulation on the camp map. Client-safe (no
 * server imports), like `brc.ts`.
 *
 * Black Rock City sits at ~40.79°N, 119.21°W; the event runs late Aug / early
 * Sep in Pacific Daylight Time (UTC−7). We compute the sun's altitude + azimuth
 * (low-precision NOAA algorithm, accurate to a fraction of a degree — plenty for
 * casting approximate shadows) for a chosen local time of day, and derive the
 * day's sunrise/sunset by scanning the altitude curve.
 */

export const BRC_LAT = 40.7864;
export const BRC_LON = -119.2065;

// Representative playa date — late August. Year comes from the active edition.
const EVENT_MONTH0 = 7; // August (0-indexed)
const EVENT_DAY = 30;
// Pacific Daylight Time during the event.
const PDT_OFFSET_MIN = -7 * 60;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** The UTC instant for a given local-clock minute-of-day on the event date. */
export function playaDate(year: number, minutesOfDay: number): Date {
  // local = UTC + offset  ⇒  UTC = local − offset.
  const utcMinutes = minutesOfDay - PDT_OFFSET_MIN;
  return new Date(
    Date.UTC(year, EVENT_MONTH0, EVENT_DAY, 0, 0) + utcMinutes * 60_000,
  );
}

/** Sun altitude (deg above horizon) + azimuth (deg clockwise from true north:
 * 0=N, 90=E, 180=S, 270=W) for an instant at a location. */
export function solarPosition(
  date: Date,
  latDeg = BRC_LAT,
  lonDeg = BRC_LON,
): { altitude: number; azimuth: number } {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0

  let meanLon = (280.46 + 0.9856474 * n) % 360;
  if (meanLon < 0) meanLon += 360;
  let meanAnom = (357.528 + 0.9856003 * n) % 360;
  if (meanAnom < 0) meanAnom += 360;
  const lambda =
    meanLon +
    1.915 * Math.sin(meanAnom * RAD) +
    0.02 * Math.sin(2 * meanAnom * RAD); // ecliptic longitude
  const epsilon = 23.439 - 0.0000004 * n; // obliquity of the ecliptic

  const sinLambda = Math.sin(lambda * RAD);
  const ra = Math.atan2(
    Math.cos(epsilon * RAD) * sinLambda,
    Math.cos(lambda * RAD),
  ); // right ascension (rad)
  const decl = Math.asin(Math.sin(epsilon * RAD) * sinLambda); // declination (rad)

  let gmst = (280.46061837 + 360.98564736629 * n) % 360;
  if (gmst < 0) gmst += 360;
  const lst = ((gmst + lonDeg) % 360) * RAD; // local sidereal time (rad)
  let H = lst - ra; // hour angle (rad)
  // normalize to [−π, π]
  H = Math.atan2(Math.sin(H), Math.cos(H));

  const latR = latDeg * RAD;
  const sinAlt =
    Math.sin(latR) * Math.sin(decl) +
    Math.cos(latR) * Math.cos(decl) * Math.cos(H);
  const altitude = Math.asin(clamp(sinAlt, -1, 1));

  const cosAz =
    (Math.sin(decl) - Math.sin(altitude) * Math.sin(latR)) /
    (Math.cos(altitude) * Math.cos(latR));
  let azimuth = Math.acos(clamp(cosAz, -1, 1)) * DEG; // 0..180 from north
  if (Math.sin(H) > 0) azimuth = 360 - azimuth; // afternoon → western half

  return { altitude: altitude * DEG, azimuth };
}

/** Sun position for a local minute-of-day on the event date of `year`. */
export function sunAt(
  year: number,
  minutesOfDay: number,
): { altitude: number; azimuth: number } {
  return solarPosition(playaDate(year, minutesOfDay));
}

/** Sunrise / sunset / solar-noon (local minutes) for the event date, found by
 * scanning the altitude curve for horizon crossings. */
export function dayArc(year: number): {
  sunriseMin: number;
  sunsetMin: number;
  noonMin: number;
} {
  let sunriseMin = 6 * 60;
  let sunsetMin = 20 * 60;
  let noonMin = 13 * 60;
  let prevAlt = sunAt(year, 0).altitude;
  let maxAlt = prevAlt;
  for (let m = 2; m <= 1440; m += 2) {
    const alt = sunAt(year, m).altitude;
    if (prevAlt < 0 && alt >= 0) sunriseMin = m;
    if (prevAlt >= 0 && alt < 0) sunsetMin = m;
    if (alt > maxAlt) {
      maxAlt = alt;
      noonMin = m;
    }
    prevAlt = alt;
  }
  return { sunriseMin, sunsetMin, noonMin };
}

/** Invert azimuth → local minute: the minute of the day whose sun azimuth is
 * closest to `azimuthDeg`. The sun sweeps the full circle once per day (daylight
 * across the south, then swinging back through the north below the horizon at
 * night), so scanning the whole day lets a drag reach any time — including night —
 * making the dial draggable all the way around. */
export function minuteForAzimuth(year: number, azimuthDeg: number): number {
  let best = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let m = 0; m <= 1440; m += 2) {
    const az = sunAt(year, m).azimuth;
    let d = Math.abs(az - azimuthDeg);
    if (d > 180) d = 360 - d;
    if (d < bestDiff) {
      bestDiff = d;
      best = m;
    }
  }
  return best;
}

/** Format a local minute-of-day as a 12-hour clock, e.g. 915 → "3:15 PM". */
export function formatClock(minutesOfDay: number): string {
  const m = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}
