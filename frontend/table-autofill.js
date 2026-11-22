import { addressOf, shiftFormula, TABLE_LIMITS } from './table-engine.js';

const mod = (n, length) => ((n % length) + length) % length;
const dayMs = 86400000;

// Keep decimal steps exact. In particular, filling 0.1, 0.2 must store 0.3
// rather than a rounded display of 0.30000000000000004.
function decimalParts(raw) {
  const text = raw.trim();
  if (text.length > 128) return null;
  const grouping = text.match(/[ \u00a0\u202f]/)?.[0];
  if (grouping && !/^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(text)) return null;
  const parts = /^([+-]?)(\d*)(?:([.,])(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.replace(/[ \u00a0\u202f]/g, ''));
  if (!parts || !(parts[2] || parts[4])) return null;
  const [, sign, whole, separator, fraction = '', exponent = '0'] = parts;
  const value = Number(text.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
  if (!Number.isFinite(value) || Math.abs(Number(exponent)) > 324) return null;
  const scale = fraction.length - Number(exponent);
  let integer = BigInt((sign === '-' ? '-' : '') + (whole + fraction));
  if (scale < 0) integer *= 10n ** BigInt(-scale);
  return { integer, scale: Math.max(0, scale), separator, grouping,
    width: /^0\d/.test(whole) ? whole.length : 0, plus: sign === '+',
    decimals: Number(exponent) ? 0 : fraction.length };
}

// Approximate a rational with guard digits and a separate base-10 exponent.
// Exponentiation then stays bounded in memory even for long, nonterminating
// fractional series, without overflowing or underflowing a JavaScript Number.
function scientificQuotient(n, d) {
  const negative = (n < 0n) !== (d < 0n);
  n = n < 0n ? -n : n;
  d = d < 0n ? -d : d;
  const places = 28 + d.toString().length - n.toString().length;
  if (places >= 0) n *= 10n ** BigInt(places);
  else d *= 10n ** BigInt(-places);
  const coefficient = (n + d / 2n) / d;
  return { coefficient: negative ? -coefficient : coefficient, exponent: -places };
}

function scientificProduct(a, b) {
  const result = scientificQuotient(a.coefficient * b.coefficient, 1n);
  result.exponent += a.exponent + b.exponent;
  return result;
}

function numericSeries(raw) {
  if (raw.length < 2) return null;
  const parsed = raw.map(decimalParts);
  if (parsed.some(part => !part)) return null;
  const scale = Math.max(...parsed.map(part => part.scale));
  const values = parsed.map(part => part.integer * 10n ** BigInt(scale - part.scale));
  const width = Math.max(...parsed.map(part => part.width));
  const minDecimals = Math.min(...parsed.map(part => part.decimals));
  const separator = parsed.find(part => part.separator)?.separator || '.';
  const grouping = parsed.find(part => part.grouping)?.grouping;
  const plus = parsed.every(part => part.plus);
  function format(integer, places) {
    const digits = (integer < 0n ? -integer : integer).toString().padStart(places + 1, '0');
    let whole = digits.slice(0, digits.length - places).padStart(width, '0');
    if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, grouping);
    const tail = digits.slice(digits.length - places).replace(/0+$/, '').padEnd(minDecimals, '0');
    return (integer < 0n ? '-' : plus ? '+' : '') + whole + (tail ? separator + tail : '');
  }
  const step = values[1] - values[0];
  if (values.every((v, i) => v === values[0] + step * BigInt(i))) {
    return i => format(values[0] + step * BigInt(i), scale);
  }
  // Two points always define an arithmetic step. Require a third matching
  // point before extrapolating a ratio, and compare the source terms exactly.
  if (values.length < 3 || !values[0] || !values[1] ||
      !values.every((v, i) => !i || v * values[0] === values[i - 1] * values[1])) return null;
  // A terminating decimal ratio can be multiplied exactly just like the
  // arithmetic step. Bound the stored precision for long fractional series.
  function exactFactor(n, d) {
    for (let places = 0; places <= 32; places++, n *= 10n) {
      if (n % d === 0n) {
        const integer = n / d;
        return { integer, places, digits: integer.toString().length };
      }
    }
    return null;
  }
  const forward = exactFactor(values[1], values[0]), backward = exactFactor(values[0], values[1]);
  const ratio = scientificQuotient(values[1], values[0]), inverse = scientificQuotient(values[0], values[1]);
  return i => {
    const from = i < 0 ? 0 : values.length - 1;
    const factor = i < 0 ? backward : forward, steps = Math.abs(i - from);
    if (factor && factor.places * steps <= 128 && factor.digits * steps <= 512) {
      return format(values[from] * factor.integer ** BigInt(steps), scale + factor.places * steps);
    }
    let result = { coefficient: values[from], exponent: -scale }, multiplier = i < 0 ? inverse : ratio;
    for (let power = steps; power; power = Math.floor(power / 2)) {
      if (power % 2) result = scientificProduct(result, multiplier);
      multiplier = scientificProduct(multiplier, multiplier);
    }
    const absolute = result.coefficient < 0n ? -result.coefficient : result.coefficient;
    const trim = Math.max(0, absolute.toString().length - 15), divisor = 10n ** BigInt(trim);
    const rounded = (absolute + divisor / 2n) / divisor;
    const digits = rounded.toString(), exponent = result.exponent + trim;
    const leadingExponent = exponent + digits.length - 1;
    if (leadingExponent >= 308 || leadingExponent < -307) {
      const tail = digits.slice(1).replace(/0+$/, '');
      return (result.coefficient < 0n ? '-' : plus ? '+' : '') + digits[0] +
        (tail ? separator + tail : '') + 'e' + leadingExponent;
    }
    const signed = result.coefficient < 0n ? -rounded : rounded;
    return format(signed * 10n ** BigInt(Math.max(0, exponent)), Math.max(0, -exponent));
  };
}

function utcDate(year, month, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date;
}

function monthLength(year, month) {
  return utcDate(year, month + 1, 0).getUTCDate();
}

function dateSeries(raw, locale) {
  const yearFirst = /^\d{4}[-/.]/.test(raw[0]);
  const pattern = yearFirst ? /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/ : /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/;
  const parts = raw.map(text => pattern.exec(text));
  if (parts.some(p => !p || p[2] !== parts[0][2])) return null;
  const delimiter = parts[0][2];
  function parseDates(monthFirst) {
    const dates = [];
    for (const [, a, , b, c] of parts) {
      const year = Number(yearFirst ? a : c);
      const month = Number(yearFirst ? b : monthFirst ? a : b) - 1;
      const day = Number(yearFirst ? c : monthFirst ? b : a);
      const date = utcDate(year, month, day);
      if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
      dates.push(date);
    }
    return dates;
  }
  let monthFirst = !yearFirst && delimiter !== '.' && /^en(?:-|$)/i.test(locale);
  let dates = parseDates(monthFirst);
  if (!dates && !yearFirst && delimiter !== '.') {
    monthFirst = !monthFirst;
    dates = parseDates(monthFirst);
  }
  if (!dates) return null;
  const monthIndex = d => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const firstMonth = monthIndex(dates[0]);
  const days = dates.map(d => d.getUTCDate());
  const monthStep = dates.length > 1 ? monthIndex(dates[1]) - firstMonth : 0;
  const anchorDay = dates.every(d => d.getUTCDate() === monthLength(d.getUTCFullYear(), d.getUTCMonth()))
    ? 31 : Math.max(...days);
  function inMonth(i) {
    const index = firstMonth + i * monthStep;
    const year = Math.floor(index / 12), month = mod(index, 12);
    return utcDate(year, month, Math.min(anchorDay, monthLength(year, month)));
  }
  let dateAt;
  if (monthStep && dates.every((date, i) => +inMonth(i) === +date)) dateAt = inMonth;
  else {
    const step = dates.length === 1 ? dayMs : dates[1] - dates[0];
    if (!dates.every((date, i) => +date === +dates[0] + i * step)) return null;
    dateAt = i => new Date(+dates[0] + i * step);
  }
  const monthPart = yearFirst ? 3 : monthFirst ? 1 : 3;
  const dayPart = yearFirst ? 4 : monthFirst ? 3 : 1;
  const paddedMonth = parts.every(p => p[monthPart].length === 2);
  const paddedDay = parts.every(p => p[dayPart].length === 2);
  return i => {
    const date = dateAt(i), y = date.getUTCFullYear();
    if (!Number.isFinite(y) || y < 0 || y > 9999) return null;
    const year = String(y).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(paddedMonth ? 2 : 1, '0');
    const day = String(date.getUTCDate()).padStart(paddedDay ? 2 : 1, '0');
    return (yearFirst ? [year, month, day] : monthFirst ? [month, day, year] : [day, month, year]).join(delimiter);
  };
}

const calendarLists = [
  'monday tuesday wednesday thursday friday saturday sunday',
  'mon tue wed thu fri sat sun',
  'понедельник вторник среда четверг пятница суббота воскресенье',
  'пн вт ср чт пт сб вс',
  'january february march april may june july august september october november december',
  'jan feb mar apr may jun jul aug sep oct nov dec',
  'jan feb mar apr may jun jul aug sept oct nov dec',
  'январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь',
  'янв фев мар апр май июн июл авг сен окт ноя дек',
  'янв февр март апр май июнь июль авг сент окт нояб дек'
].map(list => list.split(' '));

function namedSeries(raw) {
  const words = raw.map(text => text.toLowerCase().replace(/\.$/, ''));
  for (const list of calendarLists) {
    const indices = words.map(word => list.indexOf(word));
    if (indices.includes(-1)) continue;
    const step = indices.length > 1 ? indices[1] - indices[0] : 1;
    if (!indices.every((index, i) => index === mod(indices[0] + i * step, list.length))) continue;
    return i => {
      const template = raw[mod(i, raw.length)];
      let word = list[mod(indices[0] + step * i, list.length)];
      if (template === template.toUpperCase()) word = word.toUpperCase();
      else if (template[0] !== template[0].toLowerCase()) word = word[0].toUpperCase() + word.slice(1);
      return word + (template.endsWith('.') ? '.' : '');
    };
  }
  return null;
}

function labelSeries(raw) {
  // A literal-text escape or an invalid date must not become a numbered label.
  const parts = raw.map(value => /^([^\d'=+-].*?)(\d{1,64})$/u.exec(value));
  if (parts.some(part => !part || !part[1].trim() || part[1] !== parts[0][1])) return null;
  const numbers = parts.map(part => BigInt(part[2]));
  const step = numbers.length === 1 ? 1n : numbers[1] - numbers[0];
  if (!numbers.every((n, i) => n === numbers[0] + step * BigInt(i))) return null;
  const width = Math.max(...parts.map(p => /^0\d/.test(p[2]) ? p[2].length : 0));
  return i => {
    const n = numbers[0] + step * BigInt(i);
    return parts[0][1] + (n < 0n ? '-' : '') + (n < 0n ? -n : n).toString().padStart(width, '0');
  };
}

function validBounds(range, table) {
  return range && [range.top, range.bottom, range.left, range.right].every(Number.isInteger) &&
    range.top >= 0 && range.top <= range.bottom && range.bottom < Math.min(table.rows, TABLE_LIMITS.rows) &&
    range.left >= 0 && range.left <= range.right && range.right < Math.min(table.cols, TABLE_LIMITS.cols);
}

// Both rectangles are inclusive. Read every lane from the original cells so
// reverse fills and formulas always use the initial selection as the template.
export function planAutofill(table, source, target, locale = 'ru', copyValue) {
  const original = table.cells;
  if (table.locked || !validBounds(source, table) || !validBounds(target, table)) return null;
  const vertical = target.left === source.left && target.right === source.right;
  const horizontal = target.top === source.top && target.bottom === source.bottom;
  if (vertical === horizontal) return null;
  const start = vertical ? source.top : source.left, end = vertical ? source.bottom : source.right;
  const nextStart = vertical ? target.top : target.left, nextEnd = vertical ? target.bottom : target.right;
  if (nextStart > start || nextEnd < end || (nextStart < start && nextEnd > end)) return null;
  const firstLane = vertical ? source.left : source.top, lastLane = vertical ? source.right : source.bottom;
  const from = nextStart < start ? nextStart : end + 1, to = nextStart < start ? start - 1 : nextEnd;
  const lanes = new Map();
  const address = (n, lane) => vertical ? addressOf(n, lane) : addressOf(lane, n);
  function laneValues(lane) {
    const raw = Array.from({ length: end - start + 1 }, (_, i) => {
      const key = address(start + i, lane), entry = String(original[key] ?? '');
      if (!copyValue || !entry.startsWith('=')) return entry;
      const value = copyValue(key);
      // Freeze formula results. Quoting text preserves numeric-looking strings,
      // leading apostrophes and equals signs when the copied cell is evaluated.
      return typeof value === 'string' && value !== '' ? "'" + value : String(value ?? '');
    });
    if (copyValue) return i => raw[mod(i, raw.length)];
    const series = dateSeries(raw, locale) || numericSeries(raw) || namedSeries(raw) || labelSeries(raw);
    return i => {
      const template = mod(i, raw.length), delta = i - template;
      return series?.(i) ?? shiftFormula(raw[template], vertical ? delta : 0, vertical ? 0 : delta);
    };
  }
  function laneAt(lane) {
    if (!lanes.has(lane)) lanes.set(lane, laneValues(lane));
    return lanes.get(lane);
  }
  function rawAt(row, col) {
    const lane = vertical ? col : row, n = vertical ? row : col;
    if (lane < firstLane || lane > lastLane || n < from || n > to) return original[addressOf(row, col)] ?? '';
    return laneAt(lane)(n - start);
  }
  function apply() {
    let cells = original;
    for (let lane = firstLane; lane <= lastLane; lane++) {
      const generate = laneAt(lane);
      for (let n = from; n <= to; n++) {
        const value = generate(n - start), key = address(n, lane);
        if (value === (original[key] ?? '')) continue;
        if (cells === original) cells = { ...original };
        if (value === '') delete cells[key];
        else cells[key] = value;
      }
    }
    return cells;
  }
  return { rows: table.rows, cols: table.cols, rawAt, apply };
}

export function autofillCells(table, source, target, locale = 'ru', copyValue) {
  return planAutofill(table, source, target, locale, copyValue)?.apply() ?? table.cells;
}
