// 共通処理：保存先（Upstash Redis）、タイムカード/デジタルメニューからの取り込み、給与計算
// Notion には接続しない。データはタイムカード・デジタルメニューの API から取り込み、
// このアプリ専用の Redis に保存する。

const TIMECARD_URL = (process.env.TIMECARD_URL || 'https://lotus-timecard.vercel.app').replace(/\/$/, '');
const MENU_URL = (process.env.MENU_URL || 'https://lotus-digital-menu.vercel.app').replace(/\/$/, '');
const STORES = ['藤井寺店', '恵我之荘店'];
const MENU_KEY = { '藤井寺店': 'fujiidera', '恵我之荘店': 'egaoshou' }; // デジタルメニュー側の店舗キー

// スタッフバックの率（Notion の計算式と同じ）
const BACK = { normal: 0.1, late: 0.5, champagne: 0.2, medal: 50 };

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- KV (Upstash Redis REST) ----------
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = globalThis.__lotusMem || (globalThis.__lotusMem = new Map()); // 開発用（KV 未設定時）

async function kvPipeline(cmds) {
  if (!cmds.length) return [];
  if (!KV_URL || !KV_TOKEN) {
    return cmds.map(([op, key, val]) => {
      if (op === 'GET') return mem.has(key) ? mem.get(key) : null;
      if (op === 'SET') { mem.set(key, val); return 'OK'; }
      if (op === 'DEL') { mem.delete(key); return 1; }
      return null;
    });
  }
  const r = await fetch(KV_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw httpError(500, '保存先（Redis）に接続できません');
  return j.map((x) => (x && 'result' in x ? x.result : null));
}
const kvHasStore = () => !!(KV_URL && KV_TOKEN);
async function getJSON(keys) {
  const res = await kvPipeline(keys.map((k) => ['GET', k]));
  return res.map((v) => { try { return v == null ? null : JSON.parse(v); } catch (e) { return null; } });
}
async function setJSON(pairs) {
  return kvPipeline(pairs.map(([k, v]) => (v == null ? ['DEL', k] : ['SET', k, JSON.stringify(v)])));
}

// ---------- 日付 ----------
const pad = (n) => String(n).padStart(2, '0');
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${ym}-${pad(i + 1)}`);
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isYm = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));

// ---------- 上流 API ----------
async function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(httpError(504, label + ' が応答しません')), ms); });
  try { return await Promise.race([p, to]); } finally { clearTimeout(t); }
}
async function timecardStatus(store) {
  const r = await withTimeout(fetch(TIMECARD_URL + '/api/timecard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status', store }),
  }), 9000, 'タイムカード');
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw httpError(502, 'タイムカード: ' + (j.error || '取得できません'));
  return j; // { businessDate, records:[{id,staff,store,inIso,outIso,in,out,hours,normal,startCash}] }
}
async function menuHistory(store, date) {
  const u = `${MENU_URL}/api/history?store=${encodeURIComponent(MENU_KEY[store])}&date=${date}`;
  const r = await withTimeout(fetch(u), 9000, 'デジタルメニュー');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, 'デジタルメニュー: ' + (j.error || '取得できません'));
  return j.history || [];
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// タイムカードの「今日」の打刻を取り込み、日付ごとに保存（id で上書きマージ）
async function syncTimecard() {
  const out = { businessDate: null, stores: {} };
  for (const store of STORES) {
    const j = await timecardStatus(store);
    out.businessDate = j.businessDate;
    const key = `tc:${store}:${j.businessDate}`;
    const [prev] = await getJSON([key]);
    const map = {};
    for (const r of (prev && prev.records) || []) map[r.id] = r;
    for (const r of j.records || []) map[r.id] = {
      id: r.id, staff: r.staff, store, date: j.businessDate,
      in: r.inIso || null, out: r.outIso || null,
      hours: typeof r.hours === 'number' ? r.hours : null,
      tcNormal: typeof r.normal === 'number' ? r.normal : null,
      startCash: typeof r.startCash === 'number' ? r.startCash : null,
    };
    // タイムカード側で取り消された打刻（undo）は当日分から外す
    const live = new Set((j.records || []).map((r) => r.id));
    const records = Object.values(map).filter((r) => live.has(r.id));
    await setJSON([[key, { records, at: Date.now() }]]);
    out.stores[store] = records.length;
  }
  await setJSON([['meta:businessDate', { date: out.businessDate, at: Date.now() }]]);
  return out;
}

// デジタルメニューの会計履歴を日付ごとに取り込む（過去日はキャッシュ、直近は再取得）
async function syncMenu(stores, dates, { today, force } = {}) {
  const keys = [];
  for (const s of stores) for (const d of dates) keys.push([s, d, `mn:${s}:${d}`]);
  const cached = await getJSON(keys.map((k) => k[2]));
  const need = keys.filter(([, d], i) => {
    const c = cached[i];
    if (!c) return true;
    const recent = today && d >= addDays(today, -2);
    if (force && recent) return true;
    if (recent && Date.now() - c.at > 5 * 60e3) return true; // 直近3日は5分で更新
    return false;
  });
  const fetched = await mapLimit(need, 4, async ([s, d, k]) => {
    try { return [k, { history: await menuHistory(s, d), at: Date.now() }]; }
    catch (e) { return [k, null, e.message]; }
  });
  const ok = fetched.filter((x) => x[1]);
  if (ok.length) await setJSON(ok.map(([k, v]) => [k, v]));
  const errors = fetched.filter((x) => !x[1]).map((x) => x[2]);
  const res = {};
  keys.forEach(([s, d, k], i) => {
    const f = ok.find((x) => x[0] === k);
    res[k] = f ? f[1] : cached[i];
  });
  return { byKey: res, errors };
}

function mapOrder(h, store, date) {
  const cancelled = /取消|cancel/i.test(String(h.status || ''));
  return {
    id: h.id, name: h.tabName || '', store, date: h.date ? String(h.date).slice(0, 10) : date,
    state: h.status || '', cancelled,
    guests: Number(h.headcount) || 0, kind: h.customerType || '',
    normal: Number(h.normalSales) || 0, late: Number(h.lateNightSales) || 0,
    champagne: Number(h.champagneSales) || 0, medals: Number(h.medalCount) || 0,
    discount: Number(h.staffDiscount) || 0,
  };
}

// ---------- 計算 ----------
function round2(n) { return Math.round(n * 100) / 100; }
function diffHours(a, b) {
  if (!a || !b) return null;
  const h = (new Date(b) - new Date(a)) / 3600e3;
  return h >= 0 ? round2(h) : null;
}
// 1日分の打刻・会計・補正から、画面用のレコードを作る
function buildDay(store, date, tcRecords, orders, dayCfg, overrides, settings) {
  const valid = orders.filter((o) => !o.cancelled);
  const sum = { normal: 0, late: 0, champagne: 0, medals: 0, discount: 0 };
  for (const o of valid) for (const k in sum) sum[k] += o[k];
  const recs = tcRecords.map((r) => {
    const ov = (overrides && overrides[r.id]) || {};
    const inI = 'in' in ov ? ov.in : r.in;
    const outI = 'out' in ov ? ov.out : r.out;
    const hours = 'hours' in ov && ov.hours != null ? ov.hours : r.hours != null ? r.hours : diffHours(inI, outI);
    return { id: r.id, staff: r.staff, store, date, in: inI, out: outI, hours, cash: 'cash' in ov ? ov.cash : r.startCash, tcNormal: r.tcNormal, edited: Object.keys(ov).length > 0 };
  });
  // 計上担当（売上とバックが付く人）: 手動指定 > タイムカードの日締め代表 > 最初に出勤した人
  let holder = null;
  if (dayCfg && dayCfg.holder) holder = recs.find((r) => r.staff === dayCfg.holder) || null;
  if (!holder) holder = recs.find((r) => r.tcNormal != null) || null;
  if (!holder) holder = recs.slice().sort((a, b) => String(a.in || 'z').localeCompare(String(b.in || 'z')))[0] || null;
  const cashRec = recs.find((r) => r.cash != null);
  const startCash = cashRec ? cashRec.cash : null;
  const wages = (settings && settings.wages) || {};
  const defWage = settings && Number(settings.defaultWage) ? Number(settings.defaultWage) : 0;
  for (const r of recs) {
    const rate = Number(wages[r.staff]) || defWage;
    r.rate = rate;
    r.wage = r.hours != null ? Math.round(r.hours * rate) : null;
    const isH = holder && r.id === holder.id;
    r.holder = !!isH;
    r.normal = isH ? sum.normal : null;
    r.late = isH ? sum.late : null;
    r.champagne = isH ? sum.champagne : null;
    r.medals = isH ? sum.medals : null;
    r.discount = isH ? sum.discount : null;
    r.normalBack = isH ? Math.round(sum.normal * BACK.normal) : 0;
    r.lateBack = isH ? Math.round(sum.late * BACK.late) : 0;
    r.champagneBack = isH ? Math.round(sum.champagne * BACK.champagne) : 0;
    r.medalBack = isH ? sum.medals * BACK.medal : 0;
    const back = r.normalBack + r.lateBack + r.champagneBack + r.medalBack;
    r.pay = (r.wage || 0) + back;
    r.daily = isH ? sum.normal + sum.late + sum.champagne - back : 0;
    r.finalCash = isH && startCash != null ? startCash + sum.normal + sum.late + sum.champagne - back : null;
    if (!isH) r.cash = r.cash; // スタートレジ金は入力された行に残す
  }
  // 打刻がない日でも会計があれば売上は数える
  const unassigned = !holder && valid.length ? { ...sum, daily: sum.normal + sum.late + sum.champagne } : null;
  return { records: recs, orders, unassigned };
}

module.exports = {
  STORES, BACK, httpError, getJSON, setJSON, kvHasStore, addDays, monthDays, isDate, isYm,
  syncTimecard, syncMenu, mapOrder, buildDay, diffHours,
};
