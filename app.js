/* Ops Standup shell.
 *
 * Static page. Reads one night's "Ops Standup" Google Sheet with the signed-in
 * user's own Google credentials (Sheets API v4) and renders:
 *   page 1  Ops Summary            — same columns as the Sheet + a Notes column
 *   page 2  Delinquency by Station — same columns as the Sheet; every number
 *           opens the POs behind it (from the "Delinquency Detail" tab), each PO
 *           links to its workbench, and notes can be written per PO or per row.
 *   page 5  Company Volume Trends  — the present week only, from the tab that
 *           already has every week. Outlook is a first read of growth.
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
    byPerson: [], byPersonCols: [],
    personFocus: null,
    holds: [], holdCols: [],
    holdSort: { col: "", dir: 1 },
    volume: [], volumeCols: [],
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
      const o = {}; cols.forEach((c, j) => { o[c] = r[j] == null ? "" : r[j]; });
      o._row = i + 1;
      rows.push(o);
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
    const tPerson = findTab("Prev Day by Person");
    const tHolds = findTab("On Hold External Detail");
    const tVolume = findTab("Company Volume Trends");
    if (!tSummary && !tDel) throw new Error(`This Sheet has no "Ops Summary" or "Delinquency by Station" tab. Is it the Ops Standup Sheet?`);

    // OTS and TAT are limited to the columns the click-through reads, so the
    // page does not download shoe size, clinician, and the rest of those tabs.
    const rangeOf = (tab, cols) => cols ? `${quoteTab(tab)}!${cols}` : quoteTab(tab);
    const wanted = [
      [tSummary, null], [tDel, null], [tDetail, null], [tNotes, null],
      [tOts, "A:Q"], [tTat, "A:H"], [tPerson, null], [tHolds, null], [tVolume, null],
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
    const person = toObjects(byTab[tPerson] || []);
    state.byPerson = person.rows;
    state.byPersonCols = person.cols;
    state.personFocus = null;
    const holds = toObjects(byTab[tHolds] || []);
    state.holds = holds.rows;
    state.holdCols = holds.cols;
    state.holdSort = { col: "", dir: 1 };
    const volume = toObjects(byTab[tVolume] || []);
    state.volume = volume.rows;
    state.volumeCols = volume.cols;
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
    const res = await api(`${SHEETS_API}/${state.sheetId}/values/${encodeURIComponent(quoteTab(NOTES_TAB) + "!A:J")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [NOTES_HEADER.map((k) => rec[k])] }),
    });
    const range = (res.updates && res.updates.updatedRange) || "";
    const rowMatch = String(range).match(/![A-Z]+(\d+)/i);
    rec._row = rowMatch ? Number(rowMatch[1]) : "";
    state.notes.push(rec);
    return rec;
  }

  async function updateNote(note, text) {
    const row = Number(note._row);
    if (!row) throw new Error("Reload the page, then edit this note.");
    const rec = {
      ts: text ? new Date().toISOString() : (note.ts || ""),
      user: text ? (state.user || note.user || "") : (note.user || ""),
      page: note.page, level: note.level,
      factory: note.factory || "", station_group: note.station_group || "", status: note.status || "",
      bucket: note.bucket || "", po_number: note.po_number || "", note: text,
    };
    await api(`${SHEETS_API}/${state.sheetId}/values/${encodeURIComponent(quoteTab(NOTES_TAB) + "!A" + row + ":J" + row)}?valueInputOption=RAW`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [NOTES_HEADER.map((k) => rec[k])] }),
    });
    Object.assign(note, rec);
  }

  // ───────────────────────── notes lookups ─────────────────────────
  const stationKey = (r) => [r.factory, r.station_group, r.status].join("|");
  const summaryKey = (r) => [r.timeframe, r.factory, r.category, r.metric].join("|");

  function kept(notes) { return notes.filter((n) => String(n.note || "").trim()); }
  function notesForStation(row) {
    const k = stationKey(row);
    return kept(state.notes.filter((n) => n.page === "delinquency" && n.level === "station" && stationKey(n) === k));
  }
  function notesForPo(row, po) {
    const k = stationKey(row);
    return kept(state.notes.filter((n) => n.page === "delinquency" && n.level === "po" && stationKey(n) === k && n.po_number === po));
  }
  function poNotesInCell(row, col) {
    const k = stationKey(row);
    return kept(state.notes.filter((n) => n.page === "delinquency" && n.level === "po" && stationKey(n) === k && n.bucket === col));
  }
  function notesForMetric(row) {
    const k = summaryKey(row);
    return kept(state.notes.filter((n) => n.page === "summary" && n.level === "metric" &&
      [n.bucket, n.factory, n.station_group, n.status].join("|") === k));
  }
  function notesForSummaryPo(row, po) {
    return kept(state.notes.filter((n) => n.page === "summary" && n.level === "po" && n.po_number === po &&
      n.bucket === row.timeframe && n.factory === row.factory && n.status === row.metric));
  }
  function notesForPerson(station, who) {
    const email = String(who || "").toLowerCase();
    return kept(state.notes.filter((n) => n.page === "people" && n.level === "person" && n.station_group === station && String(n.status || "").toLowerCase() === email));
  }

  function noteEditor(onSave, onCancel, placeholder, initial, allowEmpty) {
    const box = el(`<div class="note-editor">
      <textarea placeholder="${esc(placeholder || "Write a note…")}"></textarea>
      <div class="row"><button type="button" class="btn ghost cancel">Cancel</button><button type="button" class="btn primary save">Save</button></div>
    </div>`);
    const ta = box.querySelector("textarea");
    ta.value = initial || "";
    box.addEventListener("click", (e) => e.stopPropagation());
    box.querySelector(".cancel").onclick = (e) => { e.stopPropagation(); onCancel(); };
    box.querySelector(".save").onclick = async (e) => {
      e.stopPropagation();
      const text = ta.value.trim();
      if (!text && !allowEmpty) return;
      box.querySelector(".save").disabled = true;
      box.querySelector(".cancel").disabled = true;
      try { await onSave(text); } catch (e) {
        toast("Could not save: " + e.message, true);
        box.querySelector(".save").disabled = false;
        box.querySelector(".cancel").disabled = false;
      }
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") box.querySelector(".save").click();
    });
    setTimeout(() => { ta.focus(); if (initial) ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    return box;
  }

  function showNoteEditor(host, initial, placeholder, paint, onSave, allowEmpty) {
    host.innerHTML = "";
    host.classList.remove("empty");
    host.appendChild(noteEditor(onSave, paint, placeholder, initial, allowEmpty));
  }

  function fillNotes(host, notes, paint, placeholder) {
    host.innerHTML = "";
    notes.forEach((n) => {
      const entry = el(`<div class="note-entry"></div>`);
      const text = document.createElement("span");
      text.innerHTML = esc(n.note).replace(/\n/g, "<br>");
      const who = el(`<span class="who"> — ${esc(shortUser(n.user))}, ${esc(fmtTs(n.ts))}</span>`);
      const edit = el(`<button type="button" class="linklike">Edit</button>`);
      const remove = el(`<button type="button" class="linklike">Remove</button>`);
      edit.onclick = (e) => {
        e.stopPropagation();
        showNoteEditor(host, n.note, placeholder, paint, async (text) => {
          await updateNote(n, text);
          toast(text ? "Note saved" : "Note removed");
          paint();
        }, true);
      };
      remove.onclick = async (e) => {
        e.stopPropagation();
        remove.disabled = true;
        try { await updateNote(n, ""); toast("Note removed"); paint(); }
        catch (err) { toast("Could not remove: " + err.message, true); remove.disabled = false; }
      };
      entry.append(text, who, edit, remove);
      host.appendChild(entry);
    });
  }

  // ───────────────────────── page 1: Ops Summary ─────────────────────────
  function renderSummary() {
    const host = $("page-summary"); host.innerHTML = "";
    if (!state.summary.length) { host.appendChild(el(`<div class="empty">No Ops Summary tab in this Sheet.</div>`)); return; }
    const cols = state.summaryCols.filter((c) => c.toLowerCase() !== "notes");
    host.appendChild(el(`<div class="page-head"><h2>${esc(findTab("Ops Summary"))}</h2><span class="legend">Click a Notes cell to add a note. Edit or Remove changes it.</span></div>`));
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
      const placeholder = `Why is ${r.metric} at ${r.value}?`;
      const paint = () => { fillNotes(noteTd, notesForMetric(r), paint, placeholder); noteTd.classList.toggle("empty", !notesForMetric(r).length); };
      paint();
      noteTd.onclick = (e) => {
        if (e.target.closest(".note-editor, .linklike, .note-entry")) return;
        showNoteEditor(noteTd, "", placeholder, paint, async (text) => {
          await appendNote({ page: "summary", level: "metric", bucket: r.timeframe, factory: r.factory, station_group: r.category, status: r.metric, note: text });
          toast("Note saved"); paint();
        }, false);
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
    const hiddenCols = new Set(["completed_yesterday", "completed_2_days_ago", "rejected_yesterday", "rejected_2_days_ago"]);
    const cols = state.delinquencyCols.filter((c) => c.toLowerCase() !== "notes" && !hiddenCols.has(c));
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
      const placeholder = `Note for ${r.factory} · ${r.status}`;
      const paint = () => { fillNotes(noteTd, notesForStation(r), paint, placeholder); noteTd.classList.toggle("empty", !notesForStation(r).length); };
      paint();
      noteTd.onclick = (e) => {
        if (e.target.closest(".note-editor, .linklike, .note-entry")) return;
        showNoteEditor(noteTd, "", placeholder, paint, async (text) => {
          await appendNote({ page: "delinquency", level: "station", factory: r.factory, station_group: r.station_group, status: r.status, note: text });
          toast("Note saved"); paint();
        }, false);
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
      const notesEl = stationBox.querySelector(".po-notes");
      const ns = notesForStation(row);
      const placeholder = `What is going on in ${row.status}?`;
      if (ns.length) fillNotes(notesEl, ns, () => { paintStation(); renderDelinquency(); }, placeholder);
      else notesEl.innerHTML = `<span class="muted">No note yet.</span>`;
      const act = stationBox.querySelector(".po-actions"); act.innerHTML = "";
      const b = el(`<button type="button" class="linklike">Add note</button>`);
      b.onclick = () => {
        showNoteEditor(act, "", placeholder, paintStation, async (text) => {
          await appendNote({ page: "delinquency", level: "station", factory: row.factory, station_group: row.station_group, status: row.status, bucket: col, note: text });
          toast("Note saved"); paintStation(); renderDelinquency();
        }, false);
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
        const placeholder = `Why is ${d.po_number} here?`;
        if (ns.length) fillNotes(notesDiv, ns, () => { paint(); renderDelinquency(); }, placeholder);
        else notesDiv.innerHTML = "";
        card.classList.toggle("noted", ns.length > 0);
        act.innerHTML = "";
        const b = el(`<button type="button" class="linklike">${ns.length ? "Add another note" : "Add note"}</button>`);
        b.onclick = () => {
          showNoteEditor(act, "", placeholder, paint, async (text) => {
            await appendNote({ page: "delinquency", level: "po", factory: row.factory, station_group: row.station_group, status: row.status, bucket: col, po_number: d.po_number, note: text });
            toast("Note saved"); paint(); renderDelinquency();
          }, false);
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
      const notesEl = metricBox.querySelector(".po-notes");
      const ns = notesForMetric(row);
      const placeholder = `Why is ${row.metric} at ${row.value}?`;
      if (ns.length) fillNotes(notesEl, ns, () => { paintMetric(); renderSummary(); }, placeholder);
      else notesEl.innerHTML = `<span class="muted">No note yet.</span>`;
      const act = metricBox.querySelector(".po-actions"); act.innerHTML = "";
      const b = el(`<button type="button" class="linklike">Add note</button>`);
      b.onclick = () => {
        showNoteEditor(act, "", placeholder, paintMetric, async (text) => {
          await appendNote({ page: "summary", level: "metric", bucket: row.timeframe, factory: row.factory, station_group: row.category, status: row.metric, note: text });
          toast("Note saved"); paintMetric(); renderSummary();
        }, false);
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
        const placeholder = `Why is ${d.po_number} in ${row.metric}?`;
        if (ns.length) fillNotes(notesDiv, ns, paint, placeholder);
        else notesDiv.innerHTML = "";
        card.classList.toggle("noted", ns.length > 0);
        act.innerHTML = "";
        const b = el(`<button type="button" class="linklike">${ns.length ? "Add another note" : "Add note"}</button>`);
        b.onclick = () => {
          showNoteEditor(act, "", placeholder, paint, async (text) => {
            await appendNote({ page: "summary", level: "po", bucket: row.timeframe, factory: row.factory, station_group: row.category, status: row.metric, po_number: d.po_number, note: text });
            toast("Note saved"); paint();
          }, false);
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

  // ───────────────────────── page 3: Prev Day by Person ─────────────────────────
  // Scoreboard only. Reads the Prev Day by Person tab already on the Sheet.
  // No orders, notes, or workbench. Ops Summary and Delinquency are not used here.
  const STATION_LABELS = {
    "PRINTING": "Printing",
    "NEEDS_MANUFACTURING": "Manufacturing",
    "NEEDS_GRINDING": "Grinding",
    "POST_PRINT_QA": "Post-print QA",
    "NEEDS_GLUING": "Gluing",
    "NEEDS_FINISHING": "Finishing",
    "NEEDS_QUALITY_CONTROL": "Quality Control",
    "NEEDS_ADDON": "Add-on",
    "NEEDS_SHIPPING": "Shipping",
    "NEEDS_MATCHING": "Matching",
    "AWAITING_SHIPMENT": "Awaiting Shipment",
  };

  function stationLabel(raw) {
    const key = String(raw || "").trim();
    if (STATION_LABELS[key]) return STATION_LABELS[key];
    const cleaned = key.replace(/^NEEDS_/, "").replace(/_/g, " ").toLowerCase();
    if (!cleaned) return "Station";
    return cleaned.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  function displayName(who) {
    let local = String(who || "").split("@")[0].trim();
    if (local.includes("+")) local = local.split("+").pop();
    local = local.replace(/[._]+/g, " ").trim();
    if (!local) return "Unknown";
    return local.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  function parseHm(label) {
    const s = String(label || "");
    let mins = 0;
    const h = s.match(/(\d+)\s*h/i);
    const m = s.match(/(\d+)\s*m/i);
    if (h) mins += Number(h[1]) * 60;
    if (m) mins += Number(m[1]);
    return mins;
  }

  function formatHm(mins) {
    mins = Math.round(mins || 0);
    if (mins <= 0) return "";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return m + "m";
    return h + "h " + m + "m";
  }

  function parseThroughput(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return { qty: 0, minutes: 0 };
    const m = s.match(/^(-?\d+(?:\.\d+)?)(?:\s*\(([^)]*)\))?/);
    if (!m) return { qty: 0, minutes: 0 };
    return { qty: Math.round(Number(m[1])), minutes: parseHm(m[2] || "") };
  }

  function dateColumns(cols) {
    return (cols || []).filter((c) => /^\*?\d{1,2}\/\d{1,2}$/.test(String(c).trim()));
  }

  function dateLabel(col) { return String(col).replace(/^\*/, ""); }

  function monthDay(col) {
    const m = String(col || "").trim().match(/^\*?(\d{1,2})\/(\d{1,2})$/);
    return m ? { month: Number(m[1]), day: Number(m[2]) } : null;
  }

  // The file name is the morning the pack is read. 10_2 means the previous
  // day on this page is 10/1. Columns on the report date itself are not used.
  function reportMonthDay() {
    const src = state.title || findTab("Prev Day by Person") || "";
    const m = String(src).match(/(\d{1,2})_(\d{1,2})/);
    return m ? { month: Number(m[1]), day: Number(m[2]) } : null;
  }

  function chicagoYear(reportMonth) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric" }).formatToParts(new Date());
    const year = Number(parts.find((p) => p.type === "year").value);
    const month = Number(parts.find((p) => p.type === "month").value);
    if (reportMonth === 12 && month === 1) return year - 1;
    if (reportMonth === 1 && month === 12) return year + 1;
    return year;
  }

  function dayKey(md, report) {
    let month = md.month;
    if (report.month <= 2 && md.month >= 11) month -= 12;
    if (report.month >= 11 && md.month <= 2) month += 12;
    return month * 40 + md.day;
  }

  function previousDayColumns(dates) {
    const report = reportMonthDay();
    if (!report) return dates;
    const year = chicagoYear(report.month);
    const prevDate = new Date(Date.UTC(year, report.month - 1, report.day));
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    const prev = { month: prevDate.getUTCMonth() + 1, day: prevDate.getUTCDate() };
    let score = dates.findIndex((col) => {
      const md = monthDay(col);
      return md && md.month === prev.month && md.day === prev.day;
    });
    if (score < 0) {
      const reportKey = dayKey(report, report);
      dates.forEach((col, i) => {
        const md = monthDay(col);
        if (md && dayKey(md, report) < reportKey) score = i;
      });
    }
    if (score < 0) return dates;
    return dates.slice(0, score + 1);
  }

  function peopleBoards() {
    const dates = previousDayColumns(dateColumns(state.byPersonCols));
    if (!dates.length || !state.byPerson.length) return { dates: dates, day: "", stations: [] };
    const day = dates[dates.length - 1];
    const grouped = new Map();
    const stationOrder = [];
    state.byPerson.forEach((row) => {
      const station = String(row.station || "").trim();
      const who = String(row.completed_by || "").trim();
      if (!station || !who) return;
      const key = station + "\n" + who.toLowerCase();
      let person = grouped.get(key);
      if (!person) {
        person = { station: station, who: who, days: dates.map((col) => ({ col: col, label: dateLabel(col), qty: 0, minutes: 0 })) };
        grouped.set(key, person);
        if (!stationOrder.includes(station)) stationOrder.push(station);
      }
      dates.forEach((col, i) => {
        const cell = parseThroughput(row[col]);
        person.days[i].qty += cell.qty;
        person.days[i].minutes += cell.minutes;
      });
    });
    const stations = stationOrder.map((station) => {
      const people = [...grouped.values()].filter((p) => p.station === station && p.days.some((d) => d.qty > 0));
      people.sort((a, b) => b.days[b.days.length - 1].qty - a.days[a.days.length - 1].qty || displayName(a.who).localeCompare(displayName(b.who)));
      people.forEach((p, i) => { p.rank = i + 1; });
      return { station: station, label: stationLabel(station), people: people };
    }).filter((s) => s.people.length);
    return { dates: dates, day: dateLabel(day), stations: stations };
  }

  function svgEl(name, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    return node;
  }

  function trendChart(days) {
    const max = Math.max.apply(null, days.map((d) => d.qty).concat([1]));
    const barW = 46;
    const gap = 26;
    const plotH = 200;
    const top = 40;
    const bottom = 52;
    const left = 12;
    const width = left + days.length * (barW + gap);
    const height = top + plotH + bottom;
    const svg = svgEl("svg", { class: "trend", viewBox: "0 0 " + width + " " + height, width: width, height: height, role: "img" });
    svg.appendChild(svgEl("title", {})).textContent = "Insoles by day";
    const baseline = top + plotH;
    svg.appendChild(svgEl("line", { x1: left, y1: baseline, x2: width - 8, y2: baseline, class: "trend-base" }));
    const points = days.map((d, i) => {
      const h = Math.round((d.qty / max) * (plotH - 8));
      const x = left + i * (barW + gap);
      const y = baseline - h;
      return { d: d, x: x, y: y, h: h, cx: x + barW / 2 };
    });
    points.forEach((p, i) => {
      const prev = i > 0 ? points[i - 1].d.qty : null;
      const dir = prev == null ? "flat" : p.d.qty > prev ? "up" : p.d.qty < prev ? "down" : "flat";
      svg.appendChild(svgEl("rect", { x: p.x, y: p.y, width: barW, height: Math.max(p.h, p.d.qty ? 2 : 0), rx: 4, class: "bar bar-" + dir }));
      const count = svgEl("text", { x: p.cx, y: Math.max(18, p.y - 16), class: "bar-count", "text-anchor": "middle", stroke: "#fff", "stroke-width": "4", "paint-order": "stroke" });
      count.textContent = String(p.d.qty);
      svg.appendChild(count);
      const date = svgEl("text", { x: p.cx, y: baseline + 18, class: "bar-date", "text-anchor": "middle" });
      date.textContent = p.d.label;
      svg.appendChild(date);
      const timeLabel = formatHm(p.d.minutes);
      if (timeLabel) {
        const time = svgEl("text", { x: p.cx, y: baseline + 34, class: "bar-time", "text-anchor": "middle" });
        time.textContent = timeLabel;
        svg.appendChild(time);
      }
    });
    for (let i = 1; i < points.length; i++) {
      const up = points[i].d.qty > points[i - 1].d.qty;
      svg.appendChild(svgEl("line", {
        x1: points[i - 1].cx, y1: points[i - 1].y, x2: points[i].cx, y2: points[i].y,
        class: up ? "trend-up" : "trend-flat",
      }));
    }
    return svg;
  }

  function directionLine(days) {
    if (days.length < 2) return null;
    const last = days[days.length - 1];
    const prev = days[days.length - 2];
    const delta = last.qty - prev.qty;
    if (delta > 0) return { kind: "up", text: "Picked up " + delta + " insoles" };
    if (delta < 0) return { kind: "down", text: "Dropped " + (-delta) + " insoles" };
    return { kind: "flat", text: "Flat vs " + prev.label };
  }

  function renderPeople() {
    const host = $("page-people");
    host.innerHTML = "";
    const board = peopleBoards();
    if (!state.byPerson.length || !board.dates.length) {
      host.appendChild(el(`<div class="empty">This Sheet has no Prev Day by Person tab.</div>`));
      return;
    }
    if (!board.stations.length) {
      host.appendChild(el(`<div class="empty">No insole counts on the Prev Day by Person tab.</div>`));
      return;
    }
    if (state.personFocus) {
      const station = board.stations.find((s) => s.station === state.personFocus.station);
      const person = station && station.people.find((p) => p.who.toLowerCase() === state.personFocus.who);
      if (station && person) { renderPersonDetail(host, board, station, person); return; }
      state.personFocus = null;
    }
    host.appendChild(el(`<div class="page-head"><h2>Prev Day by Person</h2><span class="legend">Ranked by insoles on ${esc(board.day)}.</span></div>`));
    board.stations.forEach((station) => {
      const block = el(`<section class="station-board"><h3>${esc(station.label)}</h3><div class="profile-row"></div></section>`);
      const row = block.querySelector(".profile-row");
      station.people.forEach((person) => {
        const qty = person.days[person.days.length - 1].qty;
        const name = displayName(person.who);
        const btn = el(`<button type="button" class="profile"></button>`);
        if (!qty) btn.classList.add("zero");
        btn.setAttribute("aria-label", name + ", rank " + person.rank + " at " + station.label + ", " + qty + " insoles");
        btn.appendChild(el(`<span class="rank">${person.rank}</span>`));
        btn.appendChild(el(`<span class="who">${esc(name)}</span>`));
        btn.appendChild(el(`<span class="score">${qty}</span>`));
        btn.appendChild(el(`<span class="unit">insoles</span>`));
        if (notesForPerson(station.station, person.who).length) btn.appendChild(el(`<span class="badge">note</span>`));
        btn.onclick = () => {
          state.personFocus = { station: station.station, who: person.who.toLowerCase() };
          renderPeople();
          window.scrollTo(0, 0);
        };
        row.appendChild(btn);
      });
      host.appendChild(block);
    });
  }

  function renderPersonDetail(host, board, station, person) {
    const name = displayName(person.who);
    const qty = person.days[person.days.length - 1].qty;
    const dir = directionLine(person.days);
    host.appendChild(el(`<div class="page-head"><h2>${esc(name)}</h2><span class="legend">${esc(station.label)} · rank ${person.rank} · ${qty} insoles on ${esc(board.day)}</span></div>`));
    const back = el(`<button type="button" class="btn back-board">Back to scoreboard</button>`);
    back.onclick = () => { state.personFocus = null; renderPeople(); };
    host.appendChild(back);
    if (dir) host.appendChild(el(`<p class="direction direction-${dir.kind}">${esc(dir.text)}</p>`));
    const chart = el(`<div class="chart-card"><div class="chart-title">${esc(name)} · insoles by day</div><div class="chart-scroll"></div></div>`);
    chart.querySelector(".chart-scroll").appendChild(trendChart(person.days));
    host.appendChild(chart);

    const noteCard = el(`<div class="chart-card person-note"><div class="chart-title">Note on ${esc(name)}</div><div class="po-notes"></div><div class="po-actions"></div></div>`);
    const notesEl = noteCard.querySelector(".po-notes");
    const act = noteCard.querySelector(".po-actions");
    const placeholder = `Note for ${name} at ${station.label}`;
    const paint = () => {
      const ns = notesForPerson(station.station, person.who);
      if (ns.length) fillNotes(notesEl, ns, paint, placeholder);
      else notesEl.innerHTML = `<span class="muted">No note yet.</span>`;
      act.innerHTML = "";
      const add = el(`<button type="button" class="linklike">${ns.length ? "Add another note" : "Add note"}</button>`);
      add.onclick = () => {
        showNoteEditor(act, "", placeholder, paint, async (text) => {
          await appendNote({ page: "people", level: "person", station_group: station.station, status: person.who, note: text });
          toast("Note saved");
          paint();
        }, false);
      };
      act.appendChild(add);
    };
    paint();
    host.appendChild(noteCard);
  }

  // ───────────────────────── page 4: On Hold External Detail ─────────────────────────
  // Same columns as the nightly "{date} On Hold External Detail" tab.
  // Manual holds stay above every other Hold Kind. A column heading sorts
  // inside those two blocks; click it again to reverse. No sort menu.
  function isManualHold(row) {
    return String(row["Hold Kind"] || "").trim().toLowerCase() === "manual";
  }
  function columnIsNumeric(col, rows) {
    if (col === "Days On Hold") return true;
    const vals = rows.map((r) => String(r[col] == null ? "" : r[col]).trim()).filter(Boolean);
    return vals.length > 0 && vals.every((v) => num(v) !== null);
  }
  function cellSortKey(v, numeric) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return null;
    if (numeric) return num(s);
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const t = Date.parse(s);
      if (!isNaN(t)) return t;
    }
    return s.toLowerCase();
  }
  function compareHoldCells(a, b, col, numeric, dir) {
    const ka = cellSortKey(a[col], numeric);
    const kb = cellSortKey(b[col], numeric);
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1;
    if (kb == null) return -1;
    const c = typeof ka === "number" && typeof kb === "number"
      ? ka - kb
      : String(ka).localeCompare(String(kb), undefined, { numeric: true, sensitivity: "base" });
    return c * dir;
  }
  function orderedHolds() {
    const rows = state.holds.map((r, i) => ({ r, i }));
    const col = state.holdSort.col;
    const dir = state.holdSort.dir || 1;
    const numeric = col ? columnIsNumeric(col, state.holds) : false;
    rows.sort((a, b) => {
      const group = (isManualHold(a.r) ? 0 : 1) - (isManualHold(b.r) ? 0 : 1);
      if (group) return group;
      if (!col) return a.i - b.i;
      return compareHoldCells(a.r, b.r, col, numeric, dir) || (a.i - b.i);
    });
    return rows.map((x) => x.r);
  }
  const HOLD_LAYOUT_KEY = "ops-standup:hold-layout";
  function holdLayout() {
    if (state.holdLayout) return state.holdLayout;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(HOLD_LAYOUT_KEY) || "{}") || {}; } catch (_) {}
    state.holdLayout = {
      order: Array.isArray(saved.order) ? saved.order : [],
      widths: saved.widths && typeof saved.widths === "object" ? saved.widths : {},
      rowH: Number(saved.rowH) >= 22 ? Number(saved.rowH) : 28,
    };
    return state.holdLayout;
  }
  function saveHoldLayout() {
    const l = holdLayout();
    localStorage.setItem(HOLD_LAYOUT_KEY, JSON.stringify({ order: l.order, widths: l.widths, rowH: l.rowH }));
  }
  function defaultHoldWidth(col) {
    if (/reason/i.test(col)) return 280;
    return Math.max(128, Math.min(200, Math.ceil(col.length * 7.4 + 72)));
  }
  function holdColWidth(col) {
    const n = Number(holdLayout().widths[col]);
    return n >= 48 ? n : defaultHoldWidth(col);
  }
  function visibleHoldCols() {
    const l = holdLayout();
    const known = new Set(state.holdCols);
    const order = (l.order || []).filter((c) => known.has(c));
    state.holdCols.forEach((c) => { if (!order.includes(c)) order.push(c); });
    l.order = order;
    return order;
  }
  function moveHoldCol(from, to) {
    if (!from || !to || from === to) return;
    const order = visibleHoldCols().slice();
    const i = order.indexOf(from);
    const j = order.indexOf(to);
    if (i < 0 || j < 0) return;
    order.splice(i, 1);
    order.splice(j, 0, from);
    holdLayout().order = order;
    saveHoldLayout();
    renderHolds();
  }
  function bindHoldResize(handle, begin) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.detail > 1) return;
      e.preventDefault();
      e.stopPropagation();
      const apply = begin(e);
      const move = (ev) => apply(ev);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveHoldLayout();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dragstart", (e) => e.preventDefault());
  }
  function renderHolds() {
    const host = $("page-holds");
    if (!host) return;
    host.innerHTML = "";
    if (!state.holdCols.length) {
      host.appendChild(el(`<div class="empty">No On Hold External Detail tab in this Sheet.</div>`));
      return;
    }
    const cols = visibleHoldCols();
    const rows = orderedHolds();
    const manual = rows.filter(isManualHold).length;
    const rest = rows.length - manual;
    const head = el(
      `<div class="page-head"><h2>${esc(findTab("On Hold External Detail") || "On Hold External Detail")}</h2>`
      + `<span class="legend">${manual} manual on top · ${rest} below. Drag ⋮⋮ to move a column. Drag an edge to resize. Drag the header bottom for row height. Click a heading to sort. Click a row to read it.</span></div>`
    );
    const reset = el(`<button type="button" class="linklike">Reset layout</button>`);
    reset.onclick = () => {
      state.holdLayout = { order: state.holdCols.slice(), widths: {}, rowH: 28 };
      saveHoldLayout();
      renderHolds();
    };
    head.appendChild(reset);
    host.appendChild(head);

    const wrap = el(`<div class="grid-wrap"></div>`);
    const table = document.createElement("table");
    table.className = "grid";
    const rowH = holdLayout().rowH;
    table.style.setProperty("--hold-row", rowH + "px");
    if (rowH > 34) table.classList.add("rows-wrap");
    const totalW = cols.reduce((sum, c) => sum + holdColWidth(c), 0);
    table.style.width = totalW + "px";

    const cg = document.createElement("colgroup");
    cols.forEach((c) => {
      const col = document.createElement("col");
      col.dataset.col = c;
      col.style.width = holdColWidth(c) + "px";
      cg.appendChild(col);
    });
    table.appendChild(cg);

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    cols.forEach((c) => {
      const th = document.createElement("th");
      th.className = "colhead";
      th.scope = "col";
      if (c === "PO Number") th.classList.add("sticky");
      const grip = document.createElement("span");
      grip.className = "grip";
      grip.textContent = "⋮⋮";
      grip.title = "Drag to move this column";
      grip.draggable = true;
      grip.addEventListener("dragstart", (e) => {
        state._holdDrag = c;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c);
        th.classList.add("dragging");
      });
      grip.addEventListener("dragend", () => { th.classList.remove("dragging"); state._holdDrag = ""; });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "colhead-btn";
      const label = document.createElement("span");
      label.textContent = c;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = state.holdSort.col === c ? (state.holdSort.dir < 0 ? "▼" : "▲") : "";
      btn.append(label, mark);
      btn.onclick = () => {
        if (state.holdSort.col === c) state.holdSort.dir = -state.holdSort.dir;
        else state.holdSort = { col: c, dir: 1 };
        renderHolds();
      };
      th.addEventListener("dragover", (e) => { e.preventDefault(); th.classList.add("drop"); });
      th.addEventListener("dragleave", () => th.classList.remove("drop"));
      th.addEventListener("drop", (e) => {
        e.preventDefault();
        th.classList.remove("drop");
        moveHoldCol(e.dataTransfer.getData("text/plain") || state._holdDrag, c);
      });
      const colEdge = document.createElement("span");
      colEdge.className = "col-resize";
      colEdge.title = "Drag to resize. Double-click to reset.";
      bindHoldResize(colEdge, (down) => {
        const base = holdColWidth(c);
        const x0 = down.clientX;
        return (ev) => {
          const w = Math.max(48, Math.round(base + ev.clientX - x0));
          holdLayout().widths[c] = w;
          const colEl = table.querySelector(`col[data-col="${CSS.escape(c)}"]`);
          if (colEl) colEl.style.width = w + "px";
          table.style.width = cols.reduce((sum, name) => sum + holdColWidth(name), 0) + "px";
        };
      });
      colEdge.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        delete holdLayout().widths[c];
        saveHoldLayout();
        renderHolds();
      });
      const rowEdge = document.createElement("span");
      rowEdge.className = "row-resize";
      rowEdge.title = "Drag to set row height. Double-click for one line.";
      bindHoldResize(rowEdge, (down) => {
        const base = holdLayout().rowH;
        const y0 = down.clientY;
        return (ev) => {
          const h = Math.max(22, Math.min(180, Math.round(base + ev.clientY - y0)));
          holdLayout().rowH = h;
          table.style.setProperty("--hold-row", h + "px");
          table.classList.toggle("rows-wrap", h > 34);
        };
      });
      rowEdge.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        holdLayout().rowH = 28;
        saveHoldLayout();
        renderHolds();
      });
      th.append(grip, btn, colEdge, rowEdge);
      hr.appendChild(th);
    });
    thead.appendChild(hr);

    const tb = document.createElement("tbody");
    let seenRest = false;
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      if (!isManualHold(r) && !seenRest) { tr.classList.add("hold-rest"); seenRest = true; }
      tr.addEventListener("click", () => tr.classList.toggle("open"));
      cols.forEach((c) => {
        const td = document.createElement("td");
        const v = r[c];
        const text = v == null ? "" : String(v);
        if (c === "PO Number") td.classList.add("sticky");
        if (columnIsNumeric(c, state.holds) && num(v) !== null) td.classList.add("num");
        td.textContent = text;
        if (text) td.title = text;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.append(thead, tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  // ───────────────────────── page 5: Company Volume Trends ─────────────────────────
  // The Sheet tab already has every week. This page keeps the week that
  // contains the pack date (10_3 → the week of 10/3) and shows the volume
  // columns that are already on that tab. Outlook is only a first read of
  // growth so the companies that are rising sit at the top.
  function volumeHeaderKey(col) {
    return String(col || "").toLowerCase().replace(/[_%]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function metricNum(v) {
    const s = String(v == null ? "" : v).trim().replace(/,/g, "");
    if (!s || looksLikeWeekLabel(s)) return null;
    const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*%?$/);
    return m ? Number(m[1]) : null;
  }
  function looksLikeWeekLabel(v) {
    const s = String(v || "").trim();
    if (!s) return false;
    if (/\d{4}\s*[- ]?w\d{1,2}/i.test(s)) return true;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(s)) return true;
    if (/week of/i.test(s)) return true;
    return false;
  }
  function columnShare(col, rows, pred) {
    const vals = rows.map((r) => String(r[col] == null ? "" : r[col]).trim()).filter(Boolean);
    if (!vals.length) return 0;
    return vals.filter(pred).length / vals.length;
  }
  function reportDateUtc() {
    const md = reportMonthDay();
    if (!md) {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
      const y = Number(parts.find((p) => p.type === "year").value);
      const m = Number(parts.find((p) => p.type === "month").value);
      const d = Number(parts.find((p) => p.type === "day").value);
      return new Date(Date.UTC(y, m - 1, d));
    }
    return new Date(Date.UTC(chicagoYear(md.month), md.month - 1, md.day));
  }
  function reportWeekWindow(report) {
    const monday = new Date(report.getTime());
    const day = monday.getUTCDay();
    monday.setUTCDate(monday.getUTCDate() + (day === 0 ? -6 : 1 - day));
    const start = new Date(monday.getTime());
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(monday.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
    return { monday: monday, start: start, end: end };
  }
  function formatMD(d) { return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); }
  function isoWeekParts(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week: week };
  }
  function parseLooseDate(v, report) {
    const s = String(v || "").trim();
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
    }
    m = s.match(/(\d{1,2})\/(\d{1,2})\b/);
    if (m && report) return new Date(Date.UTC(report.getUTCFullYear(), Number(m[1]) - 1, Number(m[2])));
    return null;
  }
  function weekCellInReportWeek(value, report) {
    const s = String(value || "").trim();
    const iso = s.match(/(\d{4})\s*[- ]?\s*w(\d{1,2})/i);
    if (iso) {
      const got = isoWeekParts(report);
      return Number(iso[1]) === got.year && Number(iso[2]) === got.week;
    }
    const parsed = parseLooseDate(s, report);
    if (!parsed) return false;
    const win = reportWeekWindow(report);
    return parsed >= win.start && parsed <= win.end;
  }
  function assignVolumeCols(cols, rows) {
    const byKey = new Map();
    cols.forEach((c) => { const k = volumeHeaderKey(c); if (!byKey.has(k)) byKey.set(k, c); });
    const used = new Set();
    function take(names) {
      for (let i = 0; i < names.length; i++) {
        const c = byKey.get(names[i]);
        if (c && !used.has(c)) { used.add(c); return c; }
      }
      return "";
    }
    let week = take(["week start", "week of", "week ending", "report week", "week label", "week start date"]);
    let current = take(["week volume", "week orders", "this week", "current week", "orders this week", "orders", "volume", "order count", "insoles", "qty"]);
    const prev = take(["prev week", "previous week", "prior week", "last week", "prev week orders", "previous week orders"]);
    const wow = take(["wow change", "wow changes", "wow", "week over week", "wow pct"]);
    const recent = take(["recent 4 weeks", "recent 4 week", "last 4 weeks", "trailing 4 weeks"]);
    const prior = take(["prior 4 weeks", "prior 4 week", "previous 4 weeks", "prior four weeks"]);
    const growth = take(["growth", "growth pct", "volume growth"]);
    const weekNamed = byKey.get("week");
    if (weekNamed && !used.has(weekNamed)) {
      const asWeeks = columnShare(weekNamed, rows, looksLikeWeekLabel);
      const asNums = columnShare(weekNamed, rows, (v) => metricNum(v) !== null);
      if (asWeeks >= 0.6 || asWeeks >= asNums) { week = weekNamed; used.add(weekNamed); }
      else if (!current) { current = weekNamed; used.add(weekNamed); }
    }
    if (!week) {
      const candidate = cols.find((c) => !used.has(c) && columnShare(c, rows, looksLikeWeekLabel) >= 0.6);
      if (candidate) { week = candidate; used.add(candidate); }
    }
    return { week: week, current: current, prev: prev, wow: wow, recent: recent, prior: prior, growth: growth };
  }
  function volumeDisplayCols(cols, picked) {
    const metrics = [picked.current, picked.prev, picked.wow, picked.recent, picked.prior, picked.growth].filter(Boolean);
    const skip = new Set(metrics);
    if (picked.week) skip.add(picked.week);
    const idFirst = [];
    const rest = [];
    cols.forEach((c) => {
      if (skip.has(c)) return;
      if (/company|clinic|account|customer|factory/.test(volumeHeaderKey(c))) idFirst.push(c);
      else rest.push(c);
    });
    const out = idFirst.slice();
    if (picked.week) out.push(picked.week);
    rest.forEach((c) => out.push(c));
    metrics.forEach((c) => out.push(c));
    return out;
  }
  function volumeOutlook(row, picked) {
    const g = picked.growth ? metricNum(row[picked.growth]) : null;
    const recent = picked.recent ? metricNum(row[picked.recent]) : null;
    const prior = picked.prior ? metricNum(row[picked.prior]) : null;
    const wow = picked.wow ? metricNum(row[picked.wow]) : null;
    const fourUp = recent != null && prior != null && recent > prior;
    const fourDown = recent != null && prior != null && recent < prior;
    if (g != null) {
      if (g > 0 && fourUp) return { kind: "grow", text: "Likely to grow" };
      if (g > 0) return { kind: "grow", text: "Up this week" };
      if (g < 0 && fourDown) return { kind: "slow", text: "Likely to slow" };
      if (g < 0) return { kind: "slow", text: "Down this week" };
      return { kind: "steady", text: "Steady" };
    }
    if (wow != null) {
      if (wow > 0 && fourUp) return { kind: "grow", text: "Likely to grow" };
      if (wow > 0) return { kind: "grow", text: "Up this week" };
      if (wow < 0 && fourDown) return { kind: "slow", text: "Likely to slow" };
      if (wow < 0) return { kind: "slow", text: "Down this week" };
      return { kind: "steady", text: "Steady" };
    }
    return { kind: "", text: "" };
  }
  function renderVolume() {
    const host = $("page-volume");
    if (!host) return;
    host.innerHTML = "";
    if (!state.volumeCols.length) {
      host.appendChild(el(`<div class="empty">No Company Volume Trends tab in this Sheet.</div>`));
      return;
    }
    const report = reportDateUtc();
    const win = reportWeekWindow(report);
    const picked = assignVolumeCols(state.volumeCols, state.volume);
    let rows = state.volume.slice();
    let filtered = false;
    if (picked.week) {
      filtered = true;
      rows = state.volume.filter((r) => weekCellInReportWeek(r[picked.week], report));
    }
    const weekLabel = formatMD(win.monday) + "–" + formatMD(win.end);
    const pack = reportMonthDay();
    const packLabel = pack ? (pack.month + "/" + pack.day) : "this pack";
    if (!rows.length) {
      const seen = [];
      state.volume.forEach((r) => {
        const v = picked.week ? String(r[picked.week] || "").trim() : "";
        if (v && !seen.includes(v)) seen.push(v);
      });
      const sample = seen.slice(0, 6).map(esc).join(", ");
      host.appendChild(el(
        `<div class="page-head"><h2>Company Volume Trends</h2></div>`
      ));
      host.appendChild(el(
        `<div class="empty">No rows for the week of ${esc(weekLabel)} (pack date ${esc(packLabel)}).`
        + (sample ? ` Week values on the Sheet include ${sample}.` : "")
        + `</div>`
      ));
      return;
    }
    rows.sort((a, b) => {
      const ga = picked.growth ? metricNum(a[picked.growth]) : null;
      const gb = picked.growth ? metricNum(b[picked.growth]) : null;
      if (ga == null && gb == null) return 0;
      if (ga == null) return 1;
      if (gb == null) return -1;
      return gb - ga;
    });
    const hidden = filtered ? state.volume.length - rows.length : 0;
    const legend = `Week of ${weekLabel} (pack date ${packLabel}). ${rows.length} ${rows.length === 1 ? "row" : "rows"}.`
      + (hidden ? ` ${hidden} other-week ${hidden === 1 ? "row stays" : "rows stay"} on the Sheet.` : " This tab has no other weeks.")
      + " Outlook is a first read from growth.";
    host.appendChild(el(`<div class="page-head"><h2>Company Volume Trends</h2><span class="legend">${legend}</span></div>`));
    const cols = volumeDisplayCols(state.volumeCols, picked);
    const signed = new Set([picked.wow, picked.growth].filter(Boolean));
    const wrap = el(`<div class="grid-wrap"></div>`);
    const table = document.createElement("table");
    table.className = "grid";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    cols.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c;
      hr.appendChild(th);
    });
    const outTh = document.createElement("th");
    outTh.textContent = "Outlook";
    hr.appendChild(outTh);
    thead.appendChild(hr);
    const tb = document.createElement("tbody");
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      cols.forEach((c) => {
        const td = document.createElement("td");
        const text = r[c] == null ? "" : String(r[c]);
        td.textContent = text;
        const n = metricNum(text);
        if (n !== null) td.classList.add("num");
        if (signed.has(c) && n > 0) td.classList.add("up");
        else if (signed.has(c) && n < 0) td.classList.add("down");
        tr.appendChild(td);
      });
      const outlook = volumeOutlook(r, picked);
      const td = document.createElement("td");
      if (outlook.text) td.appendChild(el(`<span class="pill ${outlook.kind}">${esc(outlook.text)}</span>`));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.append(thead, tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  // ───────────────────────── shell ─────────────────────────
  function showPage(p) {
    state.page = p;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.page === p));
    $("page-summary").hidden = p !== "summary";
    $("page-delinquency").hidden = p !== "delinquency";
    $("page-people").hidden = p !== "people";
    $("page-holds").hidden = p !== "holds";
    $("page-volume").hidden = p !== "volume";
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
      renderSummary(); renderDelinquency(); renderPeople(); renderHolds(); renderVolume();
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

    // Only the nightly pack carries the Delinquency Detail and Notes tabs that
    // the PO drawers and notes read. Other files named "Ops Standup" (an Excel
    // attachment opened in Google Sheets, a copy, another team's export) can
    // sit above the pack in Drive. Walk newest → oldest and open the first
    // file that really is the pack, so a stray copy never hides the clicks.
    const looksLikePack = (tabs) =>
      tabs.some((t) => t === "Ops Summary" || t.endsWith(" Ops Summary") || t === "Delinquency by Station" || t.endsWith(" Delinquency by Station"))
      && tabs.some((t) => t === "Delinquency Detail" || t.endsWith(" Delinquency Detail") || t === NOTES_TAB);
    for (const f of files) {
      try {
        const meta = await api(`${SHEETS_API}/${f.id}?fields=sheets.properties.title`);
        const tabs = (meta.sheets || []).map((s) => s.properties.title);
        if (looksLikePack(tabs)) return f.id;
      } catch (_) { /* not readable as a Sheet; try the next one */ }
    }
    // Nothing had the pack tabs. Open the newest one so the error on screen
    // still names the real Sheet instead of failing silently.
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
