import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { planExcerpt, auditExcerpt } from '../excerpts.js';

const materials = (await readMaterials())['材料.json'];
const byId = Object.fromEntries(materials.map(m => [m.id, m]));

test('完整摘录保留限制词并隐去联系人', () => {
  const plan = planExcerpt(byId.e1);
  assert.ok(plan.ok);
  assert.ok(plan.text.includes('仅确认'));
  assert.ok(plan.text.includes('未接货'));
  assert.ok(!plan.text.includes('封存联系人'));
  assert.ok(plan.text.includes('〈已隐去〉'));
  assert.deepEqual(plan.redactions, ['联系人']);
});

test('截去否定词的区间被拒绝，并说明仍缺什么事实', () => {
  const text = byId.e1.text;
  const start = text.indexOf('铁路承运方');
  const plan = planExcerpt(byId.e1, { start, end: start + 5 }); // 只取“铁路承运方”
  assert.equal(plan.ok, false);
  assert.ok(plan.droppedLimiters.includes('未'));
  assert.ok(plan.missingFacts.some(f => f.includes('未接货')));
});

test('限制词落在隐去区内时宁可不提供', () => {
  // e6：报价属商业条款须隐去，但“不可分公开”的否定词同处一句
  const plan = planExcerpt(byId.e6);
  assert.equal(plan.ok, false);
  assert.ok(plan.missingFacts.length >= 1);
  assert.ok(!plan.missingFacts.join('').includes('报价'));
  // e3：内部报价不供交换，否定词同样在隐去区内
  assert.equal(planExcerpt(byId.e3).ok, false);
});

test('误导性摘录审计：找回出处并指出丢失的限制词', () => {
  const audit = auditExcerpt('签名确认交给……铁路', materials, { prefer: 'e1' });
  assert.ok(audit.misleading);
  assert.deepEqual(new Set(audit.droppedLimiters), new Set(['仅', '未']));
});

test('完整语义的摘录通过审计', () => {
  const audit = auditExcerpt('第二段签名仅确认货交库房，铁路承运方未接货。', materials, { prefer: 'e1' });
  assert.equal(audit.misleading, false);
});

test('只复用原句几个字的引用也能找回出处', () => {
  const audit = auditExcerpt('confirmed a signature', materials);
  assert.ok(audit.hits.some(h => h.materialId === 'e2'));
});
