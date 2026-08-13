/* ============================================================
   Portfolio Watch — 核心策略層:建倉排程 + 偏離帶再平衡
   與既有的「目標／再平衡」(個股/持倉層)是兩套獨立系統、互不合併。
   核心範圍 = 使用者於設定頁勾選的既有組合(corePortfolioIds),
   不逐檔標記排除;tickerMap 只用來把核心組合內的持股再細分到資產塊。
   本檔不修改 app.js,只透過 VIEWS / actions 掛載進既有系統。
   資料僅存 localStorage,不上傳任何伺服器。
   ============================================================ */
"use strict";

/* ---------------- 常數與預設值 ---------------- */
const AP_LS_PLAN = "pw_allocation_plan_v1";
const AP_LS_SCHEDULE = "pw_build_schedule_v1";
const AP_LS_SNAP = "pw_price_snap_v1";

const AP_PRESETS = {
  "703": [["core", "原型", 0.70], ["leverage", "正二", 0],    ["cash", "現金", 0.30]],
  "433": [["core", "原型", 0.40], ["leverage", "正二", 0.30], ["cash", "現金", 0.30]],
  "613": [["core", "原型", 0.60], ["leverage", "正二", 0.10], ["cash", "現金", 0.30]],
  "442": [["core", "原型", 0.40], ["leverage", "正二", 0.40], ["cash", "現金", 0.20]],
  "505": [["core", "原型", 0.50], ["leverage", "正二", 0],    ["cash", "現金", 0.50]],
};

function apDefaultPlan() {
  return {
    version: 1,
    corePortfolioIds: [],
    framework: { presetName: "613", sleeves: AP_PRESETS["613"].map(([id, label, target]) => ({ id, label, target })) },
    bandWidth: 0.05,
    tickerMap: {},
    cashSleeveId: "cash",
    manualCash: [],
    lastRebalanceDate: null,
  };
}
function apLoadPlan() {
  try {
    const raw = localStorage.getItem(AP_LS_PLAN);
    if (!raw) return apDefaultPlan();
    const saved = JSON.parse(raw);
    const base = apDefaultPlan();
    return { ...base, ...saved, framework: saved.framework || base.framework };
  } catch { return apDefaultPlan(); }
}
function apSavePlan(plan) { localStorage.setItem(AP_LS_PLAN, JSON.stringify(plan)); }

function apDefaultSchedule() {
  return { version: 1, enabled: true, startDate: new Date().toISOString().slice(0, 10), plans: [] };
}
function apLoadSchedule() {
  try {
    const raw = localStorage.getItem(AP_LS_SCHEDULE);
    if (!raw) return apDefaultSchedule();
    return { ...apDefaultSchedule(), ...JSON.parse(raw) };
  } catch { return apDefaultSchedule(); }
}
function apSaveSchedule(schedule) { localStorage.setItem(AP_LS_SCHEDULE, JSON.stringify(schedule)); }

/** 讓 schedule.plans 跟目前框架的資產塊對齊(新增塊補預設列、刪除的塊移除對應列) */
function apGetSyncedSchedule(plan) {
  const schedule = apLoadSchedule();
  const before = JSON.stringify(schedule.plans);
  const ids = plan.framework.sleeves.map(s => s.id);
  const existing = new Map(schedule.plans.map(pl => [pl.sleeveId, pl]));
  schedule.plans = ids.map(id => existing.get(id) || {
    sleeveId: id, mode: "lumpsum", done: false,
    months: 12, amountPerMonth: 0, completedBatches: 0, dipRule: null,
  });
  if (JSON.stringify(schedule.plans) !== before) apSaveSchedule(schedule);
  return schedule;
}

/* ---------------- 共用小工具 ---------------- */
/** 依代號在「所有組合」(不限目前作用中的組合)裡找自訂名稱,避免核心組合不是目前作用組合時抓不到名稱 */
function apAssetLabel(key) {
  const [mkt, sym] = key.split(":");
  for (const p of state.portfolios) {
    const pos = p.positions.find(x => x.market === mkt && x.symbol === sym);
    if (pos?.name) return { name: pos.name, sym: `${MARKETS[mkt]?.label || mkt} ${sym}` };
  }
  const fd = feedPrice(key);
  return { name: fd?.name || state.assetNames?.[key] || sym, sym: `${MARKETS[mkt]?.label || mkt} ${sym}` };
}
function apCorePortfolios(plan) { return state.portfolios.filter(p => plan.corePortfolioIds.includes(p.id)); }
function apTargetSum(plan) { return plan.framework.sleeves.reduce((a, s) => a + (+s.target || 0), 0); }
/** 由某個 ISO 日期到今天,經過的整月數(可為負,代表日期在未來) */
function apElapsedMonths(startISO) {
  const start = new Date(startISO + "T00:00:00");
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return months;
}
function apScopeBanner(kind) {
  const detail = kind === "build" ? "建倉排程" : "資產塊偏離帶";
  return `<div class="scope-banner">🧭 <span><b>核心策略層</b>・${detail} — 只計算「設定」頁勾選的核心組合,依資產塊(原型/正二/現金…)監控,不逐檔算單、不產生下單建議。跟「儀表板」「再平衡」的<b>個股／持倉層</b>是分開的兩套系統,互不影響。</span></div>`;
}

/* ---------------- 資產塊現值計算(§7.2) ---------------- */
function apComputeSleeves(plan) {
  const sleeves = plan.framework.sleeves;
  const sleeveIds = new Set(sleeves.map(s => s.id));
  const cores = apCorePortfolios(plan);
  const sleeveValue = {}, sleeveMembers = {};
  sleeves.forEach(s => { sleeveValue[s.id] = 0; sleeveMembers[s.id] = []; });
  const missingPrice = [], unclassified = [];
  const posByKey = new Map();

  for (const p of cores) {
    for (const pos of p.positions) {
      const key = `${pos.market}:${pos.symbol}`;
      const pr = resolvePrice(key);
      const mkt = MARKETS[pos.market] || MARKETS.OTHER;
      const price = pr ? pr.price : 0;
      if (!pr) missingPrice.push(key);
      const value = toBase(pos.qty * price, mkt.currency);
      const cur = posByKey.get(key) || { key, value: 0, qty: 0 };
      cur.value += value; cur.qty += pos.qty;
      posByKey.set(key, cur);
    }
  }
  let cashTotal = 0;
  for (const p of cores) {
    for (const acc of p.accounts) {
      for (const [cur, amt] of Object.entries(acc.cash || {})) cashTotal += toBase(amt || 0, cur);
    }
  }
  if (plan.cashSleeveId && sleeveIds.has(plan.cashSleeveId) && cashTotal !== 0) {
    sleeveValue[plan.cashSleeveId] += cashTotal;
    sleeveMembers[plan.cashSleeveId].push({ key: "__cash__", name: "帳戶現金", value: cashTotal });
  }
  for (const mc of plan.manualCash) {
    if (sleeveIds.has(mc.sleeveId)) {
      sleeveValue[mc.sleeveId] += mc.amount;
      sleeveMembers[mc.sleeveId].push({ key: "mc:" + mc.id, name: mc.label, value: mc.amount });
    }
  }
  for (const [key, agg] of posByKey) {
    const assign = plan.tickerMap[key];
    if (assign === "excluded") continue;
    if (!assign || !sleeveIds.has(assign)) { unclassified.push(key); continue; }
    sleeveValue[assign] += agg.value;
    sleeveMembers[assign].push({ key, name: apAssetLabel(key).name, value: agg.value });
  }

  const coreTotal = Object.values(sleeveValue).reduce((a, b) => a + b, 0);
  const rows = sleeves.map(s => {
    const value = sleeveValue[s.id] || 0;
    const currentPct = coreTotal > 0 ? value / coreTotal : 0;
    const dev = currentPct - s.target;
    const band = plan.bandWidth;
    let status = "in";
    if (dev > band) status = "over";
    else if (dev < -band) status = "under";
    return { sleeve: s, value, currentPct, dev, status, members: sleeveMembers[s.id].sort((a, b) => b.value - a.value) };
  });
  return {
    coreTotal, rows,
    missingPrice: [...new Set(missingPrice)],
    unclassified: [...new Set(unclassified)],
  };
}

/* ---------------- 回檔加碼:前端逐日價格快照(§6.3) ---------------- */
/** 沒有歷史報價來源,靠每次開 app 時偵測 feed 日期是否換日,滾動保留「前一個交易日」的價格做比較 */
function apDipInfo(key) {
  const pr = feedPrice(key) || resolvePrice(key);
  if (!pr || !pr.price) return null;
  const today = (feed?.updatedAt || pr.at || "").slice(0, 10);
  if (!today) return null;
  let snap = {};
  try { snap = JSON.parse(localStorage.getItem(AP_LS_SNAP) || "{}"); } catch {}
  let e = snap[key];
  if (!e) {
    e = { curDate: today, curPrice: pr.price, prevDate: null, prevPrice: null };
    snap[key] = e; localStorage.setItem(AP_LS_SNAP, JSON.stringify(snap));
  } else if (e.curDate !== today) {
    e.prevDate = e.curDate; e.prevPrice = e.curPrice;
    e.curDate = today; e.curPrice = pr.price;
    localStorage.setItem(AP_LS_SNAP, JSON.stringify(snap));
  }
  if (e.prevPrice == null || e.prevPrice <= 0) return null;
  const dropPct = (e.prevPrice - pr.price) / e.prevPrice;
  return { dropPct, prevPrice: e.prevPrice, prevDate: e.prevDate, curPrice: pr.price, curDate: today };
}

/* ---------------- 建倉排程計算(§6.2) ---------------- */
function apComputeSchedule(plan, schedule) {
  const sMap = new Map(plan.framework.sleeves.map(s => [s.id, s]));
  const sleeveVals = apComputeSleeves(plan);
  const rowsBySleeve = new Map(sleeveVals.rows.map(r => [r.sleeve.id, r]));
  let dueThisMonth = 0;
  const items = schedule.plans.map(pl => {
    const sleeve = sMap.get(pl.sleeveId);
    if (!sleeve) return null;
    let progressPct, outstandingAmt = 0, statusText;
    if (pl.mode === "lumpsum") {
      progressPct = pl.done ? 1 : 0;
      statusText = pl.done ? "一次到位 ✓" : "尚未投入";
    } else {
      const elapsed = apElapsedMonths(schedule.startDate);
      const dueBatches = Math.max(0, Math.min(elapsed + 1, pl.months));
      const outstanding = Math.max(0, dueBatches - pl.completedBatches);
      outstandingAmt = outstanding * pl.amountPerMonth;
      dueThisMonth += outstandingAmt;
      progressPct = pl.months > 0 ? pl.completedBatches / pl.months : 0;
      statusText = `${pl.completedBatches} / ${pl.months} 批`;
    }
    let dip = null;
    if (pl.dipRule?.enabled) {
      const row = rowsBySleeve.get(pl.sleeveId);
      const top = row?.members?.find(m => !m.key.startsWith("mc:") && m.key !== "__cash__");
      if (top) {
        const info = apDipInfo(top.key);
        if (info && info.dropPct >= pl.dipRule.dropPct) dip = { ...info, name: top.name };
      }
    }
    return { plan: pl, sleeve, progressPct, statusText, outstandingAmt, dip };
  }).filter(Boolean);
  const allDone = items.length > 0 && items.every(it => it.plan.mode === "lumpsum" ? it.plan.done : it.plan.completedBatches >= it.plan.months);
  return { items, dueThisMonth, allDone };
}

/* ---------------- 視圖:建倉排程 ---------------- */
let apScheduleExpanded = false;

function vBuildSchedule() {
  const plan = apLoadPlan();
  let html = apScopeBanner("build");
  if (!plan.corePortfolioIds.length) {
    return html + `<div class="empty">尚未設定核心組合來源。請先到「設定」頁的「核心策略層」區塊,勾選要納入建倉排程的組合。</div>`;
  }
  const sum = apTargetSum(plan);
  if (Math.abs(sum - 1) > 0.001) {
    return html + `<div class="alert-strip gold">配置框架目標合計 ${fmtPct(sum * 100)},不是 100%。請先到「設定」頁調整,建倉排程暫不計算。</div>`;
  }
  const schedule = apGetSyncedSchedule(plan);
  if (!schedule.enabled) {
    return html + `<div class="empty">建倉排程尚未啟用。請到「設定」頁的「偏離帶與建倉參數」區塊開啟。</div>`;
  }
  const c = apComputeSchedule(plan, schedule);
  if (c.allDone && !apScheduleExpanded) {
    return html + `<div class="card" style="text-align:center;cursor:pointer" data-act="apToggleScheduleExpand">
      <div style="font-weight:700;color:var(--under)">✓ 建倉排程已全部完成</div>
      <div class="inline-note">點擊展開查看歷史紀錄</div>
    </div>`;
  }
  if (c.allDone) {
    html += `<div class="section-title"><span>建倉排程(已完成)</span>
      <button class="btn small" data-act="apToggleScheduleExpand">收合</button></div>`;
  } else {
    html += `<div class="card">
      <div style="font-size:12px;color:var(--muted)">本月待投</div>
      <div class="num" style="font-size:22px;font-weight:700;color:var(--gold)">${fmtMoney(c.dueThisMonth)}</div>
      <div class="inline-note">${esc(schedule.startDate)} 起算</div>
    </div>`;
  }
  html += `<div class="card flat">` + c.items.map(it => {
    const pct = Math.min(100, it.progressPct * 100);
    const isLumpsum = it.plan.mode === "lumpsum";
    const btn = isLumpsum
      ? `<button class="btn small" data-act="apToggleLumpsum" data-sleeve="${esc(it.plan.sleeveId)}">${it.plan.done ? "取消完成" : "標記完成"}</button>`
      : `<button class="btn small" data-act="apCompleteBatch" data-sleeve="${esc(it.plan.sleeveId)}" ${it.plan.completedBatches >= it.plan.months ? "disabled" : ""}>完成本月</button>`;
    return `<div class="bs-row">
      <div class="bs-head"><span class="bs-name">${esc(it.sleeve.label)}</span><span class="bs-meta num">${esc(it.statusText)}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${!isLumpsum && it.outstandingAmt > 0 ? `<div class="bs-meta num" style="margin-top:6px">本月待投 ${fmtMoney(it.outstandingAmt)}</div>` : ""}
      ${it.dip ? `<div class="bs-dip">🔻 ${esc(it.dip.name)} 自 ${esc(it.dip.prevDate)} 以來下跌 ${fmtPct(it.dip.dropPct * 100)},可考慮提前投一批(僅提示,不會自動計入進度)</div>` : ""}
      <div class="row-actions" style="margin-top:8px">${btn}</div>
    </div>`;
  }).join("") + `</div>`;
  return html;
}

/* ---------------- 視圖:偏離帶再平衡儀表板 ---------------- */
function vRebalanceBand() {
  const plan = apLoadPlan();
  let html = apScopeBanner("band");
  if (!plan.corePortfolioIds.length) {
    return html + `<div class="empty">尚未設定核心組合來源。請先到「設定」頁的「核心策略層」區塊,勾選要納入偏離帶監控的組合。</div>`;
  }
  const sum = apTargetSum(plan);
  if (Math.abs(sum - 1) > 0.001) {
    return html + `<div class="alert-strip gold">配置框架目標合計 ${fmtPct(sum * 100)},不是 100%。請先到「設定」頁調整。</div>`;
  }
  const c = apComputeSleeves(plan);
  if (c.coreTotal <= 0) {
    return html + `<div class="empty">核心組合目前尚無市值(可能還沒建倉,或報價尚未載入)。請先於「設定」頁完成分層對應。</div>`;
  }
  if (c.missingPrice.length) {
    html += `<div class="alert-strip gold">⚠ ${c.missingPrice.map(k => esc(apAssetLabel(k).sym)).join("、")} 缺少價格,先以 0 計入市值。</div>`;
  }
  if (c.unclassified.length) {
    html += `<div class="alert-strip gold">📋 核心組合內有 ${c.unclassified.length} 檔尚未分類到資產塊:${c.unclassified.map(k => esc(apAssetLabel(k).name)).join("、")}。請至「設定」頁指派。</div>`;
  }
  const monthsSince = plan.lastRebalanceDate ? apElapsedMonths(plan.lastRebalanceDate) : null;
  if (monthsSince !== null && monthsSince >= 12) {
    html += `<div class="alert-strip gold" style="align-items:center;justify-content:space-between">
      <span>📅 距上次再平衡已 ${monthsSince} 個月,建議進行年度保底檢查。</span>
      <button class="btn small" data-act="apMarkRebalanced" style="flex:0 0 auto">已完成再平衡</button>
    </div>`;
  }
  html += `<div class="card">
    <div style="font-size:12px;color:var(--muted)">核心資產總市值</div>
    <div class="num" style="font-size:22px;font-weight:700">${fmtMoney(c.coreTotal)}</div>
    <div class="inline-note">${monthsSince !== null ? `距上次再平衡 ${monthsSince} 個月` : "尚未記錄過再平衡日期"}
      ${monthsSince === null || monthsSince < 12 ? `<button class="btn small" data-act="apMarkRebalanced" style="margin-left:8px">標記已完成再平衡</button>` : ""}</div>
  </div>`;

  const bandW = plan.bandWidth;
  const win = Math.max(bandW * 3, 0.01);
  html += `<div class="card flat">` + c.rows.map(r => {
    const lo = Math.max(0, r.sleeve.target - win), hi = Math.min(1, r.sleeve.target + win);
    const range = (hi - lo) || 1;
    const bandLoPct = Math.max(0, (r.sleeve.target - bandW - lo) / range * 100);
    const bandWidthPct = Math.min(100 - bandLoPct, (bandW * 2) / range * 100);
    const targetPct = Math.min(100, Math.max(0, (r.sleeve.target - lo) / range * 100));
    const dotPct = Math.min(100, Math.max(0, (r.currentPct - lo) / range * 100));
    const statusLabel = r.status === "in" ? "在帶內 ✓" : r.status === "over" ? "穿上緣" : "穿下緣";
    let actionHtml = "";
    if (r.status === "over") {
      const trim = (r.currentPct - r.sleeve.target) * c.coreTotal;
      actionHtml = `<div class="band-action">可執行:修剪鎖利約 <b>${fmtMoney(trim)}</b></div>`;
    } else if (r.status === "under") {
      const need = (r.sleeve.target - r.currentPct) * c.coreTotal;
      actionHtml = `<div class="band-action">僅提醒:可選擇不接刀。若要拉回需買進約 ${fmtMoney(need)}(非強制)</div>`;
    }
    const membersHtml = r.members.length > 1
      ? `<div class="inline-note">內部持股(僅供參考):${r.members.map(m => `${esc(m.name)} ${fmtPct(r.value > 0 ? m.value / r.value * 100 : 0)}`).join("、")}</div>`
      : "";
    return `<div class="ruler-row">
      <div class="ruler-head">
        <span class="ruler-name">${esc(r.sleeve.label)}</span>
        <span class="band-status ${r.status}">${statusLabel}</span>
      </div>
      <div class="ruler-meta">
        <span>目前 ${fmtPct(r.currentPct * 100)} / 目標 ${fmtPct(r.sleeve.target * 100)}</span>
        <span class="num">${fmtMoney(r.value)}</span>
      </div>
      <div class="ruler-track">
        <div class="ruler-band" style="left:${bandLoPct}%;width:${bandWidthPct}%"></div>
        <div class="ruler-target" style="left:${targetPct}%"></div>
        <div class="ruler-dot band-${r.status}" style="left:${dotPct}%"></div>
      </div>
      ${actionHtml}
      ${membersHtml}
    </div>`;
  }).join("") + `</div>`;
  return html;
}

/* ---------------- 設定頁擴充 ---------------- */
function apSettingsSection() {
  const plan = apLoadPlan();
  let html = `<div class="section-title"><span>核心策略層 — 核心組合來源</span></div>`;
  html += `<div class="card"><div class="check-list">` + state.portfolios.map(p => `
      <label class="check-row">
        <input type="checkbox" data-act="apToggleCore" data-id="${p.id}" ${plan.corePortfolioIds.includes(p.id) ? "checked" : ""}>
        <span>${esc(p.name)}${p.type === "satellite" ? ` <span class="badge" style="color:var(--ok);border-color:var(--ok)">衛星</span>` : ""}</span>
      </label>`).join("") + `</div>
    <p class="inline-note">勾選要納入「建倉排程」與「偏離帶再平衡」計算的組合。未勾選的組合(例如衛星股組合)不計入核心,也不影響它原本的「目標／再平衡」功能。</p>
  </div>`;

  const sum = apTargetSum(plan);
  html += `<div class="section-title"><span>配置框架(合計 <span class="num" style="color:${Math.abs(sum - 1) < 0.001 ? "var(--under)" : "var(--over)"}">${fmtPct(sum * 100)}</span>)</span>
    <button class="btn small" data-act="apChoosePreset">選預設</button></div>`;
  html += `<div class="card flat">` + plan.framework.sleeves.map(s => `
    <div class="list-row">
      <div class="list-main"><div class="list-title">${esc(s.label)}</div></div>
      <div class="list-val"><div class="v num">${fmtPct(s.target * 100)}</div></div>
      <div class="row-actions">
        <button class="btn small" data-act="apEditSleeve" data-id="${s.id}">編</button>
        <button class="btn small danger" data-act="apDelSleeve" data-id="${s.id}">刪</button>
      </div>
    </div>`).join("") + `<button class="btn-add" data-act="apAddSleeve">+ 新增資產塊</button></div>`;
  if (Math.abs(sum - 1) > 0.001) {
    html += `<div class="alert-strip gold">目標合計需為 100%,目前${sum > 1 ? "超出" : "尚缺"} ${fmtPct(Math.abs(1 - sum) * 100)}。合計未達 100% 前,「建倉」與「核心策略」分頁暫不計算(可以先存,不會擋存檔)。</div>`;
  }

  html += `<div class="section-title"><span>標的分層對應</span></div>`;
  const cores = apCorePortfolios(plan);
  const keys = new Map();
  for (const p of cores) for (const pos of p.positions) {
    const key = `${pos.market}:${pos.symbol}`;
    if (!keys.has(key)) keys.set(key, apAssetLabel(key));
  }
  if (!cores.length) {
    html += `<div class="card"><div class="empty">請先勾選核心組合來源。</div></div>`;
  } else if (!keys.size) {
    html += `<div class="card"><div class="empty">核心組合內尚無持股。</div></div>`;
  } else {
    html += `<div class="card flat">` + [...keys.entries()].map(([key, lbl]) => {
      const assign = plan.tickerMap[key];
      const sleeve = plan.framework.sleeves.find(s => s.id === assign);
      const label = sleeve ? sleeve.label : (assign === "excluded" ? "排除" : "未分類");
      const badgeCls = !assign ? "alert" : (assign === "excluded" ? "" : "gold");
      return `<div class="list-row">
        <div class="list-main"><div class="list-title">${esc(lbl.name)} <span class="sym num" style="color:var(--muted);font-size:12px">${esc(lbl.sym)}</span>
          <span class="badge ${badgeCls}">${esc(label)}</span></div></div>
        <div class="row-actions"><button class="btn small" data-act="apAssignTicker" data-key="${esc(key)}">指派</button></div>
      </div>`;
    }).join("") + `</div>`;
  }

  const cashSleeve = plan.framework.sleeves.find(s => s.id === plan.cashSleeveId);
  html += `<div class="section-title"><span>現金</span></div>`;
  html += `<div class="card flat">
    <div class="list-row"><div class="list-main"><div class="list-title">帳戶現金歸類到</div>
      <div class="list-sub">核心組合裡各帳戶的現金會自動加總,全部算進這個資產塊</div></div>
      <button class="btn small" data-act="apSetCashSleeve">${cashSleeve ? esc(cashSleeve.label) : "尚未指定"}</button></div>
  </div>`;
  html += `<div class="section-title"><span>手動現金(定存等無報價資產)</span>
    <button class="btn small" data-act="apAddManualCash">+ 新增</button></div>`;
  html += `<div class="card flat">` + (plan.manualCash.length ? plan.manualCash.map(mc => {
    const sleeve = plan.framework.sleeves.find(s => s.id === mc.sleeveId);
    return `<div class="list-row">
      <div class="list-main"><div class="list-title">${esc(mc.label)}</div><div class="list-sub">歸類:${esc(sleeve?.label || "未分類")}</div></div>
      <div class="list-val"><div class="v num">${fmtMoney(mc.amount)}</div></div>
      <div class="row-actions">
        <button class="btn small" data-act="apEditManualCash" data-id="${mc.id}">編</button>
        <button class="btn small danger" data-act="apDelManualCash" data-id="${mc.id}">刪</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">尚無手動現金項目</div>`) + `</div>`;

  html += `<div class="section-title"><span>偏離帶與建倉參數</span></div>`;
  const schedule = apGetSyncedSchedule(plan);
  html += `<div class="card flat">
    <div class="list-row"><div class="list-main"><div class="list-title">帶寬</div><div class="list-sub">目標 ± ${fmtPct(plan.bandWidth * 100)}</div></div>
      <button class="btn small" data-act="apEditBandWidth">調整</button></div>
    <div class="list-row"><div class="list-main"><div class="list-title">建倉排程</div>
      <div class="list-sub">${schedule.enabled ? "已啟用" : "未啟用"}${schedule.startDate ? `・起始 ${esc(schedule.startDate)}` : ""}</div></div>
      <button class="btn small" data-act="apEditScheduleMeta">調整</button></div>
  </div>`;
  html += `<div class="card flat">` + schedule.plans.map(pl => {
    const sleeve = plan.framework.sleeves.find(s => s.id === pl.sleeveId);
    if (!sleeve) return "";
    const modeLabel = pl.mode === "lumpsum" ? "一次到位" : `分批 ${pl.months} 期・每期 ${fmtMoney(pl.amountPerMonth)}`;
    return `<div class="list-row">
      <div class="list-main"><div class="list-title">${esc(sleeve.label)}</div>
        <div class="list-sub num">${modeLabel}${pl.mode === "dca" && pl.dipRule?.enabled ? `・回檔加碼 ≥${fmtPct(pl.dipRule.dropPct * 100)}` : ""}</div></div>
      <div class="row-actions"><button class="btn small" data-act="apEditSchedulePlan" data-sleeve="${sleeve.id}">編輯</button></div>
    </div>`;
  }).join("") + `</div>`;

  return html;
}

/* ---------------- 動作 ---------------- */
const apActions = {
  apToggleCore(el) {
    const plan = apLoadPlan();
    const id = el.dataset.id;
    if (el.checked) { if (!plan.corePortfolioIds.includes(id)) plan.corePortfolioIds.push(id); }
    else plan.corePortfolioIds = plan.corePortfolioIds.filter(x => x !== id);
    apSavePlan(plan); render();
  },
  apChoosePreset() {
    const plan = apLoadPlan();
    openModal("選擇配置框架", [
      { id: "preset", label: "預設框架", type: "select", value: plan.framework.presetName,
        options: [...Object.keys(AP_PRESETS).map(k => ({ value: k, label: `${k}(${AP_PRESETS[k].map(s => Math.round(s[2] * 100)).join("/")})` })),
                  { value: "custom", label: "自訂(不變更目前資產塊)" }] },
    ], v => {
      if (v.preset !== "custom") {
        plan.framework = { presetName: v.preset, sleeves: AP_PRESETS[v.preset].map(([id, label, target]) => ({ id, label, target })) };
      } else {
        plan.framework.presetName = "custom";
      }
      apSavePlan(plan); render(); toast("配置框架已更新");
    });
  },
  apAddSleeve() {
    const plan = apLoadPlan();
    openModal("新增資產塊", [
      { id: "label", label: "名稱", required: true, placeholder: "例:黃金" },
      { id: "target", label: "目標比例(%)", type: "number", value: 0, step: "any" },
    ], v => {
      if (!v.label) return false;
      plan.framework.sleeves.push({ id: uid(), label: v.label, target: (+v.target || 0) / 100 });
      plan.framework.presetName = "custom";
      apSavePlan(plan); render();
    });
  },
  apEditSleeve(el) {
    const plan = apLoadPlan();
    const s = plan.framework.sleeves.find(x => x.id === el.dataset.id);
    if (!s) return;
    openModal("編輯資產塊", [
      { id: "label", label: "名稱", value: s.label, required: true },
      { id: "target", label: "目標比例(%)", type: "number", value: s.target * 100, step: "any" },
    ], v => {
      s.label = v.label; s.target = (+v.target || 0) / 100;
      plan.framework.presetName = "custom";
      apSavePlan(plan); render();
    });
  },
  apDelSleeve(el) {
    const plan = apLoadPlan();
    if (plan.framework.sleeves.length <= 1) { toast("至少要保留一個資產塊"); return; }
    const id = el.dataset.id;
    confirmDanger("刪除這個資產塊?已指派到這裡的標的會變成「未分類」,現金若指定在這裡也需要重新指定。", () => {
      plan.framework.sleeves = plan.framework.sleeves.filter(s => s.id !== id);
      plan.framework.presetName = "custom";
      if (plan.cashSleeveId === id) plan.cashSleeveId = null;
      apSavePlan(plan); render();
    });
  },
  apAssignTicker(el) {
    const plan = apLoadPlan();
    const key = el.dataset.key;
    const lbl = apAssetLabel(key);
    openModal(`指派:${lbl.name}`, [
      { id: "sleeve", label: "歸類到", type: "select", value: plan.tickerMap[key] || "",
        options: [{ value: "", label: "— 請選擇 —" }, ...plan.framework.sleeves.map(s => ({ value: s.id, label: s.label })),
                  { value: "excluded", label: "排除(不計入核心)" }] },
    ], v => {
      if (!v.sleeve) return false;
      plan.tickerMap[key] = v.sleeve;
      apSavePlan(plan); render();
    });
  },
  apSetCashSleeve() {
    const plan = apLoadPlan();
    openModal("帳戶現金歸類到", [
      { id: "sleeve", label: "資產塊", type: "select", value: plan.cashSleeveId || "",
        options: plan.framework.sleeves.map(s => ({ value: s.id, label: s.label })) },
    ], v => { plan.cashSleeveId = v.sleeve; apSavePlan(plan); render(); });
  },
  apAddManualCash() {
    const plan = apLoadPlan();
    openModal("新增手動現金", [
      { id: "label", label: "名稱", required: true, placeholder: "例:台幣定存" },
      { id: "amount", label: "金額(TWD)", type: "number", value: 0, step: "any" },
      { id: "sleeve", label: "歸類到", type: "select", value: plan.cashSleeveId || plan.framework.sleeves[0]?.id,
        options: plan.framework.sleeves.map(s => ({ value: s.id, label: s.label })) },
    ], v => {
      if (!v.label) return false;
      plan.manualCash.push({ id: uid(), label: v.label, amount: Math.round(+v.amount || 0), sleeveId: v.sleeve });
      apSavePlan(plan); render();
    });
  },
  apEditManualCash(el) {
    const plan = apLoadPlan();
    const mc = plan.manualCash.find(x => x.id === el.dataset.id);
    if (!mc) return;
    openModal("編輯手動現金", [
      { id: "label", label: "名稱", value: mc.label, required: true },
      { id: "amount", label: "金額(TWD)", type: "number", value: mc.amount, step: "any" },
      { id: "sleeve", label: "歸類到", type: "select", value: mc.sleeveId,
        options: plan.framework.sleeves.map(s => ({ value: s.id, label: s.label })) },
      { id: "del", label: "刪除請輸入 DELETE", value: "", placeholder: "留空表示不刪除" },
    ], v => {
      if (v.del === "DELETE") { plan.manualCash = plan.manualCash.filter(x => x.id !== mc.id); apSavePlan(plan); render(); return; }
      mc.label = v.label; mc.amount = Math.round(+v.amount || 0); mc.sleeveId = v.sleeve;
      apSavePlan(plan); render();
    });
  },
  apDelManualCash(el) {
    const plan = apLoadPlan();
    confirmDanger("刪除這筆手動現金?", () => {
      plan.manualCash = plan.manualCash.filter(x => x.id !== el.dataset.id);
      apSavePlan(plan); render();
    });
  },
  apEditBandWidth() {
    const plan = apLoadPlan();
    openModal("調整帶寬", [
      { id: "band", label: "帶寬(百分點,例如 5 代表 ±5%)", type: "number", value: plan.bandWidth * 100, step: "any" },
    ], v => { plan.bandWidth = Math.max(0, +v.band || 0) / 100; apSavePlan(plan); render(); });
  },
  apEditScheduleMeta() {
    const plan = apLoadPlan();
    const schedule = apGetSyncedSchedule(plan);
    openModal("建倉排程設定", [
      { id: "enabled", label: "啟用建倉排程", type: "select", value: schedule.enabled ? "1" : "0",
        options: [{ value: "1", label: "啟用" }, { value: "0", label: "停用" }] },
      { id: "start", label: "起始日期", type: "date", value: schedule.startDate },
    ], v => {
      schedule.enabled = v.enabled === "1";
      schedule.startDate = v.start || schedule.startDate;
      apSaveSchedule(schedule); render();
    });
  },
  apEditSchedulePlan(el) {
    const plan = apLoadPlan();
    const schedule = apGetSyncedSchedule(plan);
    const pl = schedule.plans.find(p => p.sleeveId === el.dataset.sleeve);
    if (!pl) return;
    const sleeve = plan.framework.sleeves.find(s => s.id === pl.sleeveId);
    openModal(`建倉參數:${sleeve?.label || ""}`, [
      { id: "mode", label: "模式", type: "select", value: pl.mode,
        options: [{ value: "lumpsum", label: "一次到位" }, { value: "dca", label: "分批(DCA)" }] },
      { id: "months", label: "總期數(月,DCA 適用)", type: "number", value: pl.months || 12, step: "1" },
      { id: "amount", label: "每期金額(TWD,DCA 適用)", type: "number", value: pl.amountPerMonth || 0, step: "any" },
      { id: "dip", label: "回檔加碼提示", type: "select", value: pl.dipRule?.enabled ? "1" : "0",
        options: [{ value: "0", label: "不啟用" }, { value: "1", label: "啟用" }] },
      { id: "dipPct", label: "回檔加碼門檻(%,例如 5)", type: "number", value: pl.dipRule?.dropPct ? pl.dipRule.dropPct * 100 : 5, step: "any" },
    ], v => {
      pl.mode = v.mode;
      pl.months = Math.max(1, Math.round(+v.months || 12));
      pl.amountPerMonth = Math.max(0, +v.amount || 0);
      pl.completedBatches = Math.min(pl.completedBatches || 0, pl.months);
      pl.dipRule = v.dip === "1" ? { enabled: true, dropPct: Math.max(0, +v.dipPct || 0) / 100 } : null;
      apSaveSchedule(schedule); render(); toast("已儲存");
    });
  },
  apCompleteBatch(el) {
    const schedule = apLoadSchedule();
    const pl = schedule.plans.find(p => p.sleeveId === el.dataset.sleeve);
    if (pl && pl.completedBatches < pl.months) { pl.completedBatches++; apSaveSchedule(schedule); render(); toast("已記錄本月投入"); }
  },
  apToggleLumpsum(el) {
    const schedule = apLoadSchedule();
    const pl = schedule.plans.find(p => p.sleeveId === el.dataset.sleeve);
    if (pl) { pl.done = !pl.done; apSaveSchedule(schedule); render(); }
  },
  apToggleScheduleExpand() { apScheduleExpanded = !apScheduleExpanded; render(); },
  apMarkRebalanced() {
    const plan = apLoadPlan();
    plan.lastRebalanceDate = new Date().toISOString().slice(0, 10);
    apSavePlan(plan); render(); toast("已記錄再平衡日期");
  },
};

/* ---------------- 掛載進既有系統(不修改 app.js) ---------------- */
Object.assign(VIEWS, { apBuild: vBuildSchedule, apBand: vRebalanceBand });
Object.assign(actions, apActions);

const apOldScopeBanner = `<div class="scope-banner">📐 <span><b>個股／持倉層</b> — 依「目標」頁逐檔設定的門檻精算,含下單建議與費用試算。核心資產塊的大方向監控請看「核心策略」與「建倉」分頁。</span></div>`;
const apOrigDashboard = VIEWS.dashboard, apOrigRebalance = VIEWS.rebalance, apOrigSettings = VIEWS.settings;
VIEWS.dashboard = () => apOldScopeBanner + apOrigDashboard();
VIEWS.rebalance = () => apOldScopeBanner + apOrigRebalance();
VIEWS.settings = () => apOrigSettings() + apSettingsSection();

render();
