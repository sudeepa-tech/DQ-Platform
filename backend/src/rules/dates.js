'use strict';
/* Reference date + calendar arithmetic for the rules layer. Integer calendar maths from the ingest layer: no JS Date, no clock. The caller passes "today" explicitly. */
const cal = require('../ingest/calendar');
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const err = m => Object.assign(new Error(m), { status: 400 });
function parseISO(s) { const m = typeof s === 'string' ? ISO.exec(s) : null; if (!m) return null; const y = +m[1], mo = +m[2], d = +m[3]; return cal.isValidYMD(y, mo, d) ? { y, m: mo, d } : null; }
const dayNumber = s => { const p = parseISO(s); return p ? cal.daysFromCivil(p.y, p.m, p.d) : null; };
/** date + N months, clamping the day to the end of a shorter month (29 Feb + 12 months = 28 Feb) */
function addMonths(s, months) { const p = parseISO(s); if (!p) return null; const t = p.y * 12 + (p.m - 1) + months, y = Math.floor(t / 12), m = (t % 12) + 1; return cal.formatYMD(y, m, Math.min(p.d, cal.daysInMonth(y, m))); }
const monthsForYears = years => Math.round(years * 12);              // 4 -> 48 months; 1.5 -> 18 months (calendar-aware, never 365.25-day approximations)
/** stale = the record's anniversary (date + threshold) is strictly before the reference date */
const isStale = (dateISO, refISO, years) => { const a = addMonths(dateISO, monthsForYears(years)); return a !== null && dayNumber(refISO) > dayNumber(a); };
function validateReferenceDate(s) { if (parseISO(s) === null || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw err('reference_date must be a real calendar date, YYYY-MM-DD.'); return s; }
/** Freeze the reference date ONCE at run start: 'fixed' uses the configured date, 'run_date' uses the date the caller supplies as today. */
function resolveReferenceDate(settings, todayISO) {
  const s = settings || {};
  if (s.reference_date_mode === 'fixed') return { reference_date: validateReferenceDate(s.reference_date), source: 'fixed' };
  if (todayISO === undefined) throw err("A 'run_date' reference date needs today's date from the caller (the rules layer never reads the clock).");
  return { reference_date: validateReferenceDate(todayISO), source: 'run_date' };
}
const validateThreshold = y => { if (!(typeof y === 'number' && y > 0 && Number.isFinite(y))) throw err('stale_threshold_years must be a positive number.'); return y; };
module.exports = { parseISO, dayNumber, addMonths, monthsForYears, isStale, resolveReferenceDate, validateReferenceDate, validateThreshold };
