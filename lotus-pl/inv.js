/* Lotus PL — 在庫タブ
   商品ごとに店舗別の在庫数・発注ライン・仕入れ先（値段・URL）を持ち、
   仕入れ・棚卸しを記録する。app.js が window.LotusPL に共通部品を出している。 */
(function () {
  'use strict';
  const P = window.LotusPL;
  if (!P) return;
  const { state, api, openSheet, closeSheet, toast, esc, yen, STORES, STORE_VAR, businessToday, storesInView, dayLabel, $ } = P;

  const CATS = ['酒', '割材・ソフトドリンク', 'フード', '消耗品', '備品', 'その他'];
  const UNITS = ['本', '個', '袋', '箱', 'kg', 'L', 'パック', 'ケース'];
  const VIEWS = [['list', '在庫一覧'], ['order', '発注リスト'], ['history', '仕入れ履歴'], ['count', '棚卸し']];
  const LSV = 'lotus_inv_view';
  let view = 'list';
  try { view = localStorage.getItem(LSV) || 'list'; } catch (e) {}
  if (!VIEWS.some(([k]) => k === view)) view = 'list';

  const inv = { items: null, log: {}, loading: false, error: '', cat: '', q: '', countStore: null };
  const n2 = (v) => (Math.round((Number(v) || 0) * 100) / 100);
  const fmtQ = (v, unit) => `${n2(v).toLocaleString('ja-JP')}${unit ? `<small>${esc(unit)}</small>` : ''}`;
  const stock = (it, s) => n2((it.stock || {})[s]);
  const minOf = (it, s) => ((it.minStock || {})[s] == null ? null : n2(it.minStock[s]));
  const low = (it, s) => { const m = minOf(it, s); return m != null && m > 0 && stock(it, s) <= m; };
  function cheapest(it) {
    const xs = (it.suppliers || []).filter((s) => s.price != null && s.price > 0);
    return xs.length ? xs.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  }
  const unitCost = (it) => { const c = cheapest(it); return c ? c.price : null; };
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
      inv.items = j.items || []; inv.log[ym] = j.log || [];
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
    const value = items.reduce((a, it) => { const c = unitCost(it); return a + (c ? stores.reduce((x, s) => x + stock(it, s) * c, 0) : 0); }, 0);
    const [, m] = state.month.split('-').map(Number);
    const tiles = `<div class="tiles">
      <div class="tile"><div class="k">商品数</div><div class="v">${items.length}<small>品</small></div><div class="s">${[...new Set(items.map((i) => i.category).filter(Boolean))].length} カテゴリ</div></div>
      <div class="tile"><div class="k">要発注</div><div class="v ${lowCount ? 'negv' : ''}">${lowCount}<small>品</small></div><div class="s">発注ライン以下</div></div>
      <div class="tile"><div class="k">${m}月の仕入れ額</div><div class="v">${yen(buy)}</div><div class="s">${monthPurchases(stores, state.month).length}件</div></div>
      <div class="tile"><div class="k">在庫金額（目安）</div><div class="v">${yen(value)}</div><div class="s">在庫数 × 最安値</div></div>
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
    const groups = cats.filter((c) => !inv.cat || inv.cat === c).map((c) => {
      const rows = shown.filter((it) => (it.category || 'その他') === c).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      if (!rows.length) return '';
      return `<div class="inv-g"><div class="grp-h inv-cat">${esc(c)} <span>${rows.length}</span></div>` + rows.map((it) => itemRow(it, stores)).join('') + '</div>';
    }).join('');
    setTimeout(applySearch, 0);
    return tiles + filters + `<div class="card inv-list">${groups || ''}<div class="empty" id="inv-none" style="display:none">該当する商品がありません</div></div>`;
  }

  function itemRow(it, stores) {
    const c = cheapest(it);
    const isLow = stores.some((s) => low(it, s));
    const st = stores.map((s) => {
      const m = minOf(it, s);
      return `<div class="inv-st ${low(it, s) ? 'low' : ''}">${stores.length > 1 ? `<i style="background:${STORE_VAR[s]}"></i>` : ''}<b>${fmtQ(stock(it, s), it.unit)}</b>${m ? `<span>発注 ${n2(m)}</span>` : ''}</div>`;
    }).join('');
    return `<div class="inv-row" data-s="${esc((it.name + ' ' + (it.location || '') + ' ' + (it.memo || '')).toLowerCase())}">
      <button class="inv-main" data-act="invedit" data-id="${it.id}">
        <div class="inv-nm"><b>${esc(it.name)}</b>${isLow ? '<span class="badge bad">要発注</span>' : ''}</div>
        <div class="inv-sub">${it.location ? `📍${esc(it.location)}　` : ''}${c ? `最安 <b>${yen(c.price)}</b> ${esc(c.name)}` : '<span class="hint">仕入れ先未登録</span>'}</div>
      </button>
      <div class="inv-stocks">${st}</div>
      <div class="inv-acts">${c && c.url ? link(c.url, '買う') : ''}<button class="btn sm" data-act="invbuy" data-id="${it.id}">仕入れ</button></div>
    </div>`;
  }

  function viewOrder(stores) {
    const blocks = stores.map((s) => {
      const rows = inv.items.filter((it) => low(it, s)).sort((a, b) => (a.category || '').localeCompare(b.category || '', 'ja'));
      const total = rows.reduce((a, it) => { const c = cheapest(it); return a + (c ? Math.max(1, minOf(it, s) - stock(it, s) + 1) * c.price : 0); }, 0);
      const list = rows.length ? rows.map((it) => {
        const c = cheapest(it); const need = Math.max(1, n2(minOf(it, s) - stock(it, s) + 1));
        return `<div class="inv-row">
          <div class="inv-main static"><div class="inv-nm"><b>${esc(it.name)}</b><span class="hint">${esc(it.category || '')}</span></div>
            <div class="inv-sub">在庫 ${fmtQ(stock(it, s), it.unit)} ／ 発注ライン ${n2(minOf(it, s))} → <b>${need}${esc(it.unit || '')}</b> 以上</div>
            <div class="inv-sub">${c ? `最安 ${link(c.url, esc(c.name))} ${yen(c.price)}　目安 <b>${yen(need * c.price)}</b>` : `<a class="linkbtn" target="_blank" rel="noopener noreferrer" href="${esc(searchUrl(it.name))}">ネットで最安を探す</a>`}</div></div>
          <div class="inv-acts"><button class="btn sm" data-act="invbuy" data-id="${it.id}" data-store="${s}">仕入れを記録</button></div>
        </div>`;
      }).join('') : '<div class="empty" style="padding:22px">発注が必要な商品はありません</div>';
      return `<div class="card" style="margin-bottom:14px"><div class="card-h"><span class="dot" style="background:${STORE_VAR[s]}"></span><h3>${s}</h3><span class="hint">${rows.length}品${total ? `・目安 ${yen(total)}` : ''}</span><span class="spacer"></span>${rows.length ? `<button class="btn sm" data-act="invcopy" data-store="${s}">リストをコピー</button>` : ''}</div>${list}</div>`;
    }).join('');
    return `<p class="hint" style="margin:0 0 12px">在庫が発注ライン以下になった商品です。目安の数は「発注ラインを1つ上回るまで」。最安は登録した仕入れ先の値段から選んでいます。</p>` + blocks;
  }

  function viewHistory(stores) {
    const log = (inv.log[state.month] || []).filter((e) => stores.includes(e.store)).sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
    const buys = log.filter((e) => e.type === 'purchase');
    const total = buys.reduce((a, e) => a + (e.total || 0), 0);
    const byCat = {}; for (const e of buys) byCat[e.category || 'その他'] = (byCat[e.category || 'その他'] || 0) + (e.total || 0);
    const bySup = {}; for (const e of buys) if (e.supplier) bySup[e.supplier] = (bySup[e.supplier] || 0) + (e.total || 0);
    const loss = log.filter((e) => e.type === 'count' && e.qty < 0);
    const lossYen = loss.reduce((a, e) => { const it = inv.items.find((x) => x.id === e.itemId); const c = it && unitCost(it); return a + (c ? -e.qty * c : 0); }, 0);
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
        <div class="tile hero"><div class="k">${m}月の仕入れ額</div><div class="v">${yen(total)}</div><div class="s">${buys.length}件${stores.length > 1 ? ' ・ ' + STORES.map((s) => `${s} ${yen(buys.filter((e) => e.store === s).reduce((a, e) => a + e.total, 0))}`).join(' ・ ') : ''}</div></div>
        <div class="tile"><div class="k">棚卸しの減り（目安）</div><div class="v">${yen(lossYen)}</div><div class="s">数え直して減った分 × 最安値</div></div>
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
    const items = [...inv.items].sort((a, b) => ((a.category || '') + a.name).localeCompare((b.category || '') + b.name, 'ja'));
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
    const cmin = Math.min(...draftSup.filter((x) => Number(x.price) > 0).map((x) => Number(x.price)));
    return draftSup.map((x, i) => `<div class="inv-sup">
      <input data-sup="${i}" data-k="name" placeholder="仕入れ先（例：Amazon・業務スーパー）" value="${esc(x.name)}">
      <input data-sup="${i}" data-k="price" type="number" inputmode="numeric" min="0" placeholder="値段（1${esc($('#i-unit') ? $('#i-unit').value : '')}あたり）" value="${x.price == null ? '' : x.price}">
      <input data-sup="${i}" data-k="url" type="url" inputmode="url" placeholder="URL（任意）" value="${esc(x.url || '')}">
      <div class="inv-sup-f">${Number(x.price) > 0 && Number(x.price) === cmin ? '<span class="badge ok">最安</span>' : ''}${x.url ? link(x.url, '開く') : ''}<button class="linkbtn" data-act="invsupdel" data-i="${i}">削除</button></div>
    </div>`).join('') || '<div class="hint">まだありません</div>';
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
        <div class="grp-h">在庫と発注ライン</div>
        <div class="inv-st-edit">${STORES.map((s) => `<div class="fld"><label><span class="dot" style="background:${STORE_VAR[s]}"></span> ${s} 在庫</label><input type="number" inputmode="decimal" min="0" step="0.5" data-stock="${s}" value="${it ? stock(it, s) : ''}" placeholder="0"></div>
          <div class="fld"><label>${s} 発注ライン</label><input type="number" inputmode="decimal" min="0" step="0.5" data-min="${s}" value="${it && minOf(it, s) != null ? minOf(it, s) : ''}" placeholder="この数以下で要発注"></div>`).join('')}</div>
        ${it ? '<div class="hint" style="margin-top:-6px">在庫数を直接変えると「在庫修正」として記録されます。ふだんは「仕入れ」「棚卸し」から更新してください。</div>' : ''}
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
    document.querySelectorAll('[data-stock]').forEach((el) => { if (el.value !== '') stockV[el.dataset.stock] = Number(el.value); });
    const item = { id: id || undefined, name: $('#i-name').value, category: $('#i-cat').value, unit: $('#i-unit').value, location: $('#i-loc').value, memo: $('#i-memo').value, minStock, stock: stockV, suppliers: draftSup.map((x) => ({ ...x, price: x.price === '' || x.price == null ? null : Number(x.price) })) };
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
    openSheet(`
      <div class="sh-h"><div><h2>仕入れを記録</h2><div class="sub">${esc(it.name)}</div></div>
        <button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sh-b">
        <div class="fld"><label>店舗</label><div class="chips">${STORES.map((s) => `<button type="button" class="chip-sel ${s === st ? 'on' : ''}" data-act="invbuystore" data-v="${s}">${s}<small style="margin-left:6px;opacity:.7">在庫 ${stock(it, s)}</small></button>`).join('')}</div></div>
        <div class="row2">
          <div class="fld"><label for="b-date">日付</label><input id="b-date" type="date" value="${todayStr()}"></div>
          <div class="fld"><label for="b-qty">数量（${esc(it.unit || '')}）</label><input id="b-qty" type="number" inputmode="decimal" min="0" step="0.5" value="1"></div>
        </div>
        <div class="row2">
          <div class="fld"><label for="b-sup">仕入れ先</label><input id="b-sup" list="b-sups" value="${esc(def ? def.name : '')}" placeholder="例：業務スーパー"><datalist id="b-sups">${sups.map((s) => `<option value="${esc(s.name)}">${s.price ? yen(s.price) : ''}</option>`).join('')}</datalist></div>
          <div class="fld"><label for="b-price">単価（円）</label><input id="b-price" type="number" inputmode="numeric" min="0" value="${def && def.price ? def.price : ''}"></div>
        </div>
        <div class="pl-row total" style="border:0"><span>合計</span><b id="b-total">—</b></div>
        ${sups.length > 1 ? `<div class="hint">登録済みの値段：${sups.filter((s) => s.price).sort((a, b) => a.price - b.price).map((s) => `${esc(s.name)} ${yen(s.price)}`).join(' ／ ')}</div>` : ''}
        <div class="fld"><label for="b-memo">メモ（任意）</label><input id="b-memo" placeholder="例：セールで購入"></div>
      </div>
      <div class="sh-f"><button class="btn" data-act="close">閉じる</button><button class="btn primary" data-act="invbuysave" data-id="${it.id}">記録する</button></div>`);
    $('#sheet').dataset.store = st;
    const upd = () => { const q = Number($('#b-qty').value) || 0, p = Number($('#b-price').value) || 0; $('#b-total').textContent = yen(Math.round(q * p)); };
    $('#b-qty').addEventListener('input', upd); $('#b-price').addEventListener('input', upd);
    $('#b-sup').addEventListener('input', () => { const s = sups.find((x) => x.name === $('#b-sup').value); if (s && s.price) { $('#b-price').value = s.price; upd(); } });
    upd();
  }
  async function saveBuy(id) {
    const store = $('#sheet').dataset.store;
    const payload = { itemId: id, store, date: $('#b-date').value, qty: Number($('#b-qty').value), unitPrice: Number($('#b-price').value) || 0, supplier: $('#b-sup').value, memo: $('#b-memo').value };
    if (!payload.qty) { toast('数量を入れてください'); return; }
    try { await api('invPurchase', payload, true); closeSheet(); toast(`${store}に${payload.qty}追加しました`); await refresh(); }
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
  async function copyOrder(store) {
    const rows = inv.items.filter((it) => low(it, store)).map((it) => {
      const c = cheapest(it); const need = Math.max(1, n2(minOf(it, store) - stock(it, store) + 1));
      return `・${it.name} ${need}${it.unit || ''}${c ? `（${c.name} ${c.price}円${c.url ? ' ' + c.url : ''}）` : ''}`;
    });
    const text = `【${store} 発注リスト ${dayLabel(todayStr())}】\n` + rows.join('\n');
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
      case 'invbuy': openBuy(b.dataset.id, b.dataset.store); break;
      case 'invbuystore': $('#sheet').dataset.store = b.dataset.v; b.parentElement.querySelectorAll('.chip-sel').forEach((x) => x.classList.toggle('on', x === b)); break;
      case 'invbuysave': saveBuy(b.dataset.id); break;
      case 'invcntstore': inv.countStore = b.dataset.v; P.render(); break;
      case 'invcountsave': saveCount(); break;
      case 'invlogdel': delLog(b.dataset.id); break;
      case 'invcopy': copyOrder(b.dataset.store); break;
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
  });

  // 売上タブの粗利カードに「今月の仕入れ額」を参考表示
  function salesNote(stores, profit) {
    if (!inv.log[state.month]) { ensure(); return ''; }
    const buy = monthPurchases(stores, state.month).reduce((a, e) => a + (e.total || 0), 0);
    if (!buy) return '';
    return `<div class="pl-row sub inv-note"><span>参考：今月の仕入れ額（在庫タブ）</span><b>−${yen(buy)}</b></div>
      <div class="pl-row sub inv-note"><span>参考：粗利 − 仕入れ額</span><b>${yen(profit - buy)}</b></div>`;
  }

  window.LotusInv = { view: viewInv, act, salesNote };
  if (state.tab === 'inv' || state.tab === 'sales') P.render();
})();
