// Keep this function self-contained so a WebView can run it in a blob worker
// when its application URL scheme does not support module workers.
export function transformRows(text, operation, language = 'ru') {
  const firstBreak = /\r\n|[\r\n]/.exec(text);
  const eol = firstBreak?.[0] || '\n';
  const trailing = text.endsWith('\n') || text.endsWith('\r');
  const mixed = eol === '\n' ? text.includes('\r') :
    eol === '\r' ? text.includes('\n') : /\r(?!\n)|(?:^|[^\r])\n/.test(text);
  const breaks = /\r\n|[\r\n]/g;
  const endings = mixed ? text.match(breaks) : null;
  const rows = text.split(mixed ? breaks : eol);
  // A final terminator belongs to the preceding record. Interior empty rows
  // are records in their own right, including the first line of "\nexample".
  if (trailing) rows.pop();

  function sortNumberedRows(descending) {
    // For a long column of integers (or IDs like "item-123") natural sort
    // reduces to a numeric comparison. Parse each key once. Fifteen decimal
    // digits fit exactly in a Number, including when they have leading zeros.
    if (rows.length < 8192) return false;
    const suffix = /(?:^|\P{Nd})([0-9]{1,15})$/u.exec(rows[0]);
    if (!suffix) return false;
    const prefix = rows[0].slice(0,-suffix[1].length);
    const values = new Float64Array(rows.length);
    for (let i=0; i<rows.length; i++) {
      const text = rows[i].slice(prefix.length);
      if (!rows[i].startsWith(prefix) || !/^[0-9]{1,15}$/.test(text)) return false;
      values[i] = Number(text);
    }
    const order = new Uint32Array(rows.length);
    for (let i=0; i<order.length; i++) order[i]=i;
    order.sort(descending ? (a,b)=>values[b]-values[a] : (a,b)=>values[a]-values[b]);
    const input = rows.slice();
    for (let i=0; i<order.length; i++) rows[i]=input[order[i]];
    return true;
  }

  switch (operation) {
    case 'sort-asc':
    case 'sort-desc': {
      if (sortNumberedRows(operation==='sort-desc')) break;
      const compare = new Intl.Collator(language, {numeric:true}).compare;
      rows.sort(operation === 'sort-asc' ? compare : (a,b) => compare(b,a));
      break;
    }
    case 'unique':
    case 'remove-empty': {
      const seen = operation === 'unique' ? new Set() : null;
      let kept = 0;
      for (let i=0; i<rows.length; i++) {
        const row = rows[i];
        if (seen) {
          if (seen.has(row)) continue;
          seen.add(row);
        } else if (!/\S/.test(row)) continue;
        rows[kept] = row;
        if (endings) endings[kept] = endings[i];
        kept++;
      }
      rows.length = kept;
      break;
    }
    case 'trim':
      for (let i=0; i<rows.length; i++) rows[i] = rows[i].trim();
      break;
    default:
      throw new RangeError('Unknown line operation');
  }

  if (!rows.length) return '';
  if (!endings) return rows.join(eol) + (trailing ? eol : '');
  // On a mixed-EOL file, sorting changes the values at each row. Filtering
  // retains each surviving row's own separator and the original final-EOL state.
  const terminated = trailing ? rows.length : rows.length-1;
  for (let i=0; i<terminated; i++) {
    const separator = endings[i];
    // Trimming, sorting or filtering can bring standalone CR and LF together
    // around an empty record. They must still decode as two separators.
    rows[i] += !rows[i] && separator === '\n' && endings[i-1] === '\r' ? '\r\n' : separator;
  }
  return rows.join('');
}

export function serveLineTransforms(transform) {
  self.onmessage = ({data}) => {
    try {
      self.postMessage({result:transform(data.text, data.operation, data.language)});
    } catch (error) {
      self.postMessage({error:String(error.message || error)});
    }
  };
  self.postMessage({ready:true});
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) serveLineTransforms(transformRows);
