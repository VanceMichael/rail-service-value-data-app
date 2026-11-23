import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMaterials } from '../tools/check-materials.mjs';
import { createModel, describeLot, lotUsesSegment } from '../src/model.mjs';
import {
  allocateOption,
  compareOptions,
  conflictsOf,
  demandRanges,
  legCapacity,
  lotQuery,
  reconcile,
  rerouteStatus,
  suppressedDemand,
  validateChains,
} from '../src/planner.mjs';

const { tables } = await loadMaterials();
const model = createModel(tables);

test('同一车底的时间不能重叠，换站需要空车路段', () => {
  const s1 = validateChains(model, 'S1');
  assert.equal(s1.feasible, false);
  assert.ok(s1.issues.some(issue => issue.code === 'overlap'));

  const s2 = validateChains(model, 'S2');
  assert.equal(s2.feasible, true, s2.issues.map(issue => issue.message).join('；'));

  // C1 在 S2 里只有一条空车调车段，不能当载货腿算。
  const emptyLeg = model.legsByOption.get('S2').find(leg => leg.leg === 'C-B');
  assert.equal(emptyLeg.empty, true);
  assert.equal(legCapacity(model, emptyLeg), 0);
});

test('有效载量取车辆总重与腿上限的较小值', () => {
  const legs = model.legsByOption.get('S0');
  const capped = { ...legs[2], maxKg: 5000, vehicle: 'C1', empty: false };
  assert.equal(legCapacity(model, capped), 1000);
  const normal = { ...legs[0], maxKg: 400, vehicle: 'C1', empty: false };
  assert.equal(legCapacity(model, normal), 400);
});

test('空车占路径但不产生载量收益', () => {
  const allocation = allocateOption(model, 'S2', { mode: 'service' });
  const emptyLeg = allocation.legs.find(leg => leg.leg === 'C-B');
  assert.equal(emptyLeg.empty, true);
  assert.equal(emptyLeg.capacityKg, 0);
  assert.equal(emptyLeg.allocatedKg, 0);
});

test('不可行车底方案不产生收益，只保留容量预测', () => {
  const allocation = allocateOption(model, 'S1', { mode: 'service' });
  assert.equal(allocation.feasible, false);
  assert.equal(allocation.totals.allocatedKg, 0);
  assert.ok(allocation.results.every(result => result.status === 'plan-infeasible'));
  const comparison = compareOptions(model);
  assert.ok(!comparison.feasibleOptions.includes('S1'));
  assert.notEqual(comparison.recommendation.option, 'S1');
});

test('按装车量排序会漏掉小站与下游承诺，服务口径能保承诺', () => {
  const volume = allocateOption(model, 'S0', { mode: 'volume' });
  const service = allocateOption(model, 'S0', { mode: 'service' });
  const volumeB = volume.stationView.find(station => station.station === 'B');
  const serviceB = service.stationView.find(station => station.station === 'B');
  assert.ok(volumeB.allocatedKg < serviceB.allocatedKg, '装车量口径不应分给小站 B 更多');

  const conflict = conflictsOf(model, service).find(entry => entry.lot === 'L2');
  assert.ok(conflict, 'S0 服务口径下 L2 的承诺应暴露为冲突');
  assert.equal(conflict.type, 'cutoff');
  assert.ok(conflict.options.every(option => option.status !== 'completed'));
});

test('可拆批可以部分装载，必须整批不能按拆批计', () => {
  const allocation = allocateOption(model, 'S0', { mode: 'volume' });
  const split = allocation.results.find(result => result.lot === 'L18');
  assert.equal(split.method, 'split');
  assert.ok(split.allocatedKg > 0 && split.allocatedKg < split.demandKg);

  const whole = allocation.results.find(result => result.lot === 'L21');
  assert.equal(whole.method, 'whole');
  assert.ok(whole.allocatedKg === 0 || whole.allocatedKg === whole.demandKg);
});

test('分配不早于受理日的车次，后续登记的货不能装已开走的车', () => {
  // L25 第 4 日受理；S2 的 A-B 只在第 1 日发车，不能把它算上。
  const allocation = allocateOption(model, 'S2', { mode: 'volume' });
  const l25 = allocation.results.find(result => result.lot === 'L25');
  assert.equal(l25.allocatedKg, 0);
  assert.equal(l25.status, 'no-path');
  // 对照：L2 第 1 日受理，能在第 2 日发的 B-C 接上。
  const service = allocateOption(model, 'S2', { mode: 'service' });
  const l2 = service.results.find(result => result.lot === 'L2');
  assert.ok(l2.allocatedKg > 0);
});

test('最低站频次按载货服务计，空车不算', () => {
  const allocation = allocateOption(model, 'S2', { mode: 'service' });
  const stationB = allocation.stationView.find(station => station.station === 'B');
  assert.equal(stationB.floorMet, true);
  // C-B 是空车，C 的载货服务只来自 C-P。
  const stationC = allocation.stationView.find(station => station.station === 'C');
  assert.equal(stationC.loadedServices, 2);
});

test('被压抑需求只把 confirmed 计为确定回流', () => {
  const demand = suppressedDemand(model);
  const confirmed = demand.rows.filter(row => row.certainReturn);
  assert.deepEqual(confirmed.map(row => row.lot), ['L3']);
  assert.equal(demand.certainReturnKg, 590);

  const unknown = demand.rows.filter(row => row.grade === 'unknown');
  assert.ok(unknown.length > 0);
  assert.ok(unknown.every(row => row.certainReturn === false));
  assert.ok(demand.rows.every(row => row.route.length > 0));
  assert.ok(demand.rows.every(row => 'evidenceAgeDays' in row));
});

test('wet 与 dry 的抽样覆盖不共用分母', () => {
  const demand = suppressedDemand(model);
  const seasons = demand.coverageBySeason.map(entry => entry.season);
  assert.deepEqual(seasons, ['dry', 'wet']);
  for (const season of demand.coverageBySeason) {
    for (const coverage of season.coverage) {
      assert.equal(coverage.season, season.season);
      assert.equal(coverage.rate, coverage.interviewed / coverage.eligiblePopulation);
    }
  }
});

test('同一货批跨站短驳不改需求归属，也不生成新需求', () => {
  const described = describeLot(model, 'L1');
  assert.deepEqual(described.transfers.map(transfer => transfer.leg), ['A-B', 'B-C', 'C-P']);
  assert.equal(described.kg, 900);
  const demand = demandRanges(model, { segment: 'B-C' });
  const row = demand.rows.find(entry => entry.lotIds.includes('L1'));
  assert.ok(row, 'L1 的短驳路径经过 B-C，需求应归属该段');
  assert.equal(demand.rows.reduce((sum, entry) => sum + entry.lotIds.filter(id => id === 'L1').length, 0), 1);
});

test('没有共同路段的货批不计入该段需求', () => {
  const demand = demandRanges(model, { segment: 'A-B' });
  assert.ok(!demand.rows.some(row => row.lotIds.includes('L2')));
  assert.ok(demand.excludedNoCommonSegment.includes('L2'));
  assert.ok(lotUsesSegment(model, model.lotsById.get('L1'), 'A-B'));
  assert.ok(!lotUsesSegment(model, model.lotsById.get('L2'), 'A-B'));
});

test('回单只认 accepted，held 与转运都不算交付', () => {
  const l17 = describeLot(model, 'L17', { asOf: model.receiptAsOf });
  // Y5 签收 280、Y6 待交 137，合计 417；交付只算 280。
  assert.equal(l17.railDeliveredKg, 280);
  assert.equal(l17.heldKg, 137);

  const result = reconcile(model, { option: 'S2' });
  const row = result.rows.find(entry => entry.lot === 'L17');
  assert.equal(row.status, 'partly-held');
  assert.ok(row.note.includes('不算交付'));

  const l1 = reconcile(model).rows.find(entry => entry.lot === 'L1');
  assert.equal(l1.status, 'matched');
  assert.deepEqual(l1.actual.modes, ['road']);
});

test('改道未成行前只能标 proposed，不能记为完成', () => {
  assert.equal(rerouteStatus(model, 'L11').status, 'proposed');
  assert.equal(rerouteStatus(model, 'L4').status, 'completed');
  const review = lotQuery(model, 'L11', { option: 'S2' });
  assert.ok(!review.reasons.some(reason => reason.includes('完成') && !reason.includes('不能')));
});

test('货主查询给出交付窗口与失约处理原因', () => {
  const query = lotQuery(model, 'L2', { option: 'S0' });
  assert.equal(query.deliveryWindow.contractDay, 6);
  assert.equal(query.deliveryWindow.from, 7);
  assert.equal(query.deliveryWindow.onDesignatedCall, false);
  assert.ok(query.reasons.length > 0);

  const met = lotQuery(model, 'L2', { option: 'S2' });
  assert.equal(met.deliveryWindow.from, 5);
  assert.equal(met.deliveryWindow.onDesignatedCall, true);
  assert.equal(met.allocation.obligationMet, true);
});

test('方案比较给出可外推与不可外推的边界', () => {
  const comparison = compareOptions(model);
  assert.ok(comparison.extrapolation.supported.length > 0);
  assert.ok(comparison.extrapolation.notSupported.includes('没有共同路段'));
  assert.ok(comparison.summary.every(row => 'forecastOnlyStations' in row));
});
