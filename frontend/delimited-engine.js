// Only record offsets stay in memory. Quoted newlines belong to their field,
// so a record number is independent of the editor's physical line numbers.
// This factory is also embedded in a blob worker on desktop WebViews.
export function createDelimitedIndex(text, separator) {
  if (typeof text !== 'string' || ![',', '\t'].includes(separator)) throw new TypeError('Invalid delimited source');
  const delimiter = separator.charCodeAt(0), size = text.length;
  const prefix = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let offsets = new Uint32Array(Math.min(1024, size + 1));
  let rowCount = 0, columnCount = 0;
  offsets[0] = prefix;

  function malformed(row, offset) {
    const error = new Error('Invalid quoted field');
    throw Object.assign(error, {code:'MALFORMED', row:row+1, offset});
  }

  // During indexing this validates and counts fields without allocating them.
  // During a read it stops as soon as the last requested field is reached.
  function scan(row, visit, lastColumn) {
    let pos = offsets[row], column = 0;
    for (;;) {
      const from = pos, quoted = text.charCodeAt(pos) === 34;
      let escaped = false;
      if (quoted) {
        pos++;
        for (;;) {
          const quote = text.indexOf('"', pos);
          if (quote < 0) malformed(row, size);
          pos = quote + 1;
          if (text.charCodeAt(pos) !== 34) break;
          escaped = true; pos++;
        }
      } else {
        while (pos < size) {
          const c = text.charCodeAt(pos);
          if (c === delimiter || c === 10 || c === 13) break;
          if (c === 34) malformed(row, pos);
          pos++;
        }
      }
      if (visit) {
        visit(column, from, pos, quoted, escaped);
        if (column === lastColumn) return pos;
      }
      column++;
      const c = text.charCodeAt(pos);
      if (c === delimiter) { pos++; continue; }
      if (pos < size && c !== 10 && c !== 13) malformed(row, pos);
      if (!visit && column > columnCount) columnCount = column;
      if (pos < size) pos += c === 13 && text.charCodeAt(pos+1) === 10 ? 2 : 1;
      return pos;
    }
  }

  while (offsets[rowCount] < size) {
    const next = scan(rowCount, null);
    if (++rowCount === offsets.length) {
      const larger = new Uint32Array(Math.min(size+1, offsets.length*2));
      larger.set(offsets); offsets = larger;
    }
    offsets[rowCount] = next;
  }

  function decode(from, to, quoted, escaped, limit = Infinity) {
    if (quoted) { from++; to--; }
    // Even a field consisting entirely of doubled quotes needs at most two
    // source characters per visible character. Viewports can request a preview
    // without transporting or allocating a multi-megabyte field.
    const end = Math.min(to,from+limit*(escaped ? 2 : 1));
    const value = text.slice(from,end);
    return escaped ? value.replaceAll('""', '"').slice(0,limit) : value;
  }
  function endOf(row) {
    const start = offsets[row], end = offsets[row+1], c = text.charCodeAt(end-1);
    if (c === 13) return end-1;
    if (c !== 10) return end;
    return end - (end-2 >= start && text.charCodeAt(end-2) === 13 ? 2 : 1);
  }
  function validColumn(column) {
    return Number.isInteger(column) && column >= 0 && column < columnCount;
  }
  function cellRange(row, column) {
    if (!Number.isInteger(row) || row < 0 || row >= rowCount || !validColumn(column)) throw new RangeError('Invalid cell');
    let from = endOf(row), to = from;
    scan(row, (index, begin, end) => { if (index === column) { from = begin; to = end; } }, column);
    return {from, to};
  }
  function read(start, count, firstColumn = 0, width = columnCount, maxCellLength = Infinity) {
    if (![start,count,firstColumn,width].every(value => Number.isSafeInteger(value) && value >= 0))
      throw new RangeError('Invalid viewport');
    if (maxCellLength !== Infinity && !(Number.isSafeInteger(maxCellLength) && maxCellLength >= 0))
      throw new RangeError('Invalid cell preview size');
    const last = Math.min(columnCount, firstColumn+width)-1, records = [];
    for (let r=start; r<Math.min(rowCount,start+count); r++) {
      const fields = new Array(Math.max(0,last-firstColumn+1)).fill('');
      if (fields.length) scan(r, (column,from,to,quoted,escaped) => {
        if (column >= firstColumn) fields[column-firstColumn] = decode(from,to,quoted,escaped,maxCellLength);
      }, last);
      records.push(fields);
    }
    return records;
  }

  // Field values are decoded once per row. Length-prefixed components keep
  // compound keys unambiguous even when fields contain arbitrary delimiters.
  function keyFor(row, columns) {
    let next = 0, key = '';
    scan(row,(column,from,to,quoted,escaped) => {
      if (column !== columns[next]) return;
      const value = decode(from,to,quoted,escaped);
      key += columns.length === 1 ? value : value.length+':'+value;
      next++;
    },columns.at(-1));
    if (columns.length > 1 && next !== columns.length) key += '0:'.repeat(columns.length-next);
    return key;
  }

  function sortOrder(order, first, column, descending, language) {
    const keys = new Array(order.length), selected = [column], rank = new Float64Array(order.length);
    const numberPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;
    const factor = descending ? -1 : 1;
    let numeric = true, hasEmpty = false;
    for (let i=0; i<order.length; i++) {
      order[i] = first+i;
      const key = keys[i] = keyFor(first+i,selected);
      if (!key) hasEmpty = true;
      else if (numeric) {
        if (numberPattern.test(key)) rank[i] = Number(key);
        else numeric = false;
      }
    }

    // Usually the numeric comparison alone is enough. Two decimal tokens can
    // round to the same Number (even to Infinity or zero). Resolve only these
    // ties from the original digits, keeping large IDs and signed values exact.
    const exact = new Map();
    function decimal(key) {
      let parsed = exact.get(key);
      if (parsed) return parsed;
      const [,marker,whole='',fraction='',subunit='',exponent='0'] = numberPattern.exec(key);
      const mantissa = whole + fraction + subunit;
      const digits = mantissa.replace(/^0+/,'');
      parsed = {sign:digits ? (marker === '-' ? -1 : 1) : 0,
        order:BigInt(exponent)+BigInt(whole.length-mantissa.length+digits.length),
        digits:digits.replace(/0+$/,'')};
      exact.set(key,parsed);
      return parsed;
    }
    function compareNumbers(a,b) {
      if (rank[a] !== rank[b]) return rank[a] < rank[b] ? -1 : 1;
      if (keys[a] === keys[b]) return 0;
      const x = decimal(keys[a]), y = decimal(keys[b]);
      if (x.sign !== y.sign) return x.sign-y.sign;
      if (!x.sign) return 0;
      if (x.order !== y.order) return x.order < y.order ? -x.sign : x.sign;
      return x.digits === y.digits ? 0 : x.digits < y.digits ? -x.sign : x.sign;
    }

    function numberedColumn() {
      const example = keys.find(Boolean);
      const suffix = example && /(?:^|\P{Nd})([0-9]{1,15})$/u.exec(example);
      if (!suffix) return false;
      const prefix = example.slice(0,example.length-suffix[1].length);
      for (let i=0; i<keys.length; i++) {
        if (!keys[i]) continue;
        const digits = keys[i].slice(prefix.length);
        if (!keys[i].startsWith(prefix) || !/^\d{1,15}$/.test(digits)) return false;
        rank[i] = Number(digits);
      }
      return true;
    }

    let byValue;
    if (numeric) byValue = compareNumbers;
    else if (numberedColumn()) byValue = (a,b) => rank[a]-rank[b];
    else {
      const collate = new Intl.Collator(language,{numeric:true}).compare;
      // Category columns often contain very few distinct values. Collate the
      // vocabulary once, then sort ranks rather than collation keys a million times.
      const vocabulary = new Map(), limit = Math.min(8192, Math.floor(keys.length/8));
      for (const key of keys) {
        vocabulary.set(key,0);
        if (vocabulary.size > limit) break;
      }
      if (vocabulary.size <= limit) {
        const values = [...vocabulary.keys()].sort(collate);
        let valueRank = 0;
        values.forEach((value,i) => {
          if (i && collate(value,values[i-1]) !== 0) valueRank++;
          vocabulary.set(value,valueRank);
        });
        for (let i=0; i<keys.length; i++) rank[i] = vocabulary.get(keys[i]);
        byValue = (a,b) => rank[a]-rank[b];
      } else byValue = (a,b) => collate(keys[a],keys[b]);
    }
    function compare(left,right) {
      const a = left-first, b = right-first;
      if (hasEmpty && (!keys[a] || !keys[b])) return Number(!keys[a])-Number(!keys[b]);
      return factor*byValue(a,b);
    }
    order.sort(compare);
  }

  function transform({kind, column, columns, direction='asc', header=false, language='ru'}) {
    const first = header && rowCount ? 1 : 0;
    const order = new Uint32Array(rowCount-first);
    let kept = 0, changed = false;
    if (kind === 'sort') {
      if (!validColumn(column) || !['asc','desc'].includes(direction)) throw new RangeError('Invalid sort column');
      sortOrder(order,first,column,direction === 'desc',language);
      kept = order.length;
      changed = order.some((row,i) => row !== first+i);
    } else if (kind === 'unique') {
      if (!Array.isArray(columns) || !columns.length || !columns.every(validColumn)) throw new RangeError('Invalid key columns');
      const selected = [...new Set(columns)].sort((a,b) => a-b);
      const seen = new Set();
      for (let row=first; row<rowCount; row++) {
        const key = keyFor(row,selected);
        if (seen.has(key)) continue;
        seen.add(key); order[kept++] = row;
      }
      changed = kept !== order.length;
    } else throw new RangeError('Unknown table operation');
    const total = first + kept, removed = rowCount-total;
    if (!changed) return {text:null,rowCount,removed:0};

    const trailing = endOf(rowCount-1) < size;
    const chunks = [], parts = [text.slice(0, offsets[first])];
    let priorCR = first > 0 && text.charCodeAt(offsets[first]-1) === 13;
    for (let i=0; i<kept; i++) {
      const row = order[i], from = offsets[row], end = endOf(row);
      // Sort retains the sequence of separators at their positions. A filter
      // keeps each survivor's own separator and the original final-EOL policy.
      const position = kind === 'sort' ? i+first : row;
      const ending = i+1 === kept && !trailing ? '' : text.slice(endOf(position),offsets[position+1]);
      // An unquoted empty final record is indistinguishable from a trailing
      // separator. A bare CR and LF can likewise coalesce across an empty row.
      const quoteEmpty = from === end && (!ending || (priorCR && ending === '\n'));
      parts.push(quoteEmpty ? '""' : text.slice(from,end),ending);
      priorCR = ending === '\r';
      if (parts.length >= 8192) { chunks.push(parts.join('')); parts.length = 0; }
    }
    chunks.push(parts.join(''));
    return {text:chunks.join(''),rowCount:total,removed};
  }
  return {rowCount,columnCount,read,cellRange,transform};
}
