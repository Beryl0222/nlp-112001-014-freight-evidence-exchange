import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { ExchangeLedger, SUPERVISOR } from '../ledger.js';

const tables = await readMaterials();
const newLedger = (extra = {}) => new ExchangeLedger({
  materials: tables['材料.json'],
  waybills: tables['运单.json'],
  statements: tables['陈述.json'],
  ...extra,
});

test('交换场次：发布、隐去与当时所见快照', () => {
  const ledger = newLedger();
  const s = ledger.openSession('第一轮');
  const e = ledger.offer(s, { materialId: 'e1' });
  assert.equal(e.status, 'released');
  const view = ledger.view(s, '仓方');
  const shown = view.entries.find(x => x.entry === e.id);
  assert.ok(shown.text.includes('未接货'));
  assert.ok(!shown.text.includes('封存联系人'));
  assert.equal(shown.source.root, 'e1');
});

test('仅主管材料不进入双边交换，保留说明也不外发', () => {
  const ledger = newLedger();
  const s = ledger.openSession('一');
  const e = ledger.offer(s, { materialId: 'e3' });
  assert.equal(e.status, 'withheld');
  const partyView = ledger.view(s, '货主');
  assert.ok(!partyView.entries.some(x => x.materialId === 'e3'));
  assert.ok(!partyView.withheld.some(x => x.materialId === 'e3'));
  const sup = ledger.view(s, SUPERVISOR);
  assert.ok(sup.withheld.some(x => x.materialId === 'e3'));
});

test('提供方确认区间的材料先挂起，确认后发布', () => {
  const materials = [...tables['材料.json'], { id: 'e7', party: '货主', language: 'zh', sourceLink: '原函', access: '提供方确认', text: '第三段末端已核。' }];
  const ledger = newLedger({ materials });
  const s = ledger.openSession('一');
  assert.equal(ledger.offer(s, { materialId: 'e7' }).status, 'held');
  assert.equal(ledger.offer(s, { materialId: 'e7', providerConfirmed: true }).status, 'released');
});

test('误导性摘录的回应留在原场次，并触发按完整语义重问', () => {
  const ledger = newLedger();
  const s = ledger.openSession('一');
  const bad = ledger.registerSent(s, { materialId: 'e1', text: '签名确认交给……铁路' });
  assert.ok(bad.misleading);
  ledger.respond(s, { party: '车方', text: '据此认为铁路已接货。', inResponseTo: bad.id });
  const plan = ledger.nextRound(s);
  const reask = plan.find(p => p.action === 're-ask-full-semantics');
  assert.ok(reask);
  assert.ok(reask.fullText.includes('未接货'));
  const view = ledger.view(s, SUPERVISOR);
  assert.ok(view.responses.some(r => r.inResponseTo === bad.id && r.party === '车方'));
});

test('来源争议回查已送出摘录并冻结支撑，当时所见文字不变', () => {
  const ledger = newLedger();
  const s = ledger.openSession('一');
  ledger.offer(s, { materialId: 'e1' });
  const before = ledger.view(s, '仓方').entries[0].text;
  const impact = ledger.dispute('e1', { byParty: '车方', reason: '原函真实性待核' });
  assert.ok(impact.entries.length >= 1);
  assert.ok(ledger.issues.get('仓库交接').flags.includes('需核对出处'));
  const after = ledger.view(s, '仓方').entries[0];
  assert.equal(after.text, before); // 当时见到的文字按快照留存
  assert.ok(after.findings.some(f => f.includes('来源争议')));
  const sup = ledger.view(s, SUPERVISOR);
  assert.ok(sup.pendingVerification.some(i => i.fact === '仓库交接'));
});

test('无法定位的新陈述请提交者补充定位，其他依据继续有效', () => {
  const statements = [...tables['陈述.json'], { id: 's4', submittedBy: '货主', requestedFact: '铁路交接', text: '另有邮件称货已交清。' }];
  const ledger = newLedger({ statements });
  const s4 = ledger.evaluated.find(x => x.id === 's4');
  assert.equal(s4.status, 'awaiting-submitter-location');
  assert.equal(s4.requestTo, '货主');
  // 其他依据仍可继续支持争点
  assert.equal(ledger.evaluated.find(x => x.id === 's1').verdict, 'contradicted');
  const s = ledger.openSession('一');
  const plan = ledger.nextRound(s);
  assert.ok(plan.some(p => p.action === 'await-submitter-location' && p.statement === 's4' && p.to === '货主'));
  assert.ok(plan.some(p => p.action === 'await-submitter-location' && p.statement === 's3' && p.to === '车方'));
});
