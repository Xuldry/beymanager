// BeyManager scoring engine v2.
//
// Replaces the old "sum atk+def+sta" model, which rewarded generalists.
// There is no single "best combo" — scoring happens once per role
// (attack/stamina/defense) against a role-specific weight vector.
//
// CORE CONSTRAINT: Beyblade X publishes no owd/recoil/grip/burst numbers for
// any part. This engine never invents an absolute number for those. Instead:
//   - every uncertain stat is {value, source, confidence}, source one of
//     "measured" (user typed it in) | "learned" (inferred from battle log)
//     | "ranked" (user's own ordinal ordering) | "default" (built-in guess)
//   - grip/recoil/burst are ORDINAL: the user maintains a short ordered list
//     of parts they actually own, and value = rank position in that list,
//     never a number they have to invent themselves. Parts not yet ranked
//     fall back to a full bootstrap ordering (still ordinal, still no
//     invented absolute magnitude) so scoring works before any ranking
//     exists at all.
//   - resolution priority for every stat: measured > learned > ranked > default.
(function () {
  'use strict';

  // ================= tunable config =================

  var DEFAULT_ROLE_WEIGHTS = {
    attack:  { atk: 0.5, xdash: 0.25, burst: 0.15, sta: 0.05, def: 0.05 },
    stamina: { sta: 0.5, burst: 0.2, def: 0.2, xdash: 0.1 },
    defense: { def: 0.4, burst: 0.3, sta: 0.2, atk: 0.1 }
  };

  // Normalized 0-10 (half the old 0-100 engine, to match owd/recoil/grip/burst's scale).
  var TYPE_BASE = {
    Attack:  { atk: 7,   def: 1.5, sta: 1.5 },
    Defense: { atk: 1.5, def: 7,   sta: 1.5 },
    Stamina: { atk: 1.5, def: 1.5, sta: 7   },
    Balance: { atk: 3.3, def: 3.4, sta: 3.3 }
  };

  // UX/CX use plastic launcher-hook engagement (needs more outward mass to
  // stay locked in); BX's metal-driver system doesn't, hence "BX low".
  var OWD_BY_LINE = { BX: 3, UX: 7, CX: 7 };

  var SHAPE_TIER = { sharp: 0, round: 1, other: 2, flat: 3 };
  var TYPE_TIER = { Stamina: 0, Defense: 1, Balance: 2, Attack: 3 };

  var CONFIDENCE = { default: 0.3, ranked: 0.6, measured: 0.9, learnedBase: 0.3, learnedCap: 0.85 };

  var LEARN = { rate: 1.2, attributionBoost: 2.5, sampleCap: 12 };

  var RANGE_SCALE = 0.35;      // max +/- swing at zero confidence
  var RANGE_CONFIDENCE_FLOOR = 0.85; // at/above this avg confidence, show a precise number

  var PENALTIES = [
    {
      name: 'burstRisk',
      reason: 'Low-burst-resistance ratchet — this combo pops out easily.',
      factor: 0.6,
      test: function (m, parts) { return parts.ratchetStats && parts.ratchetStats.burst.value <= 3; }
    },
    {
      name: 'heightCoherence',
      reason: 'A high-grip (attack) bit on a tall ratchet fights its own attack angle.',
      factor: 0.75,
      test: function (m, parts) {
        return !!(parts.bitStats && parts.bitStats.grip.value >= 7 &&
          parts.ratchet && typeof parts.ratchet.heightTenths === 'number' && parts.ratchet.heightTenths >= 70);
      }
    },
    {
      name: 'recoilGrip',
      reason: 'High-recoil blade on a high-grip bit — the blade throws itself off its own rebound.',
      factor: 0.8,
      test: function (m, parts) { return m.recoil >= 7 && !!(parts.bitStats && parts.bitStats.grip.value >= 7); }
    }
  ];

  // ================= helpers =================
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function shapeTier(shape) { var t = SHAPE_TIER[(shape || '').toLowerCase()]; return t != null ? t : SHAPE_TIER.other; }
  function typeTier(type) { var t = TYPE_TIER[type]; return t != null ? t : TYPE_TIER.Balance; }
  function stat(value, source, confidence) { return { value: round1(value), source: source, confidence: round2(confidence) }; }

  // ================= store-backed ordinal lists & overrides =================
  // `store` here is BeyManager's existing localStorage-backed object, passed
  // in once via init() so this module has no direct localStorage dependency
  // of its own (keeps it testable headless, e.g. from Node).
  var _store = null;
  function init(store) { _store = store; ensureShape(store); return store; }

  function ensureShape(s) {
    if (!s.ordinalLists) s.ordinalLists = {};
    ['bladeRecoil', 'ratchetBurst', 'bitGrip', 'bitBurst'].forEach(function (axis) {
      if (!Array.isArray(s.ordinalLists[axis])) s.ordinalLists[axis] = [];
    });
    if (!s.measuredOverrides) s.measuredOverrides = { blades: {}, ratchets: {}, bits: {} };
    ['blades', 'ratchets', 'bits'].forEach(function (cat) { if (!s.measuredOverrides[cat]) s.measuredOverrides[cat] = {}; });
    if (!s.learnedStats) s.learnedStats = { blades: {}, ratchets: {}, bits: {} };
    ['blades', 'ratchets', 'bits'].forEach(function (cat) { if (!s.learnedStats[cat]) s.learnedStats[cat] = {}; });
    if (!s.weightOverrides) s.weightOverrides = {};
    if (!Array.isArray(s.battles)) s.battles = [];
    return s;
  }

  function roleWeights(role) {
    var override = _store && _store.weightOverrides && _store.weightOverrides[role];
    var base = DEFAULT_ROLE_WEIGHTS[role];
    if (!override) return base;
    var merged = {};
    Object.keys(base).forEach(function (k) { merged[k] = typeof override[k] === 'number' ? override[k] : base[k]; });
    return merged;
  }

  function rankValueInList(list, id) {
    var idx = list.indexOf(id);
    if (idx === -1) return null;
    var denom = Math.max(1, list.length - 1);
    return (idx / denom) * 10;
  }

  // Full bootstrap ordering over ALL parts of a kind — used only as the
  // fallback for parts the user hasn't ranked yet. Purely ordinal (position
  // only), so it never asserts an absolute magnitude either.
  function bootstrapOrder(parts, keyFn) {
    return parts.slice().sort(function (a, b) {
      var ka = keyFn(a), kb = keyFn(b);
      for (var i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
      return String(a.id).localeCompare(String(b.id));
    }).map(function (p) { return p.id; });
  }

  function bootstrapBladeRecoilOrder(blades) {
    return bootstrapOrder(blades, function (b) {
      var w = typeof b.weight === 'number' ? b.weight : 34;
      return [typeTier(b.type), -w]; // heavier = slightly lower recoil, within same type tier
    });
  }
  function bootstrapRatchetBurstOrder(ratchets) {
    // Ascending sort -> low index = low value(0), high index = high value(10).
    // More protrusions + lower height should rank HIGH (more burst-resistant),
    // so the key must increase with protrusions and decrease with height.
    return bootstrapOrder(ratchets, function (r) {
      if (r.isMetal) return [999]; // metal ratchets: built for burst resistance, sort to the very top
      var protrusions = r.protrusions != null ? r.protrusions : 0;
      var height = r.heightTenths != null ? r.heightTenths : 70;
      return [protrusions * 5 - height];
    });
  }
  function bootstrapBitGripOrder(bits) {
    return bootstrapOrder(bits, function (b) { return [shapeTier(b.shape), typeTier(b.type)]; });
  }
  function bootstrapBitBurstOrder(bits) {
    // Ascending sort -> low index = low value(0). Flat tips are built to
    // catch the stadium rail on purpose, so they're the most burst-prone
    // (lowest burst *resistance*, ranks first); round tips spin smoothly
    // and rarely catch/pop (highest resistance, ranks last).
    var tier = { flat: 0, sharp: 1, other: 1, round: 2 };
    return bootstrapOrder(bits, function (b) { return [tier[(b.shape || '').toLowerCase()] != null ? tier[(b.shape || '').toLowerCase()] : 1]; });
  }

  function bootstrapOrderFor(axis, blades, ratchets, bits) {
    if (axis === 'bladeRecoil') return bootstrapBladeRecoilOrder(blades);
    if (axis === 'ratchetBurst') return bootstrapRatchetBurstOrder(ratchets);
    if (axis === 'bitGrip') return bootstrapBitGripOrder(bits);
    if (axis === 'bitBurst') return bootstrapBitBurstOrder(bits);
    return [];
  }

  // Resolves one ordinal axis (recoil/grip/burst) for one part, checking the
  // user's own ranked list first, then the bootstrap fallback order.
  function resolveOrdinal(axis, id, bootstrapCache) {
    var userList = _store.ordinalLists[axis];
    var v = rankValueInList(userList, id);
    if (v != null) return stat(v, 'ranked', CONFIDENCE.ranked);
    v = rankValueInList(bootstrapCache[axis], id);
    return stat(v != null ? v : 5, 'default', CONFIDENCE.default);
  }

  function resolveMeasured(cat, id, field) {
    var m = _store.measuredOverrides[cat][id];
    return m && typeof m[field] === 'number' ? m[field] : null;
  }

  function resolveLearned(cat, id, field) {
    var l = _store.learnedStats[cat][id];
    return l && l[field] ? l[field] : null; // {value, sampleSize}
  }

  // Generic resolver: measured > learned > (ordinal | formula default).
  function resolveField(cat, id, field, ordinalAxis, formulaFn, bootstrapCache) {
    var measured = resolveMeasured(cat, id, field);
    if (measured != null) return stat(measured, 'measured', CONFIDENCE.measured);
    var learned = resolveLearned(cat, id, field);
    if (learned) {
      var conf = clamp(CONFIDENCE.learnedBase + Math.min(learned.sampleSize, LEARN.sampleCap) * 0.045, CONFIDENCE.learnedBase, CONFIDENCE.learnedCap);
      return stat(learned.value, 'learned', conf);
    }
    if (ordinalAxis) return resolveOrdinal(ordinalAxis, id, bootstrapCache);
    return stat(formulaFn(), 'default', CONFIDENCE.default);
  }

  // ================= schema enrichment =================
  // Attaches plain measured/parsed fields once (idempotent); provenance-
  // wrapped stats are resolved fresh each call to pick up live overrides
  // and learned updates without needing to re-enrich.

  function enrichBladeShape(blade) {
    if (blade._shaped) return blade;
    blade.weightGrams = typeof blade.weight === 'number' ? blade.weight : null;
    blade.line = blade.isCX ? 'CX'
      : (blade.productCode && /^UX/.test(blade.productCode)) ? 'UX'
      : (blade.productCode && /^CX/.test(blade.productCode)) ? 'CX'
      : 'BX';
    blade._shaped = true;
    return blade;
  }

  function enrichRatchetShape(ratchet) {
    if (ratchet._shaped) return ratchet;
    var m = /^([0-9]+|M)-([0-9]+)/.exec(ratchet.id || '');
    ratchet.protrusions = m && m[1] !== 'M' ? parseInt(m[1], 10) : null;
    ratchet.heightTenths = typeof ratchet.height === 'number' ? ratchet.height : (m ? parseInt(m[2], 10) : null);
    ratchet._shaped = true;
    return ratchet;
  }

  function enrichBitShape(bit) {
    if (bit._shaped) return bit;
    var raw = bit.gearTeeth;
    bit.teeth = raw === 10 || raw === 12 || raw === 16 ? raw
      : (typeof raw === 'number' && raw >= 14) ? 16
      : (typeof raw === 'number' && raw <= 11) ? 10
      : 12; // undocumented on many bits — default to the common middle
    bit._shaped = true;
    return bit;
  }

  function shapeAllParts(blades, ratchets, bits) {
    (blades || []).forEach(enrichBladeShape);
    (ratchets || []).forEach(enrichRatchetShape);
    (bits || []).forEach(enrichBitShape);
  }

  // ================= live stat resolution =================
  // Call these at scoring time (not at load time) so measured/learned/ranked
  // edits made in the UI take effect immediately without re-enriching.

  function bladeStats(blade, bootstrapCache) {
    enrichBladeShape(blade);
    var base = TYPE_BASE[blade.type] || TYPE_BASE.Balance;
    var owdDefault = function () {
      var v = OWD_BY_LINE[blade.line] != null ? OWD_BY_LINE[blade.line] : 5;
      var w = typeof blade.weight === 'number' ? blade.weight : 34;
      return clamp(v + (w - 34) * 0.1, 0, 10);
    };
    var atkDefault = function () {
      var v = base.atk;
      if (typeof blade.contactPoints === 'number') v = v; // contactPoints affects def, not atk
      return clamp(v, 0, 10);
    };
    var defDefault = function () { return clamp(base.def + (typeof blade.contactPoints === 'number' ? blade.contactPoints * 0.15 : 0), 0, 10); };
    var staDefault = function () { return clamp(base.sta, 0, 10); };
    return {
      owd: resolveField('blades', blade.id, 'owd', null, owdDefault),
      recoil: resolveField('blades', blade.id, 'recoil', 'bladeRecoil', function () { return 5; }, bootstrapCache),
      atk: resolveField('blades', blade.id, 'atk', null, atkDefault),
      def: resolveField('blades', blade.id, 'def', null, defDefault),
      sta: resolveField('blades', blade.id, 'sta', null, staDefault)
    };
  }

  function ratchetStatsOf(ratchet, bootstrapCache) {
    enrichRatchetShape(ratchet);
    var base = TYPE_BASE[ratchet.type] || TYPE_BASE.Balance;
    var cpNum = ratchet.protrusions != null ? ratchet.protrusions : (ratchet.isMetal ? 5 : 0);
    var atkDefault = function () { return clamp(base.atk + (ratchet.heightTenths != null && ratchet.heightTenths >= 75 ? 0.8 : 0), 0, 10); };
    var defDefault = function () {
      var v = base.def + cpNum * 0.3;
      if (ratchet.heightTenths != null && ratchet.heightTenths > 55 && ratchet.heightTenths < 75) v += 0.4;
      return clamp(v, 0, 10);
    };
    var staDefault = function () { return clamp(base.sta + (ratchet.heightTenths != null && ratchet.heightTenths <= 55 ? 0.8 : 0), 0, 10); };
    return {
      burst: resolveField('ratchets', ratchet.id, 'burst', 'ratchetBurst', function () { return 5; }, bootstrapCache),
      atk: resolveField('ratchets', ratchet.id, 'atk', null, atkDefault),
      def: resolveField('ratchets', ratchet.id, 'def', null, defDefault),
      sta: resolveField('ratchets', ratchet.id, 'sta', null, staDefault)
    };
  }

  function bitStatsOf(bit, bootstrapCache) {
    enrichBitShape(bit);
    var base = TYPE_BASE[bit.type] || TYPE_BASE.Balance;
    var shape = (bit.shape || '').toLowerCase();
    var atkDefault = function () {
      var v = base.atk;
      if (typeof bit.gearTeeth === 'number') v += bit.gearTeeth * 0.08;
      if (shape === 'flat') v += 1;
      return clamp(v, 0, 10);
    };
    var defDefault = function () { return clamp(base.def + (shape === 'sharp' ? 0.8 : 0), 0, 10); };
    var staDefault = function () { return clamp(base.sta + (shape === 'round' ? 1 : 0), 0, 10); };
    return {
      grip: resolveField('bits', bit.id, 'grip', 'bitGrip', function () { return 5; }, bootstrapCache),
      burst: resolveField('bits', bit.id, 'burst', 'bitBurst', function () { return 5; }, bootstrapCache),
      atk: resolveField('bits', bit.id, 'atk', null, atkDefault),
      def: resolveField('bits', bit.id, 'def', null, defDefault),
      sta: resolveField('bits', bit.id, 'sta', null, staDefault)
    };
  }

  function buildBootstrapCache(blades, ratchets, bits) {
    return {
      bladeRecoil: bootstrapBladeRecoilOrder(blades),
      ratchetBurst: bootstrapRatchetBurstOrder(ratchets),
      bitGrip: bootstrapBitGripOrder(bits),
      bitBurst: bootstrapBitBurstOrder(bits)
    };
  }

  // ================= combo metrics & scoring =================

  function xdashOf(bitStatsResolved) {
    var teethNorm = clamp(((bitStatsResolved.teeth - 10) / 6) * 10, 0, 10);
    return clamp(teethNorm * 0.5 + bitStatsResolved.grip.value * 0.5, 0, 10);
  }

  // bladeAgg: resolved stats for one blade, or averaged across CX lock/main/assist.
  function aggregateBladeStats(list) {
    var keys = ['owd', 'recoil', 'atk', 'def', 'sta'];
    var acc = { owd: 0, recoil: 0, atk: 0, def: 0, sta: 0 };
    var confAcc = { owd: 0, recoil: 0, atk: 0, def: 0, sta: 0 };
    // For CX (3 blades averaged), the badge should reflect the weakest link,
    // not silently drop provenance — show whichever contributor is least
    // confident about this field, since that's the real limiting factor.
    var weakest = { owd: null, recoil: null, atk: null, def: null, sta: null };
    list.forEach(function (s) {
      keys.forEach(function (k) {
        acc[k] += s[k].value; confAcc[k] += s[k].confidence;
        if (!weakest[k] || s[k].confidence < weakest[k].confidence) weakest[k] = s[k];
      });
    });
    var n = list.length || 1;
    var out = {};
    keys.forEach(function (k) {
      out[k] = { value: acc[k] / n, confidence: confAcc[k] / n, source: weakest[k] ? weakest[k].source : 'default' };
    });
    return out;
  }

  function comboMetrics(bladeAgg, ratchetStats, bitStatsResolved) {
    var teeth = bitStatsResolved.teeth != null ? bitStatsResolved.teeth : 12;
    var xdash = clamp((((teeth - 10) / 6) * 10) * 0.5 + bitStatsResolved.grip.value * 0.5, 0, 10);
    return {
      atk: bladeAgg.atk.value * 0.5 + ratchetStats.atk.value * 0.25 + bitStatsResolved.atk.value * 0.25,
      def: bladeAgg.def.value * 0.5 + ratchetStats.def.value * 0.25 + bitStatsResolved.def.value * 0.25,
      sta: bladeAgg.sta.value * 0.5 + ratchetStats.sta.value * 0.25 + bitStatsResolved.sta.value * 0.25,
      xdash: xdash,
      burst: ratchetStats.burst.value * 0.7 + bitStatsResolved.burst.value * 0.3,
      recoil: bladeAgg.recoil.value,
      owd: bladeAgg.owd.value
    };
  }

  function weightedSum(metrics, weights) {
    var sum = 0;
    Object.keys(weights).forEach(function (k) { sum += (metrics[k] || 0) * weights[k]; });
    return sum;
  }

  function applyPenalties(metrics, parts) {
    var multiplier = 1, fired = [];
    PENALTIES.forEach(function (p) {
      if (p.test(metrics, parts)) { multiplier *= p.factor; fired.push({ name: p.name, factor: p.factor, reason: p.reason }); }
    });
    return { multiplier: multiplier, fired: fired };
  }

  // Confidence-weighted uncertainty -> +/- display range. High-confidence
  // combos (mostly measured/well-sampled-learned stats) get a precise
  // number; shaky ones get an honest range instead of a fake-precise digit.
  function uncertaintyRange(score, weights, bladeAgg, ratchetStats, bitStatsResolved) {
    var confSum = 0, wSum = 0;
    var confByKey = {
      atk: (bladeAgg.atk.confidence + ratchetStats.atk.confidence + bitStatsResolved.atk.confidence) / 3,
      def: (bladeAgg.def.confidence + ratchetStats.def.confidence + bitStatsResolved.def.confidence) / 3,
      sta: (bladeAgg.sta.confidence + ratchetStats.sta.confidence + bitStatsResolved.sta.confidence) / 3,
      burst: (ratchetStats.burst.confidence + bitStatsResolved.burst.confidence) / 2,
      xdash: bitStatsResolved.grip.confidence
    };
    Object.keys(weights).forEach(function (k) {
      var c = confByKey[k] != null ? confByKey[k] : 0.5;
      confSum += c * weights[k]; wSum += weights[k];
    });
    var avgConfidence = wSum ? confSum / wSum : 0.5;
    if (avgConfidence >= RANGE_CONFIDENCE_FLOOR) return null;
    var half = Math.abs(score) * (1 - avgConfidence) * RANGE_SCALE;
    return { low: round2(score - half), high: round2(score + half), avgConfidence: round2(avgConfidence) };
  }

  // Public: score one combo for one role.
  // blade2/blade3 present only for CX (lock/main/assist averaged).
  function scoreCombo(role, blade, ratchet, bit, blade2, blade3, bootstrapCache) {
    var weights = roleWeights(role);
    if (!weights) throw new Error('Unknown role: ' + role);
    bootstrapCache = bootstrapCache || { bladeRecoil: [], ratchetBurst: [], bitGrip: [], bitBurst: [] };

    var bladeList = [blade, blade2, blade3].filter(Boolean).map(function (b) { return bladeStats(b, bootstrapCache); });
    var bladeAgg = aggregateBladeStats(bladeList);
    var rStats = ratchetStatsOf(ratchet, bootstrapCache);
    var bStats = bitStatsOf(bit, bootstrapCache);

    var m = comboMetrics(bladeAgg, rStats, bStats);
    var base = weightedSum(m, weights);
    var pen = applyPenalties(m, { ratchet: ratchet, bit: bit, ratchetStats: rStats, bitStats: bStats });
    var score = round2(base * pen.multiplier);
    var range = uncertaintyRange(score, weights, bladeAgg, rStats, bStats);

    return {
      role: role,
      metrics: m,
      baseScore: round2(base),
      penalties: pen.fired,
      penaltyMultiplier: round2(pen.multiplier),
      score: score,
      range: range,
      bladeStats: bladeAgg,
      ratchetStats: rStats,
      bitStats: bStats
    };
  }

  function scoreComboAllRoles(blade, ratchet, bit, blade2, blade3, bootstrapCache) {
    var out = {};
    Object.keys(DEFAULT_ROLE_WEIGHTS).forEach(function (role) {
      out[role] = scoreCombo(role, blade, ratchet, bit, blade2, blade3, bootstrapCache);
    });
    return out;
  }

  // Old model, kept only for the Compare view (section 7f) — sums all three
  // stats with no role weighting, no xdash/burst, no penalties.
  function scoreComboOldSum(blade, ratchet, bit, blade2, blade3, bootstrapCache) {
    bootstrapCache = bootstrapCache || { bladeRecoil: [], ratchetBurst: [], bitGrip: [], bitBurst: [] };
    var bladeList = [blade, blade2, blade3].filter(Boolean).map(function (b) { return bladeStats(b, bootstrapCache); });
    var bladeAgg = aggregateBladeStats(bladeList);
    var rStats = ratchetStatsOf(ratchet, bootstrapCache);
    var bStats = bitStatsOf(bit, bootstrapCache);
    var atk = bladeAgg.atk.value * 0.5 + rStats.atk.value * 0.25 + bStats.atk.value * 0.25;
    var def = bladeAgg.def.value * 0.5 + rStats.def.value * 0.25 + bStats.def.value * 0.25;
    var sta = bladeAgg.sta.value * 0.5 + rStats.sta.value * 0.25 + bStats.sta.value * 0.25;
    return round2(atk + def + sta);
  }

  // ================= battle log -> Elo-style learning =================

  // currentValueHint: the stat's true currently-resolved value (from
  // measured/ranked/default) BEFORE this touch — used only to seed the very
  // first learned update. Without this, a part whose real default/ranked
  // value is far from a neutral midpoint (e.g. a flat bit's grip defaults to
  // 8, not 5) would get silently and incorrectly reset to 5 the instant a
  // battle first touches it, before the delta is even applied.
  function bumpLearned(cat, id, field, direction, boosted, currentValueHint) {
    var store = _store;
    var bucket = store.learnedStats[cat][id] || {};
    var current = bucket[field];
    var sampleSize = current ? current.sampleSize : 0;
    var baseValue = current ? current.value : (currentValueHint != null ? currentValueHint : 5);
    var delta = direction * LEARN.rate * (boosted ? LEARN.attributionBoost : 1) / (1 + sampleSize * 0.5);
    bucket[field] = { value: clamp(round1(baseValue + delta), 0, 10), sampleSize: sampleSize + 1 };
    store.learnedStats[cat][id] = bucket;
  }

  // combo: {isCX, blade, lock, main, assist, ratchet, bit}. Returns the list
  // of blade ids in it (1, or 3 for CX) for changedPart comparison.
  function comboBladeIds(combo) {
    return combo.isCX ? [combo.lock, combo.main, combo.assist].filter(Boolean) : [combo.blade].filter(Boolean);
  }

  function detectChangedPart(comboA, comboB) {
    if (!comboA || !comboB || comboA.isCX !== comboB.isCX) return null;
    var diffs = [];
    if (comboA.isCX) {
      if (comboA.lock !== comboB.lock) diffs.push({ cat: 'blades', id: comboA.lock, otherId: comboB.lock });
      if (comboA.main !== comboB.main) diffs.push({ cat: 'blades', id: comboA.main, otherId: comboB.main });
      if (comboA.assist !== comboB.assist) diffs.push({ cat: 'blades', id: comboA.assist, otherId: comboB.assist });
    } else if (comboA.blade !== comboB.blade) diffs.push({ cat: 'blades', id: comboA.blade, otherId: comboB.blade });
    if (comboA.ratchet !== comboB.ratchet) diffs.push({ cat: 'ratchets', id: comboA.ratchet, otherId: comboB.ratchet });
    if (comboA.bit !== comboB.bit) diffs.push({ cat: 'bits', id: comboA.bit, otherId: comboB.bit });
    return diffs.length === 1 ? diffs[0] : null;
  }

  // Applies one battle's outcome to learnedStats in place. `battle` is
  // {comboA, comboB, winner: "A"|"B", finish, changedPart?}. changedPart, if
  // not supplied, is auto-detected when the two combos differ by exactly
  // one part — when known, credit/blame goes to *only* that part instead of
  // diffusing across the whole winning/losing combo.
  // resolveCurrent(cat, id, field) -> number: the caller's job (app.js has
  // the actual part database + bootstrap cache; this module deliberately
  // doesn't) — returns the stat's true current value so the first learned
  // touch seeds from reality instead of a blind guess. Safe to omit; falls
  // back to a neutral 5 (same as never having any part-specific baseline).
  function applyBattleResult(battle, resolveCurrent) {
    var winnerCombo = battle.winner === 'A' ? battle.comboA : battle.comboB;
    var loserCombo = battle.winner === 'A' ? battle.comboB : battle.comboA;
    var changed = battle.changedPart || detectChangedPart(battle.comboA, battle.comboB);

    function touch(cat, id, field, direction) {
      if (!id) return;
      var isChangedTarget = changed && changed.cat === cat && (changed.id === id);
      if (changed && !isChangedTarget) return; // attribute solely to the isolated variable when we know it
      var hint = resolveCurrent ? resolveCurrent(cat, id, field) : null;
      bumpLearned(cat, id, field, direction, !!changed, hint);
    }

    if (battle.finish === 'xtreme') {
      comboBladeIds(winnerCombo).forEach(function (id) { touch('blades', id, 'atk', +1); });
      touch('bits', winnerCombo.bit, 'grip', +1);
    } else if (battle.finish === 'burst') {
      comboBladeIds(winnerCombo).forEach(function (id) { touch('blades', id, 'atk', +1); });
      touch('ratchets', loserCombo.ratchet, 'burst', -1);
      touch('bits', loserCombo.bit, 'burst', -1);
    } else if (battle.finish === 'spinout') {
      comboBladeIds(winnerCombo).forEach(function (id) { touch('blades', id, 'sta', +1); });
    }
  }

  window.BeyScoring = {
    DEFAULT_ROLE_WEIGHTS: DEFAULT_ROLE_WEIGHTS,
    PENALTIES: PENALTIES,
    init: init,
    ensureShape: ensureShape,
    shapeAllParts: shapeAllParts,
    buildBootstrapCache: buildBootstrapCache,
    bladeStats: bladeStats,
    ratchetStatsOf: ratchetStatsOf,
    bitStatsOf: bitStatsOf,
    roleWeights: roleWeights,
    scoreCombo: scoreCombo,
    scoreComboAllRoles: scoreComboAllRoles,
    scoreComboOldSum: scoreComboOldSum,
    detectChangedPart: detectChangedPart,
    applyBattleResult: applyBattleResult,
    rankValueInList: rankValueInList,
    bootstrapOrderFor: bootstrapOrderFor
  };
})();
