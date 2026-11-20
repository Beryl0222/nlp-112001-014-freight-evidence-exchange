// excerpts.js — 可交换摘录的生成与审计。
// 原则：限制词（仅、未、如果……）不能保留时，宁可不提供摘录，并在交换单写明仍缺什么事实。

import { splitClauses, analyzeClause } from './analysis.js';

// 不向对方公开的内容：联系人、商业条款、密封备注。隐去后以〈已隐去〉占位。
const REDACTION_DEFS = [
  { kind: '联系人', re: /封存联系人后附说明|联系人[：:][^。，,；;]*|联系人|\bcontact\b[^。.,;]*|\bphone\b[^。.,;]*/gi },
  { kind: '商业条款', re: /[^。，,；;]*报价[^。，,；;]*|[^。，,；;]*价格[^。，,；;]*|\b[^.]*\b(?:price|pricing|quote|commercial)\b[^.]*\b/gi },
  { kind: '密封备注', re: /密封备注|\bsealed\b[^.]*\b/gi },
];

export function findRedactions(text) {
  const all = [];
  for (const { kind, re } of REDACTION_DEFS) {
    for (const m of text.matchAll(re)) {
      if (m[0].length) all.push({ kind, start: m.index, end: m.index + m[0].length });
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const r of all) {
    if (!kept.some(k => k.start < r.end && r.start < k.end)) kept.push(r);
  }
  return kept;
}

export function applyRedactions(text, redactions = findRedactions(text)) {
  let out = '';
  let pos = 0;
  for (const r of redactions) {
    out += text.slice(pos, r.start) + '〈已隐去〉';
    pos = r.end;
  }
  return out + text.slice(pos);
}

// 生成摘录：区间按记录编号内文本范围给出。任何被引用子句的限制词
// 若落在区间外或隐去区内，则拒绝提供，并列出仍缺事实（已脱敏）。
export function planExcerpt(material, span = {}) {
  const text = material.text;
  const start = span.start ?? 0;
  const end = span.end ?? text.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
    throw new RangeError(`摘录区间无效：${material.id} [${start}, ${end})`);
  }
  const clauses = splitClauses(text).map(c => analyzeClause(c.text, c.start));
  const covered = clauses.filter(c => c.end > start && c.start < end);
  const redactions = findRedactions(text)
    .filter(r => r.end > start && r.start < end)
    .map(r => ({ ...r, start: Math.max(r.start, start), end: Math.min(r.end, end) }));
  const overlapsRedaction = l => redactions.some(r => r.start < l.end && l.start < r.end);
  const failures = [];
  for (const c of covered) {
    for (const l of c.limiters) {
      if (l.start < start || l.end > end || overlapsRedaction(l)) failures.push({ clause: c, limiter: l });
    }
  }
  if (failures.length) {
    const words = [...new Set(failures.map(f => f.limiter.word))];
    const missingFacts = [...new Set(failures.map((f) => {
      const redacted = applyRedactions(f.clause.text).trim();
      const readable = redacted.replace(/〈已隐去〉/g, '').replace(/[。，,；;\s.]/g, '');
      return readable.length >= 4
        ? `仍缺事实：${redacted}`
        : `仍缺事实：${material.id} 中一处的陈述因限制词（${words.join('、')}）无法保留而未提供`;
    }))];
    return { ok: false, reason: '限制词不能保留，按规定不提供摘录', droppedLimiters: words, missingFacts };
  }
  let out = '';
  let pos = start;
  for (const r of redactions) {
    out += text.slice(pos, r.start) + '〈已隐去〉';
    pos = r.end;
  }
  out += text.slice(pos, end);
  if (covered.length && start > covered[0].start) out = '……' + out;
  if (covered.length && end < covered[covered.length - 1].end) out += '……';
  return {
    ok: true,
    text: out.trim(),
    keptLimiters: covered.flatMap(c => c.limiters.filter(l => l.start >= start && l.end <= end && !overlapsRedaction(l))).map(l => ({ kind: l.kind, word: l.word })),
    redactions: [...new Set(redactions.map(r => r.kind))],
    coveredSpan: covered.length ? { start: covered[0].start, end: covered[covered.length - 1].end } : null,
  };
}

function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

function containsToken(text, word) {
  if (/^[\x20-\x7E]+$/.test(word)) {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  }
  return text.includes(word);
}

// 审计已送出的摘录：按省略号拆成片段，逐片找回出自哪份材料的哪个子句
// （引用可能只复用原句几个字），再核对该子句的限制词是否都保留。
export function auditExcerpt(excerptText, materials, { prefer } = {}) {
  const fragments = excerptText.split(/…+|\.{3,}/).map(s => s.trim()).filter(s => s.length >= 2);
  const hits = [];
  for (const m of materials) {
    for (const c of splitClauses(m.text)) {
      const clause = analyzeClause(c.text, c.start);
      const matched = fragments.filter(f => lcsLength(f, c.text) >= Math.max(2, Math.ceil(0.5 * f.length)));
      if (!matched.length) continue;
      hits.push({
        materialId: m.id,
        sentence: clause,
        matchedFragments: matched,
        droppedLimiters: clause.limiters.filter(l => !containsToken(excerptText, l.word)),
      });
    }
  }
  const primary = prefer ? hits.filter(h => h.materialId === prefer) : [];
  const considered = primary.length ? primary : hits;
  return {
    fragments,
    hits,
    considered,
    misleading: considered.some(h => h.droppedLimiters.length),
    droppedLimiters: [...new Set(considered.flatMap(h => h.droppedLimiters.map(l => l.word)))],
  };
}
