// Keep the saved selection attached to its original text while the panel is open.
// Only map a change with a verified edit location: equal neighbouring words make
// a prefix/suffix diff alone ambiguous. An empty scope requires a new selection.
export function trackFindSelection(ranges, before, after, edit) {
  if (!before || !ranges?.length) return ranges;
  if (before.length!==after.length || before.some((row,i)=>row.id!==after[i].id)) return [];
  let remapped=ranges, byId;
  for (let i=0;i<before.length;i++) {
    const old=before[i], text=after[i].text;
    if (old.text===text) continue;
    byId??=new Map(ranges.map(r=>[r.id,r]));
    const range=byId.get(old.id);
    if (!range) continue;
    if (edit?.id!==old.id) return [];
    const delta=text.length-old.text.length;
    let {from,to}=edit;
    if (from===to && delta<0) {
      if (edit.type==='deleteContentBackward') from+=delta;
      else if (edit.type==='deleteContentForward') to-=delta;
    }
    if (from<0 || to>old.text.length || to+delta<from ||
        !text.startsWith(old.text.slice(0,from)) || !text.endsWith(old.text.slice(to))) return [];
    let next;
    if (to<=range.from) next={...range,from:range.from+delta,to:range.to+delta};
    else if (from>=range.to) continue;
    else if (from>=range.from && to<=range.to) next={...range,to:range.to+delta};
    else return [];
    remapped=ranges.map(r=>r===range?next:r);
  }
  return remapped;
}

// Positions are UTF-16 offsets, shared by DOM ranges, textareas and the note model.
export function findNoteMatches(records, options, ranges) {
  const {query, regex, matchCase, wholeWord} = options;
  if (!query) return {matches:[]};
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = regex ? query : literal;
  if (wholeWord) pattern = '(?<![\\p{L}\\p{M}\\p{N}\\p{Pc}])(?:' + pattern + ')(?![\\p{L}\\p{M}\\p{N}\\p{Pc}])';
  let expression;
  try { expression = new RegExp(pattern, matchCase ? 'gmu' : 'gimu'); }
  catch { return {matches:[],error:'syntax'}; }

  const scope = ranges && new Map(ranges.map(r => [r.id,r]));
  const matches = [];
  for (const {id,text,readOnly} of records) {
    const bounds = scope?.get(id);
    if (scope && !bounds) continue;
    // matchAll advances past zero-length matches by a Unicode code point.
    for (const hit of text.matchAll(expression)) {
      const from = hit.index, to = from + hit[0].length;
      if (bounds && (from < bounds.from || to > bounds.to)) continue;
      const match = {id,from,to,value:hit[0]};
      if (readOnly) match.readOnly = true;
      if (hit.length > 1) match.captures = hit.slice(1);
      if (hit.groups) match.groups = hit.groups;
      matches.push(match);
    }
  }
  return {matches};
}

export function replacementText(match, template, options) {
  let text = template;
  if (options.regex) {
    text = template.replace(/\\([nrt\\])|\$(\$|&|\d{1,2}|<[^>]+>)/g, (token, escape, key) => {
      if (escape) return ({n:'\n',r:'\r',t:'\t','\\':'\\'})[escape];
      if (key === '$') return '$';
      if (key === '&' || key === '0') return match.value;
      if (key[0] === '<') return match.groups ? match.groups[key.slice(1,-1)] ?? '' : token;
      const index = Number(key), captures = match.captures || [];
      if (index > 0 && index <= captures.length) return captures[index-1] ?? '';
      const first = Number(key[0]);
      return key.length === 2 && first > 0 && first <= captures.length
        ? (captures[first-1] ?? '') + key[1] : token;
    });
  }
  if (!options.preserveCase || !match.value || !text) return text;
  const source = match.value;
  if (source.toUpperCase() === source.toLowerCase()) return text;
  if (source === source.toUpperCase()) return text.toUpperCase();
  if (source === source.toLowerCase()) return text.toLowerCase();
  const first = String.fromCodePoint(source.codePointAt(0)), rest = source.slice(first.length);
  if (first !== first.toLowerCase() && rest === rest.toLowerCase()) {
    const head = String.fromCodePoint(text.codePointAt(0));
    return head.toUpperCase() + text.slice(head.length).toLowerCase();
  }
  return text;
}
