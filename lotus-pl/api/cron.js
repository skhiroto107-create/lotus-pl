// 毎日 16:00(JST) に実行：営業日が切り替わる前に、その日の打刻と会計を取り込んで保存する。
// タイムカードの API は「今日」の打刻しか返さないため、この取り込みで履歴を残す。
const L = require('./_lib');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.status(401).json({ ok: false }); return; }
  try {
    const tc = await L.syncTimecard();
    const d = tc.businessDate;
    const menu = await L.syncMenu(L.STORES, [L.addDays(d, -1), d], { today: d, force: true });
    res.status(200).json({ ok: true, businessDate: d, punches: tc.stores, errors: menu.errors });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
