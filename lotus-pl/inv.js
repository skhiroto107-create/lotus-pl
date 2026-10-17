/* Lotus PL — 在庫タブ
   商品ごとに店舗別の在庫数・仕入れライン・仕入れ先（値段・URL）を持ち、
   仕入れ・棚卸しを記録する。app.js が window.LotusPL に共通部品を出している。 */
(function () {
  'use strict';
  const P = window.LotusPL;
  if (!P) return;
  const { state, api, openSheet, closeSheet, toast, esc, yen, STORES, STORE_VAR, businessToday, storesInView, dayLabel, $ } = P;

  const CATS = ['酒', '割材・ソフトドリンク', 'フード', '消耗品', '備品', 'その他'];
  const UNITS = ['本', '個', '袋', '箱', 'kg', 'L', 'パック', 'ケース'];
  const VIEWS = [['list', '在庫一覧'], ['order', '仕入れ管理'], ['history', '仕入れ履歴'], ['count', '棚卸し']];
  const LSV = 'lotus_inv_view';
  let view = 'list';
  try { view = localStorage.getItem(LSV) || 'list'; } catch (e) {}
  if (!VIEWS.some(([k]) => k === view)) view = 'list';

  const inv = { items: null, ordq: {}, exp: {}, val: {}, log: {}, loading: false, error: '', cat: '', q: '', countStore: null, reorder: false };
  // 並び順：manual＝自分で決めた順（並び替えボタンで変更）／cat＝カテゴリ別／name＝名前順／low＝在庫が少ない順
  const SORTS = [['manual', '自分の並び順'], ['cat', 'カテゴリ別'], ['name', '名前順'], ['low', '在庫が少ない順']];
  const LSS = 'lotus_inv_sort';
  let sortBy = 'manual';
  try { sortBy = localStorage.getItem(LSS) || 'manual'; } catch (e) {}
  if (!SORTS.some(([k]) => k === sortBy)) sortBy = 'manual';
  // 自分の並び順（order）→ 登録順
  const ordered = (xs) => [...xs].sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order) || (a.created || 0) - (b.created || 0));
  const n2 = (v) => (Math.round((Number(v) || 0) * 100) / 100);
  const fmtQ = (v, unit) => `${n2(v).toLocaleString('ja-JP')}${unit ? `<small>${esc(unit)}</small>` : ''}`;
  const stock = (it, s) => n2((it.stock || {})[s]);
  const minOf = (it, s) => ((it.minStock || {})[s] == null ? null : n2(it.minStock[s]));
  // 最大在庫数（常に置いておきたい数）。未設定なら仕入れライン×2
  const mustOf = (it, s) => { const t = (it.target || {})[s]; return t != null && t > 0 ? n2(t) : null; };
  // 発注が必要：仕入れライン以下になった（仕入れライン未設定なら最大在庫数を下回った）
  const low = (it, s) => { const m = minOf(it, s); if (m != null && m > 0) return stock(it, s) <= m; const t = mustOf(it, s); return t != null && stock(it, s) < t; };
  const targetOf = (it, s) => { const t = (it.target || {})[s]; return t != null && t > 0 ? n2(t) : n2((minOf(it, s) || 0) * 2); };
  const needOf = (it, s) => Math.max(1, Math.ceil(targetOf(it, s) - stock(it, s)));
  // 仕入れ管理で手で変えた仕入れ数（なければ null）
  const manQ = (it, s) => { const o = (inv.ordq || {})[it.id]; return o && o[s] != null ? n2(o[s]) : null; };
  // 仕入れ数：自分で入れた数だけ（自動では入れない）
  const ordQ = (it, s) => manQ(it, s) || 0;
  // 仕入れ管理に出す商品：発注が必要 or 手で数を入れた
  const inOrder = (it, stores) => stores.some((s) => low(it, s) || manQ(it, s) > 0);
  // 入数：ネットで1回に買う単位（1ケース）に入っている数。入力がなければ仕入れ先の名前から読み取る（例「6本」「×30本」）
  function packOf(it, sp) {
    if (!sp || (it && it.unit === 'ケース')) return 1;
    const p = Number(sp.pack); if (p >= 1) return p;
    const u = (it && it.unit) || '本';
    const m = [...String(sp.name || '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).matchAll(new RegExp('(\\d+)\\s*' + (u === '本' ? '本' : u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'g'))];
    const n = m.length ? Number(m[m.length - 1][1]) : 1;
    return n >= 2 && n <= 200 ? n : 1;
  }
  const isCase = (it, sp) => packOf(it, sp) > 1;
  const ordUnit = (it, sp) => (isCase(it, sp) ? 'ケース' : it.unit || ''); // 発注・仕入れの単位
  const perUnit = (it, sp) => sp.price / packOf(it, sp); // 1本（在庫の単位）あたりの値段
  function cheapest(it) {
    const xs = (it.suppliers || []).filter((s) => s.price != null && s.price > 0);
    return xs.length ? xs.reduce((a, b) => (perUnit(it, b) < perUnit(it, a) ? b : a)) : null;
  }
  const priceLabel = (it, c) => (isCase(it, c) ? `${yen(c.price)}/ケース(${packOf(it, c)}${esc(it.unit || '')})` : yen(c.price));
  // 到着予定：今日注文した場合（定期チェックで調べた「何日で届くか」から計算）
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  // cutoff（例 '13:00'）＝その時刻までの注文なら lead 日後に届く。過ぎたら翌日注文扱いで +1日
  function etaOf(sp) {
    if (!sp || sp.lead == null) return null;
    const j = new Date(Date.now() + 9 * 3600e3); // 日本時間
    const [y, m, d] = j.toISOString().slice(0, 10).split('-').map(Number);
    const nowMin = j.getUTCHours() * 60 + j.getUTCMinutes();
    const c = /^(\d{2}):(\d{2})$/.exec(sp.cutoff || '');
    const cutMin = c ? Math.min(24 * 60, Number(c[1]) * 60 + Number(c[2])) : null;
    const late = cutMin != null && nowMin >= cutMin;
    const t = new Date(Date.UTC(y, m - 1, d + Number(sp.lead) + (late ? 1 : 0)));
    const left = cutMin != null && !late ? cutMin - nowMin : null;
    const leftLabel = left == null ? '' : left >= 60 ? `約${Math.floor(left / 60)}時間` : `約${left}分`;
    return { label: `${t.getUTCMonth() + 1}/${t.getUTCDate()}(${WD[t.getUTCDay()]})`, lead: Number(sp.lead), at: sp.etaAt || '', note: sp.etaNote || '', cutoff: sp.cutoff || '', late, leftLabel };
  }
  const etaTag = (sp) => {
    const e = etaOf(sp); if (!e) return '';
    const head = e.leftLabel ? `今日あと${e.leftLabel}以内の注文で` : e.late ? `締切${e.cutoff}過ぎ→明日注文で` : '今日注文→';
    return `<span class="eta ${e.leftLabel && /分$/.test(e.leftLabel) ? 'soon' : ''}" title="到着予定（${esc(e.at)} に確認${e.note ? '：' + esc(e.note) : ''}${e.cutoff ? `・締切 ${e.cutoff}` : ''}）">🚚 ${head}${e.leftLabel ? '→' : ''}${e.label}着</span>`;
  };
  const unitCost = (it) => { const c = cheapest(it); return c ? perUnit(it, c) : null; };
  const link = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" class="linkbtn">${t}</a>` : t);
  const searchUrl = (name) => 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(name);
  const todayStr = () => businessToday();

  async function ensure(force) {
    const ym = state.month;
    if (!force && inv.items && inv.log[ym]) return;
    if (inv.loading) return;
    inv.loading = true; inv.error = '';
    try {
      const j = await api('invList', { month: ym });
      inv.items = j.items || []; inv.ordq = j.ordq || {}; inv.exp[ym] = j.exp || { data: {}, from: {} }; inv.val[ym] = j.val || null; inv.log[ym] = j.log || [];
    } catch (e) { inv.error = e.message; }
    inv.loading = false;
    if (state.tab === 'inv' || state.tab === 'sales') P.render();
  }
  async function refresh() { inv.log = {}; await ensure(true); }

  // ---------- view ----------
  function viewInv() {
    if (!inv.items || !inv.log[state.month]) {
      ensure();
      return inv.error ? `<div class="err"><b>在庫を読み込めませんでした</b><br>${esc(inv.error)}</div>` : '<div class="skel"></div><div class="skel" style="height:220px"></div>';
    }
    const stores = storesInView();
    const lowCount = inv.items.filter((it) => stores.some((s) => low(it, s))).length;
    const head = `<div class="inv-top">
      <div class="seg inv-seg" role="tablist">${VIEWS.map(([k, l]) => `<button class="${view === k ? 'on' : ''}" data-act="invview" data-v="${k}">${l}${k === 'order' && lowCount ? ` <span class="badge bad">${lowCount}</span>` : ''}</button>`).join('')}</div>
      <span class="spacer"></span>
      <button class="btn primary" data-act="invedit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>商品を追加</button>
    </div>`;
    const body = view === 'order' ? viewOrder(stores) : view === 'history' ? viewHistory(stores) : view === 'count' ? viewCount() : viewList(stores, lowCount);
    return head + body;
  }

  function monthPurchases(stores, ym) {
    return (inv.log[ym] || []).filter((e) => e.type === 'purchase' && stores.includes(e.store));
  }

  function viewList(stores, lowCount) {
    const items = inv.items;
    const buy = monthPurchases(stores, state.month).reduce((a, e) => a + (e.total || 0), 0);
    const [, m] = state.month.split('-').map(Number);
    const tiles = `<div class="tiles">
      <div class="tile"><div class="k">商品数</div><div class="v">${items.length}<small>品</small></div><div class="s">${[...new Set(items.map((i) => i.category).filter(Boolean))].length} カテゴリ</div></div>
      <div class="tile"><div class="k">要仕入れ</div><div class="v ${lowCount ? 'negv' : ''}">${lowCount}<small>品</small></div><div class="s">仕入れライン以下</div></div>
      <div class="tile"><div class="k">${m}月の仕入れ金額</div><div class="v">${yen(buy)}</div><div class="s">${monthPurchases(stores, state.month).length}件</div></div>
    </div>`;
    if (!items.length) {
      return tiles + `<div class="card"><div class="empty"><b>商品がまだありません</b>「商品を追加」から、お酒・割材・消耗品などを登録してください。<br>仕入れ先ごとの値段とURLを入れておくと、最安のお店がひと目でわかります。<div style="margin-top:14px"><button class="btn primary" data-act="invedit">商品を追加</button></div></div></div>`;
    }
    const cats = [...new Set(items.map((i) => i.category || 'その他'))].sort((a, b) => (CATS.indexOf(a) + 99) % 99 - (CATS.indexOf(b) + 99) % 99);
    const shown = items.filter((it) => !inv.cat || (it.category || 'その他') === inv.cat);
    const filters = `<div class="inv-filter">
      <div class="chips"><button class="chip-sel ${inv.cat ? '' : 'on'}" data-act="invcat" data-v="">すべて</button>${cats.map((c) => `<button class="chip-sel ${inv.cat === c ? 'on' : ''}" data-act="invcat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <input type="search" class="inv-q" id="inv-q" placeholder="商品名・保管場所で検索" value="${esc(inv.q)}">
    </div>`;
    if (inv.reorder && sortBy !== 'cat') sortBy = 'manual'; // カテゴリ別のときはカテゴリの中で並び替え
    const sortBar = `<div class="inv-sortbar">
      <label class="hint" for="inv-sort">並び順</label>
      <select id="inv-sort" class="inv-sort" ${inv.reorder ? 'disabled' : ''}>${SORTS.map(([k, l]) => `<option value="${k}" ${sortBy === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="spacer"></span>
      ${inv.reorder ? `<span class="hint">≡ をドラッグ、または ↑↓ で移動${sortBy === 'cat' ? '（カテゴリの中で）' : ''}</span><button class="btn sm primary" data-act="invreorder">完了</button>` : '<button class="btn sm" data-act="invreorder">並び替え</button>'}
    </div>`;
    let groups;
    if (sortBy === 'cat') {
      groups = cats.filter((c) => !inv.cat || inv.cat === c).map((c) => {
        const rows = ordered(shown.filter((it) => (it.category || 'その他') === c));
        if (!rows.length) return '';
        return `<div class="inv-g sortable ${inv.reorder ? 'reorder' : ''}"><div class="grp-h inv-cat">${esc(c)} <span>${rows.length}</span></div>` + rows.map((it) => itemRow(it, stores)).join('') + '</div>';
      }).join('');
    } else {
      let rows = ordered(shown);
      if (sortBy === 'name') rows = [...shown].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      if (sortBy === 'low') {
        const ratio = (it) => Math.min(...stores.map((s) => { const m = minOf(it, s); return m ? stock(it, s) / m : stock(it, s) + 1e3; }));
        rows = [...shown].sort((a, b) => ratio(a) - ratio(b));
      }
      groups = `<div class="inv-g sortable ${inv.reorder ? 'reorder' : ''}" id="inv-flat">` + rows.map((it) => itemRow(it, stores)).join('') + '</div>';
    }
    setTimeout(applySearch, 0);
    return tiles + filters + sortBar + `<div class="card inv-list">${groups || ''}<div class="empty" id="inv-none" style="display:none">該当する商品がありません</div></div>`;
  }

  function itemRow(it, stores) {
    const c = cheapest(it);
    const isLow = stores.some((s) => low(it, s));
    const st = stores.map((s) => {
      const m = minOf(it, s);
      return `<div class="inv-st ${low(it, s) ? 'low' : ''}">${stores.length > 1 ? `<i style="background:${STORE_VAR[s]}"></i>` : ''}<b>${fmtQ(stock(it, s), it.unit)}</b>${mustOf(it, s) != null || m ? `<span>${mustOf(it, s) != null ? `最大 ${mustOf(it, s)}` : ''}${mustOf(it, s) != null && m ? '・' : ''}${m ? `ライン ${n2(m)}` : ''}</span>` : ''}</div>`;
    }).join('');
    const mv = inv.reorder ? `<div class="inv-mv"><span class="inv-handle" data-id="${it.id}" aria-label="ドラッグで移動">≡</span><button class="icon-btn" data-act="invmove" data-id="${it.id}" data-d="-1" aria-label="上へ">↑</button><button class="icon-btn" data-act="invmove" data-id="${it.id}" data-d="1" aria-label="下へ">↓</button></div>` : '';
    return `<div class="inv-row ${inv.reorder ? 'mv' : ''}" data-id="${it.id}" data-s="${esc((it.name + ' ' + (it.location || '') + ' ' + (it.memo || '')).toLowerCase())}">
      ${mv}<button class="inv-main" data-act="invedit" data-id="${it.id}">
        <div class="inv-nm"><b>${esc(it.name)}</b>${isLow ? '<span class="badge bad">要仕入れ</span>' : ''}</div>
        <div class="inv-sub">${it.location ? `📍${esc(it.location)}　` : ''}${c ? `最安 <b>${priceLabel(it, c)}</b> ${esc(c.name)} ${etaTag(c)}` : '<span class="hint">仕入れ先未登録</span>'}</div>
      </button>
      <div class="inv-stocks">${st}</div>
      <div class="inv-acts">${c && c.url ? link(c.url, '購入') : ''}<button class="btn sm" data-act="invbuy" data-id="${it.id}">記録</button></div>
    </div>`;
  }

  // カテゴリ順（酒→割材→フード→消耗品→備品→その他→それ以外）にまとめる。中は自分の並び順
  function catGroups(items) {
    const m = new Map();
    for (const it of ordered(items)) { const c = it.category || 'その他'; if (!m.has(c)) m.set(c, []); m.get(c).push(it); }
    const rank = (c) => (CATS.indexOf(c) < 0 ? 99 : CATS.indexOf(c));
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }
  // 仕入れ管理のまとめ方：cat＝カテゴリ別／sup＝仕入れ先別（最安の仕入れ先ごと）
  const LSG = 'lotus_inv_ordgrp';
  let ordGrp = 'cat';
  try { ordGrp = localStorage.getItem(LSG) === 'sup' ? 'sup' : 'cat'; } catch (e) {}
  const NOSUP = '仕入れ先未登録';
  // リンクのドメインからネットのサイト名を判定（リンクがなければ仕入れ先の名前）
  const SITES = [[/(^|\.)amazon\./, 'Amazon'], [/(^|\.)amzn\./, 'Amazon'], [/(^|\.)rakuten\./, '楽天市場'], [/shopping\.yahoo|paypaymall|paypay-mall|(^|\.)yahoo\./, 'Yahoo!ショッピング'],
    [/biccamera/, 'ビックカメラ'], [/yodobashi/, 'ヨドバシ'], [/askul/, 'アスクル'], [/lohaco/, 'LOHACO'], [/monotaro/, 'モノタロウ'], [/kakuyasu/, 'カクヤス'], [/costco/, 'コストコ'],
    [/donki|donki-ec|majica/, 'ドン・キホーテ'], [/gyomusuper|gyomu-super/, '業務スーパー'], [/mercari/, 'メルカリ'], [/aeon/, 'イオン'], [/lohaco/, 'LOHACO'], [/qoo10/, 'Qoo10'], [/au-pay|wowma/, 'au PAY マーケット'], [/(^|\.)google\./, 'Google検索（サイト不明）']];
  function siteOf(url) {
    let h = ''; try { h = new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
    const hit = SITES.find(([re]) => re.test(h));
    return hit ? hit[1] : h.replace(/^www\./, '');
  }
  function supKey(it) {
    const c = cheapest(it) || (it.suppliers || []).find((x) => x.name || x.url);
    if (!c) return NOSUP;
    return (c.url && siteOf(c.url)) || c.name || NOSUP;
  }
  function supGroups(items) {
    const m = new Map();
    for (const it of ordered(items)) { const k = supKey(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return [...m.entries()].sort((a, b) => (a[0] === NOSUP) - (b[0] === NOSUP) || b[1].length - a[1].length || a[0].localeCompare(b[0], 'ja'));
  }
  const ordGroups = (items) => (ordGrp === 'sup' ? supGroups(items) : catGroups(items));
  function viewOrder(stores) {
    // 店舗ごとの仕入れ数（その店舗で発注が必要なときだけ）
    const needIn = ordQ;
    const rows = ordered(inv.items.filter((it) => inOrder(it, stores)));
    const edited = rows.some((it) => stores.some((s) => manQ(it, s) > 0));
    const qtyOf = (it) => stores.reduce((a, s) => a + needIn(it, s), 0);
    const costOf = (it) => { const c = cheapest(it); return c ? qtyOf(it) * c.price : 0; };
    const total = rows.reduce((a, it) => a + costOf(it), 0);
    const multi = stores.length > 1;
    // 仕入れ予定金額（最安の仕入れ先の値段 × 仕入れ数）
    const amtIn = (it, s) => { const c = cheapest(it); return c ? needIn(it, s) * c.price : 0; };
    const storeAmt = stores.map((s) => rows.reduce((a, it) => a + amtIn(it, s), 0));
    const noPrice = rows.filter((it) => !cheapest(it)).length;
    const tiles = rows.length ? `<div class="tiles">
      ${stores.map((s, k) => `<div class="tile"><div class="k"><span class="dot" style="background:${STORE_VAR[s]};display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px"></span>${s} の仕入れ予定金額</div><div class="v">${yen(storeAmt[k])}</div><div class="s">${rows.filter((it) => needIn(it, s)).length}品</div></div>`).join('')}
      ${multi ? `<div class="tile hero"><div class="k">仕入れ予定金額 合計</div><div class="v">${yen(total)}</div><div class="s">${rows.length}品${noPrice ? `・値段未登録 ${noPrice}品（金額に入っていません）` : ''}</div></div>` : ''}
    </div>` : '';
    const head = `<div class="ord-head"><span></span>${stores.map((s) => `<span><i class="dot" style="background:${STORE_VAR[s]}"></i>${s.replace('店', '')}</span>`).join('')}${multi ? '<span>合計</span>' : ''}</div>`;
    const row = (it) => {
      const c = cheapest(it); const su = esc(it.unit || ''); const u = esc(ordUnit(it, c)); const sum = qtyOf(it);
      const cell = (s) => { const q = needIn(it, s); const lw = low(it, s); const tip = `${s}：今 ${n2(stock(it, s))}${su}・最大 ${targetOf(it, s)}${su}（押すと仕入れ数を入力・仕入れを記録）`; return q
        ? `<button class="ord-q" data-act="invqty" data-id="${it.id}" data-store="${s}" title="${tip}"><b>${n2(q)}</b><small>${u}</small><em>今${n2(stock(it, s))}/${targetOf(it, s)}${su}</em>${c ? `<i class="amt">${yen(q * c.price)}</i>` : ''}</button>`
        : lw ? `<button class="ord-q none need" data-act="invqty" data-id="${it.id}" data-store="${s}" title="${tip}"><b>入力</b><em>今${n2(stock(it, s))}/${targetOf(it, s)}${su}</em></button>`
        : `<button class="ord-q none" data-act="invqty" data-id="${it.id}" data-store="${s}" title="${tip}">—</button>`; };
      return `<div class="ord-row">
        <div class="ord-nm"><b>${esc(it.name)}</b><div class="inv-sub">${c ? `最安 ${c.url && siteOf(c.url) ? `<span class="site-tag">${esc(siteOf(c.url))}</span>` : ''}${link(c.url, esc(c.name))} ${priceLabel(it, c)}${sum ? ` × ${n2(sum)}${u} ＝ <b>${yen(sum * c.price)}</b>` : ''} ${etaTag(c)}` : `<a class="linkbtn" target="_blank" rel="noopener noreferrer" href="${esc(searchUrl(it.name))}">ネットで最安を探す</a>`}</div></div>
        ${stores.map(cell).join('')}
        ${multi ? (sum ? `<div class="ord-q sum"><b>${n2(sum)}</b><small>${u}</small>${c ? `<i class="amt">${yen(sum * c.price)}</i>` : ''}</div>` : '<span class="ord-q none" style="border:0">—</span>') : ''}
      </div>`;
    };
    // カテゴリごとに分けて表示
    const list = rows.length ? ordGroups(rows).map(([cat, xs]) => {
      const sub = xs.reduce((a, it) => a + costOf(it), 0);
      return `<div class="grp-h inv-cat">${esc(cat)} <span>${xs.length}品${sub ? `・${yen(sub)}` : ''}</span></div>` + xs.map(row).join('');
    }).join('') : '<div class="empty" style="padding:22px">発注が必要な商品はありません</div>';
    return `<p class="hint" style="margin:0 0 12px">仕入れライン以下になった商品が並びます。仕入れ数は自動では入らないので、「入力」や数字を押して入れてください（その店舗の仕入れ記録もできます。仕入れを記録すると仕入れ数は空に戻ります）。小さい数字は「今の在庫／最大在庫数」と仕入れ予定金額（最安の値段 × 仕入れ数）。</p>
      ${tiles}<div class="card ord ${multi ? '' : 'one'}"><div class="card-h"><h3>仕入れ管理</h3><div class="ord-grp" role="tablist">${[['cat', 'カテゴリ別'], ['sup', '仕入れ先別']].map(([k, l]) => `<button class="${ordGrp === k ? 'on' : ''}" data-act="invordgrp" data-v="${k}">${l}</button>`).join('')}</div><span class="hint">${rows.length}品${total ? `・目安 ${yen(total)}` : ''}</span><span class="spacer"></span>${edited ? '<button class="btn sm" data-act="invqtyreset">仕入れ数をクリア</button>' : ''}${edited ? '<button class="btn sm" data-act="invcopy">リストをコピー</button>' : ''}</div>
      ${rows.length ? head : ''}${list}</div>`;
  }

  function viewHistory(stores) {
    const log = (inv.log[state.month] || []).filter((e) => stores.includes(e.store)).sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
    const buys = log.filter((e) => e.type === 'purchase');
    const total = buys.reduce((a, e) => a + (e.total || 0), 0);
    const byCat = {}; for (const e of buys) byCat[e.category || 'その他'] = (byCat[e.category || 'その他'] || 0) + (e.total || 0);
    const bySup = {}; for (const e of buys) if (e.supplier) bySup[e.supplier] = (bySup[e.supplier] || 0) + (e.total || 0);
    const [, m] = state.month.split('-').map(Number);
    const bars = (obj) => { const xs = Object.entries(obj).sort((a, b) => b[1] - a[1]); const mx = Math.max(1, ...xs.map((x) => x[1])); return xs.length ? xs.map(([k, v]) => `<div class="inv-bar"><span>${esc(k)}</span><i style="width:${Math.max(3, (v / mx) * 100)}%"></i><b>${yen(v)}</b></div>`).join('') : '<div class="hint">まだありません</div>'; };
    const T = { purchase: ['仕入れ', 'ok'], count: ['棚卸し', 'mute'], adjust: ['在庫修正', 'warn'] };
    const rows = log.map((e) => `<div class="inv-log">
        <span class="d">${dayLabel(e.date)}</span>
        ${stores.length > 1 ? `<span class="dot" style="background:${STORE_VAR[e.store]}"></span>` : ''}
        <span class="badge ${T[e.type][1]}">${T[e.type][0]}</span>
        <span class="nm">${esc(e.name)}</span>
        <span class="q">${e.type === 'purchase' ? `+${n2(e.qty)}${esc(e.unit || '')} × ${yen(e.unitPrice)}` : `${n2(e.before)} → ${n2(e.after)}${esc(e.unit || '')}（${e.qty > 0 ? '+' : ''}${n2(e.qty)}）`}</span>
        <span class="who">${e.type === 'purchase' ? esc(e.supplier || '') : ''}</span>
        <b class="t">${e.type === 'purchase' ? yen(e.total) : ''}</b>
        ${e.type === 'purchase' ? `<button class="del" data-act="invlogdel" data-id="${e.id}" aria-label="削除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>` : '<span></span>'}
      </div>`).join('');
    return `<div class="tiles">
        <div class="tile hero"><div class="k">${m}月の仕入れ金額</div><div class="v">${yen(total)}</div><div class="s">${buys.length}件${stores.length > 1 ? ' ・ ' + STORES.map((s) => `${s} ${yen(buys.filter((e) => e.store === s).reduce((a, e) => a + e.total, 0))}`).join(' ・ ') : ''}</div></div>
      </div>
      <div class="grid2" style="margin-bottom:14px">
        <div class="card"><div class="card-h"><h3>カテゴリ別</h3></div><div class="card-b">${bars(byCat)}</div></div>
        <div class="card"><div class="card-h"><h3>仕入れ先別</h3></div><div class="card-b">${bars(bySup)}</div></div>
      </div>
      <div class="card"><div class="card-h"><h3>記録</h3><span class="hint">仕入れを削除すると、その分の在庫も戻ります</span></div>${rows || '<div class="empty">この月の記録はありません</div>'}</div>`;
  }

  function viewCount() {
    const stores = storesInView();
    if (!inv.countStore || !stores.includes(inv.countStore)) inv.countStore = stores[0];
    const s = inv.countStore;
    const items = sortBy === 'cat' ? ordered(inv.items).sort((a, b) => (CATS.indexOf(a.category) + 99) % 99 - (CATS.indexOf(b.category) + 99) % 99) : sortBy === 'name' ? [...inv.items].sort((a, b) => a.name.localeCompare(b.name, 'ja')) : ordered(inv.items);
    if (!items.length) return '<div class="card"><div class="empty"><b>商品がまだありません</b>先に「商品を追加」から登録してください。</div></div>';
    let cat = '';
    const rows = items.map((it) => {
      const h = (it.category || 'その他') !== cat ? `<div class="grp-h inv-cat">${esc((cat = it.category || 'その他'))}</div>` : '';
      const last = (it.lastCount || {})[s];
      return h + `<div class="inv-cnt">
        <div><b>${esc(it.name)}</b><div class="hint">${it.location ? esc(it.location) + '・' : ''}前回 ${last ? dayLabel(last) : '—'}</div></div>
        <div class="cur">今 ${fmtQ(stock(it, s), it.unit)}</div>
        <input type="number" inputmode="decimal" min="0" step="0.5" data-cnt="${it.id}" data-before="${stock(it, s)}" placeholder="数えた数">
        <span class="diff" id="diff-${it.id}"></span>
      </div>`;
    }).join('');
    return `<div class="card">
      <div class="card-h" style="flex-wrap:wrap">
        ${stores.length > 1 ? `<div class="chips">${stores.map((x) => `<button class="chip-sel ${x === s ? 'on' : ''}" data-act="invcntstore" data-v="${x}">${x}</button>`).join('')}</div>` : `<span class="dot" style="background:${STORE_VAR[s]}"></span><h3>${s}</h3>`}
        <span class="spacer"></span>
        <label class="hint" for="cnt-date">日付</label><input id="cnt-date" type="date" class="btn sm" value="${todayStr()}">
      </div>
      <div class="card-b"><p class="hint" style="margin:0 0 6px">数えた数だけ入れてください（空欄の商品はそのまま）。保存すると在庫がその数に置き換わり、差が「棚卸し」として記録されます。月末に行うと、その月に使った量・ロスがわかります。</p></div>
      ${rows}
      <div class="sh-f" style="position:static"><button class="btn primary" data-act="invcountsave">${s}の棚卸しを保存</button></div>
    </div>`;
  }

  // ---------- 商品の追加・編集 ----------
  let draftSup = [];
  function supRows() {
    const unit = $('#i-unit') ? $('#i-unit').value : '本';
    const fake = { unit };
    const pu = (x) => Number(x.price) / packOf(fake, { ...x, pack: x.pack === '' ? null : x.pack });
    const cmin = Math.min(...draftSup.filter((x) => Number(x.price) > 0).map(pu));
    return draftSup.map((x, i) => { const auto = packOf(fake, { name: x.name }); return `<div class="inv-sup">
      <input data-sup="${i}" data-k="name" placeholder="仕入れ先（例：Amazon・業務スーパー）" value="${esc(x.name)}">
      <span class="yen-in"><input data-sup="${i}" data-k="price" type="number" inputmode="numeric" min="0" placeholder="値段（1回に買う単位の値段）" value="${x.price == null ? '' : x.price}"></span>
      <label class="inv-pack">入数<input data-sup="${i}" data-k="pack" type="number" inputmode="numeric" min="1" step="1" placeholder="${auto > 1 ? auto : 1}" value="${x.pack == null ? '' : x.pack}"><span>${esc(unit)}/回</span></label>
      <input data-sup="${i}" data-k="url" type="url" inputmode="url" placeholder="URL（任意）" value="${esc(x.url || '')}">
      <div class="inv-sup-f">${Number(x.price) > 0 && pu(x) === cmin ? '<span class="badge ok">最安</span>' : ''}${x.url ? link(x.url, '開く') : ''}<button class="linkbtn" data-act="invsupdel" data-i="${i}">削除</button></div>
    </div>`; }).join('') || '<div class="hint">まだありません</div>';
  }
  function openItem(id) {
    const it = id ? inv.items.find((x) => x.id === id) : null;
    draftSup = it ? (it.suppliers || []).map((x) => ({ ...x })) : [{ name: '', price: null, url: '' }];
    const cat = it ? it.category : inv.cat || CATS[0];
    openSheet(`
      <div class="sh-h"><div><h2>${it ? '商品を編集' : '商品を追加'}</h2>${it && it.lastPurchase ? `<div class="sub">最終仕入れ ${dayLabel(it.lastPurchase)}</div>` : ''}</div>
        <button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sh-b">
        <div class="fld"><label for="i-name">商品名</label><input id="i-name" value="${esc(it ? it.name : '')}" placeholder="例：鏡月 1.8L"></div>
        <div class="row3">
          <div class="fld"><label for="i-cat">カテゴリ</label><select id="i-cat">${[...new Set([...CATS, ...inv.items.map((x) => x.category).filter(Boolean)])].map((c) => `<option value="${esc(c)}" ${c === (cat || CATS[0]) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
          <div class="fld"><label for="i-unit">単位</label><select id="i-unit">${(() => { const u = it ? it.unit : '本'; return [...new Set([...UNITS, ...(u ? [u] : [])])].map((c) => `<option value="${esc(c)}" ${c === u ? 'selected' : ''}>${esc(c)}</option>`).join(''); })()}</select></div>
          <div class="fld"><label for="i-loc">保管場所</label><input id="i-loc" value="${esc(it ? it.location || '' : '')}" placeholder="例：バックヤード棚"></div>
        </div>
        <div class="grp-h">最大在庫数と仕入れライン</div>
        <div class="inv-st-edit">${STORES.map((s) => `<div class="fld"><label><span class="dot" style="background:${STORE_VAR[s]}"></span> ${s} 最大在庫数</label><input type="number" inputmode="decimal" min="0" step="0.5" data-target="${s}" value="${it && mustOf(it, s) != null ? mustOf(it, s) : ''}" placeholder="例：6"></div>
          <div class="fld"><label>仕入れライン</label><input type="number" inputmode="decimal" min="0" step="0.5" data-min="${s}" value="${it && minOf(it, s) != null ? minOf(it, s) : ''}" placeholder="空欄可"></div>
          ${it ? `<div class="fld"><label>今の在庫</label><div class="inv-now">${fmtQ(stock(it, s), it.unit)}</div></div>` : `<div class="fld"><label>今の在庫</label><input type="number" inputmode="decimal" min="0" step="0.5" data-stock="${s}" value="" placeholder="0"></div>`}`).join('')}</div>
        <div class="hint" style="margin-top:-6px">在庫が「仕入れライン」以下（未設定なら最大在庫数を下回る）と仕入れ管理に出ます。仕入れ数は「最大在庫数 − 今の在庫」です。${it ? '今の在庫は「仕入れ」「棚卸し」で更新されます。' : ''}</div>
        <div class="grp-h" style="display:flex;align-items:center;gap:8px">仕入れ先と値段<span class="spacer"></span><a class="linkbtn" id="i-search" target="_blank" rel="noopener noreferrer" href="${esc(searchUrl(it ? it.name : ''))}">ネットで最安を探す</a></div>
        <div id="i-sups">${supRows()}</div>
        <div><button class="btn sm" data-act="invsupadd">＋ 仕入れ先を追加</button></div>
        <div class="fld"><label for="i-memo">メモ</label><textarea id="i-memo" rows="2" placeholder="例：ケース買いだと安い・賞味期限に注意">${esc(it ? it.memo || '' : '')}</textarea></div>
        ${it ? `<div><button class="btn sm danger" data-act="invdel" data-id="${it.id}">この商品を削除</button></div>` : ''}
      </div>
      <div class="sh-f"><button class="btn" data-act="close">閉じる</button>${it ? `<button class="btn" data-act="invbuy" data-id="${it.id}">仕入れを記録</button>` : ''}<button class="btn primary" data-act="invsave" data-id="${it ? it.id : ''}">保存</button></div>`);
    const nm = $('#i-name'); if (nm) nm.addEventListener('input', () => { const a = $('#i-search'); if (a) a.href = searchUrl(nm.value); });
  }
  function readSup() {
    document.querySelectorAll('[data-sup]').forEach((el) => { const x = draftSup[Number(el.dataset.sup)]; if (x) x[el.dataset.k] = el.value; });
  }
  async function saveItem(id) {
    readSup();
    const minStock = {}, stockV = {};
    document.querySelectorAll('[data-min]').forEach((el) => { if (el.value !== '') minStock[el.dataset.min] = Number(el.value); });
    const target = {}; document.querySelectorAll('[data-target]').forEach((el) => { if (el.value !== '') target[el.dataset.target] = Number(el.value); });
    document.querySelectorAll('[data-stock]').forEach((el) => { if (el.value !== '') stockV[el.dataset.stock] = Number(el.value); });
    const item = { id: id || undefined, name: $('#i-name').value, category: $('#i-cat').value, unit: $('#i-unit').value, location: $('#i-loc').value, memo: $('#i-memo').value, minStock, target, stock: stockV, suppliers: draftSup.map((x) => ({ ...x, price: x.price === '' || x.price == null ? null : Number(x.price), pack: x.pack === '' || x.pack == null ? null : Number(x.pack) })) };
    if (!item.name.trim()) { toast('商品名を入れてください'); return; }
    try { await api('invSave', { item, date: todayStr() }, true); closeSheet(); toast('保存しました'); await refresh(); }
    catch (e) { toast(e.message); }
  }
  async function delItem(id) {
    const it = inv.items.find((x) => x.id === id);
    if (!it || !confirm(`「${it.name}」を削除しますか？（記録は残ります）`)) return;
    try { await api('invDelete', { id }, true); closeSheet(); toast('削除しました'); await refresh(); }
    catch (e) { toast(e.message); }
  }

  // ---------- 仕入れ ----------
  function openBuy(id, store) {
    const it = inv.items.find((x) => x.id === id);
    if (!it) return;
    const stores = storesInView();
    const st = store || stores[0];
    const sups = it.suppliers || [];
    const c = cheapest(it);
    const def = c || sups[0] || null;
    const pk = packOf(it, def); const cu = pk > 1 ? 'ケース' : (it.unit || '');
    openSheet(`
      <div class="sh-h"><div><h2>仕入れを記録</h2><div class="sub">${esc(it.name)}</div></div>
        <button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sh-b">
        <div class="fld"><label>店舗</label><div class="chips">${STORES.map((s) => `<button type="button" class="chip-sel ${s === st ? 'on' : ''}" data-act="invbuystore" data-v="${s}">${s}<small style="margin-left:6px;opacity:.7">在庫 ${stock(it, s)}</small></button>`).join('')}</div></div>
        <div class="row2">
          <div class="fld"><label for="b-date">日付</label><input id="b-date" type="date" value="${todayStr()}"></div>
          <div class="fld"><label for="b-qty" id="b-qty-l">数量（${esc(cu)}）</label><input id="b-qty" type="number" inputmode="decimal" min="0" step="${pk > 1 ? 1 : 0.5}" value="1"></div>
        </div>
        <div class="row2">
          <div class="fld"><label for="b-sup">仕入れ先</label><input id="b-sup" list="b-sups" value="${esc(def ? def.name : '')}" placeholder="例：業務スーパー"><datalist id="b-sups">${sups.map((s) => `<option value="${esc(s.name)}">${s.price ? yen(s.price) : ''}</option>`).join('')}</datalist></div>
          <div class="fld"><label for="b-price" id="b-price-l">${pk > 1 ? '1ケースの値段' : '単価（円）'}</label><span class="yen-in"><input id="b-price" type="number" inputmode="numeric" min="0" value="${def && def.price ? def.price : ''}"></span></div>
        </div>
        <div class="hint" id="b-pack"></div>
        <div class="pl-row total" style="border:0"><span>合計</span><b id="b-total">—</b></div>
        ${sups.length > 1 ? `<div class="hint">登録済みの値段：${sups.filter((s) => s.price).sort((a, b) => a.price - b.price).map((s) => `${esc(s.name)} ${yen(s.price)}`).join(' ／ ')}</div>` : ''}
        <div class="fld"><label for="b-memo">メモ（任意）</label><input id="b-memo" placeholder="例：セールで購入"></div>
      </div>
      <div class="sh-f"><button class="btn" data-act="close">閉じる</button><button class="btn primary" data-act="invbuysave" data-id="${it.id}">仕入れ済み</button></div>`);
    $('#sheet').dataset.store = st;
    $('#sheet').dataset.pack = pk;
    const upd = () => {
      const q = Number($('#b-qty').value) || 0, p = Number($('#b-price').value) || 0, k = Number($('#sheet').dataset.pack) || 1;
      $('#b-total').textContent = yen(Math.round(q * p));
      $('#b-pack').textContent = k > 1 ? `1ケース＝${k}${it.unit || ''}。在庫に ${n2(q * k)}${it.unit || ''} 追加されます` : '';
    };
    $('#b-qty').addEventListener('input', upd); $('#b-price').addEventListener('input', upd);
    $('#b-sup').addEventListener('input', () => {
      const s = sups.find((x) => x.name === $('#b-sup').value);
      const k = packOf(it, s); $('#sheet').dataset.pack = k;
      $('#b-qty-l').textContent = `数量（${k > 1 ? 'ケース' : it.unit || ''}）`; $('#b-price-l').textContent = k > 1 ? '1ケースの値段' : '単価（円）';
      if (s && s.price) $('#b-price').value = s.price;
      upd();
    });
    upd();
  }
  async function saveBuy(id) {
    const store = $('#sheet').dataset.store;
    const k = Number($('#sheet').dataset.pack) || 1;
    const q = Number($('#b-qty').value), p = Number($('#b-price').value) || 0;
    // ケースで買ったときは、在庫は本数（ケース×入数）で増やし、金額はケースの値段×ケース数
    const payload = { itemId: id, store, date: $('#b-date').value, qty: q * k, unitPrice: k > 1 ? Math.round(p / k) : p, total: Math.round(q * p), supPrice: p, cases: k > 1 ? q : null, pack: k > 1 ? k : null, supplier: $('#b-sup').value, memo: $('#b-memo').value };
    if (!q) { toast('数量を入れてください'); return; }
    const it = inv.items.find((x) => x.id === id);
    try { await api('invPurchase', payload, true); closeSheet(); toast(`${store}に${k > 1 ? `${q}ケース（${n2(q * k)}${(it && it.unit) || ''}）` : q}追加しました`); await refresh(); }
    catch (e) { toast(e.message); }
  }

  async function saveCount() {
    const counts = {};
    document.querySelectorAll('[data-cnt]').forEach((el) => { if (el.value !== '') counts[el.dataset.cnt] = Number(el.value); });
    if (!Object.keys(counts).length) { toast('数えた数を入れてください'); return; }
    try { const j = await api('invCount', { store: inv.countStore, date: $('#cnt-date').value || todayStr(), counts }, true); toast(`${j.count}品の棚卸しを保存しました`); await refresh(); }
    catch (e) { toast(e.message); }
  }
  async function delLog(id) {
    if (!confirm('この仕入れの記録を削除しますか？（その分の在庫も戻ります）')) return;
    try { await api('invLogDelete', { id, month: state.month }, true); toast('削除しました'); await refresh(); }
    catch (e) { toast(e.message); }
  }
  // 仕入れ数を入れるシート（−／＋、クリア、そのまま仕入れを記録）
  function openQty(id, store) {
    const it = inv.items.find((x) => x.id === id);
    if (!it) return;
    const u = esc(it.unit || ''); const c = cheapest(it);
    const pk = packOf(it, c); const ou = esc(ordUnit(it, c));
    const man = manQ(it, store);
    const cur = man > 0 ? man : '';
    openSheet(`
      <div class="sh-h"><div><h2>仕入れ数を入力</h2><div class="sub">${esc(it.name)}・${store}</div></div>
        <button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sh-b">
        <div class="hint">今の在庫 ${stock(it, store)}${u}・最大在庫数 ${targetOf(it, store)}${u}${pk > 1 ? `<br>1ケース＝${pk}${u}・最大まで あと${n2(Math.max(0, targetOf(it, store) - stock(it, store)))}${u}（約${Math.ceil(Math.max(0, targetOf(it, store) - stock(it, store)) / pk)}ケース）` : ''}</div>
        <div class="qty-step">
          <button type="button" class="btn" data-act="invqtystep" data-d="-1" aria-label="1減らす">−</button>
          <input id="q-qty" type="number" inputmode="decimal" min="0" step="1" value="${cur}" placeholder="0">
          <button type="button" class="btn" data-act="invqtystep" data-d="1" aria-label="1増やす">＋</button>
          <span class="u">${ou}</span>
        </div>
        <div class="pl-row total" style="border:0"><span>仕入れ予定金額${c ? `（${esc(c.name)} ${priceLabel(it, c)}）` : ''}</span><b id="q-amt">—</b></div>
      </div>
      <div class="sh-f">${man > 0 ? `<button class="btn" data-act="invqtyauto" data-id="${it.id}" data-store="${store}">クリア</button>` : ''}<span class="spacer"></span>
        <button class="btn" data-act="invqtybuy" data-id="${it.id}" data-store="${store}">仕入れを記録</button>
        <button class="btn primary" data-act="invqtysave" data-id="${it.id}" data-store="${store}">決定</button></div>`);
    const upd = () => { const q = Number($('#q-qty').value) || 0; $('#q-amt').textContent = c ? yen(Math.round(q * c.price)) : '値段未登録'; };
    $('#q-qty').addEventListener('input', upd); upd();
  }
  async function saveQty(id, store, qty) {
    const prev = inv.ordq[id] ? { ...inv.ordq[id] } : null;
    const o = { ...(inv.ordq[id] || {}) };
    if (qty == null) delete o[store]; else o[store] = n2(Math.max(0, qty));
    if (Object.keys(o).length) inv.ordq[id] = o; else delete inv.ordq[id];
    closeSheet(); P.render();
    try { const j = await api('invOrdQty', { id, store, qty: qty == null ? null : n2(Math.max(0, qty)) }, true); inv.ordq = j.ordq || {}; toast(qty == null ? '仕入れ数をクリアしました' : '仕入れ数を入れました'); }
    catch (e) { if (prev) inv.ordq[id] = prev; else delete inv.ordq[id]; toast(e.message); }
    P.render();
  }
  async function resetQty() {
    const stores = storesInView();
    if (!confirm('入れた仕入れ数を、すべてクリアしますか？')) return;
    try { const j = await api('invOrdReset', { stores }, true); inv.ordq = j.ordq || {}; toast('仕入れ数をクリアしました'); }
    catch (e) { toast(e.message); }
    P.render();
  }

  async function copyOrder() {
    const stores = storesInView();
    const items = ordered(inv.items.filter((it) => stores.some((s) => ordQ(it, s) > 0)));
    if (!items.length) { toast('仕入れ数を入れてください'); return; }
    const rows = ordGroups(items).map(([cat, xs]) => `■${cat}\n` + xs.map((it) => {
      const c = cheapest(it); const u = ordUnit(it, c);
      const per = stores.map((s) => ordQ(it, s));
      const sum = n2(per.reduce((a, x) => a + x, 0));
      const parts = stores.length > 1 ? stores.map((s, k) => `${s.replace('店', '')}${per[k]}`).join(' ') + ` 計${sum}${u}` : `${sum}${u}`;
      return `・${it.name} ${parts}${c ? ` ¥${Math.round(sum * c.price).toLocaleString('ja-JP')}（${c.name} ${c.price}円${isCase(it, c) ? '/ケース' : ''}${c.url ? ' ' + c.url : ''}）` : ''}`;
    }).join('\n'));
    const amt = (s) => items.reduce((a, it) => { const c = cheapest(it); return a + (c ? Math.round(ordQ(it, s) * c.price) : 0); }, 0);
    const foot = '\n\n【仕入れ予定金額】' + (stores.length > 1 ? stores.map((s) => ` ${s.replace('店', '')} ¥${amt(s).toLocaleString('ja-JP')}`).join('') + ' ／' : '') + ` 合計 ¥${stores.reduce((a, s) => a + amt(s), 0).toLocaleString('ja-JP')}`;
    const text = `【仕入れ管理 ${dayLabel(todayStr())}】\n` + rows.join('\n\n') + foot;
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
    catch (e) { window.prompt('コピーしてください', text); }
  }

  // 検索は再描画せずに表示を切り替える（日本語入力の変換中でも途切れないように）
  function applySearch() {
    const q = inv.q.trim().toLowerCase();
    let any = false;
    document.querySelectorAll('.inv-list .inv-g').forEach((g) => {
      let n = 0;
      g.querySelectorAll('.inv-row').forEach((r) => { const ok = !q || r.dataset.s.includes(q); r.style.display = ok ? '' : 'none'; if (ok) n++; });
      g.style.display = n ? '' : 'none'; if (n) any = true;
    });
    const none = $('#inv-none'); if (none) none.style.display = any ? 'none' : '';
  }

  // ---------- 並び替え ----------
  // 画面に出ている行の順番を、全体の並び順に反映して保存（絞り込み中は、その中だけ入れ替わる）
  let saveT = null;
  function commitOrder() {
    const full = ordered(inv.items).map((x) => x.id);
    // まとまり（全体 or カテゴリ）ごとに、その中の商品が並んでいた位置だけを入れ替える
    document.querySelectorAll('.inv-list .inv-g.sortable').forEach((g) => {
      const vis = [...g.querySelectorAll('.inv-row')].map((r) => r.dataset.id);
      const slots = full.map((id, i) => (vis.includes(id) ? i : -1)).filter((i) => i >= 0);
      slots.forEach((pos, k) => { full[pos] = vis[k]; });
    });
    full.forEach((id, i) => { const it = inv.items.find((x) => x.id === id); if (it) it.order = i; });
    clearTimeout(saveT);
    saveT = setTimeout(async () => { try { await api('invOrder', { ids: full }, true); toast('並び順を保存しました'); } catch (e) { toast(e.message); } }, 700);
  }
  function moveItem(id, d) {
    const row = document.querySelector(`.inv-list .inv-row[data-id="${id}"]`); if (!row) return;
    const sib = d < 0 ? row.previousElementSibling : row.nextElementSibling; if (!sib || !sib.classList.contains('inv-row')) return;
    d < 0 ? sib.before(row) : sib.after(row);
    commitOrder();
  }
  // ≡ をつかんで上下にドラッグ（iPad・スマホの指でも動く）
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.inv-handle'); if (!h) return;
    const row = h.closest('.inv-row'); if (!row) return;
    e.preventDefault();
    drag = { row, id: h.dataset.id };
    row.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch (x) {}
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.preventDefault();
    const list = drag.row.closest('.inv-g'); if (!list) return; // 同じまとまり（カテゴリ）の中だけで動かす
    const rows = [...list.querySelectorAll('.inv-row')].filter((r) => r !== drag.row);
    const after = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    after ? after.before(drag.row) : list.append(drag.row);
    const y = e.clientY; if (y < 70) window.scrollBy(0, -12); else if (y > window.innerHeight - 90) window.scrollBy(0, 12);
  }, { passive: false });
  const endDrag = () => { if (!drag) return; drag.row.classList.remove('dragging'); drag = null; commitOrder(); };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  document.addEventListener('change', (e) => {
    if (e.target.id === 'inv-sort') { sortBy = e.target.value; try { localStorage.setItem(LSS, sortBy); } catch (x) {} P.render(); }
  });

  // ---------- events ----------
  function act(a, b) {
    switch (a) {
      case 'invview': view = b.dataset.v; try { localStorage.setItem(LSV, view); } catch (e) {} P.render(); break;
      case 'invcat': inv.cat = b.dataset.v; P.render(); break;
      case 'invedit': openItem(b.dataset.id); break;
      case 'invsave': saveItem(b.dataset.id); break;
      case 'invdel': delItem(b.dataset.id); break;
      case 'invsupadd': readSup(); draftSup.push({ name: '', price: null, url: '' }); $('#i-sups').innerHTML = supRows(); break;
      case 'invsupdel': readSup(); draftSup.splice(Number(b.dataset.i), 1); $('#i-sups').innerHTML = supRows(); break;
      case 'invbuy': openBuy(b.dataset.id, b.dataset.store); if (b.dataset.qty && $('#b-qty')) { $('#b-qty').value = b.dataset.qty; $('#b-qty').dispatchEvent(new Event('input')); } break;
      case 'invbuystore': $('#sheet').dataset.store = b.dataset.v; b.parentElement.querySelectorAll('.chip-sel').forEach((x) => x.classList.toggle('on', x === b)); break;
      case 'invbuysave': saveBuy(b.dataset.id); break;
      case 'invcntstore': inv.countStore = b.dataset.v; P.render(); break;
      case 'invcountsave': saveCount(); break;
      case 'invlogdel': delLog(b.dataset.id); break;
      case 'invcopy': copyOrder(); break;
      case 'invexp': openExp(); break;
      case 'invexpstore': openExp(b.dataset.v); break;
      case 'invexpadd': { const box = $('#exp-os'); const i = box.children.length; box.insertAdjacentHTML('beforeend', $('#sheet').dataset.expRow.split('__I__').join(String(i))); break; }
      case 'invexpsave': saveExp(b.dataset.store); break;
      case 'invordgrp': ordGrp = b.dataset.v === 'sup' ? 'sup' : 'cat'; try { localStorage.setItem(LSG, ordGrp); } catch (e) {} P.render(); break;
      case 'invqty': openQty(b.dataset.id, b.dataset.store); break;
      case 'invqtystep': { const i = $('#q-qty'); i.value = n2(Math.max(0, (Number(i.value) || 0) + Number(b.dataset.d))); i.dispatchEvent(new Event('input')); break; }
      case 'invqtysave': { const v = Number($('#q-qty').value) || 0; saveQty(b.dataset.id, b.dataset.store, v > 0 ? v : null); break; }
      case 'invqtyauto': saveQty(b.dataset.id, b.dataset.store, null); break;
      case 'invqtybuy': { const q = Number($('#q-qty').value) || 0; openBuy(b.dataset.id, b.dataset.store); if (q && $('#b-qty')) { $('#b-qty').value = q; $('#b-qty').dispatchEvent(new Event('input')); } break; }
      case 'invqtyreset': resetQty(); break;
      case 'invreorder': inv.reorder = !inv.reorder; if (inv.reorder) { if (sortBy !== 'cat') sortBy = 'manual'; inv.q = ''; } P.render(); break;
      case 'invmove': moveItem(b.dataset.id, Number(b.dataset.d)); break;
    }
  }
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'inv-q') { inv.q = t.value; applySearch(); }
    if (t.dataset && t.dataset.cnt) {
      const d = $('#diff-' + t.dataset.cnt); if (!d) return;
      if (t.value === '') { d.textContent = ''; d.className = 'diff'; return; }
      const v = n2(Number(t.value) - Number(t.dataset.before));
      d.textContent = (v > 0 ? '+' : '') + v; d.className = 'diff ' + (v < 0 ? 'neg' : v > 0 ? 'pos' : '');
    }
    if (t.dataset && t.dataset.sup !== undefined && t.dataset.k === 'price') { readSup(); }
    if (t.dataset && (t.dataset.ek || t.dataset.oa !== undefined)) updExp();
  });

  // ---------- 純利益（粗利 − 仕入れ額 − 経費） ----------
  const EXP_FIELDS = [['rent', '家賃'], ['util', '光熱費'], ['comm', '通信費・サブスク']];
  const expOf = (st) => ((inv.exp[state.month] || {}).data || {})[st] || null;
  const expSum = (e) => (e ? EXP_FIELDS.reduce((a, [k]) => a + (Number(e[k]) || 0), 0) + (e.others || []).reduce((a, o) => a + (Number(o.amt) || 0), 0) : 0);
  const fromLabel = (ym) => { const [, m] = ym.split('-').map(Number); return `${m}月`; };
  // 売上タブのPL用：原価（仕入れ額±在庫の増減）と経費。読み込み中は null
  function plData(stores) {
    if (!inv.log[state.month] || !inv.exp[state.month]) { ensure(); return null; }
    const buy = monthPurchases(stores, state.month).reduce((a, e) => a + (e.total || 0), 0);
    const v = inv.val[state.month];
    const useStock = !!(v && v.hasHistory);
    const sv = (o) => stores.reduce((a, st) => a + ((o || {})[st] || 0), 0);
    const invStart = useStock ? sv(v.start) : 0, invEnd = useStock ? sv(v.end) : 0;
    const ex = stores.map((st) => expOf(st));
    const sumBy = (k) => ex.reduce((a, e) => a + (e ? Number(e[k]) || 0 : 0), 0);
    const others = ex.reduce((a, e) => a + (e ? (e.others || []).reduce((x, o) => x + (Number(o.amt) || 0), 0) : 0), 0);
    const expLines = [...EXP_FIELDS.map(([k, l]) => [l, sumBy(k)]), ['その他', others]].filter(([, x]) => x);
    const from = (inv.exp[state.month] || {}).from || {};
    const carried = stores.filter((st) => from[st]).map((st) => `${st.replace('店', '')}は${fromLabel(from[st])}`);
    const missing = stores.filter((st) => !expOf(st));
    return {
      buy, invStart, invEnd, useStock, endIsNow: !!(v && v.endIsNow), noPrice: v ? v.noPrice : 0,
      cost: buy + invStart - invEnd,
      expTotal: ex.reduce((a, e) => a + expSum(e), 0), expLines,
      expNote: missing.length ? `${missing.join('・')}の経費が未入力です（「入力・変更」から）` : carried.length ? `${carried.join('・')}の金額を引き継いでいます` : '',
    };
  }
  function openExp(store) {
    const stores = storesInView();
    const st = store || stores[0];
    const e = expOf(st) || { rent: '', util: '', comm: '', others: [] };
    const from = ((inv.exp[state.month] || {}).from || {})[st];
    const [, m] = state.month.split('-').map(Number);
    const others = (e.others || []).length ? e.others : [{ name: '', amt: '' }];
    const oRow = (o, i) => `<div class="exp-o" data-oi="${i}"><input data-on="${i}" placeholder="項目（例：おしぼりレンタル）" value="${esc(o.name || '')}"><span class="yen-in"><input data-oa="${i}" type="number" inputmode="numeric" min="0" placeholder="金額" value="${o.amt || o.amt === 0 ? o.amt : ''}"></span></div>`;
    openSheet(`
      <div class="sh-h"><div><h2>${m}月の経費</h2><div class="sub">純利益 ＝ 粗利 − 仕入れ額 − 経費</div></div>
        <button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sh-b">
        <div class="fld"><label>店舗</label><div class="chips">${STORES.map((s) => `<button type="button" class="chip-sel ${s === st ? 'on' : ''}" data-act="invexpstore" data-v="${s}">${s}</button>`).join('')}</div></div>
        ${from ? `<div class="hint" style="margin:-4px 0 10px">${fromLabel(from)}の金額を表示しています。保存すると${m}月の金額になります。</div>` : ''}
        <div class="row2">${EXP_FIELDS.slice(0, 2).map(([k, l]) => `<div class="fld"><label>${l}</label><span class="yen-in"><input data-ek="${k}" type="number" inputmode="numeric" min="0" value="${e[k] || e[k] === 0 ? e[k] : ''}"></span></div>`).join('')}</div>
        <div class="fld"><label>${EXP_FIELDS[2][1]}</label><span class="yen-in"><input data-ek="comm" type="number" inputmode="numeric" min="0" value="${e.comm || e.comm === 0 ? e.comm : ''}"></span></div>
        <div class="fld"><label>その他</label><div id="exp-os">${others.map(oRow).join('')}</div><button type="button" class="btn sm" data-act="invexpadd" style="margin-top:6px">＋ 項目を追加</button></div>
        <div class="pl-row total" style="border:0"><span>${esc(st)} の経費合計</span><b id="exp-sum">—</b></div>
      </div>
      <div class="sh-f"><button class="btn" data-act="close">閉じる</button><button class="btn primary" data-act="invexpsave" data-store="${st}">保存</button></div>`);
    $('#sheet').dataset.expRow = oRow({ name: '', amt: '' }, '__I__');
    updExp();
  }
  function readExp() {
    const d = { others: [] };
    document.querySelectorAll('[data-ek]').forEach((el) => { d[el.dataset.ek] = el.value === '' ? 0 : Number(el.value); });
    document.querySelectorAll('#exp-os .exp-o').forEach((row) => { const n = row.querySelector('[data-on]').value.trim(); const a = row.querySelector('[data-oa]').value; if (n || a) d.others.push({ name: n, amt: a === '' ? 0 : Number(a) }); });
    return d;
  }
  function updExp() { const el = $('#exp-sum'); if (el) el.textContent = yen(expSum(readExp())); }
  async function saveExp(store) {
    try { const j = await api('expSave', { month: state.month, store, data: readExp() }, true); inv.exp[state.month] = j.exp; closeSheet(); toast('経費を保存しました'); P.render(); }
    catch (e) { toast(e.message); }
  }

  window.LotusInv = { view: viewInv, act, plData };
  if (state.tab === 'inv' || state.tab === 'sales') P.render();
})();
