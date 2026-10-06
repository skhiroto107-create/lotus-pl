// 在庫管理（商品・仕入れ先と値段・仕入れ履歴・棚卸し・発注ライン）
// 保存先はこのアプリ専用の Redis（Upstash）
//   inv:items        … 商品の一覧（店舗ごとの在庫数と発注ライン、仕入れ先ごとの値段）
//   inv:log:{YYYY-MM} … その月の仕入れ・棚卸し・在庫修正の記録
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
const snap = (it) => ({ itemId: it.id, name: it.name, category: it.category || '', unit: it.unit || '' });

module.exports = {
  async invList({ month }) {
    const keys = ['inv:items'];
    if (L.isYm(month)) keys.push(`inv:log:${month}`);
    const [items, log] = await L.getJSON(keys);
    return { items: items || [], log: log || [] };
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
    const next = {
      id: prev ? prev.id : newId('i'),
      name: str(item.name, 60), category: str(item.category, 20), unit: str(item.unit, 10) || '個',
      location: str(item.location, 40), memo: str(item.memo, 200),
      minStock: perStore(item.minStock), stock: prev ? { ...(prev.stock || {}) } : {},
      suppliers, created: prev ? prev.created : Date.now(), updated: Date.now(),
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
    await L.setJSON([['inv:items', items]]);
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
