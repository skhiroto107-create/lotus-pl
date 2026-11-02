// 在庫管理（商品・仕入れ先と値段・仕入れ履歴・棚卸し・発注ライン）
// 保存先はこのアプリ専用の Redis（Upstash）
//   inv:items        … 商品の一覧（店舗ごとの在庫数と発注ライン、仕入れ先ごとの値段）
//   inv:log:{YYYY-MM} … その月の仕入れ・棚卸し・在庫修正の記録
//   inv:ordq          … 発注リストで手で変えた発注数 { 商品id: { 店舗: 数 } }（仕入れを記録すると自動に戻る）
// レシート読み取り（invReceipt）は GEMINI_API_KEY（Gemini・無料枠）を使う。なければ ANTHROPIC_API_KEY（Claude）
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
// 入数（1ケースに入っている数）：入力がなければ仕入れ先の名前の「6本」「×30本」から読み取る（inv.js と同じ考え方）
function packOf(it, sp) {
  if (!sp || (it && it.unit === 'ケース')) return 1;
  const p = num(sp.pack); if (p >= 1) return p;
  const u = (it && it.unit) || '本';
  const m = [...String(sp.name || '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).matchAll(new RegExp('(\\d+)\\s*' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  const n = m.length ? Number(m[m.length - 1][1]) : 1;
  return n >= 2 && n <= 200 ? n : 1;
}
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
  const price = (it) => { const xs = (it.suppliers || []).filter((x) => x.price > 0).map((x) => x.price / packOf(it, x)); return xs.length ? Math.min(...xs) : 0; };
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
// レシートの写真をAIで読む（Gemini：無料枠あり／Claude：有料）。どちらも { shop, date, total, lines } を返す
async function geminiRead(key, mt, data, prompt, schema) {
  const models = [process.env.RECEIPT_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].filter(Boolean);
  let last = '';
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mt, data } }, { text: prompt + '\n\n次の JSON スキーマに合う JSON だけを返してください：\n' + JSON.stringify(schema) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw L.httpError(429, '無料枠の上限に達しました。少し時間をおいてから読み取ってください');
    if (!r.ok) { last = (j.error && j.error.message) || String(r.status); continue; } // 混雑・未対応のモデルは次のモデルで試す
    const text = (((j.candidates || [])[0] || {}).content || {}).parts ? j.candidates[0].content.parts.map((p) => p.text || '').join('') : '';
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (e) { last = '読み取り結果を解釈できませんでした'; }
  }
  throw L.httpError(502, 'AIの読み取りに失敗しました：' + last);
}
async function claudeRead(key, mt, data, prompt, tool) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.RECEIPT_MODEL || 'claude-sonnet-5-5', max_tokens: 4000,
      tools: [tool], tool_choice: { type: 'tool', name: 'receipt' },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mt, data } }, { type: 'text', text: prompt }] }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw L.httpError(502, 'AIの読み取りに失敗しました：' + ((j.error && j.error.message) || r.status));
  return ((j.content || []).find((c) => c.type === 'tool_use') || {}).input || {};
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
      .map((s) => ({ id: s.id || newId('s'), name: str(s.name, 40), price: s.price === '' || s.price == null ? null : yenInt(s.price), pack: s.pack === '' || s.pack == null || !(num(s.pack) >= 1) ? null : Math.round(num(s.pack)), url: cleanUrl(s.url), note: str(s.note, 60), updated: s.updated || '' }))
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
  // qty は在庫の単位（本など）。ケースで買ったときは total（支払った金額）と supPrice（1ケースの値段）も渡す
  async invPurchase({ itemId, store, date, qty, unitPrice, total, supPrice, cases, pack, supplier, memo }, { write }) {
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
      const sp = supPrice != null && supPrice !== '' ? yenInt(supPrice) : price;
      if (s) { if (sp) { s.price = sp; s.updated = date; } }
      else it.suppliers.push({ id: newId('s'), name: sup, price: sp || null, pack: pack ? Math.round(num(pack)) : null, url: '', note: '', updated: date });
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
    const entry = { id: newId('l'), type: 'purchase', date, store, ...snap(it), qty: q, unitPrice: price, total: total != null && total !== '' ? yenInt(total) : Math.round(q * price), cases: cases ? qty2(cases) : undefined, supplier: sup, memo: str(memo, 100), before, after: it.stock[store], at: Date.now() };
    await appendLog([entry]);
    return { item: it, entry };
  },

  // レシート読み取り（AI）：写真から品目・数量・金額を読み、在庫の商品と紐付けた候補を返す（まだ保存しない）
  // 環境変数 GEMINI_API_KEY（Google AI Studio で無料発行）または ANTHROPIC_API_KEY が必要（任意で RECEIPT_MODEL）
  async invReceipt({ image, mediaType }, { write }) {
    write();
    const gkey = process.env.GEMINI_API_KEY, key = process.env.ANTHROPIC_API_KEY;
    if (!gkey && !key) throw L.httpError(400, 'レシート読み取りの設定がまだです（Vercel に GEMINI_API_KEY を登録してください）');
    const mt = /^image\/(jpeg|png|webp|gif)$/.test(String(mediaType)) ? mediaType : 'image/jpeg';
    const data = String(image || '').replace(/^data:[^,]*,/, '');
    if (!data || data.length > 6e6) throw L.httpError(400, '画像を読み込めませんでした');
    const items = await loadItems();
    const list = items.map((it) => {
      const packs = [...new Set((it.suppliers || []).map((sp) => packOf(it, sp)).filter((n) => n > 1))];
      const sups = (it.suppliers || []).map((sp) => sp.name).filter(Boolean).slice(0, 4);
      return `${it.id}\t${it.name}\t単位:${it.unit || '本'}${packs.length ? `\t1ケース=${packs.join('/')}${it.unit || '本'}` : ''}${sups.length ? `\t仕入れ先の商品名:${sups.join(' | ')}` : ''}`;
    }).join('\n');
    const tool = {
      name: 'receipt',
      description: 'レシートの読み取り結果',
      input_schema: {
        type: 'object',
        properties: {
          shop: { type: 'string', description: '店名・サイト名（例：業務スーパー、Amazon）' },
          date: { type: 'string', description: '購入日・注文日 YYYY-MM-DD（読めなければ空）' },
          total: { type: 'integer', description: 'レシート・注文の合計金額（税込）' },
          lines: { type: 'array', items: { type: 'object', properties: {
            text: { type: 'string', description: 'レシートに書かれた品名' },
            itemId: { type: 'string', description: '在庫の商品一覧で同じ商品のID。該当なしは空' },
            qty: { type: 'number', description: '在庫の単位での数量（ケースで買ったら ケース数×入数）' },
            amount: { type: 'integer', description: 'この行の支払金額（税込・値引き後）' },
          }, required: ['text', 'itemId', 'qty', 'amount'] } },
        },
        required: ['shop', 'date', 'total', 'lines'],
      },
    };
    const prompt = `バーの仕入れの記録です。お店のレシート、または Amazon・楽天市場などネット通販の注文履歴・注文詳細のスクリーンショットです。商品ごとに読み取って返してください。
・shop はお店の名前。ネット通販なら「Amazon」「楽天市場（ショップ名）」のようにする。date はレシートの日付／注文日。
・下の「在庫の商品一覧」に同じ商品があれば itemId を入れる（名前や「仕入れ先の商品名」と銘柄・容量が同じもの。違うものは入れない）。なければ空。
・qty は在庫の単位で数える。ケースや「×24」「24本入」などの入数があれば、注文数×入数で本数に直す。
・amount は税込・値引き後の金額。外税のレシートは税を各行に按分する。送料・手数料は商品の金額に按分して含める。クーポン値引きは引く。ポイント利用は支払い方法なので引かない。
・小計・合計・税・ポイント・釣銭・送料だけの行などは lines に入れない。キャンセル・返品された注文や、明らかに仕入れではない注文は入れない。
・スクリーンショットに複数の注文が写っていれば、すべての注文の商品を lines に入れ、total はその合計にする。
在庫の商品一覧（ID・名前・単位・仕入れ先の商品名）：
${list || '（なし）'}`;
    const out = gkey ? await geminiRead(gkey, mt, data, prompt, tool.input_schema) : await claudeRead(key, mt, data, prompt, tool);
    const ids = new Set(items.map((x) => x.id));
    const lines = (Array.isArray(out.lines) ? out.lines : []).slice(0, 80).map((x) => ({
      text: str(x.text, 60), itemId: ids.has(x.itemId) ? x.itemId : '', qty: qty2(x.qty), amount: yenInt(x.amount),
    }));
    return { shop: str(out.shop, 40), date: L.isDate(out.date) ? out.date : '', total: yenInt(out.total), lines };
  },
  // レシートの内容をまとめて反映：在庫を増やし、仕入れ（金額）として記録する
  async invReceiptApply({ store, date, shop, lines }, { write }) {
    write();
    if (!L.STORES.includes(store) || !L.isDate(date)) throw L.httpError(400, '店舗と日付を確認してください');
    const items = await loadItems();
    const [oq] = await L.getJSON(['inv:ordq']);
    const sup = str(shop, 40), entries = [];
    let oqChanged = false;
    for (const ln of (Array.isArray(lines) ? lines : []).slice(0, 80)) {
      const it = items.find((x) => x.id === ln.itemId);
      const q = qty2(ln.qty), total = yenInt(ln.amount);
      if (!it || !q) continue;
      const before = num((it.stock || {})[store]);
      it.stock = { ...(it.stock || {}), [store]: Math.round((before + q) * 100) / 100 };
      it.lastPurchase = date;
      if (oq && oq[it.id] && oq[it.id][store] != null) { delete oq[it.id][store]; if (!Object.keys(oq[it.id]).length) delete oq[it.id]; oqChanged = true; }
      entries.push({ id: newId('l'), type: 'purchase', date, store, ...snap(it), qty: q, unitPrice: Math.round(total / q), total, supplier: sup, memo: 'レシート', before, after: it.stock[store], at: Date.now() });
    }
    if (!entries.length) throw L.httpError(400, '反映する商品がありません');
    const sets = [['inv:items', items]];
    if (oqChanged) sets.push(['inv:ordq', Object.keys(oq).length ? oq : null]);
    await L.setJSON(sets);
    await appendLog(entries);
    return { count: entries.length, total: entries.reduce((a, e) => a + e.total, 0) };
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
