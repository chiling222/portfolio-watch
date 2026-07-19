/* ============================================================
   Portfolio Watch — 配置偏離監控與再平衡
   資料僅存於 localStorage(可匯出備份),不上傳任何伺服器。
   ============================================================ */
"use strict";

/* ---------------- 市場註冊表(日後擴充在此新增) ---------------- */
const MARKETS = {
  TW:    { label: "台股",   currency: "TWD", lot: 1000, qtyDec: 0, priceDec: 2 },
  US:    { label: "美股",   currency: "USD", lot: 1,    qtyDec: 4, priceDec: 2 },
  JP:    { label: "日股",   currency: "JPY", lot: 100,  qtyDec: 0, priceDec: 0 },
  OTHER: { label: "其他",   currency: "TWD", lot: 1,    qtyDec: 4, priceDec: 2 },
};
const CURRENCIES = ["TWD", "USD", "JPY"];
const BASE = "TWD";
const CASH_KEY = "CASH";
const LS_KEY = "pw_data_v1";

/* ---------------- 狀態 ---------------- */
const DEFAULT_SETTINGS = {
  tolAbs: 2,      // 絕對偏離容忍(百分點)
  tolRel: 25,     // 相對偏離容忍(%)
  allowOddLot: true,
  feeTW: 0.1425,  // 台股手續費 %
  taxTW: 0.3,     // 台股證交稅 %(賣出)
  feeUS: 0.5,     // 複委託手續費 %(概估,依券商調整)
  fxFallback: { USD: 32.5, JPY: 0.21 },
};

let state = null;
let feed = null;          // data/prices.json 內容(不入 localStorage 以外的持久層)
let currentView = "dashboard";
let rebalanceMode = "buyonly"; // buyonly | both

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

function defaultState() {
  const pid = uid(), aid = uid();
  return {
    version: 1,
    activePortfolioId: pid,
    settings: { ...DEFAULT_SETTINGS },
    fxManual: {},        // { USD: {rate, at} }
    manualPrices: {},    // { "TW:2330": {price, at} }
    feedCache: null,     // 上次成功抓到的 prices.json(離線備援)
    portfolios: [{
      id: pid, name: "我的組合", plannedCapital: 1000000,
      accounts: [{ id: aid, name: "預設帳戶", cash: { TWD: 0 } }],
      targets: [{ key: CASH_KEY, pct: 10 }],
      positions: [],
    }],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    state = raw ? JSON.parse(raw) : defaultState();
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
    if (state.feedCache) feed = state.feedCache;
  } catch { state = defaultState(); }
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

function activePortfolio() {
  let p = state.portfolios.find(p => p.id === state.activePortfolioId);
  if (!p) { p = state.portfolios[0]; state.activePortfolioId = p?.id; }
  return p;
}

/* ---------------- 價格與匯率解析 ---------------- */
function feedPrice(key) {
  if (!feed) return null;
  const [mkt, sym] = key.split(":");
  const pool = mkt === "TW" ? feed.tw : mkt === "US" ? feed.us : null;
  const hit = pool && pool[sym];
  return hit ? { price: +hit.price, at: hit.date || feed.updatedAt, source: "feed", name: hit.name } : null;
}
function resolvePrice(key) {
  const man = state.manualPrices[key];
  const fd = feedPrice(key);
  if (man && fd) return (new Date(man.at) >= new Date(fd.at)) ? { ...man, source: "manual" } : fd;
  if (man) return { ...man, source: "manual" };
  if (fd) return fd;
  return null;
}
function resolveFx(cur) {
  if (cur === BASE) return { rate: 1, source: "base" };
  const man = state.fxManual[cur];
  const fd = feed?.fx?.[cur] ? { rate: +feed.fx[cur], at: feed.updatedAt, source: "feed" } : null;
  if (man && fd) return (new Date(man.at) >= new Date(fd.at)) ? { ...man, source: "manual" } : fd;
  if (man) return { ...man, source: "manual" };
  if (fd) return fd;
  return { rate: state.settings.fxFallback[cur] ?? 1, source: "fallback" };
}
function toBase(amount, cur) { return amount * resolveFx(cur).rate; }
function staleDays(at) {
  if (!at) return null;
  return Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
}

/* ---------------- 計算引擎 ---------------- */
function assetLabel(key) {
  if (key === CASH_KEY) return { name: "現金", sym: "" };
  const [mkt, sym] = key.split(":");
  const p = activePortfolio()?.positions.find(x => x.market === mkt && x.symbol === sym);
  const fd = feedPrice(key);
  return { name: p?.name || fd?.name || sym, sym: `${MARKETS[mkt]?.label || mkt} ${sym}` };
}

/** 計算單一組合的完整快照 */
function compute(p) {
  const s = state.settings;
  // 各資產市值(合併所有帳戶)
  const byKey = new Map();
  let missingPrice = [];
  for (const pos of p.positions) {
    const key = `${pos.market}:${pos.symbol}`;
    const pr = resolvePrice(key);
    const mkt = MARKETS[pos.market] || MARKETS.OTHER;
    const price = pr ? pr.price : 0;
    if (!pr) missingPrice.push(key);
    const valueNative = pos.qty * price;
    const value = toBase(valueNative, mkt.currency);
    const cost = toBase(pos.qty * pos.avgCost, mkt.currency);
    const cur = byKey.get(key) || { key, value: 0, cost: 0, qty: 0, price: pr, currency: mkt.currency };
    cur.value += value; cur.cost += cost; cur.qty += pos.qty;
    byKey.set(key, cur);
  }
  // 現金(各帳戶各幣別)
  let cashValue = 0, cashByCur = {};
  for (const acc of p.accounts) {
    for (const [cur, amt] of Object.entries(acc.cash || {})) {
      if (!amt) continue;
      cashByCur[cur] = (cashByCur[cur] || 0) + amt;
      cashValue += toBase(amt, cur);
    }
  }
  const stockValue = [...byKey.values()].reduce((a, b) => a + b.value, 0);
  const total = stockValue + cashValue;
  const totalCost = [...byKey.values()].reduce((a, b) => a + b.cost, 0);

  // 組合目標列(含未設目標的持股)
  const targetKeys = new Set(p.targets.map(t => t.key));
  const rows = [];
  for (const t of p.targets) {
    const isCash = t.key === CASH_KEY;
    const value = isCash ? cashValue : (byKey.get(t.key)?.value || 0);
    rows.push(makeRow(t.key, t.pct, value, total, s, byKey.get(t.key)));
  }
  for (const [key, agg] of byKey) {
    if (!targetKeys.has(key)) rows.push(makeRow(key, 0, agg.value, total, s, agg, true));
  }
  if (!targetKeys.has(CASH_KEY) && cashValue > 0) {
    rows.push(makeRow(CASH_KEY, 0, cashValue, total, s, null, true));
  }
  rows.sort((a, b) => Math.abs(b.devAbs) - Math.abs(a.devAbs));

  const targetSum = p.targets.reduce((a, t) => a + (+t.pct || 0), 0);
  const alerts = rows.filter(r => r.status === "alert");
  return { total, stockValue, cashValue, cashByCur, totalCost, rows, byKey,
           targetSum, alerts, missingPrice,
           pnl: stockValue - totalCost };
}

function makeRow(key, targetPct, value, total, s, agg, untargeted = false) {
  const actualPct = total > 0 ? value / total * 100 : 0;
  const devAbs = actualPct - targetPct;
  const devRel = targetPct > 0 ? devAbs / targetPct * 100 : (actualPct > 0 ? 100 : 0);
  let status = "ok";
  if (targetPct > 0 || untargeted) {
    const hitAbs = Math.abs(devAbs) > s.tolAbs;
    const hitRel = Math.abs(devRel) > s.tolRel;
    if (hitAbs && hitRel) status = "alert";
    else if (hitAbs || hitRel) status = "near";
  }
  return { key, targetPct, value, actualPct, devAbs, devRel, status, untargeted, agg };
}

/* ---------------- 再平衡引擎 ---------------- */
function planRebalance(p, mode) {
  const c = compute(p);
  const s = state.settings;
  const trades = [];
  const cashTarget = p.targets.find(t => t.key === CASH_KEY)?.pct || 0;
  const stockRows = c.rows.filter(r => r.key !== CASH_KEY);

  const mkTrade = (row, diffVal) => {
    const [mktId, sym] = row.key.split(":");
    const mkt = MARKETS[mktId] || MARKETS.OTHER;
    const pr = resolvePrice(row.key);
    if (!pr || pr.price <= 0) return null;
    const fx = resolveFx(mkt.currency).rate;
    const lot = (mktId === "TW" && !s.allowOddLot) ? mkt.lot : (mkt.qtyDec > 0 ? 0 : 1);
    let qty = Math.abs(diffVal) / (pr.price * fx);
    if (lot >= 1) qty = Math.floor(qty / lot) * lot;
    else qty = Math.floor(qty * 10000) / 10000;
    if (qty <= 0) return null;
    const amtNative = qty * pr.price;
    const amtBase = amtNative * fx;
    const buy = diffVal > 0;
    let feePct = mktId === "TW" ? s.feeTW + (buy ? 0 : s.taxTW) : s.feeUS;
    const fee = amtBase * feePct / 100;
    // 帳戶歸屬:買→該幣別現金最多的帳戶;賣→該檔持股最多的帳戶
    let account = null;
    if (buy) {
      account = [...p.accounts].sort((a, b) => (b.cash?.[mkt.currency] || 0) - (a.cash?.[mkt.currency] || 0))[0];
    } else {
      const holders = {};
      for (const pos of p.positions) if (`${pos.market}:${pos.symbol}` === row.key) holders[pos.accountId] = (holders[pos.accountId] || 0) + pos.qty;
      const accId = Object.entries(holders).sort((a, b) => b[1] - a[1])[0]?.[0];
      account = p.accounts.find(a => a.id === accId);
    }
    return { key: row.key, buy, qty, amtNative, amtBase, fee, currency: mkt.currency,
             price: pr.price, account: account?.name || "—",
             afterPct: (row.value + (buy ? amtBase : -amtBase)) / c.total * 100, targetPct: row.targetPct };
  };

  let note = "";
  if (mode === "both") {
    for (const row of stockRows) {
      if (row.status === "ok") continue;
      const diffVal = row.targetPct / 100 * c.total - row.value;
      const t = mkTrade(row, diffVal);
      if (t) trades.push(t);
    }
  } else {
    // 只買不賣:可動用現金 = 現金現值 − 目標現金水位
    const deployable = c.cashValue - cashTarget / 100 * c.total;
    if (deployable <= 0) {
      note = "目前現金已低於或等於目標水位,沒有可動用資金。可等待新資金投入,或切換「買賣皆可」模式。";
    } else {
      const shorts = stockRows
        .map(r => ({ r, short: r.targetPct / 100 * c.total - r.value }))
        .filter(x => x.short > 0);
      const totalShort = shorts.reduce((a, b) => a + b.short, 0);
      const scale = totalShort > 0 ? Math.min(1, deployable / totalShort) : 0;
      for (const { r, short } of shorts) {
        const t = mkTrade(r, short * scale);
        if (t) trades.push(t);
      }
      note = `可動用現金約 ${fmtMoney(deployable)}(現金現值 − 目標現金水位)。` +
             (scale < 1 ? "資金不足以完全補齊,已按缺口比例分配。" : "");
    }
  }
  trades.sort((a, b) => b.amtBase - a.amtBase);
  const totalFee = trades.reduce((a, t) => a + t.fee, 0);
  return { trades, note, totalFee, snapshot: c };
}

/* ---------------- 格式化 ---------------- */
const nf0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
function fmtMoney(v, cur = BASE) {
  const sym = cur === "TWD" ? "NT$" : cur === "USD" ? "US$" : cur === "JPY" ? "¥" : cur + " ";
  return sym + (Math.abs(v) >= 10000 ? nf0.format(v) : nf2.format(v));
}
function fmtPct(v, signed = false) {
  const s = signed && v > 0 ? "+" : "";
  return s + nf2.format(v) + "%";
}
function fmtQty(q, mktId) {
  const mkt = MARKETS[mktId];
  if (mktId === "TW" && q >= 1000 && q % 1000 === 0) return nf0.format(q / 1000) + " 張";
  return nf0.format(q) + " 股";
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

/* ---------------- 即時查詢(FinMind,瀏覽器直接呼叫) ---------------- */
async function finmind(params) {
  const url = "https://api.finmindtrade.com/api/v4/data?" + new URLSearchParams(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  if (!j.data || !j.data.length) throw new Error("no data");
  return j.data;
}
/** 依市場+代號即時查名稱與最近收盤價;查不到的欄位回 null */
async function lookupAsset(mkt, sym) {
  const start = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  let name = null, price = null;
  if (mkt === "TW") {
    try { const info = await finmind({ dataset: "TaiwanStockInfo", data_id: sym }); name = info[0]?.stock_name || null; } catch {}
    try { const rows = await finmind({ dataset: "TaiwanStockPrice", data_id: sym, start_date: start }); price = +rows[rows.length - 1].close || null; } catch {}
  } else if (mkt === "US") {
    const id = sym.toUpperCase();
    try {
      const rows = await finmind({ dataset: "USStockPrice", data_id: id, start_date: start });
      const last = rows[rows.length - 1];
      price = +(last.Close ?? last.close) || null;
    } catch {}
  }
  return { name, price };
}
/** 即時匯率(open.er-api.com,免金鑰、允許跨域) */
async function refreshFxLive() {
  const r = await fetch("https://open.er-api.com/v6/latest/USD").then(x => x.json());
  if (!r?.rates?.TWD) throw new Error("no TWD");
  const at = new Date().toISOString();
  state.fxManual.USD = { rate: r.rates.TWD, at };
  if (r.rates.JPY) state.fxManual.JPY = { rate: r.rates.TWD / r.rates.JPY, at };
  save();
}

/* ---------------- 報價載入 ---------------- */
async function loadFeed(showToast = false) {
  const btn = document.getElementById("btnRefreshPrices");
  btn.classList.add("spinning");
  try {
    const res = await fetch(`data/prices.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    feed = await res.json();
    state.feedCache = feed; save();
    if (showToast) toast("報價已更新");
  } catch {
    if (showToast) toast(feed ? "無法取得新報價,使用快取資料" : "尚無報價資料,請先手動輸入價格");
  } finally {
    btn.classList.remove("spinning");
    renderFeedStatus();
    render();
  }
}
function renderFeedStatus() {
  const el = document.getElementById("feedStatus");
  if (!feed) { el.hidden = false; el.textContent = "尚未載入報價 — 部署 GitHub Actions 後自動更新,或於持倉頁手動輸入價格"; return; }
  const d = staleDays(feed.updatedAt);
  el.hidden = false;
  el.className = "feed-status" + (d > 3 ? " stale" : "");
  el.textContent = `報價更新:${new Date(feed.updatedAt).toLocaleString("zh-TW", { hour12: false })}` + (d > 3 ? `(已 ${d} 天未更新)` : "");
}

/* ---------------- UI 基礎 ---------------- */
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, 2400);
}

/** 通用表單 modal。fields: [{id,label,type,value,options,hint,required,step}] */
function openModal(title, fields, onOk, okText = "儲存") {
  const modal = document.getElementById("modal");
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalOk").textContent = okText;
  const body = document.getElementById("modalBody");
  body.innerHTML = fields.map(f => {
    if (f.type === "select") {
      return `<div class="field"><label for="f_${f.id}">${esc(f.label)}</label>
        <select id="f_${f.id}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
        ${f.hint ? `<div class="field-hint">${esc(f.hint)}</div>` : ""}</div>`;
    }
    if (f.type === "button") {
      return `<div class="field"><button type="button" class="btn small" id="f_${f.id}" style="width:100%">${esc(f.label)}</button>
        ${f.hint ? `<div class="field-hint" style="margin-top:5px">${esc(f.hint)}</div>` : ""}</div>`;
    }
    if (f.type === "row") {
      return `<div class="field-row">${f.fields.map(sub => `
        <div class="field"><label for="f_${sub.id}">${esc(sub.label)}</label>
        <input id="f_${sub.id}" type="${sub.type || "text"}" class="${sub.type === "number" ? "num-input" : ""}"
          value="${esc(sub.value ?? "")}" ${sub.step ? `step="${sub.step}"` : ""} ${sub.required ? "required" : ""}
          ${sub.placeholder ? `placeholder="${esc(sub.placeholder)}"` : ""} inputmode="${sub.type === "number" ? "decimal" : "text"}"></div>`).join("")}</div>`;
    }
    return `<div class="field"><label for="f_${f.id}">${esc(f.label)}</label>
      <input id="f_${f.id}" type="${f.type || "text"}" class="${f.type === "number" ? "num-input" : ""}"
        value="${esc(f.value ?? "")}" ${f.step ? `step="${f.step}"` : ""} ${f.required ? "required" : ""}
        ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} inputmode="${f.type === "number" ? "decimal" : "text"}">
      ${f.hint ? `<div class="field-hint">${esc(f.hint)}</div>` : ""}</div>`;
  }).join("");
  const form = document.getElementById("modalForm");
  form.onsubmit = (e) => {
    e.preventDefault();
    const vals = {};
    body.querySelectorAll("input,select").forEach(el => vals[el.id.slice(2)] = el.value.trim());
    if (onOk(vals) !== false) modal.close();
  };
  document.getElementById("modalCancel").onclick = () => modal.close();
  modal.showModal();
}

function confirmDanger(msg, onOk) {
  openModal("確認", [{ id: "_c", label: msg, type: "hidden" }], () => { onOk(); }, "確定");
  document.getElementById("modalBody").innerHTML = `<p style="font-size:14px;line-height:1.7">${esc(msg)}</p>`;
}

/* ---------------- 視圖:儀表板 ---------------- */
function vDashboard() {
  const p = activePortfolio();
  if (!p) return `<div class="empty">尚無組合,請先於總覽建立。</div>`;
  const c = compute(p);
  const progress = p.plannedCapital > 0 ? Math.min(100, c.total / p.plannedCapital * 100) : 0;
  const pnlPct = c.totalCost > 0 ? c.pnl / c.totalCost * 100 : 0;

  let html = "";
  if (c.targetSum !== 100 && p.targets.length > 0) {
    html += `<div class="alert-strip gold">⚠ 目標比例合計 ${fmtPct(c.targetSum)},未等於 100%,請至「目標」頁調整。</div>`;
  }
  if (c.missingPrice.length) {
    html += `<div class="alert-strip gold">⚠ ${c.missingPrice.map(k => esc(assetLabel(k).sym)).join("、")} 缺少價格,市值以 0 計算。請更新報價或手動輸入。</div>`;
  }
  if (c.alerts.length) {
    html += `<div class="alert-strip">🔔 ${c.alerts.length} 檔偏離超出容忍區間:${c.alerts.map(r => `${esc(assetLabel(r.key).name)} ${fmtPct(r.devAbs, true)}`).join("、")}</div>`;
  }

  html += `<div class="stat-grid">
    <div class="stat"><div class="k">總市值</div><div class="v num">${fmtMoney(c.total)}</div></div>
    <div class="stat"><div class="k">未實現損益</div>
      <div class="v num ${c.pnl >= 0 ? "pos" : "neg"}">${c.pnl >= 0 ? "+" : ""}${fmtMoney(c.pnl)}</div>
      <div class="sub num ${c.pnl >= 0 ? "pos" : "neg"}">${fmtPct(pnlPct, true)}</div></div>
    <div class="stat"><div class="k">現金部位</div><div class="v num">${fmtMoney(c.cashValue)}</div>
      <div class="sub num">${Object.entries(c.cashByCur).map(([k, v]) => fmtMoney(v, k)).join(" · ") || "—"}</div></div>
    <div class="stat"><div class="k">投入進度</div><div class="v num">${fmtPct(progress)}</div>
      <div class="sub num">規模 ${fmtMoney(p.plannedCapital)}</div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div></div>
  </div>`;

  html += `<div class="section-title"><span>配置偏離監控</span><span style="letter-spacing:0;font-weight:400">▲ 金色為目標</span></div>`;
  if (!c.rows.length) {
    html += `<div class="card"><div class="empty">還沒有目標與持倉。<br>先到「目標」頁設定配置比例,再到「持倉」頁輸入部位。</div></div>`;
  } else {
    html += `<div class="card flat">` + c.rows.map(r => rulerRow(r, c)).join("") + `</div>`;
    html += `<p class="inline-note">偏離狀態:同時超過絕對(±${state.settings.tolAbs} 個百分點)與相對(±${state.settings.tolRel}%)容忍區間才會警示,可於設定調整。紅=超配、綠=低配,依台股慣例。</p>`;
  }
  return html;
}

function rulerRow(r, c) {
  const lbl = assetLabel(r.key);
  const scaleMax = Math.max(r.actualPct, r.targetPct, 1) * 1.3;
  const fillW = Math.min(100, r.actualPct / scaleMax * 100);
  const tgtX = Math.min(100, r.targetPct / scaleMax * 100);
  const bandL = Math.max(0, (r.targetPct - state.settings.tolAbs) / scaleMax * 100);
  const bandR = Math.min(100, (r.targetPct + state.settings.tolAbs) / scaleMax * 100);
  const cls = r.status === "ok" ? "" : (r.devAbs > 0 ? "over" : "under");
  const devColor = r.status === "ok" ? "" : (r.devAbs > 0 ? "pos" : "neg");
  const badge = r.untargeted ? `<span class="badge gold">未設目標</span>` :
                r.status === "alert" ? `<span class="badge alert">超出區間</span>` : "";
  const pr = r.key !== CASH_KEY ? resolvePrice(r.key) : null;
  const stale = pr && staleDays(pr.at) > 3 ? `・價格已 ${staleDays(pr.at)} 天` : "";
  return `<div class="ruler-row">
    <div class="ruler-head">
      <div class="ruler-name">${esc(lbl.name)}<span class="sym">${esc(lbl.sym)}</span>${badge}</div>
      <div class="ruler-dev num ${devColor}">${fmtPct(r.devAbs, true)}</div>
    </div>
    <div class="ruler-meta">
      <span class="num">實際 ${fmtPct(r.actualPct)} / 目標 ${fmtPct(r.targetPct)}${stale}</span>
      <span class="num">${fmtMoney(r.value)}</span>
    </div>
    <div class="ruler-track">
      ${r.targetPct > 0 ? `<div class="ruler-band" style="left:${bandL}%;width:${bandR - bandL}%"></div>` : ""}
      <div class="ruler-fill ${cls}" style="width:${fillW}%"></div>
      ${r.targetPct > 0 ? `<div class="ruler-target" style="left:${tgtX}%"></div>` : ""}
    </div>
  </div>`;
}

/* ---------------- 視圖:再平衡 ---------------- */
function vRebalance() {
  const p = activePortfolio();
  if (!p) return `<div class="empty">尚無組合。</div>`;
  const plan = planRebalance(p, rebalanceMode);
  let html = `<div class="mode-toggle">
    <button data-mode="buyonly" class="${rebalanceMode === "buyonly" ? "active" : ""}">只買不賣</button>
    <button data-mode="both" class="${rebalanceMode === "both" ? "active" : ""}">買賣皆可</button>
  </div>`;
  if (plan.note) html += `<div class="alert-strip gold">${esc(plan.note)}</div>`;
  if (!plan.trades.length) {
    html += `<div class="card"><div class="empty">${rebalanceMode === "both"
      ? "所有部位皆在容忍區間內,目前不需要再平衡 🎯"
      : "沒有可執行的買進建議。"}</div></div>`;
  } else {
    html += `<div class="card flat">` + plan.trades.map(t => {
      const lbl = assetLabel(t.key);
      return `<div class="trade-row">
        <div class="trade-action ${t.buy ? "buy" : "sell"}">${t.buy ? "買進" : "賣出"}</div>
        <div class="list-main">
          <div class="list-title">${esc(lbl.name)} <span class="sym num" style="color:var(--muted);font-size:12px">${esc(lbl.sym)}</span></div>
          <div class="list-sub num">${fmtQty(t.qty, t.key.split(":")[0])} @ ${nf2.format(t.price)} ・ ${esc(t.account)}</div>
        </div>
        <div class="list-val">
          <div class="v num">${fmtMoney(t.amtNative, t.currency)}</div>
          <div class="sub num">執行後 ${fmtPct(t.afterPct)} → 目標 ${fmtPct(t.targetPct)}</div>
        </div>
      </div>`;
    }).join("") + `</div>`;
    html += `<div class="card" style="display:flex;justify-content:space-between;font-size:13px">
      <span>預估交易成本(手續費/稅)</span><span class="num">${fmtMoney(plan.totalFee)}</span></div>`;
  }
  html += `<p class="inline-note">建議依「回到目標比例」計算,已考慮最小交易單位${state.settings.allowOddLot ? "(台股允許零股)" : "(台股以整張計)"}與現金幣別歸屬帳戶。實際下單請自行確認價格與費率;本工具僅供配置參考,不構成投資建議。</p>`;
  return html;
}

/* ---------------- 視圖:持倉 ---------------- */
function vHoldings() {
  const p = activePortfolio();
  if (!p) return `<div class="empty">尚無組合。</div>`;
  let html = "";
  // 提示:持有但不在每日報價清單中的代號
  const missingFeed = new Set();
  for (const pf of state.portfolios) for (const pos of pf.positions) {
    if ((pos.market === "TW" || pos.market === "US") && !feedPrice(`${pos.market}:${pos.symbol}`)) missingFeed.add(pos.symbol);
  }
  if (feed && missingFeed.size) {
    html += `<div class="alert-strip gold" style="align-items:center;justify-content:space-between">
      <span>📋 ${[...missingFeed].join("、")} 不在每日報價清單中,只能靠查詢價/手動價。</span>
      <button class="btn small" data-act="copySymbols" style="flex:0 0 auto">複製新清單</button>
    </div>
    <p class="inline-note" style="margin-top:-4px;margin-bottom:10px">按「複製新清單」→ 到 GitHub 編輯 data/symbols.json 全選貼上 → Commit → Actions 跑一次,之後每天自動更新這些代號。</p>`;
  }
  html += `<div class="section-title"><span>帳戶與現金</span>
    <button class="btn small" data-act="addAccount">+ 帳戶</button></div>`;
  html += `<div class="card flat">` + (p.accounts.length ? p.accounts.map(a => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">${esc(a.name)}</div>
        <div class="list-sub num">${Object.entries(a.cash || {}).filter(([, v]) => v).map(([k, v]) => fmtMoney(v, k)).join(" ・ ") || "無現金"}</div>
      </div>
      <div class="row-actions">
        <button class="btn small" data-act="editAccount" data-id="${a.id}">編輯</button>
        <button class="btn small danger" data-act="delAccount" data-id="${a.id}">刪除</button>
      </div>
    </div>`).join("") : `<div class="empty">尚無帳戶</div>`) + `</div>`;

  html += `<div class="section-title"><span>持股部位</span>
    <button class="btn small" data-act="addPosition">+ 部位</button></div>`;
  const groups = {};
  for (const pos of p.positions) (groups[pos.accountId] = groups[pos.accountId] || []).push(pos);
  if (!p.positions.length) {
    html += `<div class="card"><div class="empty">尚無持股。點「+ 部位」新增第一筆。</div></div>`;
  } else {
    for (const acc of p.accounts) {
      const list = groups[acc.id];
      if (!list) continue;
      html += `<div class="card flat"><div class="list-row" style="background:var(--surface-2)"><div class="list-title">${esc(acc.name)}</div></div>`;
      html += list.map(pos => {
        const key = `${pos.market}:${pos.symbol}`;
        const pr = resolvePrice(key);
        const mkt = MARKETS[pos.market] || MARKETS.OTHER;
        const val = pr ? pos.qty * pr.price : 0;
        const pnl = pr ? (pr.price - pos.avgCost) * pos.qty : 0;
        const pnlPct = pos.avgCost > 0 && pr ? (pr.price / pos.avgCost - 1) * 100 : 0;
        return `<div class="list-row">
          <div class="list-main">
            <div class="list-title">${esc(pos.name || pos.symbol)}
              <span class="sym num" style="color:var(--muted);font-size:12px">${esc(MARKETS[pos.market]?.label || pos.market)} ${esc(pos.symbol)}</span>
              ${pr ? `<span class="badge">${pr.source === "manual" ? "手動價" : "自動價"}</span>` : `<span class="badge alert">無價格</span>`}
            </div>
            <div class="list-sub num">${fmtQty(pos.qty, pos.market)} ・ 成本 ${nf2.format(pos.avgCost)} ・ 現價 ${pr ? nf2.format(pr.price) : "—"}</div>
          </div>
          <div class="list-val">
            <div class="v num">${fmtMoney(val, mkt.currency)}</div>
            <div class="sub num ${pnl >= 0 ? "pos" : "neg"}">${pnl >= 0 ? "+" : ""}${nf0.format(pnl)} (${fmtPct(pnlPct, true)})</div>
          </div>
          <div class="row-actions">
            <button class="btn small" data-act="setPrice" data-key="${key}">價</button>
            <button class="btn small" data-act="editPosition" data-id="${pos.id}">編</button>
            <button class="btn small danger" data-act="delPosition" data-id="${pos.id}">刪</button>
          </div>
        </div>`;
      }).join("") + `</div>`;
    }
  }
  return html;
}

/* ---------------- 視圖:目標 ---------------- */
function vTargets() {
  const p = activePortfolio();
  if (!p) return `<div class="empty">尚無組合。</div>`;
  const sum = p.targets.reduce((a, t) => a + (+t.pct || 0), 0);
  let html = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><div style="font-size:12px;color:var(--muted)">預計投入資金規模</div>
      <div class="num" style="font-size:20px;font-weight:600">${fmtMoney(p.plannedCapital)}</div></div>
      <button class="btn small" data-act="editPortfolio">編輯組合</button>
    </div></div>`;
  html += `<div class="section-title"><span>目標配置(合計 <span class="num" style="color:${sum === 100 ? "var(--under)" : "var(--over)"}">${nf2.format(sum)}%</span>)</span>
    <button class="btn small" data-act="addTarget">+ 目標</button></div>`;
  html += `<div class="card flat">` + (p.targets.length ? p.targets.map((t, i) => {
    const lbl = assetLabel(t.key);
    return `<div class="list-row">
      <div class="list-main"><div class="list-title">${esc(lbl.name)}
        <span class="sym num" style="color:var(--muted);font-size:12px">${esc(lbl.sym)}</span></div></div>
      <div class="list-val"><div class="v num">${nf2.format(t.pct)}%</div></div>
      <div class="row-actions">
        <button class="btn small" data-act="editTarget" data-i="${i}">編</button>
        <button class="btn small danger" data-act="delTarget" data-i="${i}">刪</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">尚無目標配置。<br>建議把「現金」也設一個目標比例,再平衡計算會更準確。</div>`) + `</div>`;
  if (sum !== 100 && p.targets.length) html += `<div class="alert-strip gold">合計需為 100%,目前${sum > 100 ? "超出" : "尚缺"} ${nf2.format(Math.abs(100 - sum))} 個百分點。</div>`;
  return html;
}

/* ---------------- 視圖:總覽 ---------------- */
function vOverview() {
  let html = `<div class="section-title"><span>所有組合</span>
    <button class="btn small" data-act="addPortfolio">+ 新組合</button></div>`;
  let grand = 0;
  html += state.portfolios.map(p => {
    const c = compute(p);
    grand += c.total;
    const progress = p.plannedCapital > 0 ? Math.min(100, c.total / p.plannedCapital * 100) : 0;
    const pnlPct = c.totalCost > 0 ? c.pnl / c.totalCost * 100 : 0;
    return `<div class="card" style="cursor:pointer" data-act="openPortfolio" data-id="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div class="list-title" style="font-size:16px">${esc(p.name)}
          ${c.alerts.length ? `<span class="badge alert">${c.alerts.length} 檔偏離</span>` : `<span class="badge">配置正常</span>`}</div>
        <div class="num" style="font-size:17px;font-weight:600">${fmtMoney(c.total)}</div>
      </div>
      <div class="list-sub num" style="display:flex;justify-content:space-between">
        <span>損益 <span class="${c.pnl >= 0 ? "pos" : "neg"}">${c.pnl >= 0 ? "+" : ""}${nf0.format(c.pnl)} (${fmtPct(pnlPct, true)})</span></span>
        <span>投入 ${fmtPct(progress)} / ${fmtMoney(p.plannedCapital)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
    </div>`;
  }).join("");
  html += `<div class="card" style="display:flex;justify-content:space-between;border-color:var(--gold)">
    <span>家庭資產合計</span><span class="num" style="font-weight:700;color:var(--gold)">${fmtMoney(grand)}</span></div>`;
  html += `<p class="inline-note">各組合目標配置獨立,偏離監控不跨組合合併計算。點擊卡片切換至該組合。</p>`;
  return html;
}

/* ---------------- 視圖:設定 ---------------- */
function vSettings() {
  const s = state.settings;
  const fxU = resolveFx("USD"), fxJ = resolveFx("JPY");
  return `
  <div class="section-title"><span>偏離容忍區間</span></div>
  <div class="card flat">
    <div class="list-row"><div class="list-main"><div class="list-title">絕對偏離</div>
      <div class="list-sub">實際 − 目標超過 ±${s.tolAbs} 個百分點</div></div>
      <button class="btn small" data-act="editTol">調整</button></div>
    <div class="list-row"><div class="list-main"><div class="list-title">相對偏離</div>
      <div class="list-sub">偏離幅度超過目標的 ±${s.tolRel}%(兩者同時超過才警示)</div></div></div>
  </div>
  <div class="section-title"><span>交易設定</span></div>
  <div class="card flat">
    <div class="list-row"><div class="list-main"><div class="list-title">台股零股</div>
      <div class="list-sub">${s.allowOddLot ? "允許零股交易(建議以 1 股為單位)" : "僅以整張(1000 股)為單位"}</div></div>
      <button class="btn small" data-act="toggleOddLot">${s.allowOddLot ? "改整張" : "改零股"}</button></div>
    <div class="list-row"><div class="list-main"><div class="list-title">費率</div>
      <div class="list-sub num">台股手續費 ${s.feeTW}%・證交稅 ${s.taxTW}%・複委託 ${s.feeUS}%</div></div>
      <button class="btn small" data-act="editFees">調整</button></div>
  </div>
  <div class="section-title"><span>匯率(換算基準:TWD)</span>
    <button class="btn small" data-act="refreshFx">↻ 立即更新</button></div>
  <div class="card flat">
    <div class="list-row"><div class="list-main"><div class="list-title">USD/TWD</div>
      <div class="list-sub num">${nf2.format(fxU.rate)}(${fxU.source === "feed" ? "自動" : fxU.source === "manual" ? "手動" : "預設值,建議更新"})</div></div>
      <button class="btn small" data-act="editFx" data-cur="USD">手動設定</button></div>
    <div class="list-row"><div class="list-main"><div class="list-title">JPY/TWD</div>
      <div class="list-sub num">${nf2.format(fxJ.rate)}(${fxJ.source === "feed" ? "自動" : fxJ.source === "manual" ? "手動" : "預設值"})</div></div>
      <button class="btn small" data-act="editFx" data-cur="JPY">手動設定</button></div>
  </div>
  <div class="section-title"><span>資料</span></div>
  <div class="card flat">
    <div class="list-row"><div class="list-main"><div class="list-title">匯出備份</div>
      <div class="list-sub">下載 JSON 檔,可跨裝置匯入</div></div>
      <button class="btn small" data-act="exportData">匯出</button></div>
    <div class="list-row"><div class="list-main"><div class="list-title">匯入備份</div>
      <div class="list-sub">會覆蓋目前所有資料</div></div>
      <button class="btn small" data-act="importData">匯入</button></div>
    <div class="list-row"><div class="list-main"><div class="list-title">清除全部資料</div></div>
      <button class="btn small danger" data-act="resetData">清除</button></div>
  </div>
  <p class="inline-note">所有持倉資料僅儲存在此裝置的瀏覽器中,不會上傳到任何伺服器。請定期匯出備份;跨裝置同步(Google Drive)規劃於下一版本加入。</p>`;
}

/* ---------------- 動作處理 ---------------- */
const actions = {
  addPortfolio() {
    openModal("新增組合", [
      { id: "name", label: "組合名稱", value: "", required: true, placeholder: "例:兒子的組合" },
      { id: "cap", label: "預計投入資金規模(TWD)", type: "number", value: 1000000, step: "any" },
    ], v => {
      if (!v.name) return false;
      const pid = uid();
      state.portfolios.push({ id: pid, name: v.name, plannedCapital: +v.cap || 0,
        accounts: [{ id: uid(), name: "預設帳戶", cash: { TWD: 0 } }], targets: [{ key: CASH_KEY, pct: 10 }], positions: [] });
      state.activePortfolioId = pid; save(); switchView("targets");
      toast("組合已建立,先設定目標配置吧");
    });
  },
  editPortfolio() {
    const p = activePortfolio();
    openModal("編輯組合", [
      { id: "name", label: "組合名稱", value: p.name, required: true },
      { id: "cap", label: "預計投入資金規模(TWD)", type: "number", value: p.plannedCapital, step: "any" },
      { id: "del", label: "刪除組合請輸入 DELETE", value: "", placeholder: "留空表示不刪除" },
    ], v => {
      if (v.del === "DELETE") {
        state.portfolios = state.portfolios.filter(x => x.id !== p.id);
        if (!state.portfolios.length) state = defaultState();
        state.activePortfolioId = state.portfolios[0].id;
        save(); switchView("overview"); toast("組合已刪除"); return;
      }
      p.name = v.name; p.plannedCapital = +v.cap || 0; save(); render();
    });
  },
  openPortfolio(el) { state.activePortfolioId = el.dataset.id; save(); switchView("dashboard"); },

  addAccount() {
    openModal("新增帳戶", [
      { id: "name", label: "帳戶名稱", required: true, placeholder: "例:新光台股、複委託" },
      { id: "row1", type: "row", fields: [
        { id: "twd", label: "TWD 現金", type: "number", value: 0, step: "any" },
        { id: "usd", label: "USD 現金", type: "number", value: 0, step: "any" }] },
    ], v => {
      if (!v.name) return false;
      activePortfolio().accounts.push({ id: uid(), name: v.name, cash: { TWD: +v.twd || 0, USD: +v.usd || 0 } });
      save(); render();
    });
  },
  editAccount(el) {
    const a = activePortfolio().accounts.find(x => x.id === el.dataset.id);
    openModal("編輯帳戶", [
      { id: "name", label: "帳戶名稱", value: a.name, required: true },
      { id: "row1", type: "row", fields: [
        { id: "twd", label: "TWD 現金", type: "number", value: a.cash?.TWD || 0, step: "any" },
        { id: "usd", label: "USD 現金", type: "number", value: a.cash?.USD || 0, step: "any" }] },
      { id: "jpy", label: "JPY 現金", type: "number", value: a.cash?.JPY || 0, step: "any" },
    ], v => {
      a.name = v.name; a.cash = { TWD: +v.twd || 0, USD: +v.usd || 0, JPY: +v.jpy || 0 };
      save(); render();
    });
  },
  delAccount(el) {
    const p = activePortfolio();
    const hasPos = p.positions.some(x => x.accountId === el.dataset.id);
    if (hasPos) { toast("此帳戶尚有持股,請先移除部位"); return; }
    confirmDanger("確定刪除此帳戶?", () => {
      p.accounts = p.accounts.filter(x => x.id !== el.dataset.id); save(); render();
    });
  },

  addPosition() { actions._positionForm(null); },
  editPosition(el) { actions._positionForm(activePortfolio().positions.find(x => x.id === el.dataset.id)); },
  _positionForm(pos) {
    const p = activePortfolio();
    if (!p.accounts.length) { toast("請先新增帳戶"); return; }
    let fetchedPrice = null; // 查詢到的即時價,儲存時寫入
    openModal(pos ? "編輯部位" : "新增部位", [
      { id: "acc", label: "帳戶", type: "select", value: pos?.accountId || p.accounts[0].id,
        options: p.accounts.map(a => ({ value: a.id, label: a.name })) },
      { id: "mkt", label: "市場", type: "select", value: pos?.market || "TW",
        options: Object.entries(MARKETS).map(([k, m]) => ({ value: k, label: `${m.label}(${m.currency})` })) },
      { id: "row1", type: "row", fields: [
        { id: "sym", label: "代號", value: pos?.symbol || "", required: true, placeholder: "2330 / VOO" },
        { id: "name", label: "名稱(可留空)", value: pos?.name || "", placeholder: "自動帶入" }] },
      { id: "lookup", type: "button", label: "🔍 查詢名稱與現價",
        hint: "輸入代號後點此,自動帶入官方名稱與最近收盤價" },
      { id: "row2", type: "row", fields: [
        { id: "qty", label: "股數", type: "number", value: pos?.qty ?? "", step: "any", required: true },
        { id: "cost", label: "平均成本(原幣)", type: "number", value: pos?.avgCost ?? "", step: "any", required: true }] },
    ], v => {
      if (!v.sym || !v.qty) return false;
      const data = { accountId: v.acc, market: v.mkt, symbol: v.sym.toUpperCase(),
        name: v.name, qty: +v.qty, avgCost: +v.cost || 0 };
      if (pos) Object.assign(pos, data);
      else p.positions.push({ id: uid(), ...data });
      const key = `${data.market}:${data.symbol}`;
      if (fetchedPrice != null && !feedPrice(key)) {
        state.manualPrices[key] = { price: fetchedPrice, at: new Date().toISOString() };
      }
      save(); render();
    });
    const btn = document.getElementById("f_lookup");
    if (btn) btn.onclick = async () => {
      const mkt = document.getElementById("f_mkt").value;
      const sym = document.getElementById("f_sym").value.trim().toUpperCase();
      if (!sym) { toast("請先輸入代號"); return; }
      btn.disabled = true; btn.textContent = "查詢中…";
      try {
        const r = await lookupAsset(mkt, sym);
        const nameInput = document.getElementById("f_name");
        if (r.name && !nameInput.value) nameInput.value = r.name;
        if (r.price != null) fetchedPrice = r.price;
        if (!r.name && r.price == null) toast("查無此代號,請確認市場與代號");
        else toast(`${r.name || sym}${r.price != null ? " ・ 現價 " + r.price : "(價格查無,請手動輸入)"}`);
      } catch { toast("查詢失敗,可能是網路或 API 額度問題"); }
      btn.disabled = false; btn.textContent = "🔍 查詢名稱與現價";
    };
  },
  delPosition(el) {
    confirmDanger("確定刪除此部位?", () => {
      const p = activePortfolio();
      p.positions = p.positions.filter(x => x.id !== el.dataset.id); save(); render();
    });
  },
  setPrice(el) {
    const key = el.dataset.key;
    const cur = resolvePrice(key);
    openModal(`手動價格 — ${assetLabel(key).name}`, [
      { id: "price", label: "目前價格(原幣)", type: "number", value: cur?.price ?? "", step: "any", required: true,
        hint: "手動價與自動報價並存時,採用較新的一筆" },
    ], v => {
      state.manualPrices[key] = { price: +v.price, at: new Date().toISOString() };
      save(); render(); toast("價格已更新");
    });
  },

  addTarget() { actions._targetForm(null); },
  editTarget(el) { actions._targetForm(+el.dataset.i); },
  _targetForm(i) {
    const p = activePortfolio();
    const t = i != null ? p.targets[i] : null;
    const isCash = t?.key === CASH_KEY;
    openModal(t ? "編輯目標" : "新增目標", [
      ...(isCash ? [] : [
        { id: "mkt", label: "市場", type: "select", value: t ? t.key.split(":")[0] : "TW",
          options: [...Object.entries(MARKETS).map(([k, m]) => ({ value: k, label: m.label })), { value: CASH_KEY, label: "現金" }] },
        { id: "sym", label: "代號(現金免填)", value: t && t.key !== CASH_KEY ? t.key.split(":")[1] : "", placeholder: "2330 / VOO" },
      ]),
      { id: "pct", label: "目標比例(%)", type: "number", value: t?.pct ?? "", step: "any", required: true },
    ], v => {
      const pct = +v.pct;
      if (!(pct >= 0)) return false;
      let key;
      if (isCash) key = CASH_KEY;
      else if (v.mkt === CASH_KEY) key = CASH_KEY;
      else { if (!v.sym) { toast("請輸入代號"); return false; } key = `${v.mkt}:${v.sym.toUpperCase()}`; }
      if (t) { t.key = key; t.pct = pct; }
      else {
        if (p.targets.some(x => x.key === key)) { toast("此標的已有目標"); return false; }
        p.targets.push({ key, pct });
      }
      save(); render();
    });
  },
  delTarget(el) {
    const p = activePortfolio();
    p.targets.splice(+el.dataset.i, 1); save(); render();
  },

  editTol() {
    const s = state.settings;
    openModal("偏離容忍區間", [
      { id: "abs", label: "絕對偏離(百分點)", type: "number", value: s.tolAbs, step: "any" },
      { id: "rel", label: "相對偏離(%)", type: "number", value: s.tolRel, step: "any",
        hint: "兩者同時超過才警示。例:目標 5% 的部位,絕對 ±2 點、相對 ±25% 表示低於 3.75% 或高於 7% 才警示" },
    ], v => { s.tolAbs = +v.abs || 2; s.tolRel = +v.rel || 25; save(); render(); });
  },
  toggleOddLot() { state.settings.allowOddLot = !state.settings.allowOddLot; save(); render(); },
  editFees() {
    const s = state.settings;
    openModal("交易費率(%)", [
      { id: "ftw", label: "台股手續費", type: "number", value: s.feeTW, step: "any" },
      { id: "ttw", label: "台股證交稅(賣出)", type: "number", value: s.taxTW, step: "any" },
      { id: "fus", label: "複委託手續費", type: "number", value: s.feeUS, step: "any", hint: "依你的券商實際費率調整" },
    ], v => { s.feeTW = +v.ftw; s.taxTW = +v.ttw; s.feeUS = +v.fus; save(); render(); });
  },
  editFx(el) {
    const cur = el.dataset.cur;
    openModal(`${cur}/TWD 匯率`, [
      { id: "rate", label: "1 " + cur + " = ? TWD", type: "number", value: resolveFx(cur).rate, step: "any", required: true },
    ], v => {
      state.fxManual[cur] = { rate: +v.rate, at: new Date().toISOString() };
      save(); render(); toast("匯率已更新");
    });
  },

  copySymbols() {
    const tw = new Set(), us = new Set();
    for (const pf of state.portfolios) for (const pos of pf.positions) {
      if (pos.market === "TW") tw.add(pos.symbol);
      else if (pos.market === "US") us.add(pos.symbol.toUpperCase());
    }
    const json = JSON.stringify({
      "_說明": "要自動抓價的代號清單。台股放 tw(上市與上櫃皆可),美股放 us。修改後 push,下次排程或手動觸發 Actions 即生效。",
      tw: [...tw].sort(), us: [...us].sort(),
    }, null, 2);
    navigator.clipboard.writeText(json)
      .then(() => toast("已複製,貼到 GitHub 的 data/symbols.json"))
      .catch(() => { openModal("複製失敗,請手動複製以下內容", [], () => {}, "關閉");
        document.getElementById("modalBody").innerHTML = `<pre style="font-size:12px;white-space:pre-wrap;font-family:var(--mono)">${esc(json)}</pre>`; });
  },
  async refreshFx() {
    try { await refreshFxLive(); render(); toast("匯率已更新"); }
    catch { toast("匯率查詢失敗,請手動輸入"); }
  },
  exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio-watch-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  },
  importData() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "application/json";
    input.onchange = () => {
      const f = input.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          if (!data.portfolios) throw 0;
          state = data; state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
          save(); render(); renderSwitcher(); toast("匯入完成");
        } catch { toast("檔案格式不正確"); }
      };
      r.readAsText(f);
    };
    input.click();
  },
  resetData() {
    confirmDanger("將清除所有組合與持倉資料,且無法復原。確定?", () => {
      state = defaultState(); save(); render(); renderSwitcher(); toast("已清除");
    });
  },
};

/** 自動補查:持有但缺報價或報價過期(>5天)的標的,靜默用即時查詢補上 */
async function autoBackfillPrices() {
  const seen = new Set(), tasks = [];
  for (const pf of state.portfolios) for (const pos of pf.positions) {
    if (pos.market !== "TW" && pos.market !== "US") continue;
    const key = `${pos.market}:${pos.symbol}`;
    if (seen.has(key)) continue; seen.add(key);
    const pr = resolvePrice(key);
    if (!pr || staleDays(pr.at) > 5) tasks.push({ key, mkt: pos.market, sym: pos.symbol, pos });
  }
  let ok = 0;
  for (const t of tasks.slice(0, 12)) { // 單次最多補 12 檔,避免打爆免費 API
    try {
      const r = await lookupAsset(t.mkt, t.sym);
      if (r.price != null) { state.manualPrices[t.key] = { price: r.price, at: new Date().toISOString() }; ok++; }
      if (r.name) for (const pf of state.portfolios) for (const p2 of pf.positions) {
        if (`${p2.market}:${p2.symbol}` === t.key && !p2.name) p2.name = r.name;
      }
    } catch {}
  }
  if (ok) { save(); render(); toast(`已自動補查 ${ok} 檔最新報價`); }
}

/* ---------------- 路由與渲染 ---------------- */
const VIEWS = { overview: vOverview, dashboard: vDashboard, rebalance: vRebalance, holdings: vHoldings, targets: vTargets, settings: vSettings };

function render() {
  document.getElementById("view").innerHTML = VIEWS[currentView]();
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === currentView));
}
function switchView(v) { currentView = v; render(); window.scrollTo(0, 0); }

function renderSwitcher() {
  const sel = document.getElementById("portfolioSwitcher");
  sel.innerHTML = state.portfolios.map(p =>
    `<option value="${p.id}" ${p.id === state.activePortfolioId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

/* ---------------- 事件 ---------------- */
document.addEventListener("click", e => {
  const modeBtn = e.target.closest("[data-mode]");
  if (modeBtn) { rebalanceMode = modeBtn.dataset.mode; render(); return; }
  const el = e.target.closest("[data-act]");
  if (el && actions[el.dataset.act]) { e.stopPropagation(); actions[el.dataset.act](el); return; }
  const tab = e.target.closest(".tab");
  if (tab) switchView(tab.dataset.view);
});
document.getElementById("portfolioSwitcher").addEventListener("change", e => {
  state.activePortfolioId = e.target.value; save(); render();
});
document.getElementById("btnRefreshPrices").addEventListener("click", () => loadFeed(true));

/* ---------------- 啟動 ---------------- */
load();
renderSwitcher();
render();
loadFeed(false).then(() => autoBackfillPrices());
