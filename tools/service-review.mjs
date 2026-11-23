#!/usr/bin/env node
/**
 * 复运服务审议命令行。
 *
 * 用法：
 *   node tools/service-review.mjs review
 *   node tools/service-review.mjs compare [--mode volume|service] [--json]
 *   node tools/service-review.mjs allocate <方案> [--mode volume|service] [--json]
 *   node tools/service-review.mjs lot <货批> [--option S2] [--json]
 *   node tools/service-review.mjs suppressed [--json]
 *   node tools/service-review.mjs demand [--segment C-P] [--season wet] [--cargo grain] [--group small] [--json]
 *   node tools/service-review.mjs reconcile [--option S2] [--json]
 *
 * 仅用 Node.js 标准库；资料默认从 fixtures/ 读取，可用 --source 指向另一份交接目录。
 */

import { loadMaterials } from './check-materials.mjs';
import { createModel } from '../src/model.mjs';
import {
  compareOptions,
  allocateOption,
  conflictsOf,
  suppressedDemand,
  demandRanges,
  lotQuery,
  reconcile,
  rerouteStatus,
  planReview,
} from '../src/planner.mjs';

const USAGE = `复运服务审议
用法：
  review [--json]                      每期运行图调整前的完整审议包
  compare [--json]                     候选方案横向比较
  allocate <方案> [--mode volume|service] [--json]
  lot <货批> [--option 方案] [--json]   货主查询：交付窗口与失约原因
  suppressed [--json]                  被压抑需求（按证据等级）
  demand [--segment 段] [--season 季] [--cargo 货类] [--group 规模] [--json]
  reconcile [--option 方案] [--json]    回单核验
公共参数：--source <目录>  --as-of <日>`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--json') flags.json = true;
    else if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      const value = inline ?? rest[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${token} 缺少取值`);
      }
      flags[name] = value;
    } else positional.push(token);
  }
  return { command, flags, positional };
}

const MODE_SWITCH = {
  service: '保护已确认承运窗口与最低站频次',
  volume: '只按装车量排序，用来暴露大站/大货主盖住小站的风险',
};

function printLegs(allocation) {
  for (const leg of allocation.legs) {
    const tag = leg.empty ? '空车' : `载量 ${leg.capacityKg}`;
    console.log(
      `  ${leg.leg.padEnd(6)} ${String(leg.startDay).padStart(2)}-${String(leg.endDay).padEnd(2)} 车底 ${leg.vehicle}  ${tag}  已分 ${leg.allocatedKg}  余 ${leg.remainingKg}`,
    );
  }
}

function printResults(allocation) {
  const statusLabel = {
    allocated: '已排',
    'partly-loaded': '部分装载',
    'capacity-short': '载量不足',
    'misses-cutoff': '赶不上截期',
    'misses-contract': '晚于承诺',
    'no-path': '无路径',
    'plan-infeasible': '方案不可行',
  };
  const rows = allocation.results
    .slice()
    .sort((a, b) => a.station.localeCompare(b.station) || a.lot.localeCompare(b.lot, undefined, { numeric: true }));
  for (const result of rows) {
    const method = result.method === 'split' ? '可拆' : '整批';
    console.log(
      `  ${result.lot.padEnd(4)} ${result.station} ${method} 需求 ${String(result.demandKg).padStart(4)}  分得 ${String(result.allocatedKg).padStart(4)}  到港 ${result.arrivalDay ?? '-'}  ${statusLabel[result.status] ?? result.status}  ${result.reason}`,
    );
  }
}

function printStations(allocation) {
  for (const station of allocation.stationView) {
    const floor = station.floorCount ? `最低频次 ${station.loadedServices}/${station.floorCount}${station.floorMet ? ' 达' : ' 未达'}` : '无约定频次';
    // 频次与分得载量是两件事：可能保住了服务窗口，但本批仍只是预测受益。
    const tags = [];
    if (station.serviceGuaranteed) tags.push('频次已保留');
    if (station.forecastOnly) tags.push('仅预测受益');
    const tag = tags.length ? `（${tags.join('，')}）` : '';
    console.log(
      `  ${station.station} 需求 ${String(station.demandKg).padStart(4)}  分得 ${String(station.allocatedKg).padStart(4)}  载货服务 ${station.loadedServices}  ${floor}${tag}  ${station.note}`,
    );
  }
}

function runCompare(model, { asOf, json }) {
  const comparison = compareOptions(model, { asOf });
  if (json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }
  console.log(`审议日 ${asOf}；候选方案 ${model.options.join('、')}`);
  for (const row of comparison.summary) {
    console.log(`\n【${row.option}】${row.feasible ? '车底衔接可行' : '车底衔接不可行（只作容量预测）'}`);
    for (const issue of row.chainIssues) {
      console.log(`  [${issue.level}] ${issue.message}`);
    }
    console.log(
      `  服务口径装车 ${row.serviceAllocatedKg} kg；按装车量口径 ${row.volumeAllocatedKg} kg；冲突 ${row.conflicts} 项；守住最低频次 ${row.stationFloorsMet} 站`,
    );
    if (row.smallStationLossKg.length) {
      console.log(
        `  按装车量排序会少分小站：${row.smallStationLossKg.map(entry => `${entry.station} 少 ${entry.lostKg} kg`).join('，')}`,
      );
    }
    if (row.forecastOnlyStations.length) {
      console.log(`  只有预测受益的站：${row.forecastOnlyStations.join('、')}`);
    }
    if (row.missedCutoff.length) console.log(`  赶不上指定船期：${row.missedCutoff.join('、')}`);
  }
  console.log(`\n推荐：${comparison.recommendation.option ?? '无'} — ${comparison.recommendation.reason}`);
  if (comparison.recommendation.caveat) console.log(`界限：${comparison.recommendation.caveat}`);
  console.log(`可外推范围：${comparison.extrapolation.supported}`);
  console.log(`不可外推：${comparison.extrapolation.notSupported}`);
}

function runAllocate(model, { option, mode, asOf, json }) {
  if (!option) throw new Error('allocate 需要方案名');
  if (!model.legsByOption.has(option)) throw new Error(`未知方案 ${option}`);
  const allocation = allocateOption(model, option, { asOf, mode });
  const conflicts = conflictsOf(model, allocation);
  if (json) {
    console.log(JSON.stringify({ allocation, conflicts }, null, 2));
    return;
  }
  console.log(`方案 ${option}，${mode} 口径（${MODE_SWITCH[mode]}），审议日 ${asOf}`);
  console.log(
    allocation.feasible
      ? '车底衔接：可行'
      : `车底衔接：不可行 —— 下列载量只作预测，不能报复运收益`,
  );
  for (const issue of allocation.chain.issues) console.log(`  [${issue.level}] ${issue.message}`);
  console.log('\n车底腿：');
  printLegs(allocation);
  console.log('\n货批：');
  printResults(allocation);
  console.log('\n分站：');
  printStations(allocation);

  const totals = allocation.totals;
  console.log(
    `\n合计：需求 ${totals.demandKg} kg，已分 ${totals.allocatedKg} kg；整批 ${totals.whole.satisfied}/${totals.whole.lots} 批满足，可拆批 ${totals.split.partial} 批部分装载`,
  );

  if (conflicts.length) {
    console.log('\n冲突与余量：');
    for (const conflict of conflicts) {
      console.log(
        `  ${conflict.lot}（${conflict.station}）${conflict.type === 'capacity' ? '载量' : '截期'}冲突：需 ${conflict.requiredKg} kg，分得 ${conflict.allocatedKg} kg，承诺第 ${conflict.promisedBy} 日，实到 ${conflict.arrivalDay ?? '-'} 日${conflict.daysLate ? `，晚 ${conflict.daysLate} 日` : ''}`,
      );
      if (conflict.bottleneckLeg) {
        console.log(`    瓶颈段 ${conflict.bottleneckLeg.leg}：余 ${conflict.bottleneckLeg.remainingKg} / 容量 ${conflict.bottleneckLeg.capacityKg}`);
      }
      if (conflict.competingLots.length) {
        console.log(
          `    同段已分货批：${conflict.competingLots.map(entry => `${entry.lot}(${entry.station}) ${entry.allocatedKg} kg`).join('，')}；可回收 ${conflict.reclaimableKg} kg（需决定是否改道或调承诺）`,
        );
      }
      for (const choice of conflict.options) console.log(`    可选：${choice.label} [${choice.status}]`);
    }
  }
}

function runReview(model, { asOf, json }) {
  const review = planReview(model, { asOf });
  if (json) {
    console.log(JSON.stringify(review, null, 2));
    return;
  }
  console.log(`每期运行图调整前审议包，审议日 ${asOf}\n`);
  runCompare(model, { asOf, json: false });
  console.log('\n被压抑需求：');
  printSuppressed(review.suppressed);
  console.log('\n改道状态：');
  for (const reroute of review.reroutes) {
    console.log(`  ${reroute.lot}: ${reroute.status} — ${reroute.label}`);
  }
}

function printSuppressed(suppressed) {
  for (const row of suppressed.rows) {
    const window = row.windowFrom == null ? '无窗口' : `第 ${row.windowFrom}-${row.windowTo} 日`;
    const coverage = row.coverage ? `${(row.coverage.rate * 100).toFixed(1)}%（${row.coverage.registeredScope}）` : '无抽样覆盖';
    console.log(
      `  ${row.lot.padEnd(4)} ${row.stateLabel} ${String(row.kg).padStart(4)} kg  证据 ${row.grade}${row.certainReturn ? '（确定回流）' : ''}  ${window}  证据日 ${row.evidenceDay ?? '-'}（${row.evidenceAgeDays ?? '-'} 天前）  路线 ${row.route.join('→')}  覆盖 ${coverage}`,
    );
  }
  console.log(
    `  确定回流 ${suppressed.certainReturnKg} kg；可能区间 ${suppressed.possibleRangeKg.low}-${suppressed.possibleRangeKg.high} kg`,
  );
  for (const group of suppressed.byGrade) {
    console.log(`  ${group.grade}：${group.lots} 批 / ${group.kg} kg${group.certainKg ? `，其中确定 ${group.certainKg} kg` : ''}`);
  }
  for (const group of suppressed.bySource) {
    if (group.lots === 0) continue;
    console.log(
      `  ${group.label}：${group.lots} 批 / ${group.kg} kg${group.certainKg ? `，确定回流 ${group.certainKg} kg` : '，无确定回流'}`,
    );
  }
  for (const season of suppressed.coverageBySeason) {
    const unmoved = season.railUnmovedKg ? `，其中铁路过期未运 ${season.railUnmovedKg} kg 未加权` : '';
    console.log(
      `  季节 ${season.season}：${season.lots} 批，调查加权回流 ${Math.round(season.weightedKg)} kg（观测 ${season.observedKg} kg${unmoved}）；${season.note}`,
    );
  }
  console.log(`  口径：${suppressed.caveat}`);
}

function runLot(model, { lotId, option, asOf, json }) {
  if (!lotId) throw new Error('lot 需要货批号');
  const query = lotQuery(model, lotId, { asOf, option });
  if (json) {
    console.log(JSON.stringify(query, null, 2));
    return;
  }
  console.log(`${query.lot}（${query.shipper}）${query.origin}→${query.destination}，登记 ${query.kg} kg，状态：${query.stateLabel}（截至第 ${asOf} 日）`);
  console.log(
    `  铁路已交付 ${query.railDeliveredKg} kg；到站待交 ${query.heldKg} kg（不算交付）；尚未到站/未交付 ${query.physicalRemainingKg} kg`,
  );
  const window = query.deliveryWindow;
  console.log(
    `  交付窗口：${window.from == null ? '待定' : `第 ${window.from} 日到港`} → 截期 ${window.to ?? '待定'}${window.onDesignatedCall === false ? '（赶不上指定船期，落在下一班）' : ''}；承诺第 ${window.contractDay} 日`,
  );
  if (query.option) console.log(`  按方案 ${query.option}：${query.allocation ? `${query.allocation.allocatedKg} kg，${query.allocation.arrivalDay ?? '-'} 日到港` : '无分配'}`);
  for (const reason of query.reasons) console.log(`  说明：${reason}`);
  for (const evidence of query.receiptEvidence) {
    console.log(
      `  回单 ${evidence.receipt}：${evidence.state} ${evidence.kg} kg（${evidence.mode}），签收日 ${evidence.receivedDay}，回收日 ${evidence.knownDay}${evidence.countsAsDelivered ? '' : '，不算交付'}`,
    );
  }
}

function runDemand(model, { flags, asOf, json }) {
  const ranges = demandRanges(model, {
    asOf,
    segment: flags.segment ?? null,
    season: flags.season ?? null,
    cargo: flags.cargo ?? null,
    shipperGroup: flags.group ?? null,
  });
  if (json) {
    console.log(JSON.stringify(ranges, null, 2));
    return;
  }
  console.log(`需求范围${ranges.segment ? `（路段 ${ranges.segment}）` : ''}，审议日 ${asOf}`);
  for (const row of ranges.rows) {
    const delivered = row.deliveredLots.length ? `，其中已交付 ${row.deliveredLots.join('、')}` : '';
    console.log(
      `  ${row.season}/${row.cargo}/${row.shipperGroup === 'large' ? '大货主' : '小货主'}：${row.lots} 批，登记需求 ${row.demandKg} kg（未交付 ${row.outstandingKg} kg${delivered}），登记第 ${row.receiveWindow.from}-${row.receiveWindow.to} 日，起运站 ${row.origins.join('、')}${row.sampleRate == null ? '' : `，抽样覆盖 ${(row.sampleRate * 100).toFixed(1)}%`}`,
    );
  }
  if (ranges.excludedNoCommonSegment.length) {
    console.log(`  未计入（无共同路段）：${ranges.excludedNoCommonSegment.join('、')}`);
  }
  for (const season of ranges.coverageBySeason) {
    console.log(
      `  季节 ${season.season} 抽样覆盖 ${season.rate == null ? '-' : `${(season.rate * 100).toFixed(1)}%`}（${season.interviewed}/${season.eligiblePopulation}）；${season.note}`,
    );
  }
  console.log(`  ${ranges.scopeNote}`);
}

function runReconcile(model, { option, asOf, json }) {
  const result = reconcile(model, { option, asOf });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`回单核验（回收日 ${result.asOf}）${option ? `，对照方案 ${option}` : ''}`);
  for (const row of result.rows) {
    if (row.status === 'no-receipt' && !row.actual.transferOnlyKg) continue;
    const predicted = row.predicted ? `预测 ${row.predicted.allocatedKg} kg / 第 ${row.predicted.arrivalDay ?? '-'} 日` : '无预测';
    const actual = `实签 ${row.actual.acceptedKg} kg / 第 ${row.actual.arrivalDay ?? '-'} 日`;
    console.log(`  ${row.lot.padEnd(4)} ${row.status.padEnd(18)} ${predicted}   ${actual}   ${row.note}`);
  }
  console.log(`  已交付 ${result.deliveredLots} 批；部分待交 ${result.partlyHeldLots.join('、') || '无'}；仅到站待交 ${result.heldOnlyLots.join('、') || '无'}；仅有转运 ${result.transferOnlyLots.join('、') || '无'}`);
  console.log(`  ${result.caveat}`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  // 无子命令时默认出完整审议包；`npm run review -- allocate S2` 仍按子命令解析。
  const args = rawArgs.length === 0 ? ['review'] : rawArgs;
  const { command, flags, positional } = parseArgs(args);
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  const { tables } = await loadMaterials(flags.source ? flags.source : undefined);
  const model = createModel(tables);
  const asOf = flags['as-of'] ? Number(flags['as-of']) : model.planningAsOf;
  if (!Number.isFinite(asOf)) throw new Error('--as-of 需要数字日期');
  const mode = flags.mode ?? 'service';
  if (!['service', 'volume'].includes(mode)) throw new Error('--mode 只能是 service 或 volume');

  switch (command) {
    case 'review':
      runReview(model, { asOf, json: flags.json });
      break;
    case 'compare':
      runCompare(model, { asOf, json: flags.json });
      break;
    case 'allocate':
      runAllocate(model, { option: positional[0], mode, asOf, json: flags.json });
      break;
    case 'lot':
      runLot(model, { lotId: positional[0], option: flags.option ?? null, asOf, json: flags.json });
      break;
    case 'suppressed': {
      const suppressed = suppressedDemand(model, { asOf });
      if (flags.json) console.log(JSON.stringify(suppressed, null, 2));
      else printSuppressed(suppressed);
      break;
    }
    case 'demand':
      runDemand(model, { flags, asOf, json: flags.json });
      break;
    case 'reconcile':
      runReconcile(model, {
        option: flags.option ?? null,
        // 回单核验默认使用资料里最晚的回收日；显式 --as-of 只在研究某次回收时使用。
        asOf: flags['as-of'] ? asOf : model.receiptAsOf,
        json: flags.json,
      });
      break;
    case 'reroute': {
      const lotId = positional[0];
      if (!lotId) throw new Error('reroute 需要货批号');
      const status = rerouteStatus(model, lotId);
      console.log(
        flags.json
          ? JSON.stringify(status, null, 2)
          : `${status.lot}: ${status.status} — ${status.label}`,
      );
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
