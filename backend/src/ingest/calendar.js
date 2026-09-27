'use strict';
/*
 * Pure proleptic-Gregorian calendar arithmetic on integers.
 *
 * DELIBERATELY NO `Date` OBJECT ANYWHERE IN src/ingest: a JS Date is an instant on the UTC timeline that is rendered through the
 * process time zone, which is exactly how a calendar date read from a workbook used to shift by a day (S0 finding). Everything here
 * is integer arithmetic (Howard Hinnant's days-from-civil algorithms), so the result cannot depend on TZ, locale or DST.
 * A static test (backend/tests/dateModel.test.js) fails if `Date`, `toISOString`, `getTimezoneOffset` or `Date.parse` appear in src/ingest.
 */
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (y, m) => (m === 2 && isLeap(y) ? 29 : DIM[m - 1]);
const isValidYMD = (y, m, d) => Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)
  && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

/** days since 1970-01-01 for a valid civil date */
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
/** inverse of daysFromCivil */
function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
const pad = (n, w) => String(n).padStart(w, '0');
const formatYMD = (y, m, d) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const formatHMS = s => `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor((s % 3600) / 60), 2)}:${pad(s % 60, 2)}`;

module.exports = { isLeap, daysInMonth, isValidYMD, daysFromCivil, civilFromDays, formatYMD, formatHMS, pad };
