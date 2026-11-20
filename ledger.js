// ledger.js — 材料交换登记：场次、可见范围、回应留存、来源争议回查、下一轮安排。
// 主管可见全部材料；各方只见获准范围。每方当时见到的文字按场次留存快照。

import { pathToFileURL } from 'node:url';
import { readMaterials } from './materials.js';
import { analyzeMaterials, evaluateStatements, buildIssues } from './analysis.js';
import { planExcerpt, auditExcerpt } from './excerpts.js';

export const SUPERVISOR = '主管';

// 交换范围由双方约定：共享摘录可直接双边查看；提供方确认须先确认区间；仅主管不进入双边交换。
export const ACCESS_POLICY = {
  '共享摘录': { bilateral: true, needsProviderConfirm: false },
  '提供方确认': { bilateral: true, needsProviderConfirm: true },
  '仅主管': { bilateral: false, needsProviderConfirm: false },
};

export class ExchangeLedger {
  constructor({ materials, waybills, statements }) {
    this.materials = materials;
    this.waybills = waybills;
    this.statements = statements;
    this.analysis = analyzeMaterials(materials, waybills);
    this.parties = [...new Set([...materials.map(m => m.party), ...statements.map(s => s.submittedBy)])];
    this.disputed = new Map();
    this.sessions = new Map();
    this._seq = 0;
    this._reevaluate();
  }

  _reevaluate() {
    this.evaluated = evaluateStatements(this.statements, this.analysis, new Set(this.disputed.keys()));
    this.issues = buildIssues(this.evaluated);
  }

  _material(id) {
    const m = this.materials.find(x => x.id === id);
    if (!m) throw new Error(`未知材料 ${id}`);
    return m;
  }

  _session(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知场次 ${id}`);
    return s;
  }

  _recipients(to) {
    return to === '双方' ? this.parties : [to];
  }

  openSession(title) {
    const id = `S${this.sessions.size + 1}`;
    this.sessions.set(id, { id, title, entries: [], responses: [] });
    return id;
  }

  // 提供一份摘录：按访问级别与提供方确认情况决定发布、挂起或保留。
  offer(sessionId, { materialId, span, to = '双方', providerConfirmed = false }) {
    const s = this._session(sessionId);
    const m = this._material(materialId);
    const g = this.analysis.graph.get(materialId);
    const policy = ACCESS_POLICY[m.access] ?? { bilateral: false, needsProviderConfirm: false, unknown: true };
    const entry = { id: `${sessionId}#${++this._seq}`, materialId, to, chain: g.chain, root: g.root, findings: [], status: 'released' };
    if (!policy.bilateral) {
      entry.status = 'withheld';
      entry.reason = policy.unknown ? `访问级别“${m.access}”未在约定范围` : `访问级别“${m.access}”不对双方开放`;
      entry.missingFacts = [`仍缺事实：${materialId}（${m.access}）未纳入双边交换`];
      entry.bilateralNote = false;
    } else if (policy.needsProviderConfirm && !providerConfirmed) {
      entry.status = 'held';
      entry.reason = '等待提供方确认区间';
      entry.missingFacts = [`仍缺事实：${materialId} 待提供方确认区间`];
      entry.bilateralNote = true;
    } else {
      const plan = planExcerpt(m, span);
      if (!plan.ok) {
        entry.status = 'withheld';
        entry.reason = plan.reason;
        entry.droppedLimiters = plan.droppedLimiters;
        entry.missingFacts = plan.missingFacts;
        entry.bilateralNote = true;
      } else {
        entry.excerpt = plan.text;
        entry.keptLimiters = plan.keptLimiters;
        entry.coveredSpan = plan.coveredSpan;
        entry.shown = Object.fromEntries(this._recipients(to).map(p => [p, plan.text]));
      }
    }
    s.entries.push(entry);
    return entry;
  }

  // 登记一份已在场外送出的摘录：原样留存并立即审计是否丢失限制词。
  registerSent(sessionId, { materialId, text, to = '双方' }) {
    const s = this._session(sessionId);
    this._material(materialId);
    const g = this.analysis.graph.get(materialId);
    const audit = auditExcerpt(text, this.materials, { prefer: materialId });
    const entry = {
      id: `${sessionId}#${++this._seq}`, materialId, to, chain: g.chain, root: g.root,
      findings: [], status: 'released', external: true, excerpt: text,
      shown: Object.fromEntries(this._recipients(to).map(p => [p, text])),
      audit: {
        misleading: audit.misleading,
        droppedLimiters: audit.droppedLimiters,
        sources: audit.considered.map(h => ({ materialId: h.materialId, sentence: h.sentence.text.trim() })),
      },
    };
    entry.misleading = audit.misleading;
    if (audit.misleading) entry.findings.push(`摘录未保留限制词：${audit.droppedLimiters.join('、')}`);
    s.entries.push(entry);
    return entry;
  }

  // 回应留在原交换场次，不随摘录问题迁走。
  respond(sessionId, { party, text, inResponseTo }) {
    const s = this._session(sessionId);
    const r = { party, text, inResponseTo, seq: s.responses.length + 1 };
    s.responses.push(r);
    return r;
  }

  // 来源争议：重估支撑/反驳是否成立，并回查已送出摘录是否造成误解。
  dispute(materialId, { byParty, reason }) {
    this._material(materialId);
    this.disputed.set(materialId, { byParty, reason });
    this._reevaluate();
    const entries = [];
    for (const s of this.sessions.values()) {
      for (const e of s.entries) {
        if (e.status === 'released' && e.chain.includes(materialId)) {
          e.findings.push(`来源争议（${byParty}：${reason}），内容待核`);
          if (e.misleading) e.needsReask = true;
          entries.push(e);
        }
      }
    }
    const statements = this.evaluated.filter(st => st.chains.includes(materialId));
    return { statements, entries, issues: this.issues };
  }

  // 下一轮安排：误导性摘录按完整语义重问；缺事实、待确认、待定位逐项列出。
  nextRound(sessionId) {
    const s = this._session(sessionId);
    const plan = [];
    for (const e of s.entries) {
      const responded = s.responses.some(r => r.inResponseTo === e.id);
      if (e.status === 'released' && (e.misleading || e.needsReask) && responded) {
        plan.push({ action: 're-ask-full-semantics', entry: e.id, fullText: this._fullText(e), note: '回应保留在原场次，下一轮按完整语义重新发问' });
      }
      if (e.status === 'withheld') plan.push({ action: 'collect-missing-fact', entry: e.id, missingFacts: e.missingFacts });
      if (e.status === 'held') plan.push({ action: 'await-provider-confirmation', entry: e.id });
    }
    for (const st of this.evaluated) {
      if (st.status === 'awaiting-submitter-location' || st.status === 'pending-location') {
        plan.push({ action: 'await-submitter-location', statement: st.id, to: st.requestTo, fact: st.requestedFact });
      }
    }
    return plan;
  }

  _fullText(entry) {
    const m = this._material(entry.materialId);
    let span = entry.coveredSpan;
    if (!span) {
      const audit = auditExcerpt(entry.excerpt, this.materials, { prefer: entry.materialId });
      const hits = audit.considered.filter(h => h.materialId === entry.materialId);
      if (!hits.length) return '(无法回溯原文)';
      span = { start: Math.min(...hits.map(h => h.sentence.start)), end: Math.max(...hits.map(h => h.sentence.end)) };
    }
    const plan = planExcerpt(m, span);
    return plan.ok ? plan.text : `（完整语义受隐去限制：${plan.missingFacts.join('；')}）`;
  }

  // 按场次查询：每方当时见到的文字、所依据的来源、仍需核对出处的争点。
  view(sessionId, viewer) {
    const s = this._session(sessionId);
    const sup = viewer === SUPERVISOR;
    const entries = [];
    const withheld = [];
    for (const e of s.entries) {
      const m = this._material(e.materialId);
      const policy = ACCESS_POLICY[m.access] ?? { bilateral: false };
      const visible = e.status === 'released' && (sup || (policy.bilateral && (e.to === '双方' || e.to === viewer)));
      if (visible) {
        entries.push({
          entry: e.id, materialId: e.materialId,
          text: sup ? e.excerpt : e.shown?.[viewer],
          source: { root: e.root, chain: e.chain },
          findings: e.findings,
        });
      } else if (e.status !== 'released') {
        if (sup) withheld.push({ entry: e.id, materialId: e.materialId, status: e.status, reason: e.reason, missingFacts: e.missingFacts ?? [] });
        else if (e.bilateralNote) withheld.push({ entry: e.id, materialId: e.materialId, status: e.status, missingFacts: e.missingFacts });
      }
    }
    const visibleEntryIds = new Set(entries.map(x => x.entry));
    const responses = s.responses.filter(r => sup || visibleEntryIds.has(r.inResponseTo));
    const pendingVerification = [...this.issues.values()]
      .filter(i => i.flags.some(f => f !== '来源支撑' && f !== '来源反驳'))
      .map(i => ({ fact: i.fact, flags: i.flags, openRequests: i.openRequests }));
    return { session: sessionId, viewer, entries, withheld, responses, pendingVerification };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tables = await readMaterials();
  const ledger = new ExchangeLedger({ materials: tables['材料.json'], waybills: tables['运单.json'], statements: tables['陈述.json'] });
  const show = (label, value) => {
    process.stdout.write(`\n== ${label} ==\n`);
    process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
  };

  show('争点整理（交换前）', [...ledger.issues.values()]);

  const s1 = ledger.openSession('第一轮材料交换');
  ledger.offer(s1, { materialId: 'e1' });
  const truncated = ledger.registerSent(s1, { materialId: 'e1', text: '签名确认交给……铁路' });
  ledger.respond(s1, { party: '车方', text: '按摘录理解，铁路段已接货，请货主确认。', inResponseTo: truncated.id });
  ledger.offer(s1, { materialId: 'e3' });
  ledger.offer(s1, { materialId: 'e4' });
  ledger.offer(s1, { materialId: 'e6' });
  show(`场次 ${s1} 交换单（主管视角）`, ledger.view(s1, SUPERVISOR));
  show(`场次 ${s1} 交换单（仓方视角）`, ledger.view(s1, '仓方'));

  const impact = ledger.dispute('e1', { byParty: '车方', reason: '原函真实性待核' });
  show('来源争议影响（e1）', {
    statements: impact.statements.map(x => ({ id: x.id, verdict: x.verdict, effective: x.effective })),
    entries: impact.entries.map(e => e.id),
  });
  show('下一轮安排', ledger.nextRound(s1));
  show('争点整理（争议后）', [...ledger.issues.values()]);
}
