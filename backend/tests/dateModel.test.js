'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const C = require('../src/ingest/calendar');
const D = require('../src/ingest/dateModel');
const { writeWorkbook } = require('./helpers/workbook');

const utcDay = n => new Date(n * 86400000).toISOString().slice(0, 10);   // TEST-ONLY independent oracle (UTC, so TZ-independent)

test('calendar arithmetic matches an independent UTC oracle for every day 1600-01-01..2400-12-31, and round-trips', () => {
  const lo = C.daysFromCivil(1600, 1, 1), hi = C.daysFromCivil(2400, 12, 31);
  for (let n = lo; n <= hi; n++) {
    const { y, m, d } = C.civilFromDays(n);
    if (C.formatYMD(y, m, d) !== utcDay(n)) assert.fail(`day ${n}: ${C.formatYMD(y, m, d)} != ${utcDay(n)}`);
    if (C.daysFromCivil(y, m, d) !== n) assert.fail('round trip ' + n);
  }
  assert.deepEqual([1900, 2000, 2024, 2100, 2023].map(C.isLeap), [false, true, true, false, false]);
  assert.equal(C.daysInMonth(2024, 2), 29); assert.equal(C.daysInMonth(2100, 2), 28);
  assert.equal(C.isValidYMD(2024, 2, 30), false); assert.equal(C.isValidYMD(2024, 13, 1), false); assert.equal(C.isValidYMD(0, 1, 1), false);
});

test('Excel serials (1900 system) convert to the exact calendar date, incl. the 1900 leap-year bug and range limits', () => {
  const S = n => D.excelSerialToCalendar(n);
  assert.equal(S(1).date, '1900-01-01'); assert.equal(S(59).date, '1900-02-28');
  assert.equal(S(60).ok, false); assert.equal(S(60).reason, 'excel_1900_leap_bug');       // Excel shows 29-Feb-1900, which never existed
  assert.equal(S(61).date, '1900-03-01'); assert.equal(S(25569).date, '1970-01-01');
  assert.equal(S(41725).date, '2014-03-27'); assert.equal(S(45281).date, '2023-12-21');
  assert.equal(S(2958465).date, '9999-12-31'); assert.equal(S(2958466).reason, 'excel_serial_out_of_range');
  assert.equal(S(0).reason, 'excel_zero_date'); assert.equal(S(-5).reason, 'excel_negative_serial');
  assert.equal(S(NaN).reason, 'not_finite'); assert.equal(S(Infinity).reason, 'not_finite');
  // independent oracle for every serial 61..73415 (1900-03-01..2101-01-*) plus a coarse sweep to the maximum
  for (let n = 61; n <= 73415; n++) if (S(n).date !== utcDay(n - 25569)) assert.fail(`serial ${n}`);
  for (let n = 73415; n <= 2958465; n += 997) if (S(n).date !== utcDay(n - 25569)) assert.fail(`serial ${n}`);
});
test('the 1904 date system is honoured', () => {
  const S = n => D.excelSerialToCalendar(n, { date1904: true });
  assert.equal(S(0).date, '1904-01-01'); assert.equal(S(1462).date, '1908-01-02'); assert.equal(S(-1).ok, false);
  for (let n = 0; n <= 60000; n += 7) assert.equal(S(n).date, D.excelSerialToCalendar(n + 1462).date, 'same day as the 1900 system offset by 1462');
  assert.equal(S(2957003).date, '9999-12-31'); assert.equal(S(2957004).ok, false);
});
test('fractional serials: rounded to the second first; midnight rollover; date part never shifts by rounding noise', () => {
  const S = n => D.excelSerialToCalendar(n);
  assert.deepEqual([S(45281.5).date, S(45281.5).time], ['2023-12-21', '12:00:00']);
  assert.equal(S(45281 + 1 / 86400).time, '00:00:01'); assert.equal(S(45281.75).time, '18:00:00');
  assert.deepEqual([S(45281.99999999).date, S(45281.99999999).time], ['2023-12-22', '00:00:00']);   // within half a second of midnight -> next day, like a spreadsheet displays it
  assert.equal(S(45281 + 0.5 / 86400 - 1e-9).time, '00:00:00');
  for (let n = 40000; n < 40400; n++) assert.equal(S(n).time, '00:00:00');
});

test('number-format classification: date_only / datetime / time_only / not_date (locale codes, escapes, minute-vs-month)', () => {
  const k = f => D.classifyNumberFormat(f).kind;
  const expect = { 'm/d/yy': 'date_only', 'DD.MM.YYYY': 'date_only', 'dd\\.mm\\.yyyy': 'date_only', 'd-mmm-yy': 'date_only', 'mmm yy': 'date_only', 'yyyy-mm-dd': 'date_only',
    '[$-409]d-mmm-yy;@': 'date_only', '[$-F800]dddd, mmmm dd, yyyy': 'date_only', 'yyyy-mm-dd hh:mm:ss': 'datetime', 'mm/dd/yyyy hh:mm': 'datetime', 'dd.mm.yyyy h:mm AM/PM': 'datetime',
    'h:mm': 'time_only', 'hh:mm AM/PM': 'time_only', '[$-F400]h:mm:ss\\ AM/PM': 'time_only', 'mm:ss': 'time_only', '[h]:mm:ss': 'time_only', 'h:mm:ss.000': 'time_only',
    '[$-F800]': 'date_only', '[$-F400]': 'time_only', '[$-409]': 'not_date', '[$-F800];@': 'date_only',   // bare system date / system time codes carry the whole meaning
    General: 'not_date', '@': 'not_date', '0': 'not_date', '#,##0.00': 'not_date', '0.00%': 'not_date', '"Q"0': 'not_date', '0.0E+00': 'not_date', '0.00E-00': 'not_date', '##0.0E+0': 'not_date', '[Red]#,##0': 'not_date', '': 'not_date' };
  for (const [f, want] of Object.entries(expect)) assert.equal(k(f), want, JSON.stringify(f));
  assert.equal(k(undefined), 'not_date');
});

test('classifyCell: every date type is distinguished and nothing is silently converted', () => {
  const ctx = { date1904: false, profile: D.resolveDateProfile(), formatCache: new Map() }; const cc = c => D.classifyCell(c, ctx);
  const dOnly = cc({ t: 'n', v: 45281, z: 'DD.MM.YYYY' });
  assert.deepEqual([dOnly.type, dOnly.raw, dOnly.canonical], ['date_only', 45281, '2023-12-21']);
  const hidden = cc({ t: 'n', v: 45281.5, z: 'dd.mm.yyyy' });                      // date format, fractional value: still a DATE_ONLY; the hidden time is recorded, not dropped or promoted
  assert.deepEqual([hidden.type, hidden.canonical, hidden.meta.ht], ['date_only', '2023-12-21', '12:00:00']);
  const dt = cc({ t: 'n', v: 45281.75, z: 'yyyy-mm-dd hh:mm:ss' });
  assert.deepEqual([dt.type, dt.canonical, dt.meta.tz], ['datetime', '2023-12-21T18:00:00', 'floating']);   // a workbook has no zone: floating wall-clock, explicitly labelled
  const tm = cc({ t: 'n', v: 0.5, z: '[$-F400]h:mm:ss\\ AM/PM' });
  assert.deepEqual([tm.type, tm.canonical], ['time_only', '12:00:00']);
  assert.equal(cc({ t: 'n', v: 45281.25, z: 'h:mm' }).meta.hd, '2023-12-21');       // hidden date of a time-only cell is recorded
  assert.equal(cc({ t: 'n', v: 45281, z: 'General' }).type, 'number');                // a bare number is NEVER a date without a date format
  assert.equal(cc({ t: 'n', v: 45281, z: '0' }).type, 'number');
  assert.equal(cc({ t: 'n', v: 60, z: 'm/d/yy' }).meta.why, 'excel_1900_leap_bug');
  assert.equal(cc({ t: 'n', v: 0, z: 'm/d/yy' }).type, 'invalid_date');
  assert.equal(cc({ t: 'n', v: 3e9, z: 'm/d/yy' }).meta.why, 'excel_serial_out_of_range');
  assert.equal(cc({ t: 'n', v: 30.5, z: '[h]:mm:ss' }).type, 'unknown');             // elapsed hours > 24 is a duration, not a time of day
  assert.equal(cc({ t: 'b', v: true }).type, 'boolean'); assert.equal(cc({ t: 'e', v: 42, w: '#N/A' }).raw, '#N/A');
  assert.equal(cc(null).type, 'blank'); assert.equal(cc({ t: 's', v: '' }).type, 'blank');
  const ws = cc({ t: 's', v: '   ' }); assert.deepEqual([ws.type, ws.whitespaceOnly, ws.raw], ['text', true, '   ']);   // raw preserved, not counted populated
  for (const idLike of ['1000005791', '4300000346', 'SANKALP20299', '00012345', '10', '2024', '12345678', 'MAT-2024-01']) { const r = cc({ t: 's', v: idLike }); assert.equal(r.type, 'text', idLike); assert.equal(r.raw, idLike); assert.equal(r.canonical, undefined); }
  assert.equal(cc({ t: 's', v: '10:30' }).type, 'time_only');
  assert.equal(D.classifyCell({ t: 'n', v: 45281, z: 'DD.MM.YYYY' }, { date1904: true, profile: ctx.profile }).canonical, utcDay(45281 - 25569 + 1462));   // same serial, other date system (+1462 days, oracle-computed)
});

test('text dates: strict, profile-driven; ambiguity is recorded (raw + candidates + confidence + status), never guessed', () => {
  const P = D.DEFAULT_DATE_PROFILE, both = D.resolveDateProfile({ formats: ['DD/MM/YYYY', 'MM/DD/YYYY'] }), dmy = D.resolveDateProfile({ formats: ['DD/MM/YYYY'] });
  const r = (s, p = P) => D.parseTextDate(s, p);
  assert.deepEqual([r('05.03.2024').status, r('05.03.2024').value, r('05.03.2024').confidence], ['parsed', '2024-03-05', 1]);
  assert.equal(r('2024-03-05').value, '2024-03-05'); assert.equal(r('5.3.2024').value, '2024-03-05');
  assert.equal(r(' 05.03.2024 ').value, '2024-03-05'); assert.deepEqual(r(' 05.03.2024 ').flags, ['trimmed']);
  for (const bad of ['31.02.2024', '00.00.0000', '2024-13-45', '29.02.2023', '31.04.2024']) assert.equal(r(bad).status, 'invalid', bad);
  assert.equal(r('29.02.2024').status, 'parsed');                                            // leap day
  // slash dates are NOT guessed under the default profile
  const s1 = r('05/03/2024'); assert.equal(s1.status, 'needs_configuration'); assert.equal(s1.value, null);
  assert.deepEqual(s1.candidates.map(c => c.format + '=' + c.value).sort(), ['DD/MM/YYYY=2024-03-05', 'MM/DD/YYYY=2024-05-03']);
  assert.equal(r('20240305').status, 'needs_configuration');                                  // 8-digit run only when explicitly enabled
  // both slash orders enabled -> ambiguous when both readings are valid and differ; resolved when only one is valid
  const amb = r('05/03/2024', both); assert.equal(amb.status, 'ambiguous'); assert.equal(amb.value, null); assert.equal(amb.candidates.length, 2); assert.equal(amb.confidence, 0.5);
  assert.deepEqual([r('25/03/2024', both).status, r('25/03/2024', both).value], ['parsed', '2024-03-25']);
  assert.deepEqual([r('03/25/2024', both).status, r('03/25/2024', both).value], ['parsed', '2024-03-25']);
  assert.equal(r('06/06/2024', both).status, 'parsed');                                       // both readings agree -> not ambiguous
  // one order enabled: parsed, but the alternative reading under a known-but-disabled format is kept as evidence
  const pa = r('05/03/2024', dmy); assert.deepEqual([pa.status, pa.value, pa.confidence], ['parsed', '2024-03-05', 0.5]); assert.equal(pa.alt[0].value, '2024-05-03');
  const inv = r('03/25/2024', dmy); assert.deepEqual([inv.status, inv.reason], ['invalid', 'calendar_invalid_under_profile']); assert.equal(inv.alt[0].value, '2024-03-25');
  // datetimes and explicit offsets
  assert.equal(r('01.02.2024 10:30:45').value, '2024-02-01T10:30:45');
  assert.equal(r('2024-03-05T10:30:00+05:30').value, '2024-03-05T10:30:00+05:30'); assert.equal(r('2024-03-05T10:30:00+05:30').tz, '+05:30');   // offset kept, NOT converted to UTC
  assert.equal(r('2024-03-05 10:30:00Z').tz, 'Z'); assert.equal(r('01.02.2024 25:00:00').status, 'invalid');
  // not dates at all
  for (const t of ['not-a-date', 'SANKALP20299', '4300000346', '10', '', 'Due 05.03.2024', '05.03.2024 extra']) assert.equal(r(t).status, 'not_date', t);
  assert.equal(D.parseTextDate(12345, P).status, 'not_date');
  // two-digit years: refused without an explicit century pivot, resolved only with one
  assert.equal(r('16.01.19').status, 'needs_configuration'); assert.equal(r('16.01.19').candidates[0].note, 'two_digit_year_requires_century_pivot');
  assert.throws(() => D.resolveDateProfile({ formats: ['DD.MM.YY'] }), /century_pivot/);
  const p70 = D.resolveDateProfile({ formats: ['DD.MM.YYYY', 'DD.MM.YY'], century_pivot: 70 });
  assert.deepEqual(['16.01.19', '16.01.69', '16.01.70', '16.01.99'].map(s => r(s, p70).value), ['2019-01-16', '2069-01-16', '1970-01-16', '1999-01-16']);
  assert.throws(() => D.resolveDateProfile({ formats: ['MM-DD-YYYY'] }), /Unknown date format/);
  // mixed separators are not any known format -> plain text, flagged by the column profile rather than mis-parsed
  assert.equal(r('13-02.2024').status, 'not_date'); assert.equal(r('18.012022').status, 'not_date');
});

/* ------------------------------------------------------------------ no timezone-sensitive JS in the ingest layer */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
test('static guard: src/ingest contains no Date object, Date.parse, toISOString, getTimezoneOffset, Intl or locale formatting (code, not comments)', () => {
  const dir = path.join(__dirname, '..', 'src', 'ingest'); const hits = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    stripComments(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n').forEach((line, i) => {
      if (/\bDate\b|toISOString|getTimezoneOffset|toLocale|\bIntl\b|dayjs|moment|luxon|cellDates\s*:\s*true|SSF\.parse_date_code|XLSX\.SSF\.format/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

/* ------------------------------------------------------------------ timezone invariance (real child processes with TZ set) */
test('timezone invariance: the SAME workbook ingests to byte-identical canonical output under Asia/Kolkata, UTC, America/New_York, Pacific/Auckland, America/St_Johns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-tz-')); const file = path.join(dir, 'tz.xlsx');
  // serials around DST transitions of several zones + midnights + year/leap boundaries
  const serials = [41725, 41729, 41730, 42430, 42434, 43170, 43408, 44996, 45000, 45228, 45229, 45281, 45291, 45292, 43889, 43890, 43891, 36526, 36585, 36586, 73050];
  const rows = [['D_fmt1', 'D_fmt2', 'DT', 'T', 'Txt']].concat(serials.map((s, i) => [{ v: s, z: 'm/d/yy' }, { v: s, z: 'DD.MM.YYYY' }, { v: s + 0.75, z: 'yyyy-mm-dd hh:mm:ss' }, { v: (i % 24) / 24, z: 'h:mm:ss AM/PM' }, '05.03.2024']));
  writeWorkbook(file, rows);
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, `const {openSource}=require(${JSON.stringify(path.join(__dirname, '../src/ingest/reader'))});const {readCanonical}=require(${JSON.stringify(path.join(__dirname, '../src/ingest/canonicalize'))});
    const r=readCanonical(openSource(${JSON.stringify(file)}),{});process.stdout.write('@@'+JSON.stringify(r.rows.map(x=>[x.rawJson,x.canonicalJson,x.metaJson,x.rawHash])));`);
  const out = {};
  for (const tz of ['Asia/Kolkata', 'UTC', 'America/New_York', 'Pacific/Auckland', 'America/St_Johns']) {
    const p = spawnSync(process.execPath, ['--experimental-sqlite', child], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.ok(p.stdout.includes('@@'), tz + ' ' + p.stderr.slice(-300)); out[tz] = p.stdout.split('@@')[1];
  }
  const vals = Object.values(out); assert.ok(vals.every(v => v === vals[0]), 'canonical output differs between time zones');
  const rowsOut = JSON.parse(vals[0]); const first = JSON.parse(rowsOut[0][1]);
  assert.deepEqual([first.D_fmt1, first.D_fmt2, first.DT], ['2014-03-27', '2014-03-27', '2014-03-27T18:00:00']);
  assert.equal(rowsOut.length, serials.length);
  serials.forEach((s, i) => { const c = JSON.parse(rowsOut[i][1]); assert.equal(c.D_fmt1, utcDay(s - 25569), 'serial ' + s); });
});
