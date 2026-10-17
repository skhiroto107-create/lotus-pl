// 在庫管理（商品・仕入れ先と値段・仕入れ履歴・棚卸し・発注ライン）
// 保存先はこのアプリ専用の Redis（Upstash）
//   inv:items        … 商品の一覧（店舗ごとの在庫数と発注ライン、仕入れ先ごとの値段）
//   inv:log:{YYYY-MM} … その月の仕入れ・棚卸し・在庫修正の記録
//   inv:ordq          … 発注リストで手で変えた発注数 { 商品id: { 店舗: 数 } }（仕入れを記録すると自動に戻る）
const L = require('./_lib');

const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const qty2 = (v) => Math.round(Math.max(0, num(v)) * 100) / 100; // 0.5本 なども可
const yenInt = (v) => Math.max(0, Math.round(num(v)));
const str = (v, n = 80) => String(v == null ? '' : v).trim().slice(0, n);
function cleanUrl(u) {
  u = str(u, 600);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; }
}
function perStore(obj) {
  const o = {};
  for (const s of L.STORES) if (obj && obj[s] !== '' && obj[s] != null) o[s] = qty2(obj[s]);
  return o;
}

async function loadItems() { const [v] = await L.getJSON(['inv:items']); return v || []; }
async function appendLog(entries) {
  const byMonth = {};
  for (const e of entries) (byMonth[e.date.slice(0, 7)] = byMonth[e.date.slice(0, 7)] || []).push(e);
  const months = Object.keys(byMonth);
  if (!months.length) return;
  const cur = await L.getJSON(months.map((m) => `inv:log:${m}`));
  await L.setJSON(months.map((m, i) => [`inv:log:${m}`, [...(cur[i] || []), ...byMonth[m]]]));
}
// 経費（純利益用）exp:{YYYY-MM} = { 店舗: { rent, util, comm, others:[{name, amt}] } }
// その月に入力がない店舗は、直近の月の金額を引き継ぐ（最大12か月さかのぼる）
async function loadExp(month) {
  if (!L.isYm(month)) return { data: {}, from: {} };
  const [y, m] = month.split('-').map(Number);
  const yms = []; for (let i = 0; i < 13; i++) yms.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  const vals = await L.getJSON(yms.map((x) => `exp:${x}`));
  const data = {}, from = {};
  for (const st of L.STORES) {
    const i = vals.findIndex((v) => v && v[st]);
    if (i >= 0) { data[st] = vals[i][st]; if (i > 0) from[st] = yms[i]; }
  }
  return { data, from };
}
// 在庫金額（原価計算用）：月初と月末の在庫数 × 最安の値段（店舗ごと）
// その日時点の在庫数 ＝ 今の在庫から、その日より後の記録（仕入れ・棚卸し・修正）を巻き戻して求める
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
async function stockValue(month, items) {
  if (!L.isYm(month)) return null;
  const nowYm = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
  const after = []; for (let ym = month; ym <= nowYm && after.length < 24; ym = ymAdd(ym, 1)) after.push(ym);
  const before = []; for (let i = 1; i <= 12; i++) before.push(ymAdd(month, -i));
  const vals = await L.getJSON([...after, ...before].map((x) => `inv:log:${x}`));
  const logs = vals.slice(0, after.length).flat().filter(Boolean).filter((e) => e.store && e.itemId && e.before != null);
  const hasHistory = vals.slice(after.length).some((v) => v && v.length);
  logs.sort((a, b) => (a.date + String(a.at)).localeCompare(b.date + String(b.at)));
  const price = (it) => { const xs = (it.suppliers || []).filter((x) => x.price > 0).map((x) => x.price); return xs.length ? Math.min(...xs) : 0; };
  const at = (cut) => { // cut 日の終わり時点
    const v = {};
    for (const st of L.STORES) v[st] = 0;
    for (const it of items) for (const st of L.STORES) {
      const first = logs.find((e) => e.itemId === it.id && e.store === st && e.date > cut);
      const q = first ? num(first.before) : num((it.stock || {})[st]);
      v[st] += Math.round(q * price(it));
    }
    return v;
  };
  const isNow = month >= nowYm;
  return { start: at(lastDay(ymAdd(month, -1))), end: at(lastDay(month)), hasHistory, endIsNow: isNow, noPrice: items.filter((it) => !price(it)).length };
}
const snap = (it) => ({ itemId: it.id, name: it.name, category: it.category || '', unit: it.unit || '' });

module.exports = {
  async invList({ month }) {
    const keys = ['inv:items', 'inv:ordq'];
    if (L.isYm(month)) keys.push(`inv:log:${month}`);
    const [[items, ordq, log], exp] = await Promise.all([L.getJSON(keys), loadExp(month)]);
    const val = await stockValue(month, items || []).catch(() => null);
    return { items: items || [], ordq: ordq || {}, log: log || [], exp, val };
  },

  // 商品の追加・編集（在庫数を直接変えた場合は「在庫修正」として記録）
  async invSave({ item, date }, { write }) {
    write();
    if (!item || !str(item.name)) throw L.httpError(400, '商品名を入れてください');
    const items = await loadItems();
    const i = item.id ? items.findIndex((x) => x.id === item.id) : -1;
    const prev = i >= 0 ? items[i] : null;
    const suppliers = (Array.isArray(item.suppliers) ? item.suppliers : []).slice(0, 12)
      .map((s) => ({ id: s.id || newId('s'), name: str(s.name, 40), price: s.price === '' || s.price == null ? null : yenInt(s.price), url: cleanUrl(s.url), note: str(s.note, 60), updated: s.updated || '' }))
      .filter((s) => s.name || s.url);
    // 到着日数（定期チェックで入る値）は、同じ仕入れ先・同じリンクなら引き継ぐ
    for (const s of suppliers) {
      const old = prev && (prev.suppliers || []).find((x) => x.id === s.id);
      if (old && old.url === s.url && old.lead != null) Object.assign(s, { lead: old.lead, etaAt: old.etaAt, etaNote: old.etaNote || '', cutoff: old.cutoff || '' });
    }
    const next = {
      ...(prev || {}), // 最終仕入れ日・前回の棚卸し日などは残す
      id: prev ? prev.id : newId('i'),
      name: str(item.name, 60), category: str(item.category, 20), unit: str(item.unit, 10) || '個',
      location: str(item.location, 40), memo: str(item.memo, 200),
      minStock: perStore(item.minStock), target: perStore(item.target), stock: prev ? { ...(prev.stock || {}) } : {},
      suppliers, created: prev ? prev.created : Date.now(), updated: Date.now(),
      order: prev ? prev.order : items.reduce((m, x) => Math.max(m, x.order == null ? -1 : x.order), -1) + 1,
    };
    const d = L.isDate(date) ? date : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const log = [];
    const want = perStore(item.stock);
    for (const s of Object.keys(want)) {
      const before = num(next.stock[s]);
      if (want[s] !== before) {
        next.stock[s] = want[s];
        if (prev) log.push({ id: newId('l'), type: 'adjust', date: d, store: s, ...snap(next), qty: Math.round((want[s] - before) * 100) / 100, before, after: want[s], at: Date.now() });
      }
    }
    if (i >= 0) items[i] = next; else items.push(next);
    await L.setJSON([['inv:items', items]]);
    await appendLog(log);
    return { item: next };
  },

  // 並び順の保存（ids の順に order を振り直す）
  async invOrder({ ids }, { write }) {
    write();
    if (!Array.isArray(ids)) throw L.httpError(400, 'ids が必要です');
    const items = await loadItems();
    const pos = new Map(ids.map((id, i) => [String(id), i]));
    let next = ids.length;
    for (const it of [...items].sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order))) it.order = pos.has(it.id) ? pos.get(it.id) : next++;
    await L.setJSON([['inv:items', items]]);
    return { ok: true };
  },

  // 発注リストの発注数を手で変える（qty が空なら自動の数に戻す）
  async invOrdQty({ id, store, qty }, { write }) {
    write();
    if (!id || !L.STORES.includes(store)) throw L.httpError(400, '商品と店舗を確認してください');
    const [cur] = await L.getJSON(['inv:ordq']);
    const m = cur || {};
    const o = { ...(m[id] || {}) };
    if (qty === '' || qty == null) delete o[store]; else o[store] = qty2(qty);
    if (Object.keys(o).length) m[id] = o; else delete m[id];
    await L.setJSON([['inv:ordq', Object.keys(m).length ? m : null]]);
    return { ordq: m };
  },
  // 手で変えた発注数をまとめて自動に戻す（stores を渡したらその店舗だけ）
  async invOrdReset({ stores }, { write }) {
    write();
    const [cur] = await L.getJSON(['inv:ordq']);
    const m = cur || {};
    const only = Array.isArray(stores) ? stores.filter((s) => L.STORES.includes(s)) : L.STORES;
    for (const id of Object.keys(m)) { for (const s of only) delete m[id][s]; if (!Object.keys(m[id]).length) delete m[id]; }
    await L.setJSON([['inv:ordq', Object.keys(m).length ? m : null]]);
    return { ordq: m };
  },

  // 到着までの日数をまとめて保存（今日注文した場合に何日後に届くか）
  // updates: [{ itemId, supId, lead(日数・null で消す), note, cutoff('HH:MM' この時刻までの注文で lead 日後に届く) }], date: 調べた日
  async invEta({ updates, date }, { write }) {
    write();
    if (!Array.isArray(updates)) throw L.httpError(400, 'updates が必要です');
    const d = L.isDate(date) ? date : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const items = await loadItems();
    let n = 0;
    for (const u of updates) {
      const it = items.find((x) => x.id === u.itemId);
      const sp = it && (it.suppliers || []).find((x) => x.id === u.supId);
      if (!sp) continue;
      if (u.lead === null || u.lead === '') { delete sp.lead; delete sp.etaAt; delete sp.etaNote; delete sp.cutoff; }
      else {
        sp.lead = Math.max(0, Math.min(60, Math.round(num(u.lead)))); sp.etaAt = d; sp.etaNote = str(u.note, 80);
        const c = String(u.cutoff || '').match(/^(\d{1,2}):(\d{2})$/);
        sp.cutoff = c && Number(c[1]) <= 24 && Number(c[2]) < 60 ? `${c[1].padStart(2, '0')}:${c[2]}` : '';
      }
      n++;
    }
    await L.setJSON([['inv:items', items]]);
    return { count: n };
  },

  // 経費の保存（その月・その店舗）
  async expSave({ month, store, data }, { write }) {
    write();
    if (!L.isYm(month) || !L.STORES.includes(store)) throw L.httpError(400, '月と店舗を確認してください');
    const d = data || {};
    const clean = {
      rent: yenInt(d.rent), util: yenInt(d.util), comm: yenInt(d.comm),
      others: (Array.isArray(d.others) ? d.others : []).slice(0, 12).map((o) => ({ name: str(o && o.name, 20), amt: yenInt(o && o.amt) })).filter((o) => o.name || o.amt),
    };
    const key = `exp:${month}`;
    const [cur] = await L.getJSON([key]);
    await L.setJSON([[key, { ...(cur || {}), [store]: clean }]]);
    return { exp: await loadExp(month) };
  },

  async invDelete({ id }, { write }) {
    write();
    const items = await loadItems();
    await L.setJSON([['inv:items', items.filter((x) => x.id !== id)]]);
    return { ok: true };
  },

  // 仕入れを記録 → 在庫が増え、仕入れ先の値段も最新に
  async invPurchase({ itemId, store, date, qty, unitPrice, supplier, memo }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date)) throw L.httpError(400, '店舗と日付を確認してください');
    const q = qty2(qty);
    if (!q) throw L.httpError(400, '数量を入れてください');
    const items = await loadItems();
    const it = items.find((x) => x.id === itemId);
    if (!it) throw L.httpError(404, '商品が見つかりません');
    const price = yenInt(unitPrice);
    const sup = str(supplier, 40);
    const before = num((it.stock || {})[store]);
    it.stock = { ...(it.stock || {}), [store]: Math.round((before + q) * 100) / 100 };
    if (sup) {
      it.suppliers = it.suppliers || [];
      const s = it.suppliers.find((x) => x.name === sup);
      if (s) { if (price) { s.price = price; s.updated = date; } }
      else it.suppliers.push({ id: newId('s'), name: sup, price: price || null, url: '', note: '', updated: date });
    }
    it.lastPurchase = date;
    // 仕入れたら、その店舗の手入力の発注数は自動に戻す
    const [oq] = await L.getJSON(['inv:ordq']);
    const sets = [['inv:items', items]];
    if (oq && oq[it.id] && oq[it.id][store] != null) {
      delete oq[it.id][store]; if (!Object.keys(oq[it.id]).length) delete oq[it.id];
      sets.push(['inv:ordq', Object.keys(oq).length ? oq : null]);
    }
    await L.setJSON(sets);
    const entry = { id: newId('l'), type: 'purchase', date, store, ...snap(it), qty: q, unitPrice: price, total: Math.round(q * price), supplier: sup, memo: str(memo, 100), before, after: it.stock[store], at: Date.now() };
    await appendLog([entry]);
    return { item: it, entry };
  },

  // 棚卸し：数え直した数で在庫を上書きし、差（使った量・ロス）を記録
  async invCount({ store, date, counts }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date)) throw L.httpError(400, '店舗と日付を確認してください');
    const items = await loadItems();
    const log = [];
    for (const it of items) {
      if (!counts || counts[it.id] === '' || counts[it.id] == null) continue;
      const after = qty2(counts[it.id]);
      const before = num((it.stock || {})[store]);
      it.stock = { ...(it.stock || {}), [store]: after };
      it.lastCount = { ...(it.lastCount || {}), [store]: date };
      log.push({ id: newId('l'), type: 'count', date, store, ...snap(it), qty: Math.round((after - before) * 100) / 100, before, after, at: Date.now() });
    }
    if (!log.length) throw L.httpError(400, '数えた数を1つ以上入れてください');
    await L.setJSON([['inv:items', items]]);
    await appendLog(log);
    return { count: log.length };
  },

  // 記録の削除（仕入れを消したときは、その分の在庫も戻す）
  async invLogDelete({ id, month }, { write }) {
    write();
    if (!L.isYm(month)) throw L.httpError(400, 'month が必要です');
    const key = `inv:log:${month}`;
    const [log] = await L.getJSON([key]);
    const e = (log || []).find((x) => x.id === id);
    if (!e) throw L.httpError(404, '記録が見つかりません');
    if (e.type === 'purchase') {
      const items = await loadItems();
      const it = items.find((x) => x.id === e.itemId);
      if (it) {
        it.stock = { ...(it.stock || {}), [e.store]: Math.max(0, Math.round((num((it.stock || {})[e.store]) - num(e.qty)) * 100) / 100) };
        await L.setJSON([['inv:items', items]]);
      }
    }
    const next = (log || []).filter((x) => x.id !== id);
    await L.setJSON([[key, next.length ? next : null]]);
    return { ok: true };
  },
};
