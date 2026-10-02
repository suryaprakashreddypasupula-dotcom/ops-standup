/* Ops Standup shell.
 *
 * Static page. Reads one night's "Ops Standup" Google Sheet with the signed-in
 * user's own Google credentials (Sheets API v4) and renders:
 *   page 1  Ops Summary            — same columns as the Sheet + a Notes column
 *   page 2  Delinquency by Station — same columns as the Sheet; every number
 *           opens the POs behind it (from the "Delinquency Detail" tab), each PO
 *           links to its workbench, and notes can be written per PO or per row.
 * Notes are appended to the "Notes" tab of the SAME Sheet, so they belong to
 * that night's pack only. Nothing is stored on this site or in this repo.
 */
(function () {
  "use strict";

  const CFG = window.OPS_STANDUP_CONFIG || {};
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
  const SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" ");
  const LS_SHEET = "ops-standup:lastSheet";
  const LS_HINT = "ops-standup:loginHint";

  const NOTES_TAB = "Notes";
  const NOTES_HEADER = ["ts", "user", "page", "level", "factory", "station_group", "status", "bucket", "po_number", "note"];

  // Delinquency grid columns → how to pick rows from Delinquency Detail.
  const WIP_FILTERS = {
    "wip": () => true,
    "customer_overdue": (d) => isTrue(d.customer_overdue),
    "Step overdue": (d) => d.classification === "OVERDUE",
    "due_today": (d) => d.classification === "DUE_TODAY",
    "on_track": (d) => d.classification === "ON_TRACK",
    "no_date": (d) => d.classification === "NO_DATE",
  };
  const EVENT_COLS = new Set(["completed_yesterday", "completed_2_days_ago", "rejected_yesterday", "rejected_2_days_ago"]);
  const COL_LABELS = {
    "wip": "WIP", "customer_overdue": "Customer overdue", "Step overdue": "Step overdue",
    "due_today": "Due today", "on_track": "On track", "completed_yesterday": "Completed yesterday",
    "completed_2_days_ago": "Completed 2 days ago", "rejected_yesterday": "Rejected yesterday",
    "rejected_2_days_ago": "Rejected 2 days ago",
  };

  const state = {
    token: null, tokenExp: 0, tokenClient: null,
    user: "", sheetId: "", title: "", tabs: [],
    summary: [], summaryCols: [],
    delinquency: [], delinquencyCols: [],
    detail: [], notes: [],
    orders: [],
    page: "summary",
  };

  const $ = (id) => document.getElementById(id);

  // ───────────────────────── helpers ─────────────────────────
  function isTrue(v) { return v === true || String(v).trim().toUpperCase() === "TRUE" || v === 1 || v === "1"; }
  function num(v) { const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function toast(msg, isErr) {
    const t = $("toast"); t.textContent = msg; t.className = "toast" + (isErr ? " error" : ""); t.hidden = false;
    clearTimeout(toast._h); toast._h = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
  }
  function parseSheetId(s) {
    s = String(s || "").trim();
    const m = s.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
    return "";
  }
  function toObjects(values) {
    if (!values || !values.length) return { cols: [], rows: [] };
    const cols = values[0].map((c) => String(c == null ? "" : c).trim());
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i]; if (!r || r.every((v) => v === "" || v == null)) continue;
      const o = {}; cols.forEach((c, j) => { o[c] = r[j] == null ? "" : r[j]; }); rows.push(o);
    }
    return { cols: cols.filter((c) => c), rows };
  }
  function quoteTab(name) { return "'" + name.replace(/'/g, "''") + "'"; }
  function findTab(suffix) { return state.tabs.find((t) => t === suffix) || state.tabs.find((t) => t.endsWith(" " + suffix)); }
  function fmtTs(ts) {
    const d = new Date(ts); if (isNaN(d)) return String(ts);
    return d.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function shortUser(u) { return String(u || "").split("@")[0]; }

  // Grid display_status → raw status literal used by completed_* / rejected_* rows
  // (mirrors the LEFT JOIN CASEs in Delinquency by Station.sql).
  function baseStatus(row) {
    const ds = String(row.status || ""), sg = String(row.station_group || "");
    if (sg === "Printing") return ds.split(" — ")[0];
    if (["Foot Model Design", "Insole Design", "Validation Complete", "Parked — Abandoned"].includes(ds)) return "DRAFT";
    if (ds === "Needs Shipping") return "NEEDS_SHIPPING";
    if (ds === "Needs Shoes") return "NEEDS_MATCHING";
    if (ds === "Awaiting Shipment") return "AWAITING_SHIPMENT";
    if (ds.startsWith("Anodyne Factory")) return "TOE_FILLER";
    return ds;
  }

  // ───────────────────────── auth ─────────────────────────
  function gisReady() { return !!(window.google && google.accounts && google.accounts.oauth2); }

  function requestToken(interactive) {
    return new Promise((resolve, reject) => {
      if (state.demo) { state.token = "demo"; state.tokenExp = Date.now() + 3.6e6; return resolve(state.token); }
      if (!gisReady()) return reject(new Error("Google sign-in library not loaded yet. Try again in a second."));
      if (!CFG.GOOGLE_CLIENT_ID) return reject(new Error("GOOGLE_CLIENT_ID is not set in config.js"));
      if (!state.tokenClient) {
        state.tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CFG.GOOGLE_CLIENT_ID,
          scope: SCOPES,
          hd: CFG.HOSTED_DOMAIN || undefined,
          callback: () => {},
        });
      }
      state.tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        const granted = String(resp.scope || "");
        if (granted && !granted.includes("https://www.googleapis.com/auth/spreadsheets")) {
          state.token = null;
          return reject(new Error("Google signed you in without Sheets access. Add the spreadsheets scope under Data Access, then sign in again."));
        }
        if (granted && !granted.includes("https://www.googleapis.com/auth/drive.metadata.readonly")) {
          state.token = null;
          return reject(new Error("Google signed you in without Drive access. Under Data Access, add https://www.googleapis.com/auth/drive.metadata.readonly and sign in again."));
        }
        state.token = resp.access_token;
        state.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        resolve(state.token);
      };
      state.tokenClient.error_callback = (e) => reject(new Error(e && e.message ? e.message : "Sign-in was closed"));
      // Empty prompt re-prompts only when a new scope (Drive) has not been
      // granted yet. Returning visitors are not asked every morning.
      const login_hint = localStorage.getItem(LS_HINT) || undefined;
      state.tokenClient.requestAccessToken({ prompt: "", login_hint });
    });
  }

  async function ensureToken() {
    if (state.token && Date.now() < state.tokenExp) return state.token;
    return requestToken(false);
  }

  async function api(url, opts, retry = true) {
    if (state.demo) return window.OPS_STANDUP_DEMO.handle(url, opts);
    const token = await ensureToken();
    const res = await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: "Bearer " + token }, (opts && opts.headers) || {}),
    }));
    if (res.status === 401 && retry) { state.token = null; return api(url, opts, false); }
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function loadUser() {
    try {
      const j = await api("https://www.googleapis.com/oauth2/v3/userinfo");
      state.user = j.email || "";
      if (state.user) localStorage.setItem(LS_HINT, state.user);
    } catch (_) { state.user = ""; }
  }

  function signOut() {
    if (state.token && gisReady()) { try { google.accounts.oauth2.revoke(state.token, () => {}); } catch (_) {} }
    state.token = null; state.user = "";
    location.href = location.pathname;
  }

  // ───────────────────────── sheets ─────────────────────────
  async function loadSheet(sheetId) {
    const meta = await api(`${SHEETS_API}/${sheetId}?fields=properties.title,sheets.properties.title`);
    state.title = meta.properties.title;
    state.tabs = (meta.sheets || []).map((s) => s.properties.title);

    const tSummary = findTab("Ops Summary");
    const tDel = findTab("Delinquency by Station");
    const tDetail = findTab("Delinquency Detail");
    const tNotes = findTab(NOTES_TAB);
    const tOts = findTab("OTS Report");
    const tTat = findTab("TAT Report");
    if (!tSummary && !tDel) throw new Error(`This Sheet has no "Ops Summary" or "Delinquency by Station" tab. Is it the Ops Standup Sheet?`);

    // OTS and TAT are limited to the columns the click-through reads, so the
    // page does not download shoe size, clinician, and the rest of those tabs.
    const rangeOf = (tab, cols) => cols ? `${quoteTab(tab)}!${cols}` : quoteTab(tab);
    const wanted = [
      [tSummary, null], [tDel, null], [tDetail, null], [tNotes, null],
      [tOts, "A:Q"], [tTat, "A:H"],
    ].filter((pair) => pair[0]);
    const ranges = wanted.map(([tab, cols]) => "ranges=" + encodeURIComponent(rangeOf(tab, cols)));
    const data = await api(`${SHEETS_API}/${sheetId}/values:batchGet?${ranges.join("&")}&valueRenderOption=FORMATTED_VALUE`);
    const byTab = {};
    (data.valueRanges || []).forEach((vr) => {
      const name = vr.range.split("!")[0].replace(/^'|'$/g, "").replace(/''/g, "'");
      byTab[name] = vr.values || [];
    });

    const s = toObjects(byTab[tSummary] || []); state.summary = s.rows; state.summaryCols = s.cols;
    const d = toObjects(byTab[tDel] || []); state.delinquency = d.rows; state.delinquencyCols = d.cols;
    state.detail = toObjects(byTab[tDetail] || []).rows;
    state.notes = tNotes ? toObjects(byTab[tNotes] || []).rows.filter((n) => n.note) : [];
    state.orders = ordersBehindSummary(toObjects(byTab[tOts] || []).rows, toObjects(byTab[tTat] || []).rows);
    state.hasDetail = !!tDetail;
    state.hasNotes = !!tNotes;
  }

  // Ops Summary value → the orders already listed on OTS Report / TAT Report.
  // Only Last 2d opens. Last 7d / 14d / 30d stay plain numbers. Count cells
  // (OTS On Time, 1d Late, …) are that ship class. A compliance percent opens
  // the orders that missed that station. Quality rates have no order tab on
  // this Sheet, so those numbers stay as they are. The pack build is not
  // changed by this page.
  function isLast2d(tf) {
    const s = String(tf || "").trim().toLowerCase();
    return s === "last 2d" || s === "last 2bd";
  }
  const OTS_CLASS = {
    "ON_TIME": "OTS On Time",
    "1BD_EARLY": "OTS 1d Early",
    "2BD+_EARLY": "OTS 2d+ Early",
    "1BD_LATE": "OTS 1d Late",
    "2BD+_LATE": "OTS 2d+ Late",
  };
  const TAT_STATION = {
    "Design": "Design Compliance %",
    "Printing": "Printing Compliance %",
    "Production": "Production Compliance %",
    "Shipping": "Shipping Compliance %",
    "Overall": "Overall Compliance %",
  };
  const COUNT_METRICS = new Set(Object.values(OTS_CLASS));

  function ordersBehindSummary(otsRows, tatRows) {
    const out = [];
    otsRows.forEach((r) => {
      const metric = OTS_CLASS[String(r.ship_classification || "").trim()];
      const tf = r["timeframe (based on completion date)"] || r.timeframe || "";
      if (!metric || !r.po_number || !isLast2d(tf)) return;
      const bits = [];
      if (r.bd_over_sla !== "" && r.bd_over_sla != null) bits.push(`${r.bd_over_sla} BD vs SLA`);
      if (r.rework_type) bits.push(r.rework_type);
      out.push({
        timeframe: tf, factory: r.factory || "", metric, po_number: r.po_number,
        workbench_id: r.workbench_id || "", company_name: r.company_name || "",
        detail: bits.join(" · "),
      });
    });
    tatRows.forEach((r) => {
      if (String(r.sla_status || "").toUpperCase() !== "MISSED") return;
      const metric = TAT_STATION[String(r.workstation || "").trim()];
      if (!metric || !r.po_number || !isLast2d(r.timeframe)) return;
      const bits = [];
      if (r.days_over !== "" && r.days_over != null) bits.push(`missed by ${r.days_over} BD`);
      if (r.current_status) bits.push(r.current_status);
      out.push({
        timeframe: r.timeframe || "", factory: r.factory || "", metric, po_number: r.po_number,
        workbench_id: r.workbench_id || "", company_name: r.company_name || "",
        detail: bits.join(" · "),
      });
    });
    return out;
  }

  function ordersForMetric(row) {
    if (!isLast2d(row.timeframe)) return [];
    return state.orders.filter((d) => d.timeframe === row.timeframe && d.factory === row.factory && d.metric === row.metric);
  }

  async function ensureNotesTab() {
    if (state.hasNotes) return;
    await api(`${SHEETS_API}/${state.sheetId}:batchUpdate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: NOTES_TAB } } }] }),
    });
    await api(`${SHEETS_API}/${state.sheetId}/values/${encodeURIComponent(quoteTab(NOTES_TAB) + "!A1")}?valueInputOption=RAW`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [NOTES_HEADER] }),
    });
    state.hasNotes = true; state.tabs.push(NOTES_TAB);
  }

  async function appendNote(n) {
    await ensureNotesTab();
    const rec = {
      ts: new Date().toISOString(), user: state.user || "", page: n.page, level: n.level,
      factory: n.factory || "", station_group: n.station_group || "", status: n.status || "",
      bucket: n.bucket || "", po_number: n.po_number || "", note: n.note,
    };
    await api(`${SHEETS_API}/${state.sheetId}/values/${encodeURIComponent(quoteTab(NOTES_TAB) + "!A:J")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [NOTES_HEADER.map((k) => rec[k])] }),
    });
    state.notes.push(rec);
    return rec;
  }

  // ───────────────────────── notes lookups ─────────────────────────
  const stationKey = (r) => [r.factory, r.station_group, r.status].join("|");
  const summaryKey = (r) => [r.timeframe, r.factory, r.category, r.metric].join("|");

  function notesForStation(row) {
    const k = stationKey(row);
    return state.notes.filter((n) => n.page === "delinquency" && n.level === "station" && stationKey(n) === k);
  }
  function notesForPo(row, po) {
    const k = stationKey(row);
    return state.notes.filter((n) => n.page === "delinquency" && n.level === "po" && stationKey(n) === k && n.po_number === po);
  }
  function poNotesInCell(row, col) {
    const k = stationKey(row);
    return state.notes.filter((n) => n.page === "delinquency" && n.level === "po" && stationKey(n) === k && n.bucket === col);
  }
  function notesForMetric(row) {
    const k = summaryKey(row);
    return state.notes.filter((n) => n.page === "summary" && n.level === "metric" &&
      [n.bucket, n.factory, n.station_group, n.status].join("|") === k);
  }
  function notesForSummaryPo(row, po) {
    return state.notes.filter((n) => n.page === "summary" && n.level === "po" && n.po_number === po &&
      n.bucket === row.timeframe && n.factory === row.factory && n.status === row.metric);
  }

  function renderNoteList(notes) {
    if (!notes.length) return "";
    return notes.map((n) => `<div class="note-entry">${esc(n.note).replace(/\n/g, "<br>")} <span class="who">— ${esc(shortUser(n.user))}, ${esc(fmtTs(n.ts))}</span></div>`).join("");
  }

  function noteEditor(onSave, onCancel, placeholder) {
    const box = el(`<div class="note-editor">
      <textarea placeholder="${esc(placeholder || "Write a note…")}"></textarea>
      <div class="row"><button class="btn ghost cancel">Cancel</button><button class="btn primary save">Save</button></div>
    </div>`);
    const ta = box.querySelector("textarea");
    box.querySelector(".cancel").onclick = onCancel;
    box.querySelector(".save").onclick = async () => {
      const text = ta.value.trim(); if (!text) return;
      box.querySelector(".save").disabled = true;
      try { await onSave(text); } catch (e) { toast("Could not save: " + e.message, true); box.querySelector(".save").disabled = false; }
    };
    ta.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") box.querySelector(".save").click(); });
    setTimeout(() => ta.focus(), 0);
    return box;
  }

  // ───────────────────────── page 1: Ops Summary ─────────────────────────
  function renderSummary() {
    const host = $("page-summary"); host.innerHTML = "";
    if (!state.summary.length) { host.appendChild(el(`<div class="empty">No Ops Summary tab in this Sheet.</div>`)); return; }
    const cols = state.summaryCols.filter((c) => c.toLowerCase() !== "notes");
    host.appendChild(el(`<div class="page-head"><h2>${esc(findTab("Ops Summary"))}</h2><span class="legend">Click a Notes cell to add a note on that metric.</span></div>`));
    const wrap = el(`<div class="grid-wrap"></div>`);
    const table = el(`<table class="grid"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}<th>Notes</th></tr></thead><tbody></tbody></table>`);
    const tb = table.querySelector("tbody");
    let lastFactory = null;
    state.summary.forEach((r) => {
      const tr = document.createElement("tr");
      if (r.factory !== lastFactory && lastFactory !== null) tr.classList.add("factory-start");
      lastFactory = r.factory;
      cols.forEach((c) => {
        const td = document.createElement("td"); const v = r[c];
        if (c === "value" && num(v) !== null) {
          td.className = "num"; td.textContent = v;
          const list = ordersForMetric(r);
          if (list.length && num(v) !== 0) {
            td.classList.add("drill");
            td.title = "Show the orders behind this number";
            td.onclick = () => openSummaryDrawer(r, list);
          }
        }
        else { td.textContent = v; if (c === "metric") td.className = "text"; }
        tr.appendChild(td);
      });
      const noteTd = document.createElement("td"); noteTd.className = "notecell";
      const paint = () => { const ns = notesForMetric(r); noteTd.innerHTML = renderNoteList(ns); noteTd.classList.toggle("empty", !ns.length); };
      paint();
      noteTd.onclick = (e) => {
        if (noteTd.querySelector(".note-editor")) return;
        const editor = noteEditor(async (text) => {
          await appendNote({ page: "summary", level: "metric", bucket: r.timeframe, factory: r.factory, station_group: r.category, status: r.metric, note: text });
          toast("Note saved"); paint();
        }, () => paint(), `Why is ${r.metric} at ${r.value}?`);
        noteTd.classList.remove("empty"); noteTd.appendChild(editor);
      };
      tr.appendChild(noteTd);
      tb.appendChild(tr);
    });
    wrap.appendChild(table); host.appendChild(wrap);
  }

  // ───────────────────────── page 2: Delinquency by Station ─────────────────────────
  function detailFor(row, col) {
    if (WIP_FILTERS[col]) {
      const k = stationKey(row);
      return state.detail.filter((d) => d.bucket_kind === "wip" && stationKey(d) === k && WIP_FILTERS[col](d));
    }
    if (EVENT_COLS.has(col)) {
      const base = baseStatus(row);
      return state.detail.filter((d) => d.bucket_kind === col && d.factory === row.factory && d.status === base);
    }
    return [];
  }

  function renderDelinquency() {
    const host = $("page-delinquency"); host.innerHTML = "";
    if (!state.delinquency.length) { host.appendChild(el(`<div class="empty">No Delinquency by Station tab in this Sheet.</div>`)); return; }
    const cols = state.delinquencyCols.filter((c) => c.toLowerCase() !== "notes");
    const legend = state.hasDetail ? "Click any number to see the POs behind it." : "This Sheet has no Delinquency Detail tab, so numbers cannot be opened.";
    host.appendChild(el(`<div class="page-head"><h2>${esc(findTab("Delinquency by Station"))}</h2><span class="legend">${legend}</span></div>`));
    const wrap = el(`<div class="grid-wrap"></div>`);
    const table = el(`<table class="grid"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}<th>Notes</th></tr></thead><tbody></tbody></table>`);
    const tb = table.querySelector("tbody");
    let lastFactory = null;
    state.delinquency.forEach((r) => {
      const tr = document.createElement("tr");
      if (r.factory !== lastFactory && lastFactory !== null) tr.classList.add("factory-start");
      lastFactory = r.factory;
      cols.forEach((c) => {
        const td = document.createElement("td"); const v = r[c]; const n = num(v);
        const isCount = (WIP_FILTERS[c] || EVENT_COLS.has(c)) && n !== null;
        if (isCount) {
          td.className = "num"; td.textContent = n;
          if (n === 0) td.classList.add("zero");
          else if (state.hasDetail) {
            td.classList.add("clickable"); td.title = `Show the ${n} PO(s) behind ${COL_LABELS[c] || c}`;
            const noted = poNotesInCell(r, c).length;
            if (noted) td.appendChild(el(`<span class="badge" title="${noted} note(s)">${noted}</span>`));
            td.onclick = () => openDrawer(r, c);
          }
        } else { td.textContent = v; }
        tr.appendChild(td);
      });
      const noteTd = document.createElement("td"); noteTd.className = "notecell";
      const paint = () => { const ns = notesForStation(r); noteTd.innerHTML = renderNoteList(ns); noteTd.classList.toggle("empty", !ns.length); };
      paint();
      noteTd.onclick = () => {
        if (noteTd.querySelector(".note-editor")) return;
        const editor = noteEditor(async (text) => {
          await appendNote({ page: "delinquency", level: "station", factory: r.factory, station_group: r.station_group, status: r.status, note: text });
          toast("Note saved"); paint();
        }, () => paint(), `Note for ${r.factory} · ${r.status}`);
        noteTd.classList.remove("empty"); noteTd.appendChild(editor);
      };
      tr.appendChild(noteTd);
      tb.appendChild(tr);
    });
    wrap.appendChild(table); host.appendChild(wrap);
  }

  // ───────────────────────── drawer (PO list) ─────────────────────────
  function openDrawer(row, col) {
    const list = detailFor(row, col);
    const gridN = num(row[col]);
    $("drawer-title").textContent = `${row.factory} · ${row.station_group} · ${row.status}`;
    const drift = gridN !== null && gridN !== list.length ? ` (grid shows ${gridN}; the detail list was captured a moment apart)` : "";
    $("drawer-sub").textContent = `${COL_LABELS[col] || col}: ${list.length} PO${list.length === 1 ? "" : "s"}${drift}`;
    const body = $("drawer-body"); body.innerHTML = "";

    // Row-level note
    const stationBox = el(`<div class="po-card"><div class="section-title" style="margin-top:0">Note on this row</div><div class="po-notes"></div><div class="po-actions"></div></div>`);
    const paintStation = () => {
      stationBox.querySelector(".po-notes").innerHTML = renderNoteList(notesForStation(row)) || `<span class="muted">No note yet.</span>`;
      const act = stationBox.querySelector(".po-actions"); act.innerHTML = "";
      const b = el(`<button class="linklike">Add note</button>`);
      b.onclick = () => {
        act.innerHTML = "";
        act.appendChild(noteEditor(async (text) => {
          await appendNote({ page: "delinquency", level: "station", factory: row.factory, station_group: row.station_group, status: row.status, bucket: col, note: text });
          toast("Note saved"); paintStation(); renderDelinquency();
        }, paintStation, `What is going on in ${row.status}?`));
      };
      act.appendChild(b);
    };
    paintStation();
    body.appendChild(stationBox);

    body.appendChild(el(`<div class="section-title">Orders</div>`));
    if (!list.length) body.appendChild(el(`<div class="empty">No matching rows in Delinquency Detail.</div>`));

    list.sort((a, b) => (num(b.days_past_step_due) || -999) - (num(a.days_past_step_due) || -999));
    list.forEach((d) => {
      const card = el(`<div class="po-card"></div>`);
      const wbUrl = d.workbench_id ? `${CFG.WORKBENCH_BASE}/${encodeURIComponent(d.workbench_id)}` : "";
      const pills = [];
      if (isTrue(d.customer_overdue)) pills.push(`<span class="pill co">customer overdue</span>`);
      if (d.classification === "OVERDUE") pills.push(`<span class="pill overdue">step overdue ${esc(d.days_past_step_due)}d</span>`);
      else if (d.classification === "DUE_TODAY") pills.push(`<span class="pill">due today</span>`);
      else if (d.classification) pills.push(`<span class="pill">${esc(String(d.classification).toLowerCase().replace(/_/g, " "))}</span>`);
      if (d.rework_category) pills.push(`<span class="pill rework">${esc(d.rework_category)}</span>`);
      if (d.event_date) pills.push(`<span class="pill">${esc(d.event_date)}</span>`);
      const poHtml = wbUrl ? `<a href="${wbUrl}" target="_blank" rel="noopener">${esc(d.po_number)}</a>` : `<b>${esc(d.po_number)}</b>`;
      const meta = [];
      if (d.company_name) meta.push(`<b>${esc(d.company_name)}</b>`);
      if (d.go_live) meta.push(`go-live ${esc(d.go_live)}`);
      if (d.step_start) meta.push(`entered ${esc(d.step_start)}`);
      if (d.step_due_date) meta.push(`step due ${esc(d.step_due_date)}`);
      card.appendChild(el(`<div class="po-head">${poHtml} ${pills.join(" ")}</div>`));
      if (meta.length) card.appendChild(el(`<div class="po-meta">${meta.join(" · ")}</div>`));
      const notesDiv = el(`<div class="po-notes"></div>`); const act = el(`<div class="po-actions"></div>`);
      const paint = () => {
        const ns = notesForPo(row, d.po_number);
        notesDiv.innerHTML = renderNoteList(ns); card.classList.toggle("noted", ns.length > 0);
        act.innerHTML = "";
        const b = el(`<button class="linklike">${ns.length ? "Add another note" : "Add note"}</button>`);
        b.onclick = () => {
          act.innerHTML = "";
          act.appendChild(noteEditor(async (text) => {
            await appendNote({ page: "delinquency", level: "po", factory: row.factory, station_group: row.station_group, status: row.status, bucket: col, po_number: d.po_number, note: text });
            toast("Note saved"); paint(); renderDelinquency();
          }, paint, `Why is ${d.po_number} here?`));
        };
        act.appendChild(b);
      };
      paint();
      card.appendChild(notesDiv); card.appendChild(act);
      body.appendChild(card);
    });

    $("drawer").hidden = false; $("scrim").hidden = false;
  }
  function openSummaryDrawer(row, list) {
    const gridN = num(row.value);
    const countMetric = COUNT_METRICS.has(row.metric);
    $("drawer-title").textContent = `${row.factory} · ${row.metric}`;
    let sub = `${row.timeframe}: ${list.length} order${list.length === 1 ? "" : "s"}`;
    if (countMetric && gridN !== null && gridN !== list.length) {
      sub += ` (the cell shows ${gridN})`;
    }
    $("drawer-sub").textContent = sub;
    const body = $("drawer-body"); body.innerHTML = "";

    const metricBox = el(`<div class="po-card"><div class="section-title" style="margin-top:0">Note on this number</div><div class="po-notes"></div><div class="po-actions"></div></div>`);
    const paintMetric = () => {
      metricBox.querySelector(".po-notes").innerHTML = renderNoteList(notesForMetric(row)) || `<span class="muted">No note yet.</span>`;
      const act = metricBox.querySelector(".po-actions"); act.innerHTML = "";
      const b = el(`<button class="linklike">Add note</button>`);
      b.onclick = () => {
        act.innerHTML = "";
        act.appendChild(noteEditor(async (text) => {
          await appendNote({ page: "summary", level: "metric", bucket: row.timeframe, factory: row.factory, station_group: row.category, status: row.metric, note: text });
          toast("Note saved"); paintMetric(); renderSummary();
        }, paintMetric, `Why is ${row.metric} at ${row.value}?`));
      };
      act.appendChild(b);
    };
    paintMetric();
    body.appendChild(metricBox);
    body.appendChild(el(`<div class="section-title">Orders</div>`));

    list.forEach((d) => {
      const card = el(`<div class="po-card"></div>`);
      const wbUrl = d.workbench_id ? `${CFG.WORKBENCH_BASE}/${encodeURIComponent(d.workbench_id)}` : "";
      const poHtml = wbUrl ? `<a href="${wbUrl}" target="_blank" rel="noopener">${esc(d.po_number)}</a>` : `<b>${esc(d.po_number)}</b>`;
      card.appendChild(el(`<div class="po-head">${poHtml}${d.detail ? ` <span class="pill">${esc(d.detail)}</span>` : ""}</div>`));
      if (d.company_name) card.appendChild(el(`<div class="po-meta"><b>${esc(d.company_name)}</b></div>`));
      const notesDiv = el(`<div class="po-notes"></div>`); const act = el(`<div class="po-actions"></div>`);
      const paint = () => {
        const ns = notesForSummaryPo(row, d.po_number);
        notesDiv.innerHTML = renderNoteList(ns); card.classList.toggle("noted", ns.length > 0);
        act.innerHTML = "";
        const b = el(`<button class="linklike">${ns.length ? "Add another note" : "Add note"}</button>`);
        b.onclick = () => {
          act.innerHTML = "";
          act.appendChild(noteEditor(async (text) => {
            await appendNote({ page: "summary", level: "po", bucket: row.timeframe, factory: row.factory, station_group: row.category, status: row.metric, po_number: d.po_number, note: text });
            toast("Note saved"); paint();
          }, paint, `Why is ${d.po_number} in ${row.metric}?`));
        };
        act.appendChild(b);
      };
      paint();
      card.appendChild(notesDiv); card.appendChild(act);
      body.appendChild(card);
    });
    $("drawer").hidden = false; $("scrim").hidden = false;
  }

  function closeDrawer() { $("drawer").hidden = true; $("scrim").hidden = true; }

  // ───────────────────────── shell ─────────────────────────
  function showPage(p) {
    state.page = p;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.page === p));
    $("page-summary").hidden = p !== "summary";
    $("page-delinquency").hidden = p !== "delinquency";
  }

  async function start(sheetId) {
    const err = $("gate-error"); err.hidden = true;
    const btn = $("signin"); btn.disabled = true; btn.textContent = "Signing in…";
    try {
      if (state.token && Date.now() < state.tokenExp) await ensureToken();
      else await requestToken(true);
      await loadUser();
      if (!sheetId) {
        btn.textContent = "Finding the latest pack…";
        sheetId = await latestStandupId();
      }
      btn.textContent = "Loading Sheet…";
      state.sheetId = sheetId;
      await loadSheet(sheetId);
      if (!state.demo) {
        // Do not remember the id. The next visit must resolve the newest pack.
        const link = $("sheet-link"); link.href = `https://docs.google.com/spreadsheets/d/${sheetId}`; link.hidden = false;
      }

      $("gate").hidden = true; $("tabs").hidden = false;
      $("pack-title").textContent = state.title;
      $("user").textContent = state.user; $("signout").hidden = false;
      renderSummary(); renderDelinquency();
      showPage(state.delinquency.length && !state.summary.length ? "delinquency" : "summary");
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Sign in with Google";
    }
  }

  async function latestStandupId() {
    const q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains 'Ops Standup'";
    const url = "https://www.googleapis.com/drive/v3/files?pageSize=20&orderBy=createdTime desc"
      + "&fields=files(id,name,createdTime)&supportsAllDrives=true&includeItemsFromAllDrives=true"
      + "&q=" + encodeURIComponent(q);
    const data = await api(url);
    const files = (data.files || []).filter((f) => /Ops Standup/i.test(f.name || "") && !/Priority|Hanger/i.test(f.name || ""));
    files.sort((a, b) => String(b.createdTime || "").localeCompare(String(a.createdTime || "")));
    if (!files.length) throw new Error("No Ops Standup Sheet is shared with this Google account yet.");
    return files[0].id;
  }

  function init() {
    const params = new URLSearchParams(location.search);
    // ?demo=1 renders synthetic sample data (demo.js) with no Google sign-in,
    // so the layout can be reviewed before the OAuth client exists.
    state.demo = params.get("demo") === "1" && !!window.OPS_STANDUP_DEMO;
    // Drop any Sheet id saved by an older version of this page.
    localStorage.removeItem(LS_SHEET);
    $("sheet-input").value = "";
    if (!CFG.GOOGLE_CLIENT_ID && !state.demo) $("config-hint").hidden = false;
    if (state.demo) { $("signin").textContent = "Open demo data"; $("sheet-input").disabled = true; }

    $("signin").onclick = () => {
      if (state.demo) { start("demo"); return; }
      const typed = parseSheetId($("sheet-input").value);
      start(typed || "");
    };
    $("sheet-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("signin").click(); });
    $("signout").onclick = signOut;
    document.querySelectorAll(".tab").forEach((b) => { b.onclick = () => showPage(b.dataset.page); });
    $("drawer-close").onclick = closeDrawer; $("scrim").onclick = closeDrawer;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
