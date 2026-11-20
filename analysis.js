// analysis.js — 陈述人/转述人辨认、极性与限制词、运单区段定位、争点整理。
// 工具只整理出处与结构，不代替调解组的正式判断。

export const SEGMENT_RE = /第[一二三四五六七八九十百零]+段/g;
export const LOT_RE = /\b[A-Z]{1,2}\d{1,4}\b/g;
// 按标点切分语义块（子句）：限制词与归属都以子句为最小单位判断。
export const CLAUSE_RE = /[^。！？!?；;，,.]+[。！？!?；;，,.]*/g;

// “最后一站 / final station”一类说法本身不能定位到运单区段。
export const TERMINAL_PHRASES = ['最后一站', '末站', 'final station', 'last station'];

// 中英对照的语义组，用于把争点与来源子句对上；主体组用于防止张冠李戴。
export const TERM_GROUPS = [
  { key: '铁路', terms: ['铁路', 'rail'] },
  { key: '库房', terms: ['库房', '仓库', 'warehouse'] },
  { key: '签名', terms: ['签名', '签字', 'signature'] },
  { key: '交接', terms: ['接货', '交割', '交接', '收货', 'custody', 'received'] },
  { key: '车站', terms: TERMINAL_PHRASES },
  { key: '货批', terms: ['货批', '批次', 'lot'] },
];
export const SUBJECT_GROUPS = new Set(['铁路', '库房', '车站', '货批']);

// 限制词：摘录若不能保留这些词，宁可不提供。
const LIMITER_DEFS = [
  { kind: '否定', zh: ['尚未', '没有', '未', '无', '不', '非'], en: ['not', 'no', 'never', 'neither', 'nor', 'without'] },
  { kind: '限制', zh: ['仅限于', '仅', '只'], en: ['only', 'solely', 'merely'] },
  { kind: '条件', zh: ['如果', '倘若', '除非', '若'], en: ['if', 'unless', 'provided', 'assuming'] },
  { kind: '不确定', zh: ['尚不确定', '可能', '或许', '似乎', '据说', '待核'], en: ['maybe', 'perhaps', 'seems', 'interpreted', 'interpret', 'unclear', 'uncertain', 'might'] },
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LIMITER_RES = LIMITER_DEFS.map(({ kind, zh, en }) => {
  const zhPart = zh.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const enPart = en.map(escapeRe).join('|');
  return { kind, re: new RegExp(`${zhPart}|\\b(?:${enPart})\\b`, 'gi') };
});

export function findLimiters(text) {
  const all = [];
  for (const { kind, re } of LIMITER_RES) {
    for (const m of text.matchAll(re)) {
      all.push({ kind, word: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  return all.filter((l, i) => !all.some((o, j) => j < i && o.start <= l.start && o.end >= l.end));
}

export function splitClauses(text) {
  const out = [];
  for (const m of text.matchAll(CLAUSE_RE)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function analyzeClause(text, start = 0) {
  const limiters = findLimiters(text).map(l => ({ ...l, start: l.start + start, end: l.end + start }));
  const kinds = new Set(limiters.map(l => l.kind));
  const lower = text.toLowerCase();
  return {
    text, start, end: start + text.length, limiters,
    polarity: {
      negative: kinds.has('否定'),
      restricted: kinds.has('限制'),
      conditional: kinds.has('条件'),
      uncertain: kinds.has('不确定'),
    },
    groups: TERM_GROUPS.filter(g => g.terms.some(t => lower.includes(t.toLowerCase()))).map(g => g.key),
    lots: [...text.matchAll(LOT_RE)].map(m => m[0]),
    segments: [...text.matchAll(SEGMENT_RE)].map(m => m[0]),
    terminal: TERMINAL_PHRASES.some(t => lower.includes(t)),
  };
}

// 文本自身提到的区段；货批号经运单表解析，终点站类说法保持不可定位。
export function locateText(text, analysis) {
  const lots = [...text.matchAll(LOT_RE)].map(m => m[0]);
  const segments = [...text.matchAll(SEGMENT_RE)].map(m => m[0]);
  const resolved = new Set(segments);
  for (const lot of lots) {
    const w = analysis.lotIndex.get(lot);
    if (w) resolved.add(w.segment);
  }
  return { lots, segments, resolvedSegments: [...resolved], terminal: TERMINAL_PHRASES.some(t => text.toLowerCase().includes(t)) };
}

function findQuotations(clause, material, materials) {
  const out = [];
  for (const q of clause.text.matchAll(/[“"「]([^”"」]+)[”"」]/g)) {
    const quoted = q[1];
    const from = materials.filter(x => x.id !== material.id && x.text.includes(quoted)).map(x => x.id);
    out.push({ text: quoted, from });
  }
  return out;
}

// 来源链：转发/引用构成转述边，纠正另记；转述链的根才是独立来源。
export function analyzeMaterials(materials, waybills) {
  const lotIndex = new Map(waybills.map(w => [w.lot, w]));
  const graph = new Map();
  for (const m of materials) {
    const link = m.sourceLink;
    let kind = 'original';
    let relays = [];
    const mm = link.match(/^(转发|引用|转引)\s*(\S+)$/);
    if (mm) { kind = mm[1] === '引用' ? 'quote' : 'forward'; relays = [mm[2]]; }
    else if (link.includes('纠正')) kind = 'correction';
    else if (link.includes('附件')) kind = 'attachment';
    graph.set(m.id, { id: m.id, party: m.party, access: m.access, kind, relays, corrects: [], root: m.id, chain: [m.id] });
  }
  for (const m of materials) {
    const g = graph.get(m.id);
    if (g.kind === 'correction') {
      const prior = materials.filter(x => x.party === m.party && graph.get(x.id).kind === 'original' && materials.indexOf(x) < materials.indexOf(m));
      if (prior.length) g.corrects = [prior[prior.length - 1].id];
    }
  }
  for (const m of materials) {
    const g = graph.get(m.id);
    const chain = [m.id];
    const seen = new Set(chain);
    while (true) {
      const last = graph.get(chain[chain.length - 1]);
      const next = last && last.relays[0];
      if (!next || !graph.has(next) || seen.has(next)) break;
      chain.push(next);
      seen.add(next);
    }
    g.chain = chain;
    g.root = chain[chain.length - 1];
  }
  const claims = new Map();
  for (const m of materials) {
    const clauses = splitClauses(m.text).map(c => analyzeClause(c.text, c.start));
    let inherited = [];
    for (const c of clauses) {
      const fromLots = c.lots.filter(l => lotIndex.has(l)).map(l => lotIndex.get(l).segment);
      c.resolvedSegments = [...new Set([...c.segments, ...fromLots])];
      if (c.resolvedSegments.length) { c.segmentSource = 'explicit'; inherited = c.resolvedSegments; }
      else if (inherited.length) { c.resolvedSegments = inherited; c.segmentSource = 'inherited'; }
      else { c.segmentSource = c.terminal ? 'ambiguous' : 'none'; }
      c.quotations = findQuotations(c, m, materials);
    }
    claims.set(m.id, clauses);
  }
  return { graph, claims, lotIndex, waybills, materials };
}

// 同一来源的多份转述只算一份独立依据，不重复计入交叉印证。
export function independentRoots(materialIds, graph) {
  const roots = new Map();
  for (const id of materialIds) {
    const g = graph.get(id);
    if (!g) continue;
    if (!roots.has(g.root)) roots.set(g.root, []);
    roots.get(g.root).push(id);
  }
  return roots;
}

function segmentsCompatible(a, b) {
  if (!a.length || !b.length) return true;
  return a.some(s => b.includes(s));
}

// 内容提示关联（仅用于澄清请求找对象，不作为主张的支撑依据）。
function hintLinks(text, analysis, exclude) {
  const clause = analyzeClause(text);
  const subj = new Set(clause.groups.filter(g => SUBJECT_GROUPS.has(g)));
  const lots = new Set(clause.lots);
  const out = [];
  for (const m of analysis.materials) {
    if (exclude.has(m.id)) continue;
    const cs = analysis.claims.get(m.id);
    const mSubj = new Set(cs.flatMap(c => c.groups.filter(g => SUBJECT_GROUPS.has(g))));
    const mLots = new Set(cs.flatMap(c => c.lots));
    if ([...subj].some(x => mSubj.has(x)) || [...lots].some(x => mLots.has(x))) out.push(m.id);
  }
  return out;
}

const REQUEST_RE = /请|恳请|烦请|澄清|补件/;

// 评估每条陈述：肯定/否定/条件/不确定、来源链、区段相容，得出支撑或反驳是否成立。
export function evaluateStatements(statements, analysis, disputed = new Set()) {
  const { graph, claims } = analysis;
  return statements.map(st => {
    const clauses = splitClauses(st.text).map(c => analyzeClause(c.text, c.start));
    const ownLoc = locateText(st.text, analysis);
    const cites = [...new Set([...st.text.matchAll(/[eE]\d+/g)].map(m => m[0]).filter(id => graph.has(id)))];
    const isRequest = REQUEST_RE.test(st.text);
    const related = isRequest
      ? [...new Set([...cites, ...hintLinks(st.text, analysis, new Set(cites))])]
      : cites;
    const chains = [...new Set(related.flatMap(id => graph.get(id).chain))];
    const roots = [...new Set(related.map(id => graph.get(id).root))];
    const factGroups = TERM_GROUPS.filter(g => g.terms.some(t => st.requestedFact.toLowerCase().includes(t.toLowerCase()))).map(g => g.key);
    const textGroups = [...new Set(clauses.flatMap(c => c.groups))];
    const relevantSubjects = new Set([...factGroups, ...textGroups].filter(g => SUBJECT_GROUPS.has(g)));
    const segs = new Set(ownLoc.resolvedSegments);
    for (const id of cites) for (const c of claims.get(id)) for (const sg of c.resolvedSegments) segs.add(sg);
    const base = {
      ...st, related, roots, chains, segments: [...segs], lots: ownLoc.lots,
      independentSources: roots.length,
      relaysCollapsed: Math.max(0, chains.length - roots.length),
    };
    if (isRequest) {
      return { ...base, type: 'clarification-request', status: 'pending-location', requestTo: related.length ? graph.get(related[0]).party : st.submittedBy };
    }
    const matches = [];
    for (const rootId of roots) {
      for (const c of claims.get(rootId)) {
        const shared = c.groups.filter(g => factGroups.includes(g) || textGroups.includes(g));
        if (!shared.length) continue;
        const cSubj = c.groups.filter(g => SUBJECT_GROUPS.has(g));
        if (cSubj.length && relevantSubjects.size && !cSubj.every(s => relevantSubjects.has(s))) continue;
        if (!segmentsCompatible(base.segments, c.resolvedSegments)) continue;
        matches.push({ root: rootId, text: c.text.trim(), shared, polarity: c.polarity, segments: c.resolvedSegments, segmentSource: c.segmentSource });
      }
    }
    let verdict, status;
    if (matches.some(m => m.polarity.negative)) { verdict = 'contradicted'; status = '来源反驳'; }
    else if (matches.some(m => !m.polarity.conditional && !m.polarity.uncertain)) { verdict = 'supported'; status = '来源支撑'; }
    else if (matches.length) { verdict = 'uncertain-source'; status = '需核对出处'; }
    else { verdict = 'no-source-content'; status = base.segments.length ? '需核对出处' : 'awaiting-submitter-location'; }
    const rootDisputed = roots.some(r => disputed.has(r));
    const chainDisputed = chains.some(id => disputed.has(id));
    const effective = !rootDisputed;
    if (!effective) status = '需核对出处';
    return {
      ...base, type: 'assertion', verdict, status, effective, chainDisputed, matches,
      requestTo: status === 'awaiting-submitter-location' ? st.submittedBy : undefined,
    };
  });
}

// 按争点汇总：独立来源数、未决澄清、支撑/反驳/待核标记。
export function buildIssues(evaluated) {
  const issues = new Map();
  for (const st of evaluated) {
    let is = issues.get(st.requestedFact);
    if (!is) {
      is = { fact: st.requestedFact, statements: [], independentRoots: new Set(), openRequests: [], flags: new Set() };
      issues.set(st.requestedFact, is);
    }
    is.statements.push({
      id: st.id, submittedBy: st.submittedBy, type: st.type,
      verdict: st.verdict, status: st.status, effective: st.effective,
      independentSources: st.independentSources,
    });
    for (const r of st.roots) is.independentRoots.add(r);
    if (st.type === 'clarification-request') {
      is.openRequests.push({ to: st.requestTo, statement: st.id });
      is.flags.add('待补充定位');
    }
    if (st.type === 'assertion') {
      if (st.status === 'awaiting-submitter-location') {
        is.openRequests.push({ to: st.requestTo, statement: st.id });
        is.flags.add('待补充定位');
      } else if (!st.effective) is.flags.add('需核对出处');
      else if (st.verdict === 'contradicted') is.flags.add('来源反驳');
      else if (st.verdict === 'supported') is.flags.add('来源支撑');
      else is.flags.add('需核对出处');
      if (st.chainDisputed) is.flags.add('转述链有争议');
    }
  }
  for (const is of issues.values()) {
    is.independentRoots = [...is.independentRoots];
    is.flags = [...is.flags];
  }
  return issues;
}
