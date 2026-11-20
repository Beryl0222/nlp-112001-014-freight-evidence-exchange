import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import {
  analyzeMaterials, evaluateStatements, buildIssues,
  independentRoots, locateText,
} from '../analysis.js';

const tables = await readMaterials();
const analysis = analyzeMaterials(tables['材料.json'], tables['运单.json']);

test('转述链辨认与同源去重', () => {
  const { graph } = analysis;
  assert.equal(graph.get('e2').kind, 'forward');
  assert.equal(graph.get('e2').root, 'e1');
  assert.equal(graph.get('e3').kind, 'quote');
  assert.deepEqual(graph.get('e3').chain, ['e3', 'e2', 'e1']);
  assert.equal(graph.get('e5').kind, 'correction');
  assert.deepEqual(graph.get('e5').corrects, ['e1']);
  // e1、e2、e3 同源，只算一份独立依据，不重复计入交叉印证
  assert.equal(independentRoots(['e1', 'e2', 'e3'], graph).size, 1);
  assert.equal(independentRoots(['e1', 'e4'], graph).size, 2);
});

test('肯定、否定、条件与不确定', () => {
  const e1 = analysis.claims.get('e1');
  assert.ok(e1[0].limiters.some(l => l.word === '仅'));
  assert.ok(e1[1].polarity.negative); // 铁路承运方未接货
  const e2 = analysis.claims.get('e2');
  assert.ok(e2[1].polarity.uncertain); // We interpret …
  const e4 = analysis.claims.get('e4');
  assert.ok(e4[0].polarity.restricted); // only
  assert.ok(e4[1].polarity.conditional); // if this refers to lot X9
});

test('区段定位：继承、货批解析与不可定位', () => {
  const e1 = analysis.claims.get('e1');
  assert.deepEqual(e1[0].resolvedSegments, ['第二段']);
  assert.equal(e1[1].segmentSource, 'inherited'); // “未接货”句继承第二段
  assert.deepEqual(e1[1].resolvedSegments, ['第二段']);
  const e4 = analysis.claims.get('e4');
  assert.ok(e4[0].terminal);
  assert.deepEqual(e4[0].resolvedSegments, []); // “final station” 本身不可定位
  assert.deepEqual(e4[1].resolvedSegments, ['第三段']); // X9 经运单表解析
  const s3 = locateText('请补件说明最后一站邮件说的是 X8 还是 X9。', analysis);
  assert.deepEqual(new Set(s3.resolvedSegments), new Set(['第二段', '第三段']));
  assert.equal(locateText('已收货。', analysis).resolvedSegments.length, 0);
});

test('引文归属到被转述的来源', () => {
  const e3 = analysis.claims.get('e3');
  assert.deepEqual(e3[0].quotations[0].from, ['e2']);
});

test('争点评估：反驳、支撑与待定位', () => {
  const [s1, s2, s3] = evaluateStatements(tables['陈述.json'], analysis);
  // s1 主张铁路接货，但根源 e1 记“未接货”：反驳成立，且同源转述不重复计入
  assert.equal(s1.verdict, 'contradicted');
  assert.equal(s1.independentSources, 1);
  assert.ok(s1.relaysCollapsed >= 1);
  assert.ok(s1.matches.some(m => m.text.includes('未接货')));
  // s2 与 e1 一致：签名仅作库房证据
  assert.equal(s2.verdict, 'supported');
  // s3 是澄清请求，经“最后一站 / final station”关联到 e4，请提供方补件
  assert.equal(s3.type, 'clarification-request');
  assert.equal(s3.status, 'pending-location');
  assert.ok(s3.related.includes('e4'));
  assert.equal(s3.requestTo, '车方');
});

test('争点汇总', () => {
  const issues = buildIssues(evaluateStatements(tables['陈述.json'], analysis));
  assert.ok(issues.get('铁路交接').flags.includes('来源反驳'));
  assert.ok(issues.get('仓库交接').flags.includes('来源支撑'));
  assert.ok(issues.get('货批身份').flags.includes('待补充定位'));
  assert.equal(issues.get('铁路交接').independentRoots.length, 1);
});

test('来源争议改变支撑与反驳是否成立', () => {
  // 根源 e1 被争议：s1 的反驳与 s2 的支撑都暂不成立
  const rootDisputed = evaluateStatements(tables['陈述.json'], analysis, new Set(['e1']));
  assert.equal(rootDisputed[0].effective, false);
  assert.equal(rootDisputed[1].effective, false);
  const issues = buildIssues(rootDisputed);
  assert.ok(issues.get('仓库交接').flags.includes('需核对出处'));
  // 仅转述环节 e2 被争议：根源结论不变，但标记转述链待回查
  const relayDisputed = evaluateStatements(tables['陈述.json'], analysis, new Set(['e2']));
  assert.equal(relayDisputed[0].effective, true);
  assert.equal(relayDisputed[0].chainDisputed, true);
  assert.ok(buildIssues(relayDisputed).get('铁路交接').flags.includes('转述链有争议'));
});
