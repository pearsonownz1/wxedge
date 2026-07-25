/**
 * Settlement window calculator.
 *
 * NWS CLI daily high is measured over 00:00–23:59 LOCAL STANDARD TIME,
 * regardless of DST. During Daylight Saving Time (clocks 1h ahead of LST),
 * the settlement window 00:00–23:59 LST maps to 01:00 local–00:59 local
 * the next calendar day. Casual traders often miss this — we surface it
 * explicitly.
 *
 * "Contract date" = the calendar date in LST for which the CLI high is reported.
 */

import { StationMeta } from "./stations.js";

export interface SettlementWindow {
  lstStart: string;       // "00:00"
  lstEnd: string;         // "23:59"
  localStart: string;     // "01:00" (during DST) or "00:00"
  localEnd: string;       // "00:59+1" (spills) or "23:59"
  dstActive: boolean;
  spillsToNextDay: boolean;
  spillsToDate: string | null;
  hoursRemaining: number;
  contractDate: string;   // "24 Jul"
  utcOffset: number;      // LST offset in hours, e.g. -5
}

/** US DST: second Sunday in March → first Sunday in November (UTC-based approximation). */
function isDstActive(utcNow: Date, lstOffset: number): boolean {
  const year = utcNow.getUTCFullYear();

  // Second Sunday in March at 02:00 local standard time → UTC
  const marchDate = nthSundayOfMonth(year, 3, 2); // month 3=March, 2nd Sunday
  const dstStart = new Date(marchDate.getTime() - lstOffset * 3600_000 + 2 * 3600_000);

  // First Sunday in November at 02:00 local daylight time → UTC
  const novDate = nthSundayOfMonth(year, 11, 1);
  const dstEnd = new Date(novDate.getTime() - (lstOffset + 1) * 3600_000 + 2 * 3600_000);

  return utcNow >= dstStart && utcNow < dstEnd;
}

function nthSundayOfMonth(year: number, month: number, n: number): Date {
  // month: 1-indexed
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstSunday = ((7 - first.getUTCDay()) % 7) || 7;
  const day = firstSunday + (n - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatHHMM(hours: number, minutes: number): string {
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function formatDate(d: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

export function computeSettlementWindow(
  station: StationMeta,
  utcNow: Date = new Date()
): SettlementWindow {
  const lstOffset = station.lstOffset; // e.g. -5 for EST
  const dstActive = isDstActive(utcNow, lstOffset);
  const localOffset = dstActive ? lstOffset + 1 : lstOffset; // e.g. -4 during EDT

  // Current LST time
  const lstNowMs = utcNow.getTime() + lstOffset * 3600_000;
  const lstDate = new Date(lstNowMs);
  const lstHour = lstDate.getUTCHours();
  const lstMinute = lstDate.getUTCMinutes();
  const lstDateOnly = new Date(Date.UTC(lstDate.getUTCFullYear(), lstDate.getUTCMonth(), lstDate.getUTCDate()));

  // Contract date = today in LST
  const contractDate = formatDate(lstDateOnly);

  // Settlement window in LST: always 00:00–23:59
  const lstStart = "00:00";
  const lstEnd = "23:59";

  // If DST is active, local clock is 1h ahead of LST
  // So LST 00:00 = local 01:00 on the same calendar day
  // And LST 23:59 = local 00:59 the NEXT local calendar day
  const localStartHour = dstActive ? 1 : 0;
  const localEndHour = dstActive ? 0 : 23;
  const localEndMin = 59;
  const spillsToNextDay = dstActive; // The window spills past local midnight

  const localStart = formatHHMM(localStartHour, 0);
  const localEnd = dstActive
    ? `${formatHHMM(localEndHour, localEndMin)}+1`
    : formatHHMM(localEndHour, localEndMin);

  // Spills-to date: the local calendar day that the last minute falls on
  let spillsToDate: string | null = null;
  if (spillsToNextDay) {
    const localNowMs = utcNow.getTime() + localOffset * 3600_000;
    const localDate = new Date(localNowMs);
    const nextLocalDay = new Date(Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate() + 1
    ));
    spillsToDate = formatDate(nextLocalDay);
  }

  // Hours remaining until end of LST day (23:59 LST)
  const lstMinutesElapsed = lstHour * 60 + lstMinute;
  const lstMinutesTotal = 23 * 60 + 59;
  const minutesRemaining = Math.max(0, lstMinutesTotal - lstMinutesElapsed);
  const hoursRemaining = parseFloat((minutesRemaining / 60).toFixed(2));

  return {
    lstStart,
    lstEnd,
    localStart,
    localEnd,
    dstActive,
    spillsToNextDay,
    spillsToDate,
    hoursRemaining,
    contractDate,
    utcOffset: lstOffset,
  };
}
