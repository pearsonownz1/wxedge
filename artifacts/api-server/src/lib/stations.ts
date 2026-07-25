/**
 * Settlement station metadata.
 * Bias values from IEM/ACIS 90-day rolling calibration (PDF source).
 * LST offsets are always standard-time offsets (never DST).
 */

export type Season = "spring" | "summer" | "fall" | "winter";

export interface StationMeta {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** UTC offset in hours for Local Standard Time (always standard, never daylight) */
  lstOffset: number;
  /** Kalshi event ticker prefix, e.g. "KXHIGHNY" */
  kalshiPrefix: string;
  /** Seasonal bias vs NWS point forecast, in °F */
  biasF: Record<Season, number>;
  /** RMSE (°F) over 90-day rolling window — approximates forecast spread */
  rmse: number;
  /** Number of valid forecast–CLI pairs in the calibration window */
  pairCount: number;
}

export const STATION_IDS = ["KNYC", "KMDW", "KAUS", "KDFW", "KLAX", "KPHL"] as const;
export type StationId = (typeof STATION_IDS)[number];

export const STATIONS: Record<StationId, StationMeta> = {
  KNYC: {
    id: "KNYC",
    name: "Central Park, NY",
    lat: 40.7789,
    lon: -73.9692,
    lstOffset: -5,
    kalshiPrefix: "KXHIGHNY",
    biasF: { summer: 0.8, winter: 0.2, spring: 0.4, fall: 0.3 },
    rmse: 1.9,
    pairCount: 88,
  },
  KMDW: {
    id: "KMDW",
    name: "Chicago Midway, IL",
    lat: 41.7868,
    lon: -87.7522,
    lstOffset: -6,
    kalshiPrefix: "KXHIGHCHI",
    biasF: { summer: -0.3, winter: -0.1, spring: -0.2, fall: -0.2 },
    rmse: 2.4,
    pairCount: 91,
  },
  KAUS: {
    id: "KAUS",
    name: "Austin-Bergstrom, TX",
    lat: 30.1945,
    lon: -97.6699,
    lstOffset: -6,
    kalshiPrefix: "KXHIGHAUS",
    biasF: { summer: 1.4, winter: 0.5, spring: 0.8, fall: 0.9 },
    rmse: 2.1,
    pairCount: 85,
  },
  KDFW: {
    id: "KDFW",
    name: "Dallas-Fort Worth, TX",
    lat: 32.8998,
    lon: -97.0403,
    lstOffset: -6,
    kalshiPrefix: "KXHIGHDFW",
    biasF: { summer: 0.6, winter: 0.2, spring: 0.4, fall: 0.3 },
    rmse: 2.6,
    pairCount: 79,
  },
  KLAX: {
    id: "KLAX",
    name: "Los Angeles Intl, CA",
    lat: 33.9425,
    lon: -118.4081,
    lstOffset: -8,
    kalshiPrefix: "KXHIGHLAX",
    biasF: { summer: -1.1, winter: -0.5, spring: -0.8, fall: -0.7 },
    rmse: 1.7,
    pairCount: 93,
  },
  KPHL: {
    id: "KPHL",
    name: "Philadelphia Intl, PA",
    lat: 39.8744,
    lon: -75.2424,
    lstOffset: -5,
    kalshiPrefix: "KXHIGHPHIL",
    biasF: { summer: 0.2, winter: 0.1, spring: 0.1, fall: 0.1 },
    rmse: 2.2,
    pairCount: 84,
  },
};

export function getSeason(date: Date): Season {
  const month = date.getUTCMonth() + 1; // 1-12
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "fall";
  return "winter";
}

export function isStation(id: string): id is StationId {
  return STATION_IDS.includes(id as StationId);
}
