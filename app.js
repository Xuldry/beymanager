(function () {
  'use strict';

  var BASE_BLADES = window.BLADES_DATA || [];
  var BASE_RATCHETS = window.RATCHETS_DATA || [];
  var BASE_BITS = window.BITS_DATA || [];

  var BLADES, RATCHETS, BITS, STANDARD_BLADES, CX_LOCKCHIPS, CX_MAINBLADES, CX_ASSISTBLADES, byId;
  var FULL_BEY_PRODUCTS, FULL_BEY_BY_ID;

  function rebuildDerived() {
    BLADES = BASE_BLADES.concat(store.customParts.blades);
    RATCHETS = BASE_RATCHETS.concat(store.customParts.ratchets);
    BITS = BASE_BITS.concat(store.customParts.bits);

    STANDARD_BLADES = BLADES.filter(function (b) { return !b.isCX; });
    CX_LOCKCHIPS = BLADES.filter(function (b) { return b.isCX && b.role === 'Lock Chip'; });
    CX_MAINBLADES = BLADES.filter(function (b) { return b.isCX && b.role === 'Main Blade'; });
    CX_ASSISTBLADES = BLADES.filter(function (b) { return b.isCX && b.role === 'Assist Blade'; });

    byId = { blades: {}, ratchets: {}, bits: {} };
    BLADES.forEach(function (b) { byId.blades[b.id] = b; });
    RATCHETS.forEach(function (r) { byId.ratchets[r.id] = r; });
    BITS.forEach(function (b) { byId.bits[b.id] = b; });

    FULL_BEY_PRODUCTS = computeFullBeyProducts();
    FULL_BEY_BY_ID = {};
    FULL_BEY_PRODUCTS.forEach(function (p) { FULL_BEY_BY_ID[p.id] = p; });
  }

  // Reconstructs "as sold" Blade+Ratchet+Bit (or, for CX, LockChip+MainBlade+
  // AssistBlade+Ratchet+Bit) groupings purely from the scraped `includedIn` /
  // `productCode` cross-references already in the data — no extra scraping.
  // A product code with more than one valid ratchet/bit (random boosters) is
  // expanded into one selectable row per real pairing rather than guessed at.
  function computeFullBeyProducts() {
    var CAP = 12;
    var products = [];

    // A blade can have more than one real retail SKU (e.g. a Hasbro/EU
    // re-release pairs it with a different ratchet/bit than the original
    // Takara Tomy code) — check productCode plus any known altCodes and
    // dedupe the resulting (blade,ratchet,bit) triples by id.
    var seenIds = {};
    STANDARD_BLADES.forEach(function (blade) {
      var codes = (blade.productCode ? [blade.productCode] : []).concat(blade.altCodes || []);
      codes.forEach(function (code) {
        var rs = RATCHETS.filter(function (r) { return (r.includedIn || []).indexOf(code) !== -1; });
        var bs = BITS.filter(function (b) { return (b.includedIn || []).indexOf(code) !== -1; });
        if (!rs.length || !bs.length) return;
        var combos = [];
        rs.forEach(function (r) { bs.forEach(function (b) { combos.push([r, b]); }); });
        combos.slice(0, CAP).forEach(function (pair) {
          var id = 'fb-' + blade.id + '-' + pair[0].id + '-' + pair[1].id;
          if (seenIds[id]) return;
          seenIds[id] = true;
          products.push({
            id: id,
            label: blade.name + ' (' + pair[0].id + ' / ' + pair[1].name + ')',
            sub: code + (combos.length > 1 ? ' · one of ' + combos.length + ' known pairings for this code' : ''),
            image: blade.image, isCX: false,
            blade: blade.id, ratchet: pair[0].id, bit: pair[1].id
          });
        });
      });
    });

    var cxByCode = {};
    BLADES.filter(function (b) { return b.isCX; }).forEach(function (b) {
      var codes = (b.includedIn || []).slice();
      if (b.productCode) codes.push(b.productCode);
      codes.forEach(function (code) { (cxByCode[code] = cxByCode[code] || []).push(b); });
    });
    Object.keys(cxByCode).forEach(function (code) {
      var locks = cxByCode[code].filter(function (b) { return b.role === 'Lock Chip'; });
      var mains = cxByCode[code].filter(function (b) { return b.role === 'Main Blade'; });
      var assists = cxByCode[code].filter(function (b) { return b.role === 'Assist Blade'; });
      var rs = RATCHETS.filter(function (r) { return (r.includedIn || []).indexOf(code) !== -1; });
      var bs = BITS.filter(function (b) { return (b.includedIn || []).indexOf(code) !== -1; });
      if (!locks.length || !mains.length || !assists.length || !rs.length || !bs.length) return;
      var combos = [];
      locks.forEach(function (l) { mains.forEach(function (m) { assists.forEach(function (a) {
        rs.forEach(function (r) { bs.forEach(function (b) { combos.push([l, m, a, r, b]); }); });
      }); }); });
      combos.slice(0, CAP).forEach(function (c) {
        var name = c[0].name + ' + ' + c[1].name + ' + ' + c[2].name;
        products.push({
          id: 'fb-cx-' + c[0].id + '-' + c[1].id + '-' + c[2].id + '-' + c[3].id + '-' + c[4].id,
          label: name + ' (' + c[3].id + ' / ' + c[4].name + ')',
          sub: code + (combos.length > 1 ? ' · one of ' + combos.length + ' known pairings for this code' : ''),
          image: c[1].image, isCX: true,
          lock: c[0].id, main: c[1].id, assist: c[2].id, ratchet: c[3].id, bit: c[4].id
        });
      });
    });

    products.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return products;
  }

  // ---------------- storage ----------------
  var STORE_KEY = 'beymanager_v1';
  var store = loadStore();
  rebuildDerived();

  function loadStore() {
    var s = null;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) s = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    if (!s) s = {};
    if (!s.owned) s.owned = { blades: {}, ratchets: {}, bits: {} };
    if (!s.combos) s.combos = [];
    if (!s.customParts) s.customParts = { blades: [], ratchets: [], bits: [] };
    return s;
  }

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }

  function isOwned(cat, id) { return !!store.owned[cat][id]; }
  function toggleOwned(cat, id) {
    if (store.owned[cat][id]) delete store.owned[cat][id];
    else store.owned[cat][id] = true;
    saveStore();
  }

  // ---------------- scoring engine ----------------
  var TYPE_BASE = {
    Attack: { atk: 70, def: 15, sta: 15 },
    Defense: { atk: 15, def: 70, sta: 15 },
    Stamina: { atk: 15, def: 15, sta: 70 },
    Balance: { atk: 33, def: 34, sta: 33 }
  };

  function cloneBase(type) {
    var t = TYPE_BASE[type] || TYPE_BASE.Balance;
    return { atk: t.atk, def: t.def, sta: t.sta };
  }

  function bladeStats(blade) {
    if (!blade) return { atk: 0, def: 0, sta: 0 };
    var s = cloneBase(blade.type);
    if (typeof blade.weight === 'number') {
      var delta = blade.weight - 34;
      s.def += delta * 0.5;
      s.sta += delta * 0.3;
      s.atk -= delta * 0.4;
    }
    if (typeof blade.contactPoints === 'number') {
      s.def += blade.contactPoints * 1.5;
    }
    return s;
  }

  function cxBladeStats(lock, main, assist) {
    var parts = [lock, main, assist].filter(Boolean);
    if (!parts.length) return { atk: 0, def: 0, sta: 0 };
    var acc = { atk: 0, def: 0, sta: 0 };
    parts.forEach(function (p) {
      var s = cloneBase(p.type);
      acc.atk += s.atk; acc.def += s.def; acc.sta += s.sta;
    });
    var n = parts.length;
    return { atk: acc.atk / n, def: acc.def / n, sta: acc.sta / n };
  }

  function ratchetStats(ratchet) {
    if (!ratchet) return { atk: 0, def: 0, sta: 0 };
    var s = cloneBase(ratchet.type);
    var cp = ratchet.contactPoints;
    var cpNum = typeof cp === 'number' ? cp : (cp === 'M' ? 5 : 0);
    s.def += cpNum * 3;
    if (typeof ratchet.height === 'number') {
      if (ratchet.height >= 75) s.atk += 8;
      else if (ratchet.height <= 55) s.sta += 8;
      else s.def += 4;
    }
    return s;
  }

  function bitStats(bit) {
    if (!bit) return { atk: 0, def: 0, sta: 0 };
    var s = cloneBase(bit.type);
    if (typeof bit.gearTeeth === 'number') s.atk += bit.gearTeeth * 0.8;
    var shape = (bit.shape || '').toLowerCase();
    if (shape === 'flat') s.atk += 10;
    else if (shape === 'round') s.sta += 10;
    else if (shape === 'sharp') s.def += 8;
    else { s.atk += 4; s.def += 4; s.sta += 4; }
    return s;
  }

  function combineStats(blade, ratchet, bit) {
    var raw = {
      atk: blade.atk * 0.5 + ratchet.atk * 0.25 + bit.atk * 0.25,
      def: blade.def * 0.5 + ratchet.def * 0.25 + bit.def * 0.25,
      sta: blade.sta * 0.5 + ratchet.sta * 0.25 + bit.sta * 0.25
    };
    var clamped = {
      atk: Math.max(0, Math.min(100, Math.round(raw.atk))),
      def: Math.max(0, Math.min(100, Math.round(raw.def))),
      sta: Math.max(0, Math.min(100, Math.round(raw.sta)))
    };
    clamped.total = clamped.atk + clamped.def + clamped.sta;
    var top = 'atk';
    if (clamped.def > clamped[top]) top = 'def';
    if (clamped.sta > clamped[top]) top = 'sta';
    clamped.archetype = { atk: 'Attack', def: 'Defense', sta: 'Stamina' }[top];
    return clamped;
  }

  function scoreStandardCombo(blade, ratchet, bit) {
    return combineStats(bladeStats(blade), ratchetStats(ratchet), bitStats(bit));
  }

  function scoreCXCombo(lock, main, assist, ratchet, bit) {
    return combineStats(cxBladeStats(lock, main, assist), ratchetStats(ratchet), bitStats(bit));
  }

  // ---------------- tab navigation ----------------
  document.getElementById('mainTabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'mybeys') { renderOwnershipSummary(); renderSavedCombos(); }
    if (btn.dataset.tab === 'builder') { refreshComboSelects(); renderBestCombos(); renderSuggestedParts(); }
  });

  // ---------------- database tab ----------------
  var dbState = { partType: 'blades', search: '', series: '', type: '', ownedOnly: false };

  document.getElementById('partTypeTabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.subtab-btn');
    if (!btn) return;
    document.querySelectorAll('.subtab-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    dbState.partType = btn.dataset.parttype;
    populateSeriesFilter();
    renderDatabase();
  });

  document.getElementById('searchInput').addEventListener('input', function (e) {
    dbState.search = e.target.value.trim().toLowerCase();
    renderDatabase();
  });
  document.getElementById('filterSeries').addEventListener('change', function (e) {
    dbState.series = e.target.value;
    renderDatabase();
  });
  document.getElementById('filterType').addEventListener('change', function (e) {
    dbState.type = e.target.value;
    renderDatabase();
  });
  document.getElementById('filterOwnedOnly').addEventListener('change', function (e) {
    dbState.ownedOnly = e.target.checked;
    renderDatabase();
  });

  function currentDataset() {
    if (dbState.partType === 'blades') return BLADES;
    if (dbState.partType === 'ratchets') return RATCHETS;
    return BITS;
  }

  function populateSeriesFilter() {
    var sel = document.getElementById('filterSeries');
    if (dbState.partType !== 'blades') {
      sel.style.display = 'none';
      dbState.series = '';
      return;
    }
    sel.style.display = '';
    var series = Array.from(new Set(BLADES.map(function (b) { return b.series; }).filter(Boolean)));
    sel.innerHTML = '<option value="">All series</option>' + series.map(function (s) {
      return '<option value="' + s + '">' + s + '</option>';
    }).join('');
  }

  function partDisplayName(cat, p) {
    if (cat === 'ratchets') return p.id;
    return p.name || p.id;
  }

  // Beyblade names get spelled many ways across sources (Hasbro vs Takara Tomy
  // word order, "Dran Sword" vs "DranSword", aliases, etc). Strip spaces/hyphens
  // and match each search word independently so word order and spacing never
  // cause a false "not found".
  function squash(s) { return String(s || '').toLowerCase().replace(/[\s-]+/g, ''); }

  function partSearchHaystack(cat, p) {
    var parts = [partDisplayName(cat, p), p.id, p.productCode || ''].concat(p.aliases || []);
    return squash(parts.join(' '));
  }

  function partMatchesFilters(cat, p) {
    if (dbState.ownedOnly && !isOwned(cat, p.id)) return false;
    if (dbState.type && p.type !== dbState.type) return false;
    if (cat === 'blades' && dbState.series && p.series !== dbState.series) return false;
    if (dbState.search) {
      var hay = partSearchHaystack(cat, p);
      var words = dbState.search.split(/\s+/).filter(Boolean).map(squash);
      if (!words.every(function (w) { return hay.indexOf(w) !== -1; })) return false;
    }
    return true;
  }

  function renderDatabase() {
    var cat = dbState.partType;
    var data = currentDataset().filter(function (p) { return partMatchesFilters(cat, p); });
    var grid = document.getElementById('partGrid');
    if (!data.length) {
      grid.innerHTML = '<div class="empty-state">No parts match these filters.</div>';
    } else {
      grid.innerHTML = data.map(function (p) { return partCardHTML(cat, p); }).join('');
    }
    document.getElementById('count-blades').textContent = BLADES.length;
    document.getElementById('count-ratchets').textContent = RATCHETS.length;
    document.getElementById('count-bits').textContent = BITS.length;
  }

  var PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1f2330"/><text x="50" y="55" font-size="12" fill="#5b6178" text-anchor="middle" font-family="sans-serif">no image</text></svg>'
  );
  function partImg(p) { return p.image || PLACEHOLDER_IMG; }

  function partCardHTML(cat, p) {
    var owned = isOwned(cat, p.id);
    var name = partDisplayName(cat, p);
    var sub = '';
    if (cat === 'blades') {
      sub = (p.productCode || p.series || '') + (typeof p.weight === 'number' ? ' · ' + p.weight + 'g' : '');
      if (p.isCX) sub = (p.role || 'CX') + (sub ? ' · ' + sub : '');
    } else if (cat === 'ratchets') {
      sub = p.height ? p.height + ' dmm' : '';
      if (typeof p.contactPoints === 'number') sub += ' · ' + p.contactPoints + ' pts';
    } else {
      sub = p.shape ? p.shape + ' tip' : '';
      if (typeof p.gearTeeth === 'number') sub += ' · ' + p.gearTeeth + 't';
    }
    var tag = p.isCustom ? '<span class="type-badge" style="background:rgba(255,255,255,0.1);color:var(--text-dim)">Custom</span>' :
      (p.isHasbroRetool ? '<span class="type-badge" style="background:rgba(255,255,255,0.1);color:var(--text-dim)">Hasbro</span>' : '');
    return (
      '<div class="part-card' + (owned ? ' owned' : '') + '" data-cat="' + cat + '" data-id="' + escapeAttr(p.id) + '">' +
        '<div class="owned-check">' + (owned ? '✓' : '') + '</div>' +
        '<img src="' + partImg(p) + '" alt="' + escapeAttr(name) + '" loading="lazy" onerror="this.style.opacity=0.2">' +
        '<div class="part-name">' + escapeHtml(name) + '</div>' +
        '<div class="part-sub">' + escapeHtml(sub) + '</div>' +
        (p.type ? '<span class="type-badge type-' + p.type + '">' + p.type + '</span>' : '') + ' ' + tag +
      '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  document.getElementById('partGrid').addEventListener('click', function (e) {
    var card = e.target.closest('.part-card');
    if (!card) return;
    openPartModal(card.dataset.cat, card.dataset.id);
  });

  // ---------------- part modal ----------------
  var modal = document.getElementById('partModal');
  document.getElementById('modalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  function closeModal() { modal.classList.remove('open'); }

  function openPartModal(cat, id) {
    var p = byId[cat][id];
    if (!p) return;
    var name = partDisplayName(cat, p);
    var rows = [];
    if (cat === 'blades') {
      rows.push(['Series', p.series]);
      if (p.role) rows.push(['Role', p.role]);
      rows.push(['Type', p.type]);
      rows.push(['Spin', p.spin === 'R' ? 'Right (R)' : (p.spin === 'L' ? 'Left (L)' : '—')]);
      rows.push(['Weight', typeof p.weight === 'number' ? p.weight + ' g' : 'Not published']);
      rows.push(['Contact points', p.contactPoints != null ? p.contactPoints : '—']);
      if (p.productCode) rows.push(['Product code', p.productCode]);
      if (p.includedIn && p.includedIn.length) rows.push(['Included in', p.includedIn.join(', ')]);
    } else if (cat === 'ratchets') {
      rows.push(['Type', p.type]);
      rows.push(['Contact points', p.contactPoints != null ? p.contactPoints : '—']);
      rows.push(['Height', p.height != null ? p.height + ' dmm' : '—']);
      rows.push(['Metal', p.isMetal ? 'Yes' : 'No']);
      rows.push(['Simplified design', p.isSimple ? 'Yes' : 'No']);
      if (p.includedIn && p.includedIn.length) rows.push(['Included in', p.includedIn.join(', ')]);
    } else {
      rows.push(['Type', p.type]);
      rows.push(['Tip shape', p.shape || '—']);
      rows.push(['Gear teeth', p.gearTeeth != null ? p.gearTeeth : '—']);
      rows.push(['Shaft width', p.shaftWidth != null ? p.shaftWidth : '—']);
      rows.push(['Height', p.height != null ? p.height : '—']);
      rows.push(['Fused (integrated ratchet)', p.isFused ? 'Yes' : 'No']);
      if (p.includedIn && p.includedIn.length) rows.push(['Included in', p.includedIn.join(', ')]);
    }
    if (p.aliases && p.aliases.length) rows.push(['Also known as', p.aliases.join(', ')]);
    var owned = isOwned(cat, id);
    document.getElementById('modalContent').innerHTML =
      '<div class="modal-content">' +
      '<img src="' + partImg(p) + '" alt="' + escapeAttr(name) + '">' +
      '<h2 style="margin:0 0 4px">' + escapeHtml(name) + ' <span style="font-weight:400;color:var(--text-dim);font-size:14px">(' + id + ')</span></h2>' +
      (p.note ? '<p class="hint" style="margin:0 0 10px">' + escapeHtml(p.note) + '</p>' : '') +
      rows.map(function (r) {
        return '<div class="modal-spec-row"><span>' + r[0] + '</span><span>' + escapeHtml(r[1]) + '</span></div>';
      }).join('') +
      '<button class="modal-own-btn' + (owned ? ' is-owned' : '') + '" id="modalOwnBtn">' +
        (owned ? '✓ In your collection' : '+ Add to my collection') +
      '</button>' +
      (p.isCustom ? '<button class="modal-own-btn" id="modalDeleteBtn" style="margin-top:8px;border-color:var(--attack);color:var(--attack)">Remove this custom part</button>' : '') +
      '</div>';
    document.getElementById('modalOwnBtn').addEventListener('click', function () {
      toggleOwned(cat, id);
      openPartModal(cat, id);
      renderDatabase();
    });
    var delBtn = document.getElementById('modalDeleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        store.customParts[cat] = store.customParts[cat].filter(function (x) { return x.id !== id; });
        delete store.owned[cat][id];
        saveStore();
        rebuildDerived();
        closeModal();
        renderDatabase();
      });
    }
    modal.classList.add('open');
  }

  // ---------------- add custom part ----------------
  function slugify(s) {
    return String(s || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Part';
  }

  function uniqueId(cat, base) {
    var id = base, n = 1;
    while (byId[cat][id]) { id = base + n; n++; }
    return id;
  }

  document.getElementById('btnAddCustomPart').addEventListener('click', openAddCustomPartModal);

  function openAddCustomPartModal() {
    document.getElementById('modalContent').innerHTML =
      '<div class="modal-content">' +
      '<h2 style="margin:0 0 10px">Add a part I own</h2>' +
      '<p class="hint">For a bey the built-in database is missing — e.g. a Hasbro-exclusive retool with a new name. It\'ll show up in the Database, Combo Builder and Recommendations like any other part.</p>' +
      '<div class="picker-group"><label>Category</label><select id="cpCategory">' +
        '<option value="blades">Blade</option><option value="ratchets">Ratchet</option><option value="bits">Bit</option>' +
      '</select></div>' +
      '<div class="picker-group"><label>Name (or code, e.g. "9-60" for a ratchet)</label><input type="text" id="cpName" placeholder="e.g. Stun Medusa"></div>' +
      '<div class="picker-group"><label>Type</label><select id="cpType">' +
        '<option value="Attack">Attack</option><option value="Defense">Defense</option><option value="Stamina">Stamina</option><option value="Balance">Balance</option>' +
      '</select></div>' +
      '<div class="picker-group"><label>Weight in grams (optional, blades only)</label><input type="number" step="0.1" id="cpWeight" placeholder="e.g. 32.5"></div>' +
      '<div class="picker-group"><label>Note (optional)</label><input type="text" id="cpNote" placeholder="e.g. Hasbro retool of ShinobiShadow"></div>' +
      '<label class="owned-toggle" style="margin:6px 0"><input type="checkbox" id="cpOwned" checked> I own this</label>' +
      '<button class="btn-primary" id="cpSubmit">Add part</button>' +
      '</div>';
    document.getElementById('cpSubmit').addEventListener('click', function () {
      var cat = document.getElementById('cpCategory').value;
      var rawName = document.getElementById('cpName').value.trim();
      if (!rawName) { document.getElementById('cpName').focus(); return; }
      var type = document.getElementById('cpType').value;
      var weightVal = parseFloat(document.getElementById('cpWeight').value);
      var note = document.getElementById('cpNote').value.trim();
      var owned = document.getElementById('cpOwned').checked;

      var id = cat === 'blades' ? uniqueId(cat, 'custom-' + slugify(rawName)) : uniqueId(cat, rawName);
      var part = { id: id, type: type, image: '', isCustom: true, note: note || undefined, includedIn: [] };
      if (cat === 'blades') {
        part.name = rawName;
        part.series = 'Collaboration';
        part.spin = 'R';
        part.weight = isNaN(weightVal) ? null : weightVal;
        part.contactPoints = null;
        part.productCode = null;
        part.isCX = false;
        part.role = null;
      } else if (cat === 'ratchets') {
        part.contactPoints = null;
        part.height = null;
        part.isMetal = false;
        part.isSimple = false;
        part.weightCode = null;
      } else {
        part.name = rawName;
        part.shape = null;
        part.gearTeeth = null;
        part.height = null;
        part.shaftWidth = null;
        part.weightCode = null;
        part.isFused = false;
      }
      store.customParts[cat].push(part);
      if (owned) store.owned[cat][id] = true;
      saveStore();
      rebuildDerived();
      populateSeriesFilter();
      renderDatabase();
      closeModal();
    });
    modal.classList.add('open');
  }

  // ---------------- add a bey I bought ----------------
  function fullBeyOwned(p) {
    if (p.isCX) {
      return isOwned('blades', p.lock) && isOwned('blades', p.main) && isOwned('blades', p.assist) &&
        isOwned('ratchets', p.ratchet) && isOwned('bits', p.bit);
    }
    return isOwned('blades', p.blade) && isOwned('ratchets', p.ratchet) && isOwned('bits', p.bit);
  }

  function addFullBeyToOwned(p) {
    if (p.isCX) {
      store.owned.blades[p.lock] = true;
      store.owned.blades[p.main] = true;
      store.owned.blades[p.assist] = true;
    } else {
      store.owned.blades[p.blade] = true;
    }
    store.owned.ratchets[p.ratchet] = true;
    store.owned.bits[p.bit] = true;
    saveStore();
  }

  document.getElementById('btnAddBey').addEventListener('click', openAddBeyModal);

  function openAddBeyModal() {
    document.getElementById('modalContent').innerHTML =
      '<div class="modal-content">' +
      '<h2 style="margin:0 0 10px">Add a bey I bought</h2>' +
      '<p class="hint">Search for the set you bought — this marks every one of its parts as owned in one tap. This list only covers pairings our source database happens to cross-reference (mostly Japan/Takara Tomy releases), so a Hasbro or EU set with a different ratchet/bit than the Japanese original may not show up here — if so, use "Pick the exact parts yourself" below instead.</p>' +
      '<input type="search" id="fbSearch" placeholder="e.g. Dran Sword, PhoenixRudder…" ' +
        'style="width:100%;padding:9px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg-elev-2);color:var(--text);margin-bottom:10px;box-sizing:border-box">' +
      '<div id="fbResults" style="max-height:36vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>' +
      '<details style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">' +
        '<summary style="cursor:pointer;font-weight:600;font-size:13px">Not listed? Pick the exact parts yourself</summary>' +
        '<div style="margin-top:10px">' +
          '<div class="picker-group"><label>Blade</label><select id="fbBlade"></select></div>' +
          '<div class="picker-group"><label>Ratchet</label><select id="fbRatchet"></select></div>' +
          '<div class="picker-group"><label>Bit</label><select id="fbBit"></select></div>' +
          '<button class="btn-primary" id="fbManualAdd" style="margin-top:8px">Mark these as owned</button>' +
        '</div>' +
      '</details>' +
      '</div>';
    var input = document.getElementById('fbSearch');
    input.addEventListener('input', function () { renderFbResults(input.value); });
    renderFbResults('');

    var fbBlade = document.getElementById('fbBlade');
    var fbRatchet = document.getElementById('fbRatchet');
    var fbBit = document.getElementById('fbBit');
    fbBlade.innerHTML = '<option value="">— select —</option>' + STANDARD_BLADES.map(function (b) {
      return '<option value="' + b.id + '">' + escapeHtml(b.name) + (b.productCode ? ' (' + b.productCode + ')' : '') + '</option>';
    }).join('');
    fbRatchet.innerHTML = optionsHTML(RATCHETS, 'ratchets', false);
    fbBit.innerHTML = optionsHTML(BITS, 'bits', false);
    document.getElementById('fbManualAdd').addEventListener('click', function () {
      if (!fbBlade.value || !fbRatchet.value || !fbBit.value) return;
      store.owned.blades[fbBlade.value] = true;
      store.owned.ratchets[fbRatchet.value] = true;
      store.owned.bits[fbBit.value] = true;
      saveStore();
      renderDatabase();
      renderFbResults(document.getElementById('fbSearch').value);
      var btn = document.getElementById('fbManualAdd');
      btn.textContent = '✓ Added';
      setTimeout(function () { btn.textContent = 'Mark these as owned'; }, 1200);
    });

    modal.classList.add('open');
    input.focus();
  }

  function renderFbResults(query) {
    var words = query.split(/\s+/).filter(Boolean).map(squash);
    var filtered = FULL_BEY_PRODUCTS.filter(function (p) {
      var hay = squash(p.label + ' ' + p.sub);
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
    var results = document.getElementById('fbResults');
    if (!filtered.length) {
      results.innerHTML = '<div class="empty-state">No matches. If this bey truly isn\'t catalogued, close this and use "+ Add a part I own" instead.</div>';
      return;
    }
    results.innerHTML = filtered.slice(0, 80).map(function (p) {
      var owned = fullBeyOwned(p);
      return '<div class="suggested-part-row">' +
        '<img src="' + partImg(p) + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">' +
        '<div><div class="name">' + escapeHtml(p.label) + '</div><div class="reason">' + escapeHtml(p.sub) + '</div></div>' +
        '<button class="btn-primary" data-add="' + p.id + '" style="margin-left:auto;padding:6px 10px;font-size:12px"' + (owned ? ' disabled' : '') + '>' +
          (owned ? '✓ Owned' : 'Add') +
        '</button>' +
        '</div>';
    }).join('');
    results.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        addFullBeyToOwned(FULL_BEY_BY_ID[btn.dataset.add]);
        renderFbResults(document.getElementById('fbSearch').value);
        renderDatabase();
      });
    });
  }

  // ---------------- combo builder ----------------
  function optionsHTML(list, cat, ownedOnly) {
    var filtered = ownedOnly ? list.filter(function (p) { return isOwned(cat, p.id); }) : list;
    if (!filtered.length) return '<option value="">— none available —</option>';
    return '<option value="">— select —</option>' + filtered.map(function (p) {
      return '<option value="' + p.id + '">' + escapeHtml(partDisplayName(cat, p)) + '</option>';
    }).join('');
  }

  var selBlade = document.getElementById('selectBlade');
  var selLock = document.getElementById('selectLockChip');
  var selMain = document.getElementById('selectMainBlade');
  var selAssist = document.getElementById('selectAssistBlade');
  var selRatchet = document.getElementById('selectRatchet');
  var selBit = document.getElementById('selectBit');
  var comboOwnedOnly = document.getElementById('comboOwnedOnly');

  // Blade select includes both standard blades and a CX marker; we detect CX by picking any CX main blade too.
  function refreshComboSelects() {
    var ownedOnly = comboOwnedOnly.checked;
    var bladeOptions = STANDARD_BLADES.slice();
    var showCX = true;
    selBlade.innerHTML = '<option value="">— standard blade —</option>' +
      (ownedOnly ? bladeOptions.filter(function (b) { return isOwned('blades', b.id); }) : bladeOptions)
        .map(function (b) { return '<option value="' + b.id + '">' + escapeHtml(b.name) + ' (' + b.productCode + ')</option>'; }).join('');
    selLock.innerHTML = optionsHTML(CX_LOCKCHIPS, 'blades', ownedOnly);
    selMain.innerHTML = optionsHTML(CX_MAINBLADES, 'blades', ownedOnly);
    selAssist.innerHTML = optionsHTML(CX_ASSISTBLADES, 'blades', ownedOnly);
    selRatchet.innerHTML = optionsHTML(RATCHETS, 'ratchets', ownedOnly);
    selBit.innerHTML = optionsHTML(BITS, 'bits', ownedOnly);
    updateComboPreview();
  }

  comboOwnedOnly.addEventListener('change', refreshComboSelects);

  var cxModeToggle = document.createElement('label');
  cxModeToggle.className = 'owned-toggle';
  cxModeToggle.innerHTML = '<input type="checkbox" id="cxModeCheckbox"> Building a CX combo (Main/Assist/Lock Chip)';
  document.getElementById('pickerBladeStandard').parentNode.insertBefore(cxModeToggle, document.getElementById('pickerBladeStandard'));
  var cxModeCheckbox = document.getElementById('cxModeCheckbox');
  cxModeCheckbox.addEventListener('change', function () {
    document.getElementById('pickerBladeStandard').style.display = cxModeCheckbox.checked ? 'none' : '';
    document.getElementById('pickerCXGroup').style.display = cxModeCheckbox.checked ? '' : 'none';
    updateComboPreview();
  });

  [selBlade, selLock, selMain, selAssist, selRatchet, selBit].forEach(function (el) {
    el.addEventListener('change', updateComboPreview);
  });

  function getCurrentCombo() {
    var ratchet = byId.ratchets[selRatchet.value];
    var bit = byId.bits[selBit.value];
    if (cxModeCheckbox.checked) {
      var lock = byId.blades[selLock.value];
      var main = byId.blades[selMain.value];
      var assist = byId.blades[selAssist.value];
      return { isCX: true, lock: lock, main: main, assist: assist, ratchet: ratchet, bit: bit };
    }
    var blade = byId.blades[selBlade.value];
    return { isCX: false, blade: blade, ratchet: ratchet, bit: bit };
  }

  function updateComboPreview() {
    var combo = getCurrentCombo();
    var stats;
    var ready;
    if (combo.isCX) {
      ready = combo.lock || combo.main || combo.assist;
      stats = scoreCXCombo(combo.lock, combo.main, combo.assist, combo.ratchet, combo.bit);
    } else {
      ready = !!combo.blade;
      stats = scoreStandardCombo(combo.blade, combo.ratchet, combo.bit);
    }
    renderStatBars(stats);
    var meta = document.getElementById('comboMeta');
    var weight = 0;
    if (!combo.isCX && combo.blade && typeof combo.blade.weight === 'number') weight += combo.blade.weight;
    var metaBits = ['Archetype: ' + (ready ? stats.archetype : '—'), 'Total score: ' + stats.total];
    if (weight) metaBits.push('Blade weight: ' + weight + 'g');
    meta.innerHTML = metaBits.map(function (m) { return '<span>' + m + '</span>'; }).join('');
    document.getElementById('btnSaveCombo').disabled = !ready;
  }

  function renderStatBars(stats) {
    var rows = [
      ['ATK', 'atk', stats.atk],
      ['DEF', 'def', stats.def],
      ['STA', 'sta', stats.sta]
    ];
    document.getElementById('statBars').innerHTML = rows.map(function (r) {
      return '<div class="stat-row">' +
        '<div class="stat-label">' + r[0] + '</div>' +
        '<div class="stat-track"><div class="stat-fill ' + r[1] + '" style="width:' + r[2] + '%"></div></div>' +
        '<div class="stat-value">' + r[2] + '</div>' +
        '</div>';
    }).join('');
  }

  document.getElementById('btnSaveCombo').addEventListener('click', function () {
    var combo = getCurrentCombo();
    var entry = combo.isCX
      ? { isCX: true, lock: combo.lock && combo.lock.id, main: combo.main && combo.main.id, assist: combo.assist && combo.assist.id, ratchet: combo.ratchet && combo.ratchet.id, bit: combo.bit && combo.bit.id }
      : { isCX: false, blade: combo.blade && combo.blade.id, ratchet: combo.ratchet && combo.ratchet.id, bit: combo.bit && combo.bit.id };
    store.combos.push(entry);
    saveStore();
    renderSavedCombos();
  });

  function bitName(id) { return (byId.bits[id] && byId.bits[id].name) || id || '—'; }

  function comboLabel(entry) {
    if (entry.isCX) {
      var parts = [entry.lock, entry.main, entry.assist].filter(Boolean).map(function (id) {
        return byId.blades[id] ? byId.blades[id].name : id;
      });
      return parts.join(' + ') + ' / ' + (entry.ratchet || '—') + ' / ' + bitName(entry.bit);
    }
    var bladeName = entry.blade && byId.blades[entry.blade] ? byId.blades[entry.blade].name : '—';
    return bladeName + ' / ' + (entry.ratchet || '—') + ' / ' + bitName(entry.bit);
  }

  // For CX combos the Main Blade is the biggest, most recognizable piece,
  // so it stands in as the combo's thumbnail alongside the standard blade.
  function comboRepresentativeImage(entry) {
    var bladeId = entry.isCX ? entry.main : entry.blade;
    var blade = bladeId && byId.blades[bladeId];
    return blade ? partImg(blade) : PLACEHOLDER_IMG;
  }

  function comboScoreOf(entry) {
    if (entry.isCX) {
      return scoreCXCombo(byId.blades[entry.lock], byId.blades[entry.main], byId.blades[entry.assist], byId.ratchets[entry.ratchet], byId.bits[entry.bit]);
    }
    return scoreStandardCombo(byId.blades[entry.blade], byId.ratchets[entry.ratchet], byId.bits[entry.bit]);
  }

  // Identifies a combo by its parts so we can tell whether a recommended
  // combo has already been saved (and avoid pushing an exact duplicate).
  function comboEntryKey(e) {
    return e.isCX ? ['cx', e.lock, e.main, e.assist, e.ratchet, e.bit].join('|') : ['std', e.blade, e.ratchet, e.bit].join('|');
  }

  // Compact ATK/DEF/STA readout used anywhere a combo is listed (saved combos,
  // best-combos ranking) so the full stat spread is visible, not just the
  // single dominant archetype.
  function comboStatChipsHTML(stats) {
    return '<div class="cc-stats">' +
      '<span class="cc-stat atk">ATK <b>' + stats.atk + '</b></span>' +
      '<span class="cc-stat def">DEF <b>' + stats.def + '</b></span>' +
      '<span class="cc-stat sta">STA <b>' + stats.sta + '</b></span>' +
      '<span class="cc-stat total">Σ <b>' + stats.total + '</b></span>' +
      '</div>';
  }

  function winRateOf(entry) {
    var w = entry.wins || 0, l = entry.losses || 0, d = entry.draws || 0;
    var total = w + l + d;
    return { wins: w, losses: l, draws: d, total: total, pct: total ? Math.round((w / total) * 100) : null };
  }

  // ---------------- saved combos: filter + sort ----------------
  var savedCombosState = { blade: '', ratchet: '', bit: '', sort: 'total_desc' };

  function renderSavedCombosControls() {
    var container = document.getElementById('savedCombosControls');
    if (!store.combos.length) { container.innerHTML = ''; return; }

    var bladeIds = [], ratchetIds = [], bitIds = [];
    store.combos.forEach(function (e) {
      if (e.isCX) { [e.lock, e.main, e.assist].forEach(function (id) { if (id && bladeIds.indexOf(id) === -1) bladeIds.push(id); }); }
      else if (e.blade && bladeIds.indexOf(e.blade) === -1) bladeIds.push(e.blade);
      if (e.ratchet && ratchetIds.indexOf(e.ratchet) === -1) ratchetIds.push(e.ratchet);
      if (e.bit && bitIds.indexOf(e.bit) === -1) bitIds.push(e.bit);
    });

    function opts(ids, cat, current) {
      return '<option value="">Any ' + cat.slice(0, -1) + '</option>' + ids.map(function (id) {
        var label = cat === 'ratchets' ? id : partDisplayName(cat, byId[cat][id] || { id: id });
        return '<option value="' + escapeAttr(id) + '"' + (id === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join('');
    }

    container.innerHTML =
      '<select id="scfBlade" class="filter-select">' + opts(bladeIds, 'blades', savedCombosState.blade) + '</select>' +
      '<select id="scfRatchet" class="filter-select">' + opts(ratchetIds, 'ratchets', savedCombosState.ratchet) + '</select>' +
      '<select id="scfBit" class="filter-select">' + opts(bitIds, 'bits', savedCombosState.bit) + '</select>' +
      '<select id="scfSort" class="filter-select">' +
        ['total_desc:Total score (high→low)', 'atk_desc:Attack (high→low)', 'def_desc:Defense (high→low)', 'sta_desc:Stamina (high→low)',
          'winrate_desc:Win rate (high→low)', 'wins_desc:Most wins', 'newest:Newest first'].map(function (o) {
          var parts = o.split(':');
          return '<option value="' + parts[0] + '"' + (parts[0] === savedCombosState.sort ? ' selected' : '') + '>' + parts[1] + '</option>';
        }).join('') +
      '</select>';

    document.getElementById('scfBlade').addEventListener('change', function (e) { savedCombosState.blade = e.target.value; renderSavedCombos(); });
    document.getElementById('scfRatchet').addEventListener('change', function (e) { savedCombosState.ratchet = e.target.value; renderSavedCombos(); });
    document.getElementById('scfBit').addEventListener('change', function (e) { savedCombosState.bit = e.target.value; renderSavedCombos(); });
    document.getElementById('scfSort').addEventListener('change', function (e) { savedCombosState.sort = e.target.value; renderSavedCombos(); });
  }

  function entryHasPart(entry, cat, id) {
    if (!id) return true;
    if (cat === 'blades') return entry.isCX ? [entry.lock, entry.main, entry.assist].indexOf(id) !== -1 : entry.blade === id;
    if (cat === 'ratchets') return entry.ratchet === id;
    return entry.bit === id;
  }

  function renderSavedCombos() {
    renderSavedCombosControls();
    var container = document.getElementById('savedCombos');
    if (!store.combos.length) {
      container.innerHTML = '<div class="empty-state">No saved combos yet. Build one above and hit "Save this combo".</div>';
      return;
    }

    var rows = store.combos.map(function (entry, i) {
      return { entry: entry, idx: i, stats: comboScoreOf(entry), wl: winRateOf(entry) };
    }).filter(function (row) {
      return entryHasPart(row.entry, 'blades', savedCombosState.blade) &&
        entryHasPart(row.entry, 'ratchets', savedCombosState.ratchet) &&
        entryHasPart(row.entry, 'bits', savedCombosState.bit);
    });

    var sorters = {
      total_desc: function (a, b) { return b.stats.total - a.stats.total; },
      atk_desc: function (a, b) { return b.stats.atk - a.stats.atk; },
      def_desc: function (a, b) { return b.stats.def - a.stats.def; },
      sta_desc: function (a, b) { return b.stats.sta - a.stats.sta; },
      winrate_desc: function (a, b) { return (b.wl.pct == null ? -1 : b.wl.pct) - (a.wl.pct == null ? -1 : a.wl.pct); },
      wins_desc: function (a, b) { return b.wl.wins - a.wl.wins; },
      newest: function (a, b) { return b.idx - a.idx; }
    };
    rows.sort(sorters[savedCombosState.sort] || sorters.total_desc);

    if (!rows.length) {
      container.innerHTML = '<div class="empty-state">No saved combos match these filters.</div>';
      return;
    }

    container.innerHTML = rows.map(function (row) {
      var wl = row.wl;
      var wlLabel = wl.total ? (wl.wins + 'W - ' + wl.losses + 'L - ' + wl.draws + 'D · ' + wl.pct + '% win rate') : 'No matches logged yet';
      var autoLabel = comboLabel(row.entry);
      var displayName = row.entry.name || autoLabel;
      return '<div class="combo-chip-v2" data-idx="' + row.idx + '">' +
        '<div class="cc-row">' +
          '<img class="cc-thumb" src="' + comboRepresentativeImage(row.entry) + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">' +
          '<div class="cc-body">' +
            '<div class="cc-top">' +
              '<span class="combo-title-wrap">' +
                '<span class="combo-parts" data-nameview="' + row.idx + '">' + escapeHtml(displayName) + '</span>' +
                (row.entry.name ? '<span class="combo-subparts">' + escapeHtml(autoLabel) + '</span>' : '') +
              '</span>' +
              '<span class="cc-top-btns">' +
                '<button class="btn-icon" data-rename="' + row.idx + '" title="Rename">✏️</button>' +
                '<button class="btn-del" data-del="' + row.idx + '" title="Delete">&times;</button>' +
              '</span>' +
            '</div>' +
            comboStatChipsHTML(row.stats) +
            '<div class="cc-wl">' +
              '<span class="wl-label">' + wlLabel + '</span>' +
              '<span class="wl-btns">' +
                '<button data-win="' + row.idx + '">+ Win</button>' +
                '<button data-draw="' + row.idx + '">+ Draw</button>' +
                '<button data-loss="' + row.idx + '">+ Loss</button>' +
                (wl.total ? '<button data-resetwl="' + row.idx + '" class="wl-reset">reset</button>' : '') +
              '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    container.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.confirming === '1') {
          store.combos.splice(Number(btn.dataset.del), 1);
          saveStore();
          renderSavedCombos();
          return;
        }
        btn.dataset.confirming = '1';
        btn.textContent = 'Sure?';
        btn.classList.add('confirm-delete');
        setTimeout(function () {
          if (btn.dataset.confirming === '1') {
            btn.dataset.confirming = '';
            btn.textContent = '×';
            btn.classList.remove('confirm-delete');
          }
        }, 2500);
      });
    });
    container.querySelectorAll('[data-win]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var e = store.combos[Number(btn.dataset.win)];
        e.wins = (e.wins || 0) + 1;
        saveStore();
        renderSavedCombos();
      });
    });
    container.querySelectorAll('[data-loss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var e = store.combos[Number(btn.dataset.loss)];
        e.losses = (e.losses || 0) + 1;
        saveStore();
        renderSavedCombos();
      });
    });
    container.querySelectorAll('[data-draw]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var e = store.combos[Number(btn.dataset.draw)];
        e.draws = (e.draws || 0) + 1;
        saveStore();
        renderSavedCombos();
      });
    });
    container.querySelectorAll('[data-resetwl]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var e = store.combos[Number(btn.dataset.resetwl)];
        e.wins = 0; e.losses = 0; e.draws = 0;
        saveStore();
        renderSavedCombos();
      });
    });
    container.querySelectorAll('[data-rename]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        startRenameCombo(Number(btn.dataset.rename));
      });
    });
  }

  function startRenameCombo(idx) {
    var span = document.querySelector('[data-nameview="' + idx + '"]');
    if (!span) return;
    var entry = store.combos[idx];
    var current = entry.name || comboLabel(entry);
    var input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'combo-rename-input';
    span.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      if (save) {
        var val = input.value.trim();
        entry.name = val && val !== comboLabel(entry) ? val : undefined;
        saveStore();
      }
      renderSavedCombos();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  // ---------------- recommendations ----------------
  function ownedList(cat, dataset) {
    return dataset.filter(function (p) { return isOwned(cat, p.id); });
  }

  function renderOwnershipSummary() {
    var ob = ownedList('blades', STANDARD_BLADES.concat(CX_LOCKCHIPS, CX_MAINBLADES, CX_ASSISTBLADES));
    var or_ = ownedList('ratchets', RATCHETS);
    var obit = ownedList('bits', BITS);
    var cards = [
      ['Blades', ob.length, BLADES.length],
      ['Ratchets', or_.length, RATCHETS.length],
      ['Bits', obit.length, BITS.length]
    ];
    var html = cards.map(function (c) {
      return '<div class="summary-card"><div class="big">' + c[1] + '<span style="color:var(--text-dim);font-size:14px">/' + c[2] + '</span></div><div class="lbl">' + c[0] + ' owned</div></div>';
    }).join('');
    document.getElementById('ownershipSummary').innerHTML = html;
  }

  function typeDistribution(list) {
    var counts = { Attack: 0, Defense: 0, Stamina: 0, Balance: 0 };
    list.forEach(function (p) { if (p.type && counts.hasOwnProperty(p.type)) counts[p.type]++; });
    return counts;
  }

  function renderBestCombos() {
    var ownedBlades = ownedList('blades', STANDARD_BLADES);
    var ownedRatchets = ownedList('ratchets', RATCHETS);
    var ownedBits = ownedList('bits', BITS);
    var ownedLocks = ownedList('blades', CX_LOCKCHIPS);
    var ownedMains = ownedList('blades', CX_MAINBLADES);
    var ownedAssists = ownedList('blades', CX_ASSISTBLADES);

    var container = document.getElementById('bestCombos');
    if (!ownedRatchets.length || !ownedBits.length || (!ownedBlades.length && !ownedMains.length)) {
      container.innerHTML = '<div class="empty-state">Mark some blades, ratchets and bits as owned in the Database tab to see combo suggestions.</div>';
      return;
    }

    var candidates = [];
    ownedBlades.forEach(function (blade) {
      ownedRatchets.forEach(function (ratchet) {
        ownedBits.forEach(function (bit) {
          var stats = scoreStandardCombo(blade, ratchet, bit);
          candidates.push({
            label: blade.name + ' / ' + ratchet.id + ' / ' + bit.name, stats: stats,
            entry: { isCX: false, blade: blade.id, ratchet: ratchet.id, bit: bit.id }
          });
        });
      });
    });
    if (ownedMains.length) {
      var locks = ownedLocks.length ? ownedLocks : [null];
      var assists = ownedAssists.length ? ownedAssists : [null];
      ownedMains.forEach(function (main) {
        locks.forEach(function (lock) {
          assists.forEach(function (assist) {
            ownedRatchets.forEach(function (ratchet) {
              ownedBits.forEach(function (bit) {
                var stats = scoreCXCombo(lock, main, assist, ratchet, bit);
                var parts = [lock, main, assist].filter(Boolean).map(function (p) { return p.name; });
                candidates.push({
                  label: parts.join(' + ') + ' / ' + ratchet.id + ' / ' + bit.name, stats: stats,
                  entry: { isCX: true, lock: lock && lock.id, main: main.id, assist: assist && assist.id, ratchet: ratchet.id, bit: bit.id }
                });
              });
            });
          });
        });
      });
    }
    candidates.sort(function (a, b) { return b.stats.total - a.stats.total; });
    var top = candidates.slice(0, 10);

    var existingKeys = {};
    store.combos.forEach(function (e) { existingKeys[comboEntryKey(e)] = true; });

    container.innerHTML = top.map(function (c, i) {
      var saved = existingKeys[comboEntryKey(c.entry)];
      return '<div class="combo-chip-v2">' +
        '<div class="cc-top"><span><span class="rank-num">' + (i + 1) + '</span>' +
        '<span class="combo-parts">' + escapeHtml(c.label) + '</span></span>' +
        '<button class="btn-save-combo" data-idx="' + i + '"' + (saved ? ' disabled' : '') + '>' + (saved ? '✓ Saved' : '+ Save') + '</button>' +
        '</div>' +
        comboStatChipsHTML(c.stats) +
        '</div>';
    }).join('');

    container.querySelectorAll('.btn-save-combo').forEach(function (btn) {
      btn.addEventListener('click', function () {
        store.combos.push(top[Number(btn.dataset.idx)].entry);
        saveStore();
        renderBestCombos();
      });
    });
  }

  function renderSuggestedParts() {
    var container = document.getElementById('suggestedParts');
    var ownedBlades = ownedList('blades', STANDARD_BLADES);
    var ownedRatchets = ownedList('ratchets', RATCHETS);
    var ownedBits = ownedList('bits', BITS);

    function gapScore(list, owned) {
      var dist = typeDistribution(owned.length ? owned : []);
      var maxCount = Math.max(1, dist.Attack, dist.Defense, dist.Stamina, dist.Balance);
      return function (p) {
        var count = dist[p.type] || 0;
        return (maxCount - count);
      };
    }

    var bladeGap = gapScore(STANDARD_BLADES, ownedBlades);
    var ratchetGap = gapScore(RATCHETS, ownedRatchets);
    var bitGap = gapScore(BITS, ownedBits);

    function popularity(p) { return Math.min(6, (p.includedIn || []).length); }

    var missingBlades = STANDARD_BLADES.filter(function (b) { return !isOwned('blades', b.id) && typeof b.weight === 'number'; })
      .map(function (b) { return { cat: 'blades', p: b, score: bladeGap(b) * 10 + popularity(b) * 2, reason: 'Fills a ' + b.type + ' gap in your blades' }; });
    var missingRatchets = RATCHETS.filter(function (r) { return !isOwned('ratchets', r.id); })
      .map(function (r) { return { cat: 'ratchets', p: r, score: ratchetGap(r) * 10 + popularity(r) * 2, reason: 'Fills a ' + r.type + ' gap · used in ' + (r.includedIn || []).length + ' sets' }; });
    var missingBits = BITS.filter(function (b) { return !isOwned('bits', b.id); })
      .map(function (b) { return { cat: 'bits', p: b, score: bitGap(b) * 10 + popularity(b) * 2, reason: 'Fills a ' + b.type + ' gap · used in ' + (b.includedIn || []).length + ' sets' }; });

    var all = missingBlades.concat(missingRatchets, missingBits);
    all.sort(function (a, b) { return b.score - a.score; });
    var top = all.slice(0, 10);
    if (!top.length) {
      container.innerHTML = '<div class="empty-state">You own everything tracked here, or the database is empty.</div>';
      return;
    }
    container.innerHTML = top.map(function (item) {
      var name = partDisplayName(item.cat, item.p);
      return '<div class="suggested-part-row" data-cat="' + item.cat + '" data-id="' + escapeAttr(item.p.id) + '">' +
        '<img src="' + partImg(item.p) + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">' +
        '<div><div class="name">' + escapeHtml(name) + (item.p.type ? ' <span class="type-badge type-' + item.p.type + '">' + item.p.type + '</span>' : '') + '</div>' +
        '<div class="reason">' + escapeHtml(item.reason) + '</div></div>' +
        '</div>';
    }).join('');
    container.querySelectorAll('.suggested-part-row').forEach(function (row) {
      row.addEventListener('click', function () {
        openPartModal(row.dataset.cat, row.dataset.id);
      });
    });
  }

  // ---------------- init ----------------
  populateSeriesFilter();
  renderDatabase();
  refreshComboSelects();
  renderOwnershipSummary();
  renderSavedCombos();
  renderBestCombos();
  renderSuggestedParts();
})();
