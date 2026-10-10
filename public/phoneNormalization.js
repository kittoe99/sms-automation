// One contract for browser input and server entry points. No guessing international prefixes.
export function canonicalPhone(value) {
  const raw=String(value??'').trim();
  if(!raw || !/^[+\d\s().-]+$/.test(raw)) throw new Error('Valid international phone number required');
  let compact=raw.replace(/[\s().-]/g,'');
  if(compact.startsWith('00')) compact='+'+compact.slice(2);
  if(/^\d{10}$/.test(compact)) compact='+1'+compact;
  else if(/^1\d{10}$/.test(compact)) compact='+'+compact;
  if(!/^\+[1-9]\d{7,14}$/.test(compact)) throw new Error('Valid international phone number required');
  return compact;
}
