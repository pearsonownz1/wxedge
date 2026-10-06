/** Match market data to the day used by the forecast and running-high model.
 * Weather settlement days use local STANDARD time, never daylight time.
 */
export function stationTradingDate(now: Date, lstOffset: number): string {
  return new Date(now.getTime() + lstOffset * 3_600_000).toISOString().slice(0, 10);
}

export function isStationTradingDate(
  marketDate: Date | null,
  now: Date,
  lstOffset: number,
): boolean {
  if (!marketDate || !Number.isFinite(marketDate.getTime())) return false;
  const localDate = stationTradingDate(now, lstOffset);
  return marketDate.toISOString().slice(0, 10) === localDate;
}

export function bookPriceSums(
  brackets: Array<{ bidCents: number | null; askCents: number | null }>,
): { sumAsk: number; sumBid: number } {
  return {
    // Kalshi's empty ask is 100¢, not zero. This is only an invariant bound;
    // keep the quote itself null so an unavailable ask can NEVER be executed.
    sumAsk: brackets.reduce((sum, b) => sum + (b.askCents ?? 100), 0),
    sumBid: brackets.reduce((sum, b) => sum + (b.bidCents ?? 0), 0),
  };
}

export function isBookCoherent(
  brackets: Array<{ bidCents: number | null; askCents: number | null }>,
): boolean {
  if (!brackets.some(b => b.bidCents !== null || b.askCents !== null)) return false;
  const { sumAsk, sumBid } = bookPriceSums(brackets);
  // Preserve the existing bounds; do not loosen the trading safeguards.
  return sumAsk >= 100 && sumAsk <= 115 && sumBid <= 105;
}
