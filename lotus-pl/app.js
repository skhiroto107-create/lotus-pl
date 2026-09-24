/* Lotus PL — フロントエンド
   Notion には接続しない。/api/lotus がタイムカードとデジタルメニューの API から
   打刻・会計を取り込み、このアプリ専用の保存先（Upstash Redis）にためる。
   この画面はそれらを店舗・日・月ごとに見て、直し、シフト予定を組むためのもの。 */
(function () {
  'use strict';

  const STORES = ['藤井寺店', '恵我之荘店'];
  const STORE_VAR = { '藤井寺店': 'var(--s1)', '恵我之荘店': 'var(--s2)' };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const BUSINESS_CUTOFF_HOUR = 10; // タイムカードに繋がらないときだけ使う予備の切替時刻(JST)
  let serverBusinessDate = null;   // タイムカードが返す「今日の営業日」
  const LS = { store: 'lotus_sm_store', tab: 'lotus_sm_tab' };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => (n == null || isNaN(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
  const yenShort = (n) => (Math.abs(n) >= 10000 ? (n / 10000).toFixed(n % 10000 === 0 ? 0 : 1) + '万' : Math.round(n).toLocaleString('ja-JP'));
  const nz = (n) => (typeof n === 'number' && !isNaN(n) ? n : 0);
  const hrs = (n) => (n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + 'h');

  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function ssSet(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch (e) {} }

  // ---------- JST date helpers ----------
  function jstParts(d = new Date()) {
    const t = new Date(d.getTime() + 9 * 3600e3);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function addDays(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function businessToday() {
    if (serverBusinessDate) return serverBusinessDate;
    const p = jstParts();
    const today = ymd(p.y, p.m, p.d);
    return p.h < BUSINESS_CUTOFF_HOUR ? addDays(today, -1) : today;
  }
  const weekday = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  const monthOf = (s) => s.slice(0, 7);
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${ym}-01`, to: `${ym}-${pad(last)}`, days: last };
  }
  function addMonth(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
  }
  function dayLabel(s) { const [, m, d] = s.split('-').map(Number); return `${m}/${d}`; }
  // ISO → "HH:MM"(JST)
  function hm(iso) {
    if (!iso) return '';
    if (!/T/.test(iso)) return '';
    const p = jstParts(new Date(iso));
    return `${pad(p.h)}:${pad(p.mi)}`;
  }
  // ISO → datetime-local 値(JST)
  function toLocalInput(iso) {
    if (!iso || !/T/.test(iso)) return '';
    const p = jstParts(new Date(iso));
    return `${ymd(p.y, p.m, p.d)}T${pad(p.h)}:${pad(p.mi)}`;
  }
  const fromLocalInput = (v) => (v ? `${v}:00+09:00` : null);

  // ---------- state ----------
  const state = {
    store: lsGet(LS.store, STORES[0]),
    tab: lsGet(LS.tab, 'daily'),
    day: businessToday(),
    month: monthOf(businessToday()),
    meta: { staff: [], stores: STORES, pinRequired: false },
    cache: {}, // key: ym|store → {records, orders, plans}
    loading: false,
    error: '',
    openStaff: {},
    showTable: false,
  };
  if (!['藤井寺店', '恵我之荘店', 'all'].includes(state.store)) state.store = STORES[0];
  if (!['daily', 'shift', 'pay', 'sales', 'settings'].includes(state.tab)) state.tab = 'daily';

  // ---------- API ----------
  async function api(action, payload = {}, write = false) {
    const body = Object.assign({ action }, payload);
    if (write && state.meta.pinRequired) {
      const pin = await ensurePin();
      if (!pin) throw new Error('キャンセルしました');
      body.pin = pin;
    }
    const r = await fetch('/api/lotus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, error: '通信エラー' }));
    if (r.status === 401) ssSet('lotus_sm_pin', '');
    if (!j.ok) throw new Error(j.error || 'エラー');
    return j;
  }

  function currentYm() { return state.tab === 'daily' ? monthOf(state.day) : state.month; }

  async function load(force) {
    const ym = currentYm();
    const key = ym + '|' + state.store;
    if (!force && state.cache[key]) { render(); return; }
    state.loading = true; state.error = ''; setSync('load'); render();
    try {
      const j = await api('data', { month: ym, store: state.store, force: !!force });
      const firstLoad = !serverBusinessDate;
      if (j.businessDate) serverBusinessDate = j.businessDate;
      state.cache[key] = { records: j.records, orders: j.orders, plans: j.plans, errors: j.errors || [], kv: j.kv, at: Date.now() };
      setSync(j.errors && j.errors.length ? 'err' : 'ok');
      // 初回：タイムカードの営業日に合わせて表示日を補正
      if (firstLoad && serverBusinessDate && state.tab === 'daily' && state.day !== serverBusinessDate && !state.userPickedDay) {
        state.day = serverBusinessDate; state.month = monthOf(serverBusinessDate);
        if (monthOf(serverBusinessDate) !== ym) { state.loading = false; return load(); }
      }
    } catch (e) {
      state.error = e.message; setSync('err');
    }
    state.loading = false;
    render();
  }
  function data() { return state.cache[currentYm() + '|' + state.store] || { records: [], orders: [], plans: [] }; }
  function invalidate() { state.cache = {}; }

  function setSync(k) {
    const el = $('#sync');
    el.className = 'sync ' + (k === 'ok' ? 'ok' : k === 'err' ? 'err' : '');
    const p = jstParts();
    el.querySelector('span').textContent = k === 'load' ? '読み込み中…' : k === 'err' ? '一部取得できません' : `取り込み ${pad(p.h)}:${pad(p.mi)}`;
  }

  // ---------- chrome ----------
  function renderStoreSeg() {
    const opts = [...STORES, 'all'];
    $('#storeSeg').innerHTML = opts.map((s) => `<button data-store="${s}" class="${state.store === s ? 'on' : ''}" role="tab" aria-selected="${state.store === s}">${s === 'all' ? '全店' : `<span class="dot" style="background:${STORE_VAR[s]}"></span>${s}`}</button>`).join('');
  }
  function renderTabs() {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  }
  $('#storeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.store = b.dataset.store; lsSet(LS.store, state.store); renderStoreSeg(); load();
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (state.tab === 'daily' && b.dataset.tab !== 'daily') state.month = monthOf(state.day);
    state.tab = b.dataset.tab; lsSet(LS.tab, state.tab); renderTabs(); window.scrollTo({ top: 0 }); load();
  });
  $('#reloadBtn').addEventListener('click', () => { invalidate(); load(true); });

  const storesInView = () => (state.store === 'all' ? STORES : [state.store]);

  // ---------- render root ----------
  function render() {
    const m = $('#main');
    let head = '';
    if (state.tab === 'daily') head = dateBar();
    else if (state.tab === 'settings') head = '';
    else head = monthBar();
    if (state.loading && !state.cache[currentYm() + '|' + state.store]) {
      m.innerHTML = head + '<div class="skel"></div><div class="skel" style="height:220px"></div>';
      return;
    }
    if (state.error) {
      m.innerHTML = head + `<div class="err"><b>読み込めませんでした</b><br>${esc(state.error)}<br><span class="hint">通信状況と、Vercel の Upstash Redis 連携（KV_REST_API_URL / KV_REST_API_TOKEN）を確認してください。</span></div>`;
      return;
    }
    const body = state.tab === 'daily' ? viewDaily() : state.tab === 'shift' ? viewShift() : state.tab === 'pay' ? viewPay() : state.tab === 'sales' ? viewSales() : viewSettings();
    m.innerHTML = head + banner() + body;
    if (state.tab === 'sales') bindChart();
  }

  const chevL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>';
  const chevR = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>';

  function dateBar() {
    const wd = WD[weekday(state.day)];
    const isToday = state.day === businessToday();
    return `<div class="bar">
      <div class="nav-date">
        <button class="icon-btn" data-act="day" data-n="-1" aria-label="前日">${chevL}</button>
        <div class="lbl">${dayLabel(state.day)}<small>(${wd})${isToday ? ' 本日' : ''}</small></div>
        <button class="icon-btn" data-act="day" data-n="1" aria-label="翌日">${chevR}</button>
      </div>
      ${isToday ? '' : '<button class="btn sm" data-act="today">今日へ</button>'}
      <input type="date" class="btn sm" data-act="pickday" value="${state.day}" aria-label="日付を選ぶ" style="padding:5px 8px">
      <span class="spacer"></span>
      <span class="hint">営業日はタイムカードに合わせて切替</span>
    </div>`;
  }
  function monthBar() {
    const [y, m] = state.month.split('-').map(Number);
    const extra = state.tab === 'shift' ? `<span class="spacer"></span><button class="btn primary" data-act="addplan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>予定を追加</button>` : '';
    return `<div class="bar">
      <div class="nav-date">
        <button class="icon-btn" data-act="month" data-n="-1" aria-label="前月">${chevL}</button>
        <div class="lbl">${y}年 ${m}月</div>
        <button class="icon-btn" data-act="month" data-n="1" aria-label="翌月">${chevR}</button>
      </div>
      ${state.month === monthOf(businessToday()) ? '' : '<button class="btn sm" data-act="thismonth">今月へ</button>'}
      ${extra}
    </div>`;
  }

  // ---------- daily ----------
  function sumOrders(orders) {
    const s = { n: orders.length, guests: 0, newc: 0, rep: 0, normal: 0, late: 0, champagne: 0, medals: 0, discount: 0 };
    for (const o of orders) {
      s.guests += nz(o.guests); s.normal += nz(o.normal); s.late += nz(o.late); s.champagne += nz(o.champagne); s.medals += nz(o.medals); s.discount += nz(o.discount);
      if (o.kind === '新規') s.newc += nz(o.guests) || 1; else if (o.kind === 'リピート') s.rep += nz(o.guests) || 1;
    }
    s.gross = s.normal + s.late + s.champagne;
    return s;
  }
  function sumRecords(recs) {
    const s = { pay: 0, wage: 0, back: 0, hours: 0 };
    for (const r of recs) { s.pay += nz(r.pay); s.wage += nz(r.wage); s.hours += nz(r.hours); s.back += backOf(r); }
    return s;
  }
  const backOf = (r) => nz(r.normalBack) + nz(r.lateBack) + nz(r.champagneBack) + nz(r.medalBack);
  // 売上は会計（デジタルメニュー）から、バックは計上担当の行から。日次売上 = 通常+開店後+シャンパン − スタッフバック
  const netSales = (recs, orders) => sumOrders(orders).gross - sumRecords(recs).back;

  function viewDaily() {
    const d = data();
    return storesInView().map((st) => {
      const recs = d.records.filter((r) => r.store === st && r.date === state.day).sort((a, b) => String(a.in || 'z').localeCompare(String(b.in || 'z')));
      const orders = d.orders.filter((o) => o.store === st && o.date === state.day);
      const plans = d.plans.filter((p) => p.store === st && p.date === state.day);
      return `<section class="store-block">
        <div class="store-h"><span class="dot" style="background:${STORE_VAR[st]};width:10px;height:10px"></span><h2>${st}</h2><div class="line"></div></div>
        ${dailyStore(st, recs, orders, plans)}
      </section>`;
    }).join('');
  }

  function dailyStore(st, recs, orders, plans) {
    if (!recs.length && !orders.length && !plans.length) {
      const future = state.day > businessToday();
      return `<div class="card"><div class="empty"><b>${future ? 'まだ営業日前です' : 'この日の記録はありません'}</b>${future ? 'シフト画面で予定を組めます' : state.day < (state.firstDay || '') ? 'このアプリで取り込みを始める前の日です' : 'タイムカードで出勤・デジタルメニューで会計するとここに表示されます'}</div></div>`;
    }
    const rs = sumRecords(recs);
    const os = sumOrders(orders);
    const holder = recs.find((r) => r.holder);
    const cashRec = recs.find((r) => r.cash != null);
    const net = os.gross - rs.back;

    let note = '';
    if (orders.length && !recs.length) note = `<div class="recon ng"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg><div><b>会計はありますが、打刻がありません</b><span class="diffs">売上は集計していますが、バックを付けるスタッフがいません。タイムカードの打刻を確認してください。</span></div></div>`;

    const tiles = `<div class="tiles">
      <div class="tile hero"><div class="k">日次売上（バック控除後）</div><div class="v">${yen(net)}</div><div class="s">通常 ${yen(os.normal)} ・ 開店後 ${yen(os.late)} ・ シャンパン ${yen(os.champagne)}</div></div>
      <div class="tile"><div class="k">会計 / 客数</div><div class="v">${os.n}<small>件</small> ${os.guests}<small>人</small></div><div class="s">新規 ${os.newc} ・ リピート ${os.rep}</div></div>
      <div class="tile"><div class="k">最終レジ金</div><div class="v">${yen(holder ? holder.finalCash : null)}</div><div class="s">スタート ${yen(cashRec ? cashRec.cash : null)}</div></div>
      <div class="tile"><div class="k">スタッフ割引 / メダル</div><div class="v">${yen(os.discount)}</div><div class="s">メダル ${os.medals} 枚</div></div>
      <div class="tile"><div class="k">人件費</div><div class="v">${yen(rs.pay)}</div><div class="s">稼働 ${hrs(rs.hours)} ・ バック ${yen(rs.back)}</div></div>
    </div>`;

    const punchedStaff = new Set(recs.map((r) => r.staff));
    const noShow = plans.filter((p) => !punchedStaff.has(p.staff));
    const rows = recs.map((r) => {
      const planned = plans.find((p) => p.staff === r.staff);
      let tm;
      if (!r.in) tm = '<span class="badge warn">出勤未打刻</span>';
      else tm = `<span class="times">${hm(r.in)} – ${r.out ? hm(r.out) : ''}</span>${r.out ? '' : ' <span class="badge warn">退勤未打刻</span>'}`;
      return `<button class="srow" data-act="edit" data-id="${r.id}">
        <div class="c-nm nm"><span>${esc(r.staff || '（未選択）')}</span>${r.holder ? '<span class="badge ok">計上担当</span>' : ''}${r.edited ? '<span class="badge mute">修正済</span>' : ''}${planned ? '' : '<span class="badge mute">予定外</span>'}</div>
        <div class="c-tm">${tm}</div>
        <div class="c-h r">${hrs(r.hours)}</div>
        <div class="c-wage r">${r.rate ? yen(r.wage) : '<span class="badge warn">時給未設定</span>'}</div>
        <div class="c-back r">${yen(backOf(r))}</div>
        <div class="c-pay r"><b>${yen(r.pay)}</b></div>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>`;
    }).join('') + noShow.map((p) => `<div class="srow" style="cursor:default">
        <div class="c-nm nm"><span>${esc(p.staff)}</span><span class="badge ${state.day < businessToday() ? 'bad' : 'mute'}">${state.day < businessToday() ? '予定・未出勤' : '出勤予定'}</span></div>
        <div class="c-tm times">${esc(p.start || '')}${p.end ? ' – ' + esc(p.end) : ''}</div>
        <div class="c-h"></div><div class="c-wage"></div><div class="c-back"></div><div class="c-pay"></div><span></span></div>`).join('');

    const staffCard = `<div class="card">
      <div class="card-h"><h3>スタッフ</h3><span class="hint">${recs.length} 名出勤</span><span class="spacer"></span>${recs.length ? `<button class="btn sm" data-act="holder" data-store="${esc(st)}">計上担当を変更</button>` : ''}</div>
      ${recs.length || noShow.length ? `<div class="srow head"><div>スタッフ</div><div>出勤 – 退勤</div><div class="r">稼働</div><div class="r">時間給</div><div class="r">バック</div><div class="r">給料</div><span></span></div>${rows}` : '<div class="empty"><b>この日の打刻はありません</b>タイムカードで出勤するとここに表示されます</div>'}
    </div>`;

    const orderCard = `<div class="card">
      <div class="card-h"><h3>デジタルメニューの会計</h3><span class="hint">${orders.length} 件</span></div>
      <div class="card-b">${orders.length ? `<dl class="kv">
        <dt>通常売上</dt><dd>${yen(os.normal)}</dd>
        <dt>開店時間以降売上</dt><dd>${yen(os.late)}</dd>
        <dt>シャンパン</dt><dd>${yen(os.champagne)}</dd>
        <dt>スタッフ割引</dt><dd>${yen(os.discount)}</dd>
        <dt>メダル</dt><dd>${os.medals} 枚</dd>
        <div class="sep"></div>
        <dt>スタッフバック</dt><dd>−${yen(rs.back)}</dd>
        <dt><b>日次売上</b></dt><dd>${yen(net)}</dd>
        <div class="sep"></div>
        <dt>客数</dt><dd>${os.guests} 人</dd>
        <dt>客単価</dt><dd>${os.guests ? yen(os.gross / os.guests) : '—'}</dd>
      </dl>` : '<div class="hint">この日の会計はまだありません</div>'}</div>
    </div>`;

    return note + tiles + `<div class="grid2">${staffCard}${orderCard}</div>`;
  }

  // ---------- edit sheet（打刻・レジ金の修正はこのアプリ内だけで保存） ----------
  const xBtn = '<button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  function openEdit(id) {
    const r = data().records.find((x) => x.id === id);
    if (!r) return;
    openSheet(`
      <div class="sh-h"><div><h2>${esc(r.staff || '')}</h2><div class="sub">${esc(r.store || '')} ・ ${dayLabel(r.date)}(${WD[weekday(r.date)]})${r.holder ? ' ・ 計上担当' : ''}</div></div>${xBtn}</div>
      <div class="sh-b">
        <div class="grp-h">打刻</div>
        <div class="row2 dt">
          <div class="fld"><label for="f-in">出勤</label><input id="f-in" type="datetime-local" value="${toLocalInput(r.in)}"></div>
          <div class="fld"><label for="f-out">退勤</label><input id="f-out" type="datetime-local" value="${toLocalInput(r.out)}"></div>
        </div>
        <div class="row2">
          <div class="fld"><div class="aux"><label for="f-hours">稼働時間（h）</label><button type="button" class="linkbtn" data-act="calchours">打刻から計算</button></div><input id="f-hours" type="number" inputmode="decimal" step="0.01" value="${r.hours == null ? '' : r.hours}"></div>
          <div class="fld"><label for="f-cash">スタート/レジ金</label><input id="f-cash" type="number" inputmode="numeric" step="1" value="${r.cash == null ? '' : r.cash}"></div>
        </div>
        <dl class="kv" style="margin-top:4px">
          <dt>時間給（${r.rate ? yen(r.rate) + '/h' : '時給未設定'}）</dt><dd>${yen(r.wage)}</dd>
          <dt>通常バック 10% / 開店後バック 50%</dt><dd>${yen(r.normalBack)} / ${yen(r.lateBack)}</dd>
          <dt>シャンパンバック 20% / メダル ¥50</dt><dd>${yen(r.champagneBack)} / ${yen(r.medalBack)}</dd>
          <div class="sep"></div>
          <dt><b>給料</b></dt><dd>${yen(r.pay)}</dd>
        </dl>
        <div class="hint">修正はこのアプリの中だけに保存され、タイムカード側の記録は変わりません。${r.edited ? '<button class="linkbtn" data-act="resetov" data-id="' + r.id + '">修正を取り消してタイムカードの値に戻す</button>' : ''}</div>
      </div>
      <div class="sh-f"><button class="btn" data-act="close">キャンセル</button><button class="btn primary" data-act="save" data-id="${r.id}">保存</button></div>`);
  }

  async function saveEdit(id) {
    const r = data().records.find((x) => x.id === id);
    const v = (k) => { const el = $('#f-' + k); return el.value === '' ? null : Number(el.value); };
    const patch = {};
    for (const k of ['hours', 'cash']) { const nv = v(k); if (nv !== r[k]) patch[k] = nv; }
    if (toLocalInput(r.in) !== $('#f-in').value) patch.in = fromLocalInput($('#f-in').value);
    if (toLocalInput(r.out) !== $('#f-out').value) patch.out = fromLocalInput($('#f-out').value);
    if (!Object.keys(patch).length) { closeSheet(); return; }
    const btn = $('[data-act="save"]'); btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('override', { store: r.store, date: r.date, id, patch }, true);
      closeSheet(); toast('保存しました'); await load(true);
    } catch (e) { btn.disabled = false; btn.textContent = '保存'; toast(e.message); }
  }
  async function resetOverride(id) {
    const r = data().records.find((x) => x.id === id);
    if (!r || !confirm('修正を取り消して、タイムカードの値に戻しますか？')) return;
    try { await api('override', { store: r.store, date: r.date, id, reset: true }, true); closeSheet(); toast('元に戻しました'); await load(true); }
    catch (e) { toast(e.message); }
  }

  function calcHours() {
    const a = $('#f-in').value, b = $('#f-out').value;
    if (!a || !b) { toast('出勤と退勤を入力してください'); return; }
    const h = (new Date(fromLocalInput(b)) - new Date(fromLocalInput(a))) / 3600e3;
    if (h < 0) { toast('退勤が出勤より前になっています'); return; }
    $('#f-hours').value = Math.round(h * 100) / 100;
  }

  // 計上担当（売上とバックが付くスタッフ）
  function openHolder(st) {
    const recs = data().records.filter((r) => r.store === st && r.date === state.day);
    const cur = recs.find((r) => r.holder);
    openSheet(`
      <div class="sh-h"><div><h2>計上担当</h2><div class="sub">${esc(st)} ・ ${dayLabel(state.day)}(${WD[weekday(state.day)]})</div></div>${xBtn}</div>
      <div class="sh-b">
        <div class="hint">その日の売上と、通常10%・開店後50%・シャンパン20%・メダル¥50 のバックが付くスタッフです。通常はタイムカードの日締め代表（なければ最初に出勤した人）が自動で選ばれます。</div>
        <div class="chips">${recs.map((r) => `<button class="chip-sel ${cur && cur.id === r.id ? 'on' : ''}" data-act="setholder" data-store="${esc(st)}" data-v="${esc(r.staff)}">${esc(r.staff)}</button>`).join('')}</div>
        <button class="linkbtn" data-act="setholder" data-store="${esc(st)}" data-v="">自動で選ぶ（手動指定を解除）</button>
      </div>`);
  }
  async function setHolder(st, staff) {
    try { await api('holder', { store: st, date: state.day, staff: staff || null }, true); closeSheet(); toast(staff ? `${staff} を計上担当にしました` : '自動に戻しました'); await load(true); }
    catch (e) { toast(e.message); }
  }

  // ---------- shift calendar ----------
  function viewShift() {
    const d = data();
    const { from, days } = monthRange(state.month);
    const first = weekday(from);
    const today = businessToday();
    const stores = storesInView();
    let cells = WD.map((w, i) => `<div class="wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('');
    for (let i = 0; i < first; i++) cells += '<div class="cell out"></div>';
    for (let day = 1; day <= days; day++) {
      const ds = `${state.month}-${pad(day)}`;
      const wd = weekday(ds);
      const chips = [];
      for (const st of stores) {
        const plans = d.plans.filter((p) => p.date === ds && p.store === st);
        const recs = d.records.filter((r) => r.date === ds && r.store === st);
        const sd = state.store === 'all' ? `<span class="sd" style="background:${STORE_VAR[st]}"></span>` : '';
        for (const p of plans) {
          const done = recs.some((r) => r.staff === p.staff);
          const cls = done ? 'done' : ds < today ? 'miss' : '';
          chips.push(`<span class="chip ${cls}">${sd}${esc(p.staff)}<span class="t">${esc(p.start || '')}</span></span>`);
        }
        for (const r of recs) {
          if (plans.some((p) => p.staff === r.staff)) continue;
          chips.push(`<span class="chip extra" title="予定外の出勤">${sd}${esc(r.staff || '?')}<span class="t">${hm(r.in)}</span></span>`);
        }
      }
      cells += `<button class="cell ${ds === today ? 'today' : ''} ${wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}" data-act="dayplan" data-date="${ds}"><div class="d"><span>${day}</span></div>${chips.join('')}</button>`;
    }
    const tail = (first + days) % 7;
    if (tail) for (let i = tail; i < 7; i++) cells += '<div class="cell out"></div>';
    const warn = '';
    return warn + `<div class="cal">${cells}</div>
      <div class="legend"><span class="chip">予定</span><span class="chip done">出勤済み</span><span class="chip miss">未出勤</span><span class="chip extra">予定外の出勤</span><span>日付をタップして予定を編集</span></div>`;
  }

  let planDraft = null;
  function openDayPlan(ds) {
    const d = data();
    const stores = storesInView();
    const plans = d.plans.filter((p) => p.date === ds && stores.includes(p.store));
    const recs = d.records.filter((r) => r.date === ds && stores.includes(r.store));
    planDraft = planDraft && planDraft.keep ? planDraft : { staff: [], start: '20:00', end: '', store: stores[0], repeat: 1 };
    planDraft.date = ds; planDraft.keep = false;
    const list = plans.length ? `<div class="plist">${plans.map((p) => {
      const done = recs.some((r) => r.staff === p.staff && r.store === p.store);
      return `<div class="pi">${state.store === 'all' ? `<span class="dot" style="background:${STORE_VAR[p.store]}"></span>` : ''}<b>${esc(p.staff)}</b><span class="t">${esc(p.start || '')}${p.end ? '–' + esc(p.end) : ''}</span>${done ? '<span class="badge ok">出勤済み</span>' : ''}${p.memo ? `<span class="hint">${esc(p.memo)}</span>` : ''}
        <button class="del" data-act="delplan" data-id="${p.id}" aria-label="${esc(p.staff)}の予定を削除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></div>`;
    }).join('')}</div>` : '<div class="hint">この日の予定はまだありません</div>';
    const extra = recs.filter((r) => !plans.some((p) => p.staff === r.staff && p.store === r.store));
    openSheet(`
      <div class="sh-h"><div><h2>${dayLabel(ds)}(${WD[weekday(ds)]}) のシフト</h2><div class="sub">${state.store === 'all' ? '全店' : esc(state.store)}</div></div>
        <button class="icon-btn x" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sh-b">
        <div class="grp-h">登録済みの予定</div>${list}
        ${extra.length ? `<div class="hint">予定外の出勤：${extra.map((r) => esc(r.staff) + (r.in ? ' ' + hm(r.in) : '')).join('、')}</div>` : ''}
        <div class="grp-h">予定を追加</div>
        ${planForm()}
      </div>
      <div class="sh-f"><button class="btn" data-act="close">閉じる</button><button class="btn primary" data-act="saveplan">追加する</button></div>`);
  }
  function planForm() {
    const pd = planDraft;
    const staffList = state.meta.staff.length ? state.meta.staff : [];
    return `
      ${state.store === 'all' ? `<div class="fld"><label>店舗</label><div class="chips">${STORES.map((s) => `<button type="button" class="chip-sel ${pd.store === s ? 'on' : ''}" data-act="pstore" data-v="${s}">${s}</button>`).join('')}</div></div>` : ''}
      <div class="fld"><label>スタッフ（複数選択可）</label><div class="chips">${staffList.map((s) => `<button type="button" class="chip-sel ${pd.staff.includes(s) ? 'on' : ''}" data-act="pstaff" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>
      <div class="row3">
        <div class="fld"><label for="p-start">開始</label><input id="p-start" type="time" value="${pd.start}"></div>
        <div class="fld"><label for="p-end">終了</label><input id="p-end" type="time" value="${pd.end}"></div>
        <div class="fld"><label for="p-rep">繰り返し</label><select id="p-rep">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${pd.repeat === n ? 'selected' : ''}>${n === 1 ? 'この日だけ' : `毎週 ${n}回`}</option>`).join('')}</select></div>
      </div>
      <div class="fld"><label for="p-memo">メモ（任意）</label><input id="p-memo" type="text" placeholder="例：イベント対応" value=""></div>`;
  }
  async function savePlan() {
    const pd = planDraft;
    pd.start = $('#p-start').value; pd.end = $('#p-end').value; pd.repeat = Number($('#p-rep').value);
    const memo = $('#p-memo').value.trim();
    if (!pd.staff.length) { toast('スタッフを選んでください'); return; }
    const store = state.store === 'all' ? pd.store : state.store;
    const items = [];
    for (let w = 0; w < pd.repeat; w++) for (const s of pd.staff) items.push({ staff: s, store, date: addDays(pd.date, 7 * w), start: pd.start, end: pd.end, memo });
    const btn = $('[data-act="saveplan"]'); btn.disabled = true; btn.textContent = '登録中…';
    try {
      const j = await api('planAdd', { items }, true);
      // 同じ月のキャッシュに入れる（他月分は次回読み込みで取得）
      for (const key of Object.keys(state.cache)) {
        const [ym, st] = key.split('|');
        for (const p of j.plans) if (monthOf(p.date) === ym && (st === 'all' || st === p.store)) state.cache[key].plans.push(p);
      }
      toast(`${j.plans.length} 件の予定を追加しました`);
      pd.staff = []; render(); openDayPlan(pd.date);
    } catch (e) { btn.disabled = false; btn.textContent = '追加する'; toast(e.message); }
  }
  async function delPlan(id) {
    const p = data().plans.find((x) => x.id === id);
    if (!p || !confirm(`${p.staff} の ${dayLabel(p.date)} の予定を削除しますか？`)) return;
    try {
      await api('planDelete', { id, date: p.date }, true);
      for (const c of Object.values(state.cache)) c.plans = c.plans.filter((x) => x.id !== id);
      toast('削除しました'); render(); planDraft.keep = true; openDayPlan(p.date);
    } catch (e) { toast(e.message); }
  }

  // ---------- payroll ----------
  function viewPay() {
    const d = data();
    const recs = d.records.filter((r) => storesInView().includes(r.store));
    if (!recs.length) return '<div class="card"><div class="empty"><b>この月の出勤記録はありません</b></div></div>';
    const by = {};
    for (const r of recs) {
      const k = r.staff || '（未選択）';
      (by[k] = by[k] || []).push(r);
    }
    const order = state.meta.staff.length ? state.meta.staff : Object.keys(by);
    const names = [...order.filter((n) => by[n]), ...Object.keys(by).filter((n) => !order.includes(n))];
    const agg = (rs) => {
      const s = { days: new Set(rs.map((r) => r.date + r.store)).size, hours: 0, wage: 0, nb: 0, lb: 0, cb: 0, mb: 0, pay: 0, open: 0 };
      for (const r of rs) { s.hours += nz(r.hours); s.wage += nz(r.wage); s.nb += nz(r.normalBack); s.lb += nz(r.lateBack); s.cb += nz(r.champagneBack); s.mb += nz(r.medalBack); s.pay += nz(r.pay); if (r.in && !r.out) s.open++; }
      return s;
    };
    const tot = agg(recs);
    tot.days = names.reduce((a, n) => a + agg(by[n]).days, 0);
    const rowsHtml = names.map((n) => {
      const rs = by[n].slice().sort((a, b) => a.date.localeCompare(b.date));
      const s = agg(rs);
      const open = state.openStaff[n];
      const sub = open ? rs.map((r) => `<tr class="sub"><td>${dayLabel(r.date)}(${WD[weekday(r.date)]}) ${state.store === 'all' ? `<span class="dot" style="background:${STORE_VAR[r.store]}"></span>` : ''} ${r.in ? hm(r.in) : ''}–${r.out ? hm(r.out) : '<span class="badge warn">退勤なし</span>'}</td><td></td><td>${hrs(r.hours)}</td><td>${yen(r.wage)}</td><td>${yen(r.normalBack)}</td><td>${yen(r.lateBack)}</td><td>${yen(r.champagneBack)}</td><td>${yen(r.medalBack)}</td><td class="strong">${yen(r.pay)}</td></tr>`).join('') : '';
      return `<tr class="main" data-act="togglestaff" data-v="${esc(n)}"><td><span class="nmcell">${open ? '▾' : '▸'} ${esc(n)} ${s.open ? `<span class="badge warn">退勤なし ${s.open}</span>` : ''}</span></td><td>${s.days}日</td><td>${hrs(s.hours)}</td><td>${yen(s.wage)}</td><td>${yen(s.nb)}</td><td>${yen(s.lb)}</td><td>${yen(s.cb)}</td><td>${yen(s.mb)}</td><td class="strong">${yen(s.pay)}</td></tr>${sub}`;
    }).join('');
    const sales = netSales(recs, d.orders.filter((o) => storesInView().includes(o.store)));
    return `<div class="tiles">
        <div class="tile hero"><div class="k">給料合計</div><div class="v">${yen(tot.pay)}</div><div class="s">${names.length} 名 ・ 稼働 ${hrs(tot.hours)}</div></div>
        <div class="tile"><div class="k">時間給 計</div><div class="v">${yen(tot.wage)}</div></div>
        <div class="tile"><div class="k">バック 計</div><div class="v">${yen(tot.nb + tot.lb + tot.cb + tot.mb)}</div></div>
        <div class="tile"><div class="k">人件費率</div><div class="v">${sales ? Math.round((tot.pay / sales) * 1000) / 10 + '<small>%</small>' : '—'}</div><div class="s">売上 ${yen(sales)}</div></div>
      </div>
      <div class="card"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>スタッフ</th><th>出勤</th><th>稼働</th><th>時間給</th><th>通常バック</th><th>開店後バック</th><th>シャンパンバック</th><th>メダルバック</th><th>給料</th></tr></thead>
        <tbody>${rowsHtml}<tr class="total"><td>合計</td><td>延べ${tot.days}日</td><td>${hrs(tot.hours)}</td><td>${yen(tot.wage)}</td><td>${yen(tot.nb)}</td><td>${yen(tot.lb)}</td><td>${yen(tot.cb)}</td><td>${yen(tot.mb)}</td><td>${yen(tot.pay)}</td></tr></tbody>
      </table></div></div>
      <p class="hint" style="margin-top:10px">時間給＝稼働時間×時給（設定タブ）、バックは計上担当に 通常10%・開店後50%・シャンパン20%・メダル¥50。行をタップすると日別の内訳を表示します。</p>`;
  }

  // ---------- sales dashboard ----------
  let chartModel = null;
  function viewSales() {
    const d = data();
    const stores = storesInView();
    const { days } = monthRange(state.month);
    const recs = d.records.filter((r) => stores.includes(r.store));
    const orders = d.orders.filter((o) => stores.includes(o.store));
    const rs = sumRecords(recs), os = sumOrders(orders);
    const perDay = [];
    for (let i = 1; i <= days; i++) {
      const ds = `${state.month}-${pad(i)}`;
      const row = { date: ds };
      for (const st of stores) row[st] = netSales(recs.filter((r) => r.date === ds && r.store === st), orders.filter((o) => o.date === ds && o.store === st));
      row.guests = orders.filter((o) => o.date === ds).reduce((a, o) => a + nz(o.guests), 0);
      perDay.push(row);
    }
    const openDays = new Set([...recs.map((r) => r.date + r.store), ...orders.map((o) => o.date + o.store)]).size;
    const salesAll = os.gross - rs.back;
    chartModel = { perDay, stores };

    const tiles = `<div class="tiles">
      <div class="tile hero"><div class="k">月間売上</div><div class="v">${yen(salesAll)}</div><div class="s">通常 ${yen(os.normal)} ・ 開店後 ${yen(os.late)} ・ シャンパン ${yen(os.champagne)} − バック ${yen(rs.back)}</div></div>
      <div class="tile"><div class="k">営業日数</div><div class="v">${openDays}<small>日</small></div><div class="s">平均日商 ${openDays ? yen(salesAll / openDays) : '—'}</div></div>
      <div class="tile"><div class="k">来店客数</div><div class="v">${os.guests}<small>人</small></div><div class="s">新規 ${os.newc} ・ リピート ${os.rep}</div></div>
      <div class="tile"><div class="k">客単価</div><div class="v">${os.guests ? yen((os.normal + os.late + os.champagne) / os.guests) : '—'}</div><div class="s">デジタル注文ベース</div></div>
      <div class="tile"><div class="k">人件費率</div><div class="v">${salesAll ? Math.round((rs.pay / salesAll) * 1000) / 10 + '<small>%</small>' : '—'}</div><div class="s">給料 ${yen(rs.pay)}</div></div>
    </div>`;

    const legend = stores.length > 1 ? `<div class="lg">${stores.map((s) => `<span><span class="sw" style="background:${STORE_VAR[s]}"></span>${s}</span>`).join('')}</div>` : '';
    const chartCard = `<div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>日別売上${stores.length === 1 ? '（' + stores[0] + '）' : ''}</h3><span class="spacer"></span>${legend}<button class="linkbtn" data-act="toggletable">${state.showTable ? 'グラフで見る' : '表で見る'}</button></div>
      <div class="card-b">${state.showTable ? salesTable(perDay, stores) : `<div class="chart" id="chart">${chartSvg(perDay, stores)}</div>`}</div></div>`;

    const breakdown = `<div class="card"><div class="card-h"><h3>店舗別の内訳</h3></div><div class="tbl-wrap"><table class="tbl" style="min-width:640px">
      <thead><tr><th>店舗</th><th>売上</th><th>通常</th><th>開店後</th><th>シャンパン</th><th>割引</th><th>メダル</th><th>客数</th><th>給料</th></tr></thead><tbody>
      ${stores.map((st) => { const a = sumRecords(recs.filter((r) => r.store === st)); const o = sumOrders(orders.filter((x) => x.store === st));
        return `<tr><td><span class="nmcell"><span class="dot" style="background:${STORE_VAR[st]}"></span>${st}</span></td><td class="strong">${yen(o.gross - a.back)}</td><td>${yen(o.normal)}</td><td>${yen(o.late)}</td><td>${yen(o.champagne)}</td><td>${yen(o.discount)}</td><td>${o.medals}枚</td><td>${o.guests}人</td><td>${yen(a.pay)}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
    return tiles + chartCard + breakdown;
  }

  function salesTable(perDay, stores) {
    return `<div class="tbl-wrap"><table class="tbl" style="min-width:${stores.length > 1 ? 420 : 300}px"><thead><tr><th>日付</th>${stores.map((s) => `<th>${s}</th>`).join('')}<th>客数</th></tr></thead><tbody>
      ${perDay.filter((r) => stores.some((s) => r[s]) || r.guests).map((r) => `<tr><td>${dayLabel(r.date)}(${WD[weekday(r.date)]})</td>${stores.map((s) => `<td>${yen(r[s])}</td>`).join('')}<td>${r.guests}人</td></tr>`).join('') || `<tr><td colspan="${stores.length + 2}" style="text-align:center">データなし</td></tr>`}
    </tbody></table></div>`;
  }

  function niceMax(v) {
    if (v <= 0) return 10000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function chartSvg(perDay, stores) {
    const W = 1000, H = 260, L = 44, R = 6, T = 10, B = 26;
    const max = niceMax(Math.max(0, ...perDay.flatMap((r) => stores.map((s) => r[s]))));
    const n = perDay.length, slot = (W - L - R) / n;
    const gap = 2, groupPad = Math.max(3, slot * 0.18);
    const bw = Math.max(2, (slot - groupPad * 2 - gap * (stores.length - 1)) / stores.length);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let g = '<g class="grid">';
    for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`; }
    g += '</g><g class="axis">';
    for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; g += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${yenShort(v)}</text>`; }
    perDay.forEach((r, i) => { const d = i + 1; if (d === 1 || d % 5 === 0) g += `<text x="${L + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${d}</text>`; });
    g += '</g>';
    let bars = '', hits = '';
    const rad = Math.min(4, bw / 2);
    perDay.forEach((r, i) => {
      stores.forEach((s, k) => {
        const v = r[s]; if (!v) return;
        const x = L + slot * i + groupPad + k * (bw + gap), top = y(v), base = y(0), h = Math.max(1, base - top);
        const rr = Math.min(rad, h);
        bars += `<path style="fill:${STORE_VAR[s]}" d="M${x},${base} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${base} Z"/>`;
      });
      hits += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" rx="4"/>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日別売上グラフ">${g}${hits}<g style="pointer-events:none">${bars}</g><line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--ink-3)"/></svg>`;
  }
  function bindChart() {
    const c = $('#chart'); if (!c || !chartModel) return;
    const tip = $('#tip');
    const show = (e) => {
      const t = e.target.closest('.hit'); if (!t) { tip.classList.remove('on'); return; }
      const r = chartModel.perDay[Number(t.dataset.i)];
      const total = chartModel.stores.reduce((a, s) => a + r[s], 0);
      tip.innerHTML = `<b>${dayLabel(r.date)}(${WD[weekday(r.date)]})</b>${chartModel.stores.map((s) => `<div class="row"><span>${s}</span><span>${yen(r[s])}</span></div>`).join('')}${chartModel.stores.length > 1 ? `<div class="row"><span>合計</span><span>${yen(total)}</span></div>` : ''}<div class="row"><span>客数</span><span>${r.guests}人</span></div>`;
      const pt = e.touches ? e.touches[0] : e;
      const x = Math.min(window.innerWidth - 230, pt.clientX + 14), yy = Math.max(8, pt.clientY - 80);
      tip.style.left = x + 'px'; tip.style.top = yy + 'px'; tip.classList.add('on');
    };
    c.addEventListener('mousemove', show);
    c.addEventListener('click', show);
    c.addEventListener('mouseleave', () => tip.classList.remove('on'));
  }

  // ---------- banner（取り込みの警告） ----------
  function banner() {
    if (state.tab === 'settings') return '';
    const d = data();
    const msgs = [];
    if (d.kv === false) msgs.push('保存先（Upstash Redis）が未設定です。修正・予定・時給が保存されません。README の手順で Vercel に追加してください。');
    for (const e of d.errors || []) msgs.push(e);
    return msgs.length ? `<div class="recon ng"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg><div>${msgs.map(esc).join('<br>')}</div></div>` : '';
  }

  // ---------- settings（時給） ----------
  function viewSettings() {
    const m = state.meta;
    const wages = (m.settings && m.settings.wages) || {};
    const staff = [...new Set([...(m.staff || []), ...Object.keys(wages)])];
    return `<div class="card" style="max-width:640px">
      <div class="card-h"><h3>時給</h3><span class="hint">時間給 = 稼働時間 × 時給</span></div>
      <div class="card-b" style="display:flex;flex-direction:column;gap:12px">
        <div class="fld"><label for="w-default">標準の時給（個別に入れていないスタッフに適用）</label><input id="w-default" type="number" inputmode="numeric" min="0" step="10" value="${(m.settings && m.settings.defaultWage) || ''}" placeholder="例：1100"></div>
        <div class="row3">${staff.map((s) => `<div class="fld"><label>${esc(s)}</label><input type="number" inputmode="numeric" min="0" step="10" data-wage="${esc(s)}" value="${wages[s] == null ? '' : wages[s]}" placeholder="標準"></div>`).join('')}</div>
        <div><button class="btn primary" data-act="savesettings">保存</button></div>
      </div></div>
      <div class="card" style="max-width:640px;margin-top:14px"><div class="card-h"><h3>バック率</h3></div><div class="card-b"><dl class="kv">
        <dt>通常売上</dt><dd>10%</dd><dt>開店時間以降売上</dt><dd>50%</dd><dt>シャンパン</dt><dd>20%</dd><dt>メダル</dt><dd>1枚 ¥50</dd>
      </dl><p class="hint">計上担当のスタッフに付きます。率を変えるときは api/_lib.js の BACK を編集してください。</p></div></div>
      <div class="card" style="max-width:640px;margin-top:14px"><div class="card-h"><h3>データの取り込み</h3></div><div class="card-b"><p class="hint" style="margin:0">打刻はタイムカード、会計はデジタルメニューから自動で取り込みます（画面を開いたとき＋毎日16:00）。タイムカードは当日の打刻しか返さないため、このアプリを使い始めた日より前の打刻は表示されません。</p></div></div>`;
  }
  async function saveSettings() {
    const wages = {};
    document.querySelectorAll('[data-wage]').forEach((el) => { if (el.value !== '') wages[el.dataset.wage] = Number(el.value); });
    try {
      const j = await api('settings', { wages, defaultWage: Number($('#w-default').value) || 0 }, true);
      state.meta.settings = j.settings; invalidate(); toast('保存しました');
    } catch (e) { toast(e.message); }
  }

  // ---------- sheet / toast / pin ----------
  function openSheet(html) { $('#sheet').innerHTML = html; $('#overlay').classList.add('on'); $('#overlay').setAttribute('aria-hidden', 'false'); }
  function closeSheet() { $('#overlay').classList.remove('on'); $('#overlay').setAttribute('aria-hidden', 'true'); }
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2600); }

  function ensurePin() {
    const saved = ssGet('lotus_sm_pin');
    if (saved) return Promise.resolve(saved);
    const pin = window.prompt('管理者PINを入力してください');
    if (pin) ssSet('lotus_sm_pin', pin);
    return Promise.resolve(pin || '');
  }

  // ---------- event delegation ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    switch (act) {
      case 'day': state.day = addDays(state.day, Number(b.dataset.n)); state.userPickedDay = true; load(); break;
      case 'today': state.day = businessToday(); load(); break;
      case 'month': state.month = addMonth(state.month, Number(b.dataset.n)); state.openStaff = {}; load(); break;
      case 'thismonth': state.month = monthOf(businessToday()); load(); break;
      case 'edit': openEdit(b.dataset.id); break;
      case 'close': closeSheet(); break;
      case 'save': saveEdit(b.dataset.id); break;
      case 'calchours': calcHours(); break;
      case 'holder': openHolder(b.dataset.store); break;
      case 'setholder': setHolder(b.dataset.store, b.dataset.v); break;
      case 'resetov': resetOverride(b.dataset.id); break;
      case 'savesettings': saveSettings(); break;
      case 'dayplan': openDayPlan(b.dataset.date); break;
      case 'addplan': {
        const t = businessToday();
        openDayPlan(monthOf(t) === state.month ? t : `${state.month}-01`); break;
      }
      case 'pstaff': { const v = b.dataset.v; const i = planDraft.staff.indexOf(v); i >= 0 ? planDraft.staff.splice(i, 1) : planDraft.staff.push(v); b.classList.toggle('on'); break; }
      case 'pstore': planDraft.store = b.dataset.v; b.parentElement.querySelectorAll('.chip-sel').forEach((x) => x.classList.toggle('on', x === b)); break;
      case 'saveplan': savePlan(); break;
      case 'delplan': delPlan(b.dataset.id); break;
      case 'togglestaff': state.openStaff[b.dataset.v] = !state.openStaff[b.dataset.v]; render(); break;
      case 'toggletable': state.showTable = !state.showTable; render(); break;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-act="pickday"]') && e.target.value) { state.day = e.target.value; state.userPickedDay = true; load(); }
  });
  // 画面に戻ってきたら最新化（打刻・会計が他端末で進むため）
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (data().at || 0) > 60e3) { invalidate(); load(true); } });

  // ---------- boot ----------
  renderStoreSeg(); renderTabs();
  api('meta').then((m) => { state.meta = Object.assign(state.meta, m); }).catch(() => {}).finally(() => load());
})();
