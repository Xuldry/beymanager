// BeyManager built-in combo estimates.
//
// Produces the three per-role (attack/stamina/defense) estimate scores shown
// on saved combos. Beyblade X publishes no owd/recoil/grip/burst numbers, so
// everything here is a built-in default derived from part type/shape/weight
// (ordinal where no number exists) — a rough sorting aid, not a verdict.
// The old tuning layer (user-measured values, battle-learned values, ranked
// lists, weight overrides) was removed; nothing reads those store fields.
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

  var CONFIDENCE = { default: 0.3 };

  // ================= helpers =================
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function shapeTier(shape) { var t = SHAPE_TIER[(shape || '').toLowerCase()]; return t != null ? t : SHAPE_TIER.other; }
  function typeTier(type) { var t = TYPE_TIER[type]; return t != null ? t : TYPE_TIER.Balance; }
  function stat(value, source, confidence) { return { value: round1(value), source: source, confidence: round2(confidence) }; }

  function roleWeights(role) { return DEFAULT_ROLE_WEIGHTS[role]; }

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

  // Resolves one ordinal axis (recoil/grip/burst) for one part from the
  // built-in bootstrap ordering (position in that list -> 0-10).
  function resolveOrdinal(axis, id, bootstrapCache) {
    var v = rankValueInList(bootstrapCache[axis], id);
    return stat(v != null ? v : 5, 'default', CONFIDENCE.default);
  }

  function resolveField(cat, id, field, ordinalAxis, formulaFn, bootstrapCache) {
    if (ordinalAxis) return resolveOrdinal(ordinalAxis, id, bootstrapCache);
    return stat(formulaFn(), 'default', CONFIDENCE.default);
  }

  // ================= schema enrichment =================
  // Attaches plain parsed fields once (idempotent).

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
      sta: resolveField('bits', bit.id, 'sta', null, staDefault),
      teeth: bit.teeth
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
    if (!ratchetStats) {
      // Blade has its ratchet built in: there's no separate ratchet to read
      // stats from, so average only the two parts we actually know (same
      // 2:1 blade:bit proportion) rather than inventing numbers for one.
      return {
        atk: bladeAgg.atk.value * (2 / 3) + bitStatsResolved.atk.value * (1 / 3),
        def: bladeAgg.def.value * (2 / 3) + bitStatsResolved.def.value * (1 / 3),
        sta: bladeAgg.sta.value * (2 / 3) + bitStatsResolved.sta.value * (1 / 3),
        xdash: xdash,
        burst: bitStatsResolved.burst.value,
        recoil: bladeAgg.recoil.value,
        owd: bladeAgg.owd.value
      };
    }
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

  // Plain fired-flag list, no score effect — see WARNING_FLAGS above.
  function evaluateWarningFlags(metrics, parts) {
    var fired = [];
    WARNING_FLAGS.forEach(function (f) {
      if (f.test(metrics, parts)) fired.push({ id: f.id, label: f.label });
    });
    return fired;
  }

  // Public: score one combo for one role.
  // blade2/blade3 present only for CX (lock/main/assist averaged).
  function scoreCombo(role, blade, ratchet, bit, blade2, blade3, bootstrapCache) {
    var weights = roleWeights(role);
    if (!weights) throw new Error('Unknown role: ' + role);
    bootstrapCache = bootstrapCache || { bladeRecoil: [], ratchetBurst: [], bitGrip: [], bitBurst: [] };

    var bladeList = [blade, blade2, blade3].filter(Boolean).map(function (b) { return bladeStats(b, bootstrapCache); });
    var bladeAgg = aggregateBladeStats(bladeList);
    var rStats = ratchet ? ratchetStatsOf(ratchet, bootstrapCache) : null;
    var bStats = bitStatsOf(bit, bootstrapCache);

    var m = comboMetrics(bladeAgg, rStats, bStats);
    var score = round1(weightedSum(m, weights));

    return {
      role: role,
      metrics: m,
      score: score,
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

  window.BeyScoring = {
    DEFAULT_ROLE_WEIGHTS: DEFAULT_ROLE_WEIGHTS,
    shapeAllParts: shapeAllParts,
    buildBootstrapCache: buildBootstrapCache,
    scoreCombo: scoreCombo,
    scoreComboAllRoles: scoreComboAllRoles
  };
})();
