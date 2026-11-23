/**
 * 交接资料的规范化、索引与单批画像。
 *
 * 业务口径：
 * - 一个 lot 是同一货批；跨站短驳、分段改道仍属于该货批，不产生新需求。
 * - 日期是运输季内的相对日；known_day 是资料在决策时点是否可见的日期。
 * - kg 一律为千克。
 * - 回单里只有 accepted 是交付；held 是到站待交；transfers 只证明位移，不证明交付。
 */

export const RETURN_GRADES = ['confirmed', 'range', 'unknown'];

export function numberOf(value, fallback = 0) {
  if (value === '' || value === '-' || value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function optionalNumber(value) {
  if (value === '' || value === '-' || value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 形如 `B:1|C:2` 的最低站频次。 */
export function parseStationFloors(value) {
  if (!value || value === '-') return [];
  return value
    .split('|')
    .filter(Boolean)
    .map(part => {
      const [station, count] = part.split(':');
      return { station, count: numberOf(count, 1) };
    });
}

export function splitLeg(leg) {
  const [from, to] = leg.split('-');
  return { from, to };
}

function normalizeLoad(row) {
  return {
    lot: row.lot,
    shipper: row.shipper,
    origin: row.origin,
    destination: row.destination,
    kg: numberOf(row.kg),
    receivedDay: numberOf(row.received_day),
    deliverBy: numberOf(row.deliver_by),
    splittable: row.splittable === 'true',
    state: row.state,
  };
}

function normalizeTransfer(row) {
  return {
    line: row.line,
    lot: row.lot,
    leg: row.leg,
    day: numberOf(row.day),
    kg: numberOf(row.kg),
    mode: row.mode,
    kind: row.kind,
  };
}

function normalizeSurvey(row) {
  return {
    lot: row.lot,
    windowFrom: optionalNumber(row.window_from),
    windowTo: optionalNumber(row.window_to),
    returnClass: row.return_class,
    weight: numberOf(row.weight),
    evidenceDay: numberOf(row.evidence_day),
  };
}

export function normalizeLeg(row) {
  const { from, to } = splitLeg(row.leg);
  const empty = row.direction === 'empty' || numberOf(row.max_kg) === 0;
  return {
    // 同一 option 下同一段可能多次开行，用方案+段+发车日+车底区分各次运行。
    id: `${row.option}:${row.leg}:${row.start_day}:${row.vehicle}`,
    option: row.option,
    leg: row.leg,
    from,
    to,
    startDay: numberOf(row.start_day),
    endDay: numberOf(row.end_day),
    maxKg: numberOf(row.max_kg),
    vehicle: row.vehicle,
    direction: row.direction,
    empty,
  };
}

function normalizeReceipt(row) {
  return {
    receipt: row.receipt,
    lot: row.lot,
    station: row.station,
    receivedDay: numberOf(row.received_day),
    knownDay: numberOf(row.known_day),
    kg: numberOf(row.kg),
    mode: row.mode,
    state: row.state,
  };
}

export function createModel(tables) {
  const loads = tables.loads.map(normalizeLoad);
  const lotsById = new Map(loads.map(lot => [lot.lot, lot]));
  const transfers = tables.transfers.map(normalizeTransfer);
  const surveys = tables['road-survey'].map(normalizeSurvey);
  const obligations = tables.obligations.map(row => ({
    lot: row.lot,
    minKg: numberOf(row.min_kg),
    promisedBy: numberOf(row.promised_by),
    acceptanceDay: numberOf(row.acceptance_day),
    floors: parseStationFloors(row.local_station_floor),
  }));
  const portCalls = tables['port-calls'].map(row => ({
    station: row.station,
    cutoffDay: numberOf(row.cutoff_day),
    knownDay: numberOf(row.known_day),
    mode: row.mode,
  }));
  const receipts = tables['shipment-receipts'].map(normalizeReceipt);
  const profiles = new Map(
    tables['freight-profile'].map(row => [
      row.lot,
      {
        lot: row.lot,
        season: row.season,
        cargo: row.cargo,
        shipperGroup: row.shipper_group,
        originPanel: row.origin_panel,
        knownDay: numberOf(row.known_day),
      },
    ]),
  );
  const captures = tables['service-capture'].map(row => ({
    season: row.season,
    station: row.station,
    cargo: row.cargo,
    shipperGroup: row.shipper_group,
    registeredScope: row.registered_scope,
    interviewed: numberOf(row.interviewed),
    eligiblePopulation: numberOf(row.eligible_population),
    knownDay: numberOf(row.known_day),
  }));
  const vehicles = new Map(
    tables['vehicle-rules'].map(row => [
      row.vehicle,
      {
        vehicle: row.vehicle,
        home: row.home,
        availableDay: numberOf(row.available_day),
        totalMassKg: numberOf(row.total_mass_kg),
      },
    ]),
  );
  const legs = tables.legs
    .map(normalizeLeg)
    .sort((a, b) => a.option.localeCompare(b.option) || a.startDay - b.startDay || a.leg.localeCompare(b.leg));
  const legsByOption = new Map();
  for (const leg of legs) {
    if (!legsByOption.has(leg.option)) legsByOption.set(leg.option, []);
    legsByOption.get(leg.option).push(leg);
  }

  const groupBy = (rows, key) => {
    const index = new Map();
    for (const row of rows) {
      const value = typeof key === 'function' ? key(row) : row[key];
      if (!index.has(value)) index.set(value, []);
      index.get(value).push(row);
    }
    return index;
  };

  const planningKnownDays = [
    ...profiles.values(),
    ...captures,
    ...portCalls,
    ...surveys.map(survey => ({ knownDay: survey.evidenceDay })),
    ...obligations.map(obligation => ({ knownDay: obligation.acceptanceDay })),
    ...loads.map(load => ({ knownDay: load.receivedDay })),
  ].map(row => row.knownDay);
  const receiptKnownDays = receipts.map(receipt => receipt.knownDay);

  return {
    tables,
    loads,
    lotsById,
    transfers,
    surveys,
    obligations,
    portCalls,
    receipts,
    profiles,
    captures,
    vehicles,
    legs,
    legsByOption,
    options: [...legsByOption.keys()].sort(),
    indexes: {
      transfersByLot: groupBy(transfers, 'lot'),
      surveyByLot: new Map(surveys.map(survey => [survey.lot, survey])),
      obligationByLot: new Map(obligations.map(obligation => [obligation.lot, obligation])),
      receiptsByLot: groupBy(receipts, 'lot'),
      capturesByStation: groupBy(captures, 'station'),
    },
    // 计划审议只能看到审议日之前已获知的资料；回单另有回收日。
    planningAsOf: planningKnownDays.length ? Math.max(...planningKnownDays) : 0,
    receiptAsOf: receiptKnownDays.length ? Math.max(...receiptKnownDays) : 0,
  };
}

export function knownBy(row, asOf, field = 'knownDay') {
  return row[field] === undefined || row[field] <= asOf;
}

export function findCapture(model, { season, station, cargo, shipperGroup, asOf = Infinity }) {
  return (
    model.captures.find(
      capture =>
        capture.season === season &&
        capture.station === station &&
        capture.cargo === cargo &&
        capture.shipperGroup === shipperGroup &&
        capture.knownDay <= asOf,
    ) ?? null
  );
}

export function coverageOf(capture) {
  if (!capture) return null;
  return {
    interviewed: capture.interviewed,
    eligiblePopulation: capture.eligiblePopulation,
    rate: capture.eligiblePopulation > 0 ? capture.interviewed / capture.eligiblePopulation : null,
    registeredScope: capture.registeredScope,
    knownDay: capture.knownDay,
    season: capture.season,
    source: `${capture.season}/${capture.station}/${capture.cargo}/${capture.shipperGroup}`,
  };
}

/**
 * 线性走廊上某段是否位于货批起讫之间。
 * 需求归属按货批起讫判断；转运记录只说明它当时怎么走，不改变该批对某段的需求。
 */
export function lotUsesSegment(model, lot, segment, _transfers = []) {
  const [from, to] = segment.split('-');
  if (from === lot.origin && to === lot.destination) return true;
  const corridor = ['A', 'B', 'C', 'P'];
  const fromIndex = corridor.indexOf(lot.origin);
  const toIndex = corridor.indexOf(lot.destination);
  const segmentFrom = corridor.indexOf(from);
  const segmentTo = corridor.indexOf(to);
  if ([fromIndex, toIndex, segmentFrom, segmentTo].some(index => index < 0)) {
    return false;
  }
  return fromIndex < toIndex && fromIndex <= segmentFrom && segmentTo <= toIndex;
}

/**
 * 单批在审议时点的画像。amount 的三种口径分开：
 * - physicalRemainingKg：尚未经任何方式交付、也未到站待交的公斤数。
 * - railDeliveredKg：只有铁路签收算铁路交付。
 * - heldKg：到站待交，不算交付。
 */
export function describeLot(model, lotOrId, { asOf = model.planningAsOf } = {}) {
  const lot = typeof lotOrId === 'string' ? model.lotsById.get(lotOrId) : lotOrId;
  if (!lot) throw new Error(`未知货批 ${lotOrId}`);
  const profileRecord = model.profiles.get(lot.lot) ?? null;
  // 资料在 known_day / acceptance_day 之前不能用于当时的决策。
  const profile = profileRecord && profileRecord.knownDay <= asOf ? profileRecord : null;
  const survey = model.indexes.surveyByLot.get(lot.lot) ?? null;
  const obligationRecord = model.indexes.obligationByLot.get(lot.lot) ?? null;
  const obligation = obligationRecord && obligationRecord.acceptanceDay <= asOf ? obligationRecord : null;
  const transfers = (model.indexes.transfersByLot.get(lot.lot) ?? []).filter(
    transfer => transfer.day <= asOf,
  );
  const visibleReceipts = (model.indexes.receiptsByLot.get(lot.lot) ?? []).filter(receipt =>
    knownBy(receipt, asOf),
  );
  const acceptedReceipts = visibleReceipts.filter(receipt => receipt.state === 'accepted');
  const heldReceipts = visibleReceipts.filter(receipt => receipt.state === 'held');
  const anyDeliveredKg = acceptedReceipts.reduce((sum, receipt) => sum + receipt.kg, 0);
  const railDeliveredKg = acceptedReceipts
    .filter(receipt => receipt.mode === 'rail')
    .reduce((sum, receipt) => sum + receipt.kg, 0);
  const heldKg = heldReceipts.reduce((sum, receipt) => sum + receipt.kg, 0);
  const physicalRemainingKg = Math.max(0, lot.kg - anyDeliveredKg - heldKg);
  const railLoaded = transfers.filter(
    transfer => transfer.mode === 'rail' && transfer.kind === 'loaded',
  );
  const state = deriveState({
    lot,
    deliveredKg: anyDeliveredKg,
    heldKg,
    railLoaded,
    asOf,
    physicalRemainingKg,
  });
  const capture = profile
    ? findCapture(model, {
        season: profile.season,
        station: lot.origin,
        cargo: profile.cargo,
        shipperGroup: profile.shipperGroup,
        asOf,
      })
    : null;

  return {
    lot: lot.lot,
    shipper: lot.shipper,
    origin: lot.origin,
    destination: lot.destination,
    kg: lot.kg,
    receivedDay: lot.receivedDay,
    deliverBy: lot.deliverBy,
    splittable: lot.splittable,
    loadState: lot.state,
    profile,
    season: profile?.season ?? null,
    cargo: profile?.cargo ?? null,
    shipperGroup: profile?.shipperGroup ?? null,
    survey: survey && survey.evidenceDay <= asOf ? survey : null,
    obligation,
    transfers,
    receipts: visibleReceipts,
    deliveredKg: anyDeliveredKg,
    railDeliveredKg,
    heldKg,
    physicalRemainingKg,
    railLoaded,
    lastRailDay: railLoaded.length ? Math.max(...railLoaded.map(transfer => transfer.day)) : null,
    effectiveState: state,
    route: buildRoute(lot, transfers),
    coverage: coverageOf(capture),
    capture,
  };
}

function deriveState({ lot, deliveredKg, heldKg, railLoaded, asOf, physicalRemainingKg }) {
  // 只有 accepted 覆盖全部登记量、且没有待交余量，才算整批交付。
  if (deliveredKg > 0 && heldKg === 0 && physicalRemainingKg === 0) return 'delivered';
  if (deliveredKg > 0) return 'partly-delivered';
  if (heldKg > 0 && physicalRemainingKg === 0) return 'arrived-held';
  if (['accepted', 'promised', 'reported'].includes(lot.state)) {
    if (railLoaded.length === 0 && asOf > lot.deliverBy) return 'expired';
  }
  return lot.state;
}

function buildRoute(lot, transfers) {
  if (transfers.length > 0) {
    return transfers
      .slice()
      .sort((a, b) => a.day - b.day)
      .map(transfer => transfer.leg);
  }
  return [`${lot.origin}-${lot.destination}`];
}

