// src/outcomeMatcher.js — normalize and map AI predicted outcomes to market outcomes

export function matchOutcome(predicted, outcomes) {
  if (!predicted || !outcomes?.length) return null;
  const raw = String(predicted).trim();

  // Normalize side-prefixed AI strings like "YES - ..." or "NO: ...".
  const withoutSidePrefix = raw.replace(/^\s*(yes|no)\s*[-:–—]\s*/i, '').trim();
  const candidates = [raw, withoutSidePrefix].filter(Boolean);

  const normalize = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const candidateNorms = candidates.map(normalize).filter(Boolean);
  const pool = outcomes.map((o) => ({
    o,
    text: String(o.outcome || ''),
    label: String(o.label || ''),
  }));

  for (const c of candidates) {
    const exact = pool.find((p) => p.text === c || p.label === c);
    if (exact) return exact.o;
  }

  for (const c of candidates) {
    const cLower = c.toLowerCase();
    const ci = pool.find((p) => p.text.toLowerCase() === cLower || p.label.toLowerCase() === cLower);
    if (ci) return ci.o;
  }

  const yesAliases = new Set(['yes', 'over', 'above', 'true']);
  const noAliases = new Set(['no', 'under', 'below', 'false']);
  if (candidates.some((c) => yesAliases.has(c.toLowerCase()))) {
    const yes = outcomes.find((o) => yesAliases.has(String(o.outcome || '').toLowerCase()));
    if (yes) return yes;
  }
  if (candidates.some((c) => noAliases.has(c.toLowerCase()))) {
    const no = outcomes.find((o) => noAliases.has(String(o.outcome || '').toLowerCase()));
    if (no) return no;
  }

  for (const cNorm of candidateNorms) {
    const exactNorm = pool.find((p) => normalize(p.text) === cNorm || normalize(p.label) === cNorm);
    if (exactNorm) return exactNorm.o;
  }

  for (const cNorm of candidateNorms) {
    const contain = pool.find((p) => {
      const textNorm = normalize(p.text);
      const labelNorm = normalize(p.label);
      return textNorm.includes(cNorm)
        || cNorm.includes(textNorm)
        || labelNorm.includes(cNorm)
        || cNorm.includes(labelNorm);
    });
    if (contain) return contain.o;
  }

  return null;
}
