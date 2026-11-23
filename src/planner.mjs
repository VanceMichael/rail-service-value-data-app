/**
 * 复运方案比较。
 *
 * 推演口径（逐条对应交接说明）：
 * - 一个 lot 是一条货批；跨站短驳/分段改道若仍指向同一 lot，不能当新需求。
 * - 每张 legs 记录是一次独立车底运行；同一车底按 start/end 日衔接，
 *   同一日只在同站可接，换站必须有已提供的空车路段；空车 max_kg=0 但也占车底时间。
 * - 有效载量 = min(leg.max_kg, vehicle.total_mass_kg)；空车不计载量。
 * - 已确认承运窗口（obligations）在服务口径下先保留，再分配其它货批；
 *   按装车量口径不再保护，用来暴露“大站盖住小站/下游承诺”的风险。
 * - 可拆批按公斤部分装载；必须整批按整批全有全无，两种计法分开记录。
 * - 只有车底衔接可行的方案才计入“已实现”收益；不可行方案仍列容量，但只作预测。
 * - 改道在出现位移记录前一律 proposed，不能记为完成。
 */

import { RETURN_GRADES, describeLot, lotUsesSegment } from './model.mjs';

// 合成资料中的线性走廊。真实实施应由线路拓扑计算，而不是依赖站名字母序。
const CORRIDOR = ['A', 'B', 'C', 'P'];
const SMALL_STATION_MAX_KG = 900;

export function corridorIndex(station) {
  return CORRIDOR.indexOf(station);
}

function vehicleOf(model, leg) {
  return model.vehicles.get(leg.vehicle) ?? null;
}

/** 单次运行的有效载量；空车为 0。 */
export function legCapacity(model, leg) {
  if (leg.empty) return 0;
  const vehicle = vehicleOf(model, leg);
  const vehicleCapacity = vehicle ? vehicle.totalMassKg : leg.maxKg;
  return Math.min(leg.maxKg, vehicleCapacity);
}

/**
 * 校验某方案的车底衔接。空车路段也参与顺序与时间校验。
 * 返回 { feasible, issues }。
 */
export function validateChains(model, option) {
  const legs = model.legsByOption.get(option) ?? [];
  const issues = [];
  const byVehicle = new Map();
  for (const leg of legs) {
    if (!byVehicle.has(leg.vehicle)) byVehicle.set(leg.vehicle, []);
    byVehicle.get(leg.vehicle).push(leg);
  }

  for (const [vehicleId, vehicleLegs] of byVehicle) {
    const vehicle = model.vehicles.get(vehicleId);
    if (!vehicle) {
      issues.push({
        level: 'error',
        code: 'unknown-vehicle',
        vehicle: vehicleId,
        message: `车底 ${vehicleId} 没有 vehicle-rules 记录`,
      });
      continue;
    }
    const ordered = vehicleLegs
      .slice()
      .sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay);
    for (const leg of ordered) {
      if (leg.startDay < vehicle.availableDay) {
        issues.push({
          level: 'error',
          code: 'vehicle-early',
          vehicle: vehicleId,
          leg: leg.leg,
          message: `车底 ${vehicleId} 第 ${vehicle.availableDay} 日才可用，${leg.leg} 第 ${leg.startDay} 日发车`,
        });
      }
      if (leg.endDay < leg.startDay) {
        issues.push({
          level: 'error',
          code: 'leg-window',
          vehicle: vehicleId,
          leg: leg.leg,
          message: `${leg.leg} 的结束日早于开始日`,
        });
      }
    }
    const first = ordered[0];
    if (first && first.from !== vehicle.home) {
      const positioned = ordered.some(
        leg =>
          leg.empty &&
          leg !== first &&
          leg.from === vehicle.home &&
          leg.to === first.from &&
          leg.startDay >= vehicle.availableDay &&
          leg.endDay <= first.startDay,
      );
      if (!positioned) {
        issues.push({
          level: 'warning',
          code: 'no-home-positioning',
          vehicle: vehicleId,
          leg: first.leg,
          message: `车底 ${vehicleId} 的驻地是 ${vehicle.home}，首个运行 ${first.leg} 从 ${first.from} 发车，资料未提供驻地到 ${first.from} 的空车路段，按已事先到位处理`,
        });
      }
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const prev = ordered[index - 1];
      const next = ordered[index];
      if (next.startDay < prev.endDay) {
        issues.push({
          level: 'error',
          code: 'overlap',
          vehicle: vehicleId,
          leg: `${prev.leg} -> ${next.leg}`,
          message: `车底 ${vehicleId} 的 ${prev.leg}（至第 ${prev.endDay} 日）与 ${next.leg}（第 ${next.startDay} 日发车）时间重叠`,
        });
        continue;
      }
      if (prev.to === next.from) continue;
      if (next.startDay === prev.endDay) {
        issues.push({
          level: 'error',
          code: 'same-day-cross-station',
          vehicle: vehicleId,
          leg: `${prev.leg} -> ${next.leg}`,
          message: `同一日只能同站接续：${prev.leg} 到 ${prev.to}，${next.leg} 从 ${next.from} 发车`,
        });
        continue;
      }
      const empty = ordered.find(
        leg =>
          leg.empty &&
          leg !== prev &&
          leg !== next &&
          leg.from === prev.to &&
          leg.to === next.from &&
          leg.startDay >= prev.endDay &&
          leg.endDay <= next.startDay,
      );
      if (!empty) {
        issues.push({
          level: 'error',
          code: 'missing-empty',
          vehicle: vehicleId,
          leg: `${prev.leg} -> ${next.leg}`,
          message: `车底 ${vehicleId} 需从 ${prev.to} 调往 ${next.from}，但没有已提供的空车路段`,
        });
      }
    }
  }

  return { feasible: !issues.some(issue => issue.level === 'error'), issues };
}

/**
 * 沿方案载货段找一条时间可接的起讫路径。
 * 返回 { legs, arrivalDay } 或 null。
 */
/**
 * 沿方案载货段找一条时间可接的起讫路径。
 * earliestDay 是货批最早可装车的日期（受理日），不能拿已开走的车次去装后来才登记的货。
 * 返回 { legs, arrivalDay } 或 null。
 */
export function findPath(model, option, origin, destination, { earliestDay = -Infinity } = {}) {
  if (origin === destination) return { legs: [], arrivalDay: null };
  const legs = (model.legsByOption.get(option) ?? []).filter(leg => !leg.empty);
  let station = origin;
  let day = earliestDay;
  const used = [];
  for (let step = 0; step < 12; step += 1) {
    if (station === destination) {
      return { legs: used, arrivalDay: used[used.length - 1].endDay };
    }
    const next = legs
      .filter(leg => leg.from === station && leg.startDay >= day)
      .sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay)[0];
    if (!next) return null;
    used.push(next);
    station = next.to;
    day = next.endDay;
  }
  return null;
}

/** 目标 P 的指定船期：asOf 前已获知、且不早于货批受理日的最早截期。 */
export function designatedPortCall(model, station, { receivedDay = -Infinity, asOf = model.planningAsOf } = {}) {
  const calls = model.portCalls
    .filter(call => call.station === station && call.knownDay <= asOf && call.cutoffDay >= receivedDay)
    .sort((a, b) => a.cutoffDay - b.cutoffDay);
  return calls[0] ?? null;
}

export function nextPortCallAfter(model, station, day, asOf = model.planningAsOf) {
  const calls = model.portCalls
    .filter(call => call.station === station && call.knownDay <= asOf && call.cutoffDay > day)
    .sort((a, b) => a.cutoffDay - b.cutoffDay);
  return calls[0] ?? null;
}

/**
 * 最低站频次：可办理的载货服务窗口数量；空车不计。
 * 返回 Map<station, number>。
 */
export function loadedServiceCounts(optionLegs) {
  const counts = new Map();
  for (const leg of optionLegs) {
    if (leg.empty) continue;
    counts.set(leg.from, (counts.get(leg.from) ?? 0) + 1);
    counts.set(leg.to, (counts.get(leg.to) ?? 0) + 1);
  }
  return counts;
}

export function collectFloors(model) {
  const floors = [];
  for (const obligation of model.obligations) {
    for (const floor of obligation.floors) {
      const existing = floors.find(entry => entry.station === floor.station);
      if (existing) {
        existing.count = Math.max(existing.count, floor.count);
        existing.from.add(obligation.lot);
      } else {
        floors.push({ station: floor.station, count: floor.count, from: new Set([obligation.lot]) });
      }
    }
  }
  return floors.map(floor => ({ ...floor, from: [...floor.from] }));
}

function isSmallStation(described) {
  if (described.length === 0) return false;
  const allSmall = described.every(lot => lot.shipperGroup === 'small');
  const demand = described.reduce((sum, lot) => sum + Math.max(0, lot.physicalRemainingKg), 0);
  return allSmall || demand < SMALL_STATION_MAX_KG;
}

/**
 * 分配候选货批到某方案。
 * mode = 'volume'：单纯按装车量排（大货主优先，容易盖住小站/下游承诺）。
 * mode = 'service'：先保已确认承运窗口，再按承诺到站日与整批约束。
 *
 * 可拆批与必须整批不用同一计法：
 * - 可拆批按公斤占用路径余量，可部分装载。
 * - 必须整批只做全有全无判断，不占用“半车”；若它排不下，余量留给可拆批，
 *   两者载量在 totals 里分开报告，避免用拆批收益掩盖整批落空。
 */
export function allocateOption(model, option, { asOf = model.planningAsOf, mode = 'service' } = {}) {
  const optionLegs = model.legsByOption.get(option) ?? [];
  const chain = validateChains(model, option);
  const remaining = new Map(optionLegs.map(leg => [leg.id, legCapacity(model, leg)]));
  const allDescribed = model.loads.map(lot => describeLot(model, lot, { asOf }));
  // 复运排程只排仍在铁路侧、尚未交付的货批。拒收与主动改走属于被压抑需求，
  // 需要重新受理后才进入车次分配，不能默认他们已回流。
  const railDemand = allDescribed.filter(lot =>
    ['accepted', 'promised', 'reported', 'expired', 'partly-delivered'].includes(lot.effectiveState),
  );
  const paths = new Map();
  for (const lot of railDemand) {
    // 只有受理日当天或之后才发车的车次能装这批货。
    paths.set(lot.lot, findPath(model, option, lot.origin, lot.destination, { earliestDay: lot.receivedDay }));
  }

  const byVolume = (a, b) =>
    b.physicalRemainingKg - a.physicalRemainingKg || a.lot.localeCompare(b.lot);
  const urgency = lot => (lot.obligation ? lot.obligation.promisedBy : lot.deliverBy);
  // 同一承诺日下必须整批的先排：零头对它没用，余量不足就整批走不了；
  // 可拆批的货随后用余量部分装载。两者载量与收益分开统计，不用同一计法。
  const byService = (a, b) =>
    urgency(a) - urgency(b) ||
    Number(a.splittable) - Number(b.splittable) ||
    b.physicalRemainingKg - a.physicalRemainingKg ||
    a.lot.localeCompare(b.lot);

  const obligationLots = railDemand.filter(lot => lot.obligation);
  const otherLots = railDemand.filter(lot => !lot.obligation);
  // 服务口径分三段：已确认承诺 → 必须整批 → 可拆批。
  // 整批段在前，避免可拆批用零头把整批车次占掉；两段仍各自按紧迫度排序。
  const ordered =
    mode === 'volume'
      ? railDemand.slice().sort(byVolume)
      : [
          ...obligationLots.slice().sort(byService),
          ...otherLots.filter(lot => !lot.splittable).sort(byService),
          ...otherLots.filter(lot => lot.splittable).sort(byService),
        ];

  const results = new Map();
  for (const lot of ordered) {
    results.set(lot.lot, allocateLot(model, { lot, path: paths.get(lot.lot), option, chain, remaining, asOf }));
  }

  const values = [...results.values()];
  const legs = optionLegs.map(leg => {
    const users = values.filter(result => result.path.includes(leg.id));
    return {
      id: leg.id,
      leg: leg.leg,
      vehicle: leg.vehicle,
      startDay: leg.startDay,
      endDay: leg.endDay,
      empty: leg.empty,
      capacityKg: legCapacity(model, leg),
      demandKg: users.reduce((sum, result) => sum + result.demandKg, 0),
      allocatedKg: users.reduce((sum, result) => sum + result.allocatedKg, 0),
      remainingKg: remaining.get(leg.id),
      callsAt: [leg.from, leg.to],
    };
  });

  return {
    option,
    mode,
    feasible: chain.feasible,
    chain,
    legs,
    results: values,
    stationView: buildStationView({ model, option, chain, railDemand, results: values, optionLegs }),
    totals: summarize(values),
  };
}

function allocateLot(model, { lot, path, option, chain, remaining, asOf }) {
  const demandKg = Math.max(0, lot.physicalRemainingKg);
  const base = {
    lot: lot.lot,
    station: lot.origin,
    state: lot.effectiveState,
    demandKg,
    method: lot.splittable ? 'split' : 'whole',
    obligation: lot.obligation,
    deliverBy: lot.deliverBy,
    path: path ? path.legs.map(leg => leg.id) : [],
    pathLegs: path ? path.legs.map(leg => leg.leg) : [],
  };

  if (!chain.feasible) {
    return {
      ...base,
      allocatedKg: 0,
      arrivalDay: path?.arrivalDay ?? null,
      status: 'plan-infeasible',
      reason: `方案 ${option} 车底衔接不可行，收益不能算已实现`,
    };
  }
  if (!path) {
    return {
      ...base,
      allocatedKg: 0,
      arrivalDay: null,
      status: 'no-path',
      reason: `方案 ${option} 没有从 ${lot.origin} 到 ${lot.destination} 的可接路径`,
    };
  }

  const headroom = Math.min(...path.legs.map(leg => remaining.get(leg.id)), demandKg);
  let allocatedKg;
  if (lot.splittable) {
    allocatedKg = Math.max(0, Math.min(demandKg, headroom));
  } else {
    allocatedKg = demandKg <= headroom ? demandKg : 0;
  }
  if (allocatedKg > 0) {
    for (const leg of path.legs) remaining.set(leg.id, remaining.get(leg.id) - allocatedKg);
  }

  const arrivalDay = path.arrivalDay;
  const deadline = lot.obligation ? lot.obligation.promisedBy : lot.deliverBy;
  const portCall = designatedPortCall(model, lot.destination, { receivedDay: lot.receivedDay, asOf });
  const nextCall = portCall && arrivalDay != null && arrivalDay > portCall.cutoffDay
    ? nextPortCallAfter(model, lot.destination, portCall.cutoffDay, asOf)
    : null;
  const meetsDeadline = arrivalDay == null ? null : arrivalDay <= deadline;
  const meetsCutoff = portCall ? arrivalDay <= portCall.cutoffDay : null;
  const obligationMet =
    lot.obligation && allocatedKg >= lot.obligation.minKg && arrivalDay <= lot.obligation.promisedBy;

  // 交付窗口：最早到港日与可赶上的船期截期。晚于指定船期时窗口落在下一班。
  const catchableCall =
    portCall && arrivalDay != null && arrivalDay <= portCall.cutoffDay
      ? portCall
      : arrivalDay != null
        ? nextPortCallAfter(model, lot.destination, arrivalDay - 1, asOf)
        : null;
  const deliveryWindow = {
    from: arrivalDay,
    to: catchableCall?.cutoffDay ?? null,
    contractDay: lot.deliverBy,
    cutoffDay: portCall?.cutoffDay ?? null,
    onDesignatedCall: catchableCall != null && catchableCall === portCall,
  };

  let status;
  let reason;
  if (allocatedKg <= 0) {
    status = 'capacity-short';
    reason = `共用段余量不足：需要 ${demandKg} kg，仅余 ${Math.max(0, headroom)} kg`;
  } else if (allocatedKg < demandKg) {
    status = 'partly-loaded';
    // 部分装载本身不是完成；如果这一班也赶不上截期，要同时说出来。
    reason = `可拆批，先装 ${allocatedKg} kg，余 ${demandKg - allocatedKg} kg 待下一班${
      meetsCutoff === false ? `；本班到港第 ${arrivalDay} 日已晚于指定船期截期第 ${portCall.cutoffDay} 日` : ''
    }`;
  } else if (meetsCutoff === false) {
    status = 'misses-cutoff';
    reason = `到港第 ${arrivalDay} 日，晚于指定船期截期第 ${portCall.cutoffDay} 日${nextCall ? `，下一班截期第 ${nextCall.cutoffDay} 日` : '，无后续班期'}`;
  } else if (meetsDeadline === false) {
    status = 'misses-contract';
    reason = `到港第 ${arrivalDay} 日，晚于${lot.obligation ? '承运承诺' : '承诺'}第 ${deadline} 日`;
  } else {
    status = 'allocated';
    reason = `装 ${allocatedKg} kg，第 ${arrivalDay} 日到港`;
  }

  return {
    ...base,
    allocatedKg,
    arrivalDay,
    deadline,
    portCall,
    nextCall,
    deliveryWindow,
    meetsDeadline,
    meetsCutoff,
    obligationMet,
    status,
    reason,
  };
}

function buildStationView({ model, option, chain, railDemand, results, optionLegs }) {
  const floors = collectFloors(model);
  const serviceCounts = loadedServiceCounts(optionLegs);
  const stations = [...new Set(railDemand.map(lot => lot.origin))].sort(
    (a, b) => corridorIndex(a) - corridorIndex(b) || a.localeCompare(b),
  );

  return stations.map(station => {
    const demand = railDemand.filter(lot => lot.origin === station);
    const demandKg = demand.reduce((sum, lot) => sum + lot.physicalRemainingKg, 0);
    const allocated = results.filter(result => result.station === station && result.allocatedKg > 0);
    const allocatedKg = allocated.reduce((sum, result) => sum + result.allocatedKg, 0);
    const floor = floors.find(entry => entry.station === station) ?? null;
    const loadedServices = serviceCounts.get(station) ?? 0;
    const floorMet = floor ? loadedServices >= floor.count : null;
    const smallStation = isSmallStation(demand);

    let note;
    if (!chain.feasible) {
      note = `方案 ${option} 车底衔接不可行，${station} 只有容量与频次预测，不能报为已复运`;
    } else if (loadedServices === 0) {
      note = `方案 ${option} 在 ${station} 无载货服务（空车不计），只有预测受益`;
    } else if (floor && !floorMet) {
      note = `最低站频次未达：需 ${floor.count} 次载货服务，方案只有 ${loadedServices} 次`;
    } else if (allocatedKg === 0) {
      note = `有 ${loadedServices} 次载货服务，但本批未分到载量，只有预测受益`;
    } else {
      note = '已排到载货服务';
    }

    return {
      station,
      smallStation,
      demandKg,
      allocatedKg,
      loadedServices,
      floorCount: floor?.count ?? 0,
      floorMet,
      floorFrom: floor?.from ?? [],
      onPlanRoute: loadedServices > 0,
      // 有载货服务窗口才算守住最低频次；空车不算。
      serviceGuaranteed: chain.feasible && loadedServices > 0 && (floor ? floorMet : true),
      // 未分到载量的小站只是预测受益，不能当成已恢复。
      forecastOnly: !chain.feasible || allocatedKg === 0,
      note,
    };
  });
}

function summarize(results) {
  const demandKg = results.reduce((sum, result) => sum + result.demandKg, 0);
  const allocatedKg = results.reduce((sum, result) => sum + result.allocatedKg, 0);
  const whole = results.filter(result => result.method === 'whole');
  const split = results.filter(result => result.method === 'split');
  return {
    lots: results.length,
    demandKg,
    allocatedKg,
    unmetKg: demandKg - allocatedKg,
    allocatedLots: results.filter(result => result.allocatedKg > 0).length,
    whole: {
      lots: whole.length,
      demandKg: whole.reduce((sum, result) => sum + result.demandKg, 0),
      allocatedKg: whole.reduce((sum, result) => sum + result.allocatedKg, 0),
      satisfied: whole.filter(result => result.allocatedKg >= result.demandKg).length,
    },
    split: {
      lots: split.length,
      demandKg: split.reduce((sum, result) => sum + result.demandKg, 0),
      allocatedKg: split.reduce((sum, result) => sum + result.allocatedKg, 0),
      partial: split.filter(
        result => result.allocatedKg > 0 && result.allocatedKg < result.demandKg,
      ).length,
    },
    missedCutoff: results.filter(result => result.status === 'misses-cutoff').map(result => result.lot),
    missedContract: results.filter(result => result.status === 'misses-contract').map(result => result.lot),
    capacityShort: results.filter(result => result.status === 'capacity-short').map(result => result.lot),
    planInfeasible: results.filter(result => result.status === 'plan-infeasible').map(result => result.lot),
  };
}

/**
 * 冲突与余量：已认领承运承诺在截期前到不了港时，给出缺口、瓶颈段
 * 与可回收的载量，并列出改道/调承诺两个选项。改道未成行前只标 proposed。
 */
export function conflictsOf(model, allocation) {
  const conflicts = [];
  const byLeg = new Map(allocation.legs.map(leg => [leg.id, leg]));

  for (const result of allocation.results) {
    if (!result.obligation) continue;
    if (result.obligationMet) continue;
    const obligation = result.obligation;
    const bottleneck = result.path
      .map(legId => byLeg.get(legId))
      .filter(Boolean)
      .sort((a, b) => a.remainingKg - b.remainingKg)[0] ?? null;
    const competing = allocation.results
      .filter(
        other =>
          other.lot !== result.lot &&
          other.allocatedKg > 0 &&
          other.path.some(leg => result.path.includes(leg)),
      )
      .sort((a, b) => b.allocatedKg - a.allocatedKg)
      .map(other => ({
        lot: other.lot,
        station: other.station,
        allocatedKg: other.allocatedKg,
        whole: other.method === 'whole',
      }));

    conflicts.push({
      lot: result.lot,
      station: result.station,
      type: result.allocatedKg < obligation.minKg ? 'capacity' : 'cutoff',
      requiredKg: obligation.minKg,
      allocatedKg: result.allocatedKg,
      shortfallKg: Math.max(0, obligation.minKg - result.allocatedKg),
      promisedBy: obligation.promisedBy,
      arrivalDay: result.arrivalDay,
      daysLate: result.arrivalDay == null ? null : Math.max(0, result.arrivalDay - obligation.promisedBy),
      bottleneckLeg: bottleneck
        ? { leg: bottleneck.leg, remainingKg: bottleneck.remainingKg, capacityKg: bottleneck.capacityKg }
        : null,
      // 余量 = 瓶颈段剩余 + 同段其它货批已分载量中可回收的部分（需用户决定是否改道/调整）
      spareKg: bottleneck ? bottleneck.remainingKg : null,
      reclaimableKg: competing.reduce((sum, entry) => sum + entry.allocatedKg, 0),
      competingLots: competing,
      options: [
        {
          action: 'reroute',
          status: 'proposed',
          label: '改由公路短驳并在截期前到港；未出现位移记录前不能记为完成',
        },
        {
          action: 'renegotiate',
          status: 'window',
          label: `申请把承运承诺窗口从第 ${obligation.promisedBy} 日后移，或在下一班截期前补运`,
        },
      ],
    });
  }
  return conflicts;
}

/** 候选方案横向比较；service 与 volume 两种计法并排。 */
export function compareOptions(model, { asOf = model.planningAsOf, modes = ['volume', 'service'] } = {}) {
  const rows = [];
  for (const option of model.options) {
    const byMode = {};
    for (const mode of modes) {
      const allocation = allocateOption(model, option, { asOf, mode });
      byMode[mode] = { allocation, conflicts: conflictsOf(model, allocation) };
    }
    rows.push({ option, byMode });
  }

  const summary = rows.map(row => {
    const service = row.byMode.service.allocation;
    const volume = row.byMode.volume.allocation;
    return {
      option: row.option,
      feasible: service.feasible,
      chainIssues: service.chain.issues,
      serviceAllocatedKg: service.totals.allocatedKg,
      volumeAllocatedKg: volume.totals.allocatedKg,
      smallStationLossKg: smallStationLoss(volume, service),
      conflicts: row.byMode.service.conflicts.length,
      stationFloorsMet: service.stationView.filter(station => station.floorMet).length,
      forecastOnlyStations: service.stationView
        .filter(station => station.allocatedKg === 0 && station.demandKg > 0)
        .map(station => station.station),
      missedCutoff: service.totals.missedCutoff,
    };
  });

  const feasibleOptions = rows.filter(row => row.byMode.service?.allocation.feasible).map(row => row.option);
  return {
    asOf,
    options: rows,
    summary,
    feasibleOptions,
    recommendation: recommend(summary, feasibleOptions),
    extrapolation: {
      supported: '仅限本资料覆盖的 A-B-C-P 走廊、同一运输季与该季抽样覆盖',
      notSupported: '没有共同路段或同一季节支持的比较，不能外推到其它走廊、其它季节或未抽样货主群',
    },
  };
}

function smallStationLoss(volume, service) {
  const loss = [];
  for (const station of service.stationView) {
    if (!station.smallStation) continue;
    const volumeRow = volume.stationView.find(entry => entry.station === station.station);
    if (volumeRow && volumeRow.allocatedKg < station.allocatedKg) {
      loss.push({ station: station.station, lostKg: station.allocatedKg - volumeRow.allocatedKg });
    }
  }
  return loss;
}

function recommend(summary, feasibleOptions) {
  const feasible = summary.filter(row => feasibleOptions.includes(row.option));
  if (feasible.length === 0) {
    return {
      option: null,
      reason: '没有车底衔接可行的方案；只能给出容量预测，不能报复运收益',
      alternatives: [],
    };
  }
  const best = feasible
    .slice()
    .sort((a, b) => b.serviceAllocatedKg - a.serviceAllocatedKg || a.conflicts - b.conflicts)[0];
  return {
    option: best.option,
    reason: `在可执行方案中服务口径装车量最高（${best.serviceAllocatedKg} kg），冲突 ${best.conflicts} 项`,
    caveat: '推荐只用于本例路段与季节，不能外推到没有共同路段或不同季节的比较',
    alternatives: feasible.filter(row => row.option !== best.option).map(row => row.option),
  };
}

/**
 * 改道状态：proposed（无位移）< in-transit（有位移、无签收）< completed（有 accepted 签收）。
 * 未成行的改道不能记为完成。
 */
export function rerouteStatus(model, lotId, { asOf = model.receiptAsOf } = {}) {
  const described = describeLot(model, lotId, { asOf });
  const alternate = described.transfers.filter(
    transfer => transfer.kind === 'alternate' || transfer.kind === 'feeder',
  );
  const accepted = described.receipts.filter(receipt => receipt.state === 'accepted');
  const alternateAccepted = accepted.filter(receipt => receipt.mode === 'road');
  let status;
  if (alternateAccepted.length > 0) status = 'completed';
  else if (alternate.length > 0) status = 'in-transit';
  else status = 'proposed';
  return {
    lot: described.lot,
    status,
    label: {
      proposed: '仅提出改道，尚未见位移记录，不能记为完成',
      'in-transit': '已有位移记录但目的站未签收，不能记为交付完成',
      completed: '目的站已按 accepted 签收，改道完成',
    }[status],
    movements: alternate.map(transfer => ({
      line: transfer.line,
      leg: transfer.leg,
      day: transfer.day,
      kg: transfer.kg,
      mode: transfer.mode,
    })),
    acceptedKg: alternateAccepted.reduce((sum, receipt) => sum + receipt.kg, 0),
  };
}

const STATE_LABEL = {
  road: '主动改走公路',
  rejected: '承运商拒收',
  expired: '已收但过期未运',
  accepted: '铁路已收',
  promised: '已认领铁路承诺',
  reported: '已申报待认领',
  delivered: '已交付',
  'partly-delivered': '部分交付',
  'arrived-held': '到站待交',
};

/**
 * 被压抑需求：区分状态、证据等级、路线与抽样覆盖，并带时效。
 * - confirmed 才算确定回流；range 只是可能窗口；unknown 或无意向时间不得计为确定回流。
 * - wet 与 dry 的抽样分母分开，不合并。
 */
export function suppressedDemand(model, { asOf = model.planningAsOf } = {}) {
  const described = model.loads.map(lot => describeLot(model, lot, { asOf }));
  const rows = [];
  for (const lot of described) {
    if (!['road', 'rejected', 'expired'].includes(lot.effectiveState)) continue;
    if (lot.physicalRemainingKg <= 0) continue;
    const survey = lot.survey;
    const hasWindow = survey != null && survey.windowFrom != null && survey.windowTo != null;
    const grade =
      hasWindow && RETURN_GRADES.includes(survey.returnClass) ? survey.returnClass : 'unknown';
    // 回流意向只对已经不在铁路侧的货（主动改走/被拒收）成立；
    // 已收但过期未运是铁路侧未完成的需求，单独列，不能算作“回流”。
    const returnIntentState = ['road', 'rejected'].includes(lot.effectiveState);
    rows.push({
      lot: lot.lot,
      state: lot.effectiveState,
      stateLabel: STATE_LABEL[lot.effectiveState],
      source: returnIntentState ? 'left-rail' : 'rail-unmoved',
      kg: lot.physicalRemainingKg,
      grade,
      certainReturn: returnIntentState && grade === 'confirmed',
      windowFrom: hasWindow ? survey.windowFrom : null,
      windowTo: hasWindow ? survey.windowTo : null,
      evidenceDay: survey?.evidenceDay ?? null,
      evidenceAgeDays: survey ? Math.max(0, asOf - survey.evidenceDay) : null,
      weight: survey?.weight ?? null,
      // 抽样权重只用于公路回流意向；过期未运的铁路需求不用公路调查权重放大。
      weightedKg: survey && returnIntentState ? lot.physicalRemainingKg * survey.weight : null,
      route: lot.route,
      coverage: lot.coverage,
      season: lot.season,
      note: !returnIntentState
        ? '铁路已收但过期未运，属铁路侧未完成需求；无公路回流意向，不计确定回流'
        : grade === 'confirmed'
          ? '有确认的应答窗口，可计入确定回流'
          : grade === 'range'
            ? '可能应答窗口，未通过协议确认，只能作区间'
            : '只有公路记录或无意向时间，不能报成确定回流',
    });
  }

  const byGrade = ['confirmed', 'range', 'unknown'].map(grade => {
    const group = rows.filter(row => row.grade === grade);
    return {
      grade,
      lots: group.length,
      kg: group.reduce((sum, row) => sum + row.kg, 0),
      certainKg: group.filter(row => row.certainReturn).reduce((sum, row) => sum + row.kg, 0),
      withRoute: group.filter(row => row.route.length > 0).length,
      evidenceAgeDays: ageStats(group.map(row => row.evidenceAgeDays).filter(age => age != null)),
    };
  });
  const bySource = ['left-rail', 'rail-unmoved'].map(source => {
    const group = rows.filter(row => row.source === source);
    return {
      source,
      label: source === 'left-rail' ? '已离开铁路（改走/拒收）' : '铁路已收但过期未运',
      lots: group.length,
      kg: group.reduce((sum, row) => sum + row.kg, 0),
      totalKg: group.reduce((sum, row) => sum + row.kg, 0),
      certainKg: group.filter(row => row.certainReturn).reduce((sum, row) => sum + row.kg, 0),
    };
  });

  const confirmed = rows.filter(row => row.certainReturn);
  const possible = rows.filter(row => row.grade === 'range');
  const seasons = [...new Set(rows.map(row => row.season).filter(Boolean))].sort();
  return {
    asOf,
    rows,
    byGrade,
    bySource,
    certainReturnKg: confirmed.reduce((sum, row) => sum + row.kg, 0),
    possibleRangeKg: {
      low: confirmed.reduce((sum, row) => sum + row.kg, 0),
      high:
        confirmed.reduce((sum, row) => sum + row.kg, 0) +
        possible.reduce((sum, row) => sum + row.kg, 0),
    },
    coverageBySeason: seasons.map(season => {
      const group = rows.filter(row => row.season === season);
      const uncovered = group.filter(row => !row.coverage).length;
      const leftRail = group.filter(row => row.source === 'left-rail');
      return {
        season,
        lots: group.length,
        // 只对本季已离开铁路且有调查权重的行加权；无权重或铁路遗留需求按观测值相加并标注。
        weightedKg: leftRail.reduce((sum, row) => sum + (row.weightedKg ?? row.kg), 0),
        observedKg: group.reduce((sum, row) => sum + row.kg, 0),
        railUnmovedKg: group
          .filter(row => row.source === 'rail-unmoved')
          .reduce((sum, row) => sum + row.kg, 0),
        coverage: group.map(row => row.coverage).filter(Boolean),
        uncoveredLots: uncovered,
        note:
          uncovered > 0
            ? '本季有货批没有抽样覆盖，只能报观测值，不能当作本季全量'
            : '本季分子分母只在本季内相加，不与其它季共用抽样分母',
      };
    }),
    timeliness: {
      evidenceAges: rows.map(row => ({ lot: row.lot, evidenceDay: row.evidenceDay, ageDays: row.evidenceAgeDays })),
      note: '证据日期、路线与抽样覆盖随每行带入时效分析',
    },
    caveat: 'unknown 与无意向时间的公路记录不进入确定回流；证据日期、路线与抽样覆盖随行',
  };
}

function ageStats(ages) {
  if (ages.length === 0) return null;
  return { min: Math.min(...ages), max: Math.max(...ages), mean: ages.reduce((a, b) => a + b, 0) / ages.length };
}

/**
 * 按货类与货主规模给出需求与交付时间范围。
 * 指定路段时只计与该段有共同路段的货批；没有共同路段不外推。
 */
export function demandRanges(
  model,
  { asOf = model.planningAsOf, segment = null, season = null, cargo = null, shipperGroup = null } = {},
) {
  const described = model.loads.map(lot => describeLot(model, lot, { asOf }));
  const inSegment = lot =>
    !segment || lotUsesSegment(model, lot, segment, lot.transfers);
  const filtered = described.filter(lot => {
    // 需求范围按登记需求统计，已交付的批仍在范围内，但另列未交付量，避免重复计。
    if (season && lot.season !== season) return false;
    if (cargo && lot.cargo !== cargo) return false;
    if (shipperGroup && lot.shipperGroup !== shipperGroup) return false;
    return inSegment(lot);
  });
  // 未指定货类/货主群时按季汇总覆盖：分子分母不跨季相加。
  const seasonCoverage = new Map();
  for (const lot of described) {
    if (!lot.season || !lot.coverage || !inSegment(lot)) continue;
    if (season && lot.season !== season) continue;
    if (!seasonCoverage.has(lot.season)) seasonCoverage.set(lot.season, []);
    seasonCoverage.get(lot.season).push(lot.coverage);
  }

  const groups = new Map();
  for (const lot of filtered) {
    const key = `${lot.season}|${lot.cargo}|${lot.shipperGroup}`;
    if (!groups.has(key)) {
      groups.set(key, {
        season: lot.season,
        cargo: lot.cargo,
        shipperGroup: lot.shipperGroup,
        lots: [],
        demandKg: 0,
        outstandingKg: 0,
        deliveredLots: [],
        windows: [],
        origins: new Set(),
        coverage: [],
      });
    }
    const group = groups.get(key);
    group.lots.push(lot.lot);
    group.demandKg += lot.kg;
    group.outstandingKg += lot.physicalRemainingKg;
    if (lot.physicalRemainingKg <= 0) group.deliveredLots.push(lot.lot);
    group.windows.push({ from: lot.receivedDay, to: lot.deliverBy });
    group.origins.add(lot.origin);
    if (lot.coverage) group.coverage.push(lot.coverage);
  }

  const rows = [...groups.values()]
    .map(group => ({
      season: group.season,
      cargo: group.cargo,
      shipperGroup: group.shipperGroup,
      lots: group.lots.length,
      lotIds: group.lots,
      demandKg: group.demandKg,
      outstandingKg: group.outstandingKg,
      deliveredLots: group.deliveredLots,
      receiveWindow: {
        from: Math.min(...group.windows.map(window => window.from)),
        to: Math.max(...group.windows.map(window => window.to)),
      },
      origins: [...group.origins].sort(),
      coverage: group.coverage,
      sampleRate: group.coverage.length
        ? group.coverage.reduce((sum, coverage) => sum + (coverage.rate ?? 0), 0) / group.coverage.length
        : null,
    }))
    .sort(
      (a, b) =>
        String(a.season).localeCompare(String(b.season)) ||
        a.cargo.localeCompare(b.cargo) ||
        a.shipperGroup.localeCompare(b.shipperGroup),
    );

  const unsupported = segment
    ? described.filter(lot => !inSegment(lot)).map(lot => lot.lot)
    : [];

  return {
    asOf,
    segment,
    season,
    rows,
    excludedNoCommonSegment: unsupported,
    coverageBySeason: [...seasonCoverage.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, coverages]) => {
        const interviewed = coverages.reduce((sum, coverage) => sum + coverage.interviewed, 0);
        const population = coverages.reduce((sum, coverage) => sum + coverage.eligiblePopulation, 0);
        return {
          season: name,
          rows: coverages.length,
          interviewed,
          eligiblePopulation: population,
          // 只在同一季内相加分子分母；不与另一季合并。
          rate: population > 0 ? interviewed / population : null,
          note: '本季被访数与人群基数只在本季内相加，wet 与 dry 不共用抽样分母',
        };
      }),
    scopeNote: segment
      ? `只统计与本段（${segment}）有共同路段的货批；没有共同路段或同一季节支持的比较不外推`
      : '未指定路段；不同路段/季节之间的差异不能直接外推',
  };
}

/**
 * 方案审议后给货主的本批查询：交付窗口与失约处理原因。
 */
export function lotQuery(model, lotId, { asOf = model.planningAsOf, option = null } = {}) {
  const described = describeLot(model, lotId, { asOf });
  const allocation = option ? allocateOption(model, option, { asOf }) : null;
  const result = allocation?.results.find(entry => entry.lot === lotId) ?? null;
  const conflicts = allocation
    ? conflictsOf(model, allocation).filter(conflict => conflict.lot === lotId)
    : [];
  const portCall =
    result?.portCall ??
    designatedPortCall(model, described.destination, { receivedDay: described.receivedDay, asOf });

  const reasons = [];
  if (result) {
    reasons.push(result.reason);
    if (result.status === 'misses-cutoff') {
      reasons.push(
        `未赶上前一班船期截期，需改配第 ${result.nextCall?.cutoffDay ?? '待定'} 日之后班期或申请调承诺`,
      );
    }
    if (result.status === 'capacity-short') {
      reasons.push('共用路段载量不足，未成行前不能把改道记为完成');
    }
    if (result.status === 'plan-infeasible') {
      reasons.push('本方案车底衔接不可行，不能把本批列为已复运');
    }
  }
  if (['road', 'rejected'].includes(described.effectiveState)) {
    reasons.push(
      described.effectiveState === 'road'
        ? '该批已主动改走公路，铁路侧不作为交付'
        : '承运商拒收，需重新受理或改走',
    );
  }
  if (described.effectiveState === 'expired') {
    reasons.push('铁路已收但过期未运，本批尚未交付');
  }

  return {
    lot: described.lot,
    shipper: described.shipper,
    origin: described.origin,
    destination: described.destination,
    kg: described.kg,
    effectiveState: described.effectiveState,
    stateLabel: STATE_LABEL[described.effectiveState] ?? described.effectiveState,
    railDeliveredKg: described.railDeliveredKg,
    heldKg: described.heldKg,
    physicalRemainingKg: described.physicalRemainingKg,
    deliveryWindow: result?.deliveryWindow ?? {
      from: null,
      to: portCall?.cutoffDay ?? null,
      contractDay: described.deliverBy,
      cutoffDay: portCall?.cutoffDay ?? null,
      onDesignatedCall: null,
    },
    portCall,
    option,
    allocation: result,
    conflicts,
    reasons,
    receiptEvidence: described.receipts.map(receipt => ({
      receipt: receipt.receipt,
      state: receipt.state,
      kg: receipt.kg,
      mode: receipt.mode,
      receivedDay: receipt.receivedDay,
      knownDay: receipt.knownDay,
      countsAsDelivered: receipt.state === 'accepted',
    })),
  };
}

/**
 * 回单核验：用 accepted 的签收量与到站日验证当时预测。
 * 转运、到站待交（held）都不算交付。
 */
export function reconcile(model, { asOf = model.receiptAsOf, option = null } = {}) {
  const predictions = option
    ? new Map(
        allocateOption(model, option, { asOf: model.planningAsOf }).results.map(result => [result.lot, result]),
      )
    : new Map();
  const rows = [];

  for (const load of model.loads) {
    const described = describeLot(model, load, { asOf });
    const accepted = described.receipts.filter(receipt => receipt.state === 'accepted');
    const held = described.receipts.filter(receipt => receipt.state === 'held');
    const prediction = predictions.get(load.lot) ?? null;
    const acceptedKg = accepted.reduce((sum, receipt) => sum + receipt.kg, 0);
    const heldKg = held.reduce((sum, receipt) => sum + receipt.kg, 0);
    const actualArrival = accepted.length ? Math.max(...accepted.map(receipt => receipt.receivedDay)) : null;

    let status;
    if (accepted.length === 0 && held.length > 0) status = 'held-not-delivered';
    else if (accepted.length === 0) status = 'no-receipt';
    else if (acceptedKg >= load.kg) status = 'matched';
    else if (acceptedKg + heldKg >= load.kg) status = 'partly-held';
    else status = 'short-delivered';

    rows.push({
      lot: load.lot,
      predicted: prediction
        ? {
            arrivalDay: prediction.arrivalDay,
            allocatedKg: prediction.allocatedKg,
            status: prediction.status,
          }
        : null,
      actual: {
        acceptedKg,
        acceptedDays: accepted.map(receipt => receipt.receivedDay),
        arrivalDay: actualArrival,
        heldKg,
        modes: [...new Set(accepted.map(receipt => receipt.mode))].sort(),
        transferOnlyKg: accepted.length === 0 ? described.transfers.reduce((sum, transfer) => sum + transfer.kg, 0) : 0,
      },
      status,
      verified:
        accepted.length > 0
          ? {
              kgMatchesPrediction: prediction ? prediction.allocatedKg === acceptedKg : null,
              kgVsLoad: acceptedKg - load.kg,
              arrivedByPrediction:
                prediction && actualArrival != null ? actualArrival <= prediction.arrivalDay : null,
            }
          : null,
      note:
        status === 'held-not-delivered'
          ? '已到站待交，不算交付'
          : status === 'partly-held'
            ? `已签收 ${acceptedKg} kg；另有 ${heldKg} kg 到站待交，仍不算交付`
            : status === 'short-delivered'
              ? heldKg > 0
                ? `已签收 ${acceptedKg} kg，另有 ${heldKg} kg 到站待交（不算交付）`
                : `已签收 ${acceptedKg} kg，少于登记 ${load.kg} kg`
              : accepted.length === 0
                ? described.transfers.length
                ? '只有转运/位移记录，不算交付'
                : '尚未回收目的站回单'
              : '按 accepted 签收核验',
    });
  }

  return {
    asOf,
    option,
    rows,
    deliveredLots: rows.filter(row => row.status === 'matched').length,
    partlyHeldLots: rows.filter(row => row.status === 'partly-held').map(row => row.lot),
    heldOnlyLots: rows.filter(row => row.status === 'held-not-delivered').map(row => row.lot),
    transferOnlyLots: rows.filter(row => row.status === 'no-receipt' && row.actual.transferOnlyKg > 0).map(row => row.lot),
    caveat: '转运与到站待交不能算作交付；核验只用 accepted 的签收公斤与到站日',
  };
}

/** 每期运行图调整前的整体审议包。 */
export function planReview(model, { asOf = model.planningAsOf } = {}) {
  const comparison = compareOptions(model, { asOf });
  return {
    asOf,
    comparison,
    suppressed: suppressedDemand(model, { asOf }),
    demandBySegment: model.options.map(option => {
      const optionLegs = model.legsByOption.get(option) ?? [];
      const segments = [...new Set(optionLegs.filter(leg => !leg.empty).map(leg => leg.leg))].sort();
      return {
        option,
        segments: segments.map(segment => ({
          segment,
          demand: demandRanges(model, { asOf, segment }).rows,
        })),
      };
    }),
    reroutes: model.loads
      .filter(load => ['road', 'rejected'].includes(load.state))
      .map(load => ({
        ...rerouteStatus(model, load.lot, { asOf }),
        // 审议日当时可见的位移与签收；回收日更晚的回单会把状态推进到 completed。
        observedAsOf: asOf,
        latest: rerouteStatus(model, load.lot),
      })),
  };
}
