// Lotus PL API（Vercel Serverless Function）
// Notion には接続しません。
//   ・打刻     … タイムカード（lotus-timecard）の API から取り込み
//   ・会計     … デジタルメニュー（lotus-digital-menu）の API から取り込み
//   ・シフト予定・時給・修正 … このアプリ専用の Redis（Upstash）に保存
// 環境変数:
//   KV_REST_API_URL / KV_REST_API_TOKEN … Vercel の Upstash Redis 連携で自動設定される
//   ADMIN_PIN     … 任意。書き込み（修正・担当変更・予定・時給）に PIN を求める
//   TIMECARD_URL  … 省略時 https://lotus-timecard.vercel.app
//   MENU_URL      … 省略時 https://lotus-digital-menu.vercel.app

const L = require('./_lib');

function planId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
const isHM = (s) => s === '' || /^\d{1,2}:\d{2}$/.test(String(s || ''));
const storesOf = (store) => (store && store !== 'all' ? [store] : L.STORES);

async function currentBusinessDate() {
  const [m] = await L.getJSON(['meta:businessDate']);
  return m && m.date;
}

const actions = {
  async meta() {
    const [settings] = await L.getJSON(['settings']);
    let staff = [];
    try {
      const menu = (process.env.MENU_URL || 'https://lotus-digital-menu.vercel.app').replace(/\/$/, '');
      const r = await fetch(menu + '/api/staff');
      const j = await r.json();
      staff = j.staff || [];
    } catch (e) { /* 取れなければ設定から */ }
    const s = settings || {};
    if (!staff.length) staff = Object.keys(s.wages || {});
    return { staff, stores: L.STORES, pinRequired: !!process.env.ADMIN_PIN, kv: L.kvHasStore(), settings: { wages: s.wages || {}, defaultWage: s.defaultWage || 0, startDate: s.startDate || '', cogsRate: s.cogsRate == null ? 30 : s.cogsRate, champagneRate: s.champagneRate == null ? 30 : s.champagneRate } };
  },

  async data({ month, store, force }) {
    if (!L.isYm(month)) throw L.httpError(400, 'month が必要です');
    const stores = storesOf(store);
    const errors = [];
    let today = null;
    try { today = (await L.syncTimecard()).businessDate; }
    catch (e) { errors.push(e.message); today = await currentBusinessDate(); }
    const days = L.monthDays(month).filter((d) => !today || d <= today);
    const menu = await L.syncMenu(stores, days, { today, force: !!force });
    errors.push(...menu.errors.slice(0, 2));
    const keys = [];
    for (const s of stores) for (const d of days) keys.push(`tc:${s}:${d}`, `day:${s}:${d}`, `ov:${s}:${d}`, `man:${s}:${d}`, `ms:${s}:${d}`);
    const vals = keys.length ? await L.getJSON(keys) : [];
    const [settings, plansAll] = await L.getJSON(['settings', `plans:${month}`]);
    const records = [], orders = [];
    const startDate = (settings && settings.startDate) || '';
    let i = 0;
    for (const s of stores) for (const d of days) {
      const tc = vals[i++], cfg = vals[i++], ov = vals[i++], man = vals[i++], ms = vals[i++];
      const mn = menu.byKey[`mn:${s}:${d}`];
      const ords = ((mn && mn.history) || []).map((h) => L.mapOrder(h, s, d));
      // 後から手入力した計上（シフトのカレンダーから）
      if (ms) ords.push({ id: 'ms-' + s + d, name: '手入力', store: s, date: d, state: '手入力', cancelled: false, manual: true,
        guests: Number(ms.guests) || 0, kind: '', normal: Number(ms.normal) || 0, late: Number(ms.late) || 0,
        champagne: Number(ms.champagne) || 0, medals: Number(ms.medals) || 0, discount: Number(ms.discount) || 0 });
      // タイムカードの打刻 ＋ 後から手入力した出勤
      const tcRecs = [...((tc && tc.records) || []), ...((man || []).map((m) => ({ ...m, manual: true })))];
      const day = L.buildDay(s, d, tcRecs, ords, cfg, ov, settings);
      if (startDate && d < startDate) continue; // 集計開始日より前は含めない
      records.push(...day.records);
      orders.push(...ords.filter((o) => !o.cancelled));
    }
    const plans = (plansAll || []).filter((p) => stores.includes(p.store));
    return { records, orders, plans, businessDate: today, startDate, errors: [...new Set(errors)], kv: L.kvHasStore() };
  },

  // 打刻・レジ金の修正（タイムカード側のデータは書き換えず、このアプリ内で上書き）
  async override({ store, date, id, patch, reset }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date) || !id) throw L.httpError(400, '入力内容を確認してください');
    const key = `ov:${store}:${date}`;
    const [cur] = await L.getJSON([key]);
    const map = cur || {};
    if (reset) delete map[id];
    else {
      const o = map[id] || {};
      for (const k of ['in', 'out', 'hours', 'cash']) {
        if (patch && k in patch) {
          const v = patch[k];
          o[k] = v === '' || v == null ? null : k === 'in' || k === 'out' ? String(v) : Number(v);
        }
      }
      map[id] = o;
    }
    await L.setJSON([[key, Object.keys(map).length ? map : null]]);
    return { ok: true };
  },

  // 計上担当（売上・バックが付くスタッフ）を変更
  async holder({ store, date, staff }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date)) throw L.httpError(400, '入力内容を確認してください');
    await L.setJSON([[`day:${store}:${date}`, staff ? { holder: String(staff) } : null]]);
    return { ok: true };
  },

  async planAdd({ items }, { write }) {
    write();
    if (!Array.isArray(items) || !items.length) throw L.httpError(400, 'items が必要です');
    if (items.length > 80) throw L.httpError(400, '一度に登録できるのは80件までです');
    const byMonth = {};
    const created = [];
    for (const it of items) {
      if (!it.staff || !L.STORES.includes(it.store) || !L.isDate(it.date) || !isHM(it.start || '') || !isHM(it.end || ''))
        throw L.httpError(400, '入力内容を確認してください');
      const p = { id: planId(), staff: String(it.staff), store: it.store, date: it.date, start: it.start || '', end: it.end || '', memo: String(it.memo || '').slice(0, 60) };
      (byMonth[it.date.slice(0, 7)] = byMonth[it.date.slice(0, 7)] || []).push(p);
      created.push(p);
    }
    const months = Object.keys(byMonth);
    const cur = await L.getJSON(months.map((m) => `plans:${m}`));
    await L.setJSON(months.map((m, i) => [`plans:${m}`, [...(cur[i] || []), ...byMonth[m]]]));
    return { plans: created };
  },

  async planDelete({ id, date }, { write }) {
    write();
    if (!id || !L.isDate(date)) throw L.httpError(400, 'id と date が必要です');
    const key = `plans:${date.slice(0, 7)}`;
    const [cur] = await L.getJSON([key]);
    await L.setJSON([[key, (cur || []).filter((p) => p.id !== id)]]);
    return { ok: true };
  },

  async settings({ wages, defaultWage, startDate, cogsRate, champagneRate }, { write }) {
    write();
    const [cur] = await L.getJSON(['settings']);
    const s = Object.assign({ wages: {}, defaultWage: 0, startDate: '' }, cur || {});
    if (wages !== undefined) {
      const clean = {};
      for (const [k, v] of Object.entries(wages || {})) if (v !== '' && v != null && Number(v) >= 0) clean[String(k)] = Math.round(Number(v));
      s.wages = clean;
    }
    if (defaultWage !== undefined) s.defaultWage = Math.max(0, Math.round(Number(defaultWage) || 0));
    // 集計開始日：この日より前の打刻・会計は売上・給与・日次計上に含めない（空欄なら全期間）
    if (startDate !== undefined) s.startDate = L.isDate(startDate) ? startDate : '';
    // 原価率（%）：粗利 = 売上 − 原価。通常・開店後の売上とシャンパンで別の率
    const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v) * 10) / 10 || 0));
    if (cogsRate !== undefined) s.cogsRate = pct(cogsRate);
    if (champagneRate !== undefined) s.champagneRate = pct(champagneRate);
    await L.setJSON([['settings', s]]);
    return { settings: s };
  },

  // 出勤を後から追加（打刻忘れ・アプリ導入前の日など）
  async manualAdd({ store, date, staff, in: inIso, out: outIso }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date) || !staff) throw L.httpError(400, '店舗・日付・スタッフを入力してください');
    const key = `man:${store}:${date}`;
    const [cur] = await L.getJSON([key]);
    const rec = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), staff: String(staff), store, date,
      in: inIso || null, out: outIso || null, hours: L.diffHours(inIso, outIso), tcNormal: null, startCash: null };
    await L.setJSON([[key, [...(cur || []), rec]]]);
    return { record: rec };
  },
  async manualDelete({ store, date, id }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date) || !id) throw L.httpError(400, '入力内容を確認してください');
    const key = `man:${store}:${date}`;
    const [cur] = await L.getJSON([key]);
    const next = (cur || []).filter((r) => r.id !== id);
    await L.setJSON([[key, next.length ? next : null]]);
    return { ok: true };
  },
  // 計上を後から入力（デジタルメニューを使わなかった日など）。空で保存すると削除
  async manualSales({ store, date, sales }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date)) throw L.httpError(400, '入力内容を確認してください');
    const f = {};
    for (const k of ['normal', 'late', 'champagne', 'medals', 'discount', 'guests']) f[k] = Math.max(0, Math.round(Number((sales || {})[k]) || 0));
    const empty = Object.values(f).every((v) => !v);
    await L.setJSON([[`ms:${store}:${date}`, empty ? null : f]]);
    return { ok: true, sales: empty ? null : f };
  },

  async checkPin(_, { write }) { write(); return { ok: true }; },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const fn = actions[body.action];
    if (!fn) throw L.httpError(400, '不明な操作です');
    const ctx = {
      write() {
        const pin = process.env.ADMIN_PIN;
        if (pin && String(body.pin || '') !== String(pin)) throw L.httpError(401, 'PIN が違います');
      },
    };
    const data = await fn(body, ctx);
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'エラー' });
  }
};
