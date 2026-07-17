/* ============================================================
   每日報價抓取(由 GitHub Actions 執行,Node 20+,無相依套件)
   來源:
   - 台股上市:TWSE OpenAPI 全市場收盤行情
   - 台股上櫃:TPEx OpenAPI 收盤行情
   - 美股 / 匯率:Stooq 免費 CSV
   輸出:data/prices.json
   ============================================================ */
import { readFileSync, writeFileSync } from "node:fs";

const SYMBOLS = JSON.parse(readFileSync(new URL("../data/symbols.json", import.meta.url), "utf8"));
const OUT = new URL("../data/prices.json", import.meta.url);

const UA = { headers: { "User-Agent": "portfolio-watch/1.0 (personal use)" } };

async function getJSON(url) {
  const res = await fetch(url, UA);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, UA);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

/* ---- 台股上市(TWSE):一次取回全市場,再過濾 watchlist ---- */
async function fetchTWSE() {
  const rows = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  const map = {};
  for (const r of rows) {
    const code = r.Code || r.code;
    const close = parseFloat(r.ClosingPrice ?? r.closingPrice);
    if (!code || !isFinite(close)) continue;
    map[code] = { price: close, name: r.Name || r.name || code, date: r.Date ? normalizeTWDate(r.Date) : today() };
  }
  return map;
}

/* ---- 台股上櫃(TPEx) ---- */
async function fetchTPEx() {
  const rows = await getJSON("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes");
  const map = {};
  for (const r of rows) {
    const code = r.SecuritiesCompanyCode || r.Code;
    const close = parseFloat(String(r.Close ?? r.ClosingPrice ?? "").replace(/,/g, ""));
    if (!code || !isFinite(close)) continue;
    map[code] = { price: close, name: r.CompanyName || r.Name || code, date: r.Date ? normalizeTWDate(r.Date) : today() };
  }
  return map;
}

/* ---- Stooq:美股個股與匯率(csv: symbol,date,time,open,high,low,close,volume) ---- */
async function fetchStooq(symbol) {
  const csv = await getText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`);
  const line = csv.trim().split("\n")[1];
  if (!line) throw new Error(`no data: ${symbol}`);
  const parts = line.split(",");
  const close = parseFloat(parts[6]);
  if (!isFinite(close)) throw new Error(`N/A: ${symbol}`);
  return { price: close, date: parts[1] || today() };
}

function normalizeTWDate(d) {
  // TWSE 可能回傳民國年 "1150716" 或西元 "20260716"
  const s = String(d).replace(/\D/g, "");
  if (s.length === 7) { // 民國
    const y = 1911 + parseInt(s.slice(0, 3), 10);
    return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
  }
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return today();
}
function today() { return new Date().toISOString().slice(0, 10); }

async function main() {
  const prev = safeReadPrev();
  const out = { updatedAt: new Date().toISOString(), tw: { ...prev.tw }, us: { ...prev.us }, fx: { ...prev.fx } };
  const errors = [];

  // 台股
  try {
    const [twse, tpex] = await Promise.allSettled([fetchTWSE(), fetchTPEx()]);
    const pool = {
      ...(tpex.status === "fulfilled" ? tpex.value : {}),
      ...(twse.status === "fulfilled" ? twse.value : {}),
    };
    if (twse.status === "rejected") errors.push(`TWSE: ${twse.reason.message}`);
    if (tpex.status === "rejected") errors.push(`TPEx: ${tpex.reason.message}`);
    for (const sym of SYMBOLS.tw || []) {
      if (pool[sym]) out.tw[sym] = pool[sym];
      else errors.push(`台股 ${sym} 查無收盤價(確認代號或是否為興櫃)`);
    }
  } catch (e) { errors.push(`台股來源失敗: ${e.message}`); }

  // 美股
  for (const sym of SYMBOLS.us || []) {
    try {
      const q = await fetchStooq(sym.toLowerCase() + ".us");
      out.us[sym.toUpperCase()] = { price: q.price, name: sym.toUpperCase(), date: q.date };
    } catch (e) { errors.push(`美股 ${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 400)); // 禮貌性間隔
  }

  // 匯率(Stooq 貨幣對)
  const fxPairs = { USD: "usdtwd", JPY: "jpytwd" };
  for (const [cur, pair] of Object.entries(fxPairs)) {
    try {
      const q = await fetchStooq(pair);
      out.fx[cur] = q.price;
    } catch (e) { errors.push(`匯率 ${cur}: ${e.message}`); }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`✅ prices.json 已更新(台股 ${Object.keys(out.tw).length}、美股 ${Object.keys(out.us).length}、匯率 ${Object.keys(out.fx).length})`);
  if (errors.length) {
    console.warn("⚠ 部分來源失敗(沿用前次數值):\n" + errors.map(e => "  - " + e).join("\n"));
  }
}

function safeReadPrev() {
  try { return JSON.parse(readFileSync(OUT, "utf8")); }
  catch { return { tw: {}, us: {}, fx: {} }; }
}

main().catch(e => { console.error(e); process.exit(1); });
