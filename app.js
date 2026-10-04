/* Ops Standup shell.
 *
 * Static page. Reads one night's "Ops Standup" Google Sheet with the signed-in
 * user's own Google credentials (Sheets API v4) and renders:
 *   page 1  Ops Summary            — same columns as the Sheet + a Notes column
 *   page 2  Delinquency by Station — same columns as the Sheet; every number
 *           opens the POs behind it (from the "Delinquency Detail" tab), each PO
 *           links to its workbench, and notes can be written per PO or per row.
 *   page 4  On Hold External       — same columns as the Sheet; a PO opens its
 *           workbench when the id is known from this Sheet.
 *   page 5  Company Volume Trends  — the present week only, from the tab that
 *           already has every week. A company opens its history, trend,
 *           next-week read and month totals.
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
  // PO Number → workbench. The Hold tab has no workbench_id of its own, so the
  // id comes from a workbench column if one exists, else from the same PO on
  // Delinquency Detail / OTS / TAT in this Sheet. POs found nowhere stay text.
  function isPoCol(col) { return /^po[ _]?(number|num|no)?$/i.test(String(col || "").trim()); }
  function workbenchIndex() {
    const map = new Map();
    const put = (po, wb) => {
      const k = String(po || "").trim().toLowerCase();
      if (k && wb && !map.has(k)) map.set(k, String(wb).trim());
    };
    state.detail.forEach((d) => put(d.po_number, d.workbench_id));
    state.orders.forEach((o) => put(o.po_number, o.workbench_id));
    return map;
  }
  function holdWorkbench(row, po, index) {
    const own = Object.keys(row).find((c) => /workbench/i.test(c) && String(row[c] || "").trim());
    if (own) return String(row[own]).trim();
    return index.get(String(po || "").trim().toLowerCase()) || "";
  }
  function renderHolds() {
    const host = $("page-holds");
    if (!host) return;
    host.innerHTML = "";
    const wbIndex = workbenchIndex();
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
      + `<span class="legend">${manual} manual on top · ${rest} below. Click a PO to open its workbench. Drag ⋮⋮ to move a column. Drag an edge to resize. Drag the header bottom for row height. Click a heading to sort. Click a row to read it.</span></div>`
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
        const wb = text && isPoCol(c) ? holdWorkbench(r, text, wbIndex) : "";
        if (wb) {
          const a = document.createElement("a");
          a.href = `${CFG.WORKBENCH_BASE}/${encodeURIComponent(wb)}`;
          a.target = "_blank";
          a.rel = "noopener";
          a.className = "po-link";
          a.textContent = text;
          a.title = "Open the workbench for " + text;
          a.addEventListener("click", (e) => e.stopPropagation());
          td.appendChild(a);
        } else {
          td.textContent = text;
          if (text) td.title = isPoCol(c) ? text + " — no workbench id on this Sheet" : text;
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.append(thead, tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  // ───────────────────────── page 5: Company Volume Trends ─────────────────────────
  // The Sheet tab already has every week for every company. The table keeps
  // the present week and shows every column the Sheet has, with Orders as the
  // main number. Clicking a company opens its history: orders by week, the
  // fitted trend, a next-week read, and month totals. Nothing is written back.
  function volumeHeaderKey(col) {
    return String(col || "").toLowerCase().replace(/[_%]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function metricNum(v) {
    const s = String(v == null ? "" : v).trim().replace(/,/g, "");
    if (!s) return null;
    const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*%?$/);
    return m ? Number(m[1]) : null;
  }
  function looksLikeWeekLabel(v) {
    const s = String(v || "").trim();
    if (!s) return false;
    if (/\d{4}\s*[- ]?w\d{1,2}/i.test(s)) return true;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(s)) return true;
    if (/week/i.test(s)) return true;
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
  function mondayOf(date) {
    const monday = new Date(date.getTime());
    const day = monday.getUTCDay();
    monday.setUTCDate(monday.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return monday;
  }
  function reportWeekWindow(report) {
    const monday = mondayOf(report);
    const start = new Date(monday.getTime());
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(monday.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
    return { monday: monday, start: start, end: end };
  }
  function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
  function formatMD(d) { return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); }
  function isoWeekMonday(year, week) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const day = jan4.getUTCDay() || 7;
    return addDays(jan4, (1 - day) + (week - 1) * 7);
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
    m = s.match(/^(\d{1,2})\/(\d{1,2})\b/);
    if (m && report) return new Date(Date.UTC(report.getUTCFullYear(), Number(m[1]) - 1, Number(m[2])));
    m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
    if (m) {
      const t = Date.parse(m[1] + " " + m[2] + ", " + (m[3] || (report ? report.getUTCFullYear() : new Date().getUTCFullYear())) + " UTC");
      if (!isNaN(t)) return new Date(t);
    }
    return null;
  }
  // A Week cell → a sortable key plus (when the cell is a date) the Monday it
  // stands for. Week numbers with no date still sort, so the latest one wins.
  function weekOf(value, report) {
    const s = String(value == null ? "" : value).trim();
    if (!s) return null;
    const iso = s.match(/(\d{4})\s*[- ]?\s*w(\d{1,2})/i);
    if (iso) {
      const d = isoWeekMonday(Number(iso[1]), Number(iso[2]));
      return { key: d.getTime(), date: d, label: s };
    }
    const d = parseLooseDate(s, report);
    if (d) return { key: mondayOf(d).getTime(), date: mondayOf(d), label: s };
    const n = s.match(/(\d+(?:\.\d+)?)/);
    if (n) return { key: Number(n[1]), date: null, label: s };
    return null;
  }
  function assignVolumeCols(cols, rows, report) {
    const byKey = new Map();
    cols.forEach((c) => { const k = volumeHeaderKey(c); if (!byKey.has(k)) byKey.set(k, c); });
    const used = new Set();
    const share = (c, pred) => columnShare(c, rows, pred);
    function take(names) {
      for (let i = 0; i < names.length; i++) {
        const c = byKey.get(names[i]);
        if (c && !used.has(c)) { used.add(c); return c; }
      }
      return "";
    }
    let week = take(["week", "week start", "week of", "week ending", "report week", "week label", "week start date", "wk", "week beginning"]);
    if (week && share(week, (v) => weekOf(v, report) !== null) < 0.5) { used.delete(week); week = ""; }
    if (!week) {
      const cand = cols.find((c) => !used.has(c) && share(c, looksLikeWeekLabel) >= 0.6);
      if (cand) { week = cand; used.add(cand); }
    }
    let company = take(["company", "company name", "clinic", "clinic name", "account", "account name", "customer", "customer name", "client", "practice", "name"]);
    if (!company) {
      company = cols.find((c) => !used.has(c) && share(c, (v) => metricNum(v) === null && !looksLikeWeekLabel(v)) >= 0.8) || "";
      if (company) used.add(company);
    }
    const prev = take(["prev week", "previous week", "prior week", "last week", "prev week orders", "previous week orders", "prev"]);
    const wow = take(["wow change", "wow changes", "wow", "week over week", "wow pct", "wow change pct"]);
    const recent = take(["recent 4 weeks", "recent 4 week", "recent 4 wks", "last 4 weeks", "trailing 4 weeks", "recent 4"]);
    const prior = take(["prior 4 weeks", "prior 4 week", "prior 4 wks", "previous 4 weeks", "prior four weeks", "prior 4"]);
    const growth = take(["growth", "growth pct", "volume growth", "4 week growth", "4wk growth"]);
    let orders = take(["orders", "order count", "orders this week", "week orders", "this week", "this week orders", "current week", "week volume", "volume", "insoles", "qty", "count", "total orders", "total"]);
    if (!orders) {
      orders = cols.find((c) => !used.has(c) && share(c, (v) => metricNum(v) !== null) >= 0.8) || "";
      if (orders) used.add(orders);
    }
    return { week: week, company: company, orders: orders, prev: prev, wow: wow, recent: recent, prior: prior, growth: growth };
  }
  // Everything the page and the drawer need, computed once per render.
  function volumeModel() {
    const report = reportDateUtc();
    const picked = assignVolumeCols(state.volumeCols, state.volume, report);
    const rowWeek = new Map();
    const weeksByKey = new Map();
    state.volume.forEach((r) => {
      const w = picked.week ? weekOf(r[picked.week], report) : null;
      if (!w) return;
      rowWeek.set(r, w.key);
      if (!weeksByKey.has(w.key)) weeksByKey.set(w.key, w);
    });
    let weeks = [...weeksByKey.values()].sort((a, b) => a.key - b.key);
    let current = null;
    if (weeks.length) {
      const win = reportWeekWindow(report);
      const inWin = weeks.filter((w) => w.date && w.date >= win.start && w.date <= win.end);
      const before = weeks.filter((w) => w.date && w.date <= report);
      current = inWin.length ? inWin[inWin.length - 1] : before.length ? before[before.length - 1] : weeks[weeks.length - 1];
      // Rows for weeks after the present one stay on the Sheet and out of
      // every history, chart and month total here.
      weeks = weeks.filter((w) => w.key <= current.key);
    }
    const idx = current ? weeks.indexOf(current) : -1;
    const prevWeek = idx > 0 ? weeks[idx - 1] : null;
    const companyOf = (r) => String(picked.company ? r[picked.company] : "").trim();
    const ordersOf = (r) => { const n = picked.orders ? metricNum(r[picked.orders]) : null; return n == null ? 0 : n; };
    const rowsForWeek = (w) => (w ? state.volume.filter((r) => rowWeek.get(r) === w.key) : state.volume.slice());
    // Business days of the present week already in the pack. The pack is built
    // overnight, so a 9/29 pack carries orders through Monday 9/28.
    let bdIn = 5;
    let through = null;
    if (current && current.date) {
      through = addDays(report, -1);
      const end = addDays(current.date, 4);
      if (through >= end) bdIn = 5;
      else if (through < current.date) bdIn = 0;
      else bdIn = Math.min(5, Math.max(0, Math.floor((through - current.date) / 86400000) + 1));
    }
    return { report: report, picked: picked, weeks: weeks, current: current, prevWeek: prevWeek, rowWeek: rowWeek, companyOf: companyOf, ordersOf: ordersOf, rowsForWeek: rowsForWeek, bdIn: bdIn, through: through };
  }
  // ALL Clinical and ALL Consumer are totals the Sheet already computed.
  // Adding them on top of the companies counts every order twice.
  function isRollupRow(row) {
    return state.volumeCols.some((c) => {
      const s = String(row[c] == null ? "" : row[c]).trim().toLowerCase();
      return s === "all" || s.startsWith("all ");
    });
  }
  function volumeHistory(model, company) {
    return model.weeks.map((w) => {
      let orders = 0;
      let rows = 0;
      state.volume.forEach((r) => {
        if (isRollupRow(r)) return;
        if (model.rowWeek.get(r) !== w.key) return;
        if (company != null && model.companyOf(r) !== company) return;
        orders += model.ordersOf(r);
        rows += 1;
      });
      return { key: w.key, date: w.date, label: w.label, orders: orders, rows: rows, current: model.current && w.key === model.current.key };
    }).filter((h) => h.rows > 0 || h.current);
  }
  // New from the first week on the Sheet until one month after that week.
  function isNewCompany(model, name) {
    if (!model.current || !model.current.date) return false;
    const first = volumeHistory(model, name).find((h) => h.date && h.rows > 0);
    if (!first) return false;
    const end = new Date(Date.UTC(first.date.getUTCFullYear(), first.date.getUTCMonth() + 1, first.date.getUTCDate()));
    return model.current.date < end;
  }
  function linearFit(ys) {
    const n = ys.length;
    if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    ys.forEach((y, x) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const den = n * sxx - sx * sx;
    const slope = den ? (n * sxy - sx * sy) / den : 0;
    return { slope: slope, intercept: (sy - slope * sx) / n };
  }
  function pctChange(now, before) {
    if (before == null || now == null || !before) return null;
    return (now - before) / before * 100;
  }
  function fmtPct(p, digits) {
    if (p == null || !isFinite(p)) return "—";
    const d = digits == null ? 1 : digits;
    return (p > 0 ? "+" : "") + p.toFixed(d) + "%";
  }
  function fmtInt(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-US"); }
  function signClass(n) { return n > 0 ? "vol-up" : n < 0 ? "vol-down" : "vol-flat"; }
  function weekLabelOf(w) { return w ? (w.date ? "week of " + formatMD(w.date) : w.label) : ""; }
  function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
  // The numbers the drawer leads with. A single Sheet row keeps the Sheet's own
  // Prev Week / WoW / 4-week values. Several rows (or All companies) are summed
  // from Orders so every company is measured the same way.
  function volumeStats(model, hist, sheetRows) {
    const n = hist.length;
    const cur = hist.findIndex((h) => h.current);
    const i = cur >= 0 ? cur : n - 1;
    const thisWeek = i >= 0 ? hist[i].orders : 0;
    const prevWeek = i > 0 ? hist[i - 1].orders : null;
    const recent4 = i >= 0 ? sum(hist.slice(Math.max(0, i - 3), i + 1).map((h) => h.orders)) : null;
    const prior4 = i >= 4 ? sum(hist.slice(Math.max(0, i - 7), i - 3).map((h) => h.orders)) : null;
    const out = {
      thisWeek: thisWeek, prevWeek: prevWeek, wow: pctChange(thisWeek, prevWeek),
      recent4: recent4, prior4: prior4, growth: pctChange(recent4, prior4), fromSheet: false,
    };
    const p = model.picked;
    if (sheetRows.length === 1) {
      const r = sheetRows[0];
      const pick = (col, fallback) => { const v = col ? metricNum(r[col]) : null; return v == null ? fallback : v; };
      out.thisWeek = pick(p.orders, thisWeek);
      out.prevWeek = pick(p.prev, prevWeek);
      out.wow = p.wow && metricNum(r[p.wow]) != null ? metricNum(r[p.wow]) : pctChange(out.thisWeek, out.prevWeek);
      out.recent4 = pick(p.recent, recent4);
      out.prior4 = pick(p.prior, prior4);
      out.growth = p.growth && metricNum(r[p.growth]) != null ? metricNum(r[p.growth]) : pctChange(out.recent4, out.prior4);
      out.fromSheet = true;
    }
    // Trend over the last 8 weeks and the read for next week.
    const tail = hist.slice(Math.max(0, i - 7), i + 1).map((h) => h.orders);
    const fit = linearFit(tail);
    out.slope = tail.length >= 3 ? fit.slope : 0;
    out.forecast = tail.length >= 3 ? Math.max(0, Math.round(fit.intercept + fit.slope * tail.length)) : null;
    out.fitStart = Math.max(0, i - 7);
    out.fit = fit;
    out.avg = n ? sum(hist.map((h) => h.orders)) / n : 0;
    const best = hist.reduce((b, h) => (!b || h.orders > b.orders ? h : b), null);
    out.best = best;
    let streak = 0;
    for (let k = i; k > 0; k--) {
      const d = hist[k].orders - hist[k - 1].orders;
      if (!d) break;
      if (streak === 0) streak = d > 0 ? 1 : -1;
      else if ((streak > 0) === (d > 0)) streak += d > 0 ? 1 : -1;
      else break;
    }
    out.streak = streak;
    let upOf4 = 0, cmp4 = 0;
    for (let k = Math.max(1, i - 3); k <= i; k++) { cmp4 += 1; if (hist[k].orders > hist[k - 1].orders) upOf4 += 1; }
    out.upOf4 = upOf4; out.cmp4 = cmp4;
    // Pace needs at least two business days in; one day is too thin to scale.
    out.pace = model.bdIn >= 2 && model.bdIn < 5 && model.current && model.current.date ? Math.round(out.thisWeek / model.bdIn * 5) : null;
    return out;
  }
  // Growth inside ±5% is noise, so it reads Steady. Beyond that, the 8-week
  // slope says whether the move is a trend or a one-week bump.
  const STEADY_BAND = 5;
  function volumeOutlook(stats) {
    const g = stats.growth;
    const wow = stats.wow;
    const up = stats.slope > 0;
    const down = stats.slope < 0;
    if (g != null) {
      if (Math.abs(g) < STEADY_BAND) return { kind: "steady", text: "Steady" };
      if (g > 0 && up) return { kind: "grow", text: "Likely to grow" };
      if (g > 0) return { kind: "grow", text: "Up, trend flat" };
      if (g < 0 && down) return { kind: "slow", text: "Likely to slow" };
      return { kind: "slow", text: "Down, trend holding" };
    }
    if (wow != null) {
      if (Math.abs(wow) < STEADY_BAND) return { kind: "steady", text: "Steady" };
      if (wow > 0 && up) return { kind: "grow", text: "Likely to grow" };
      if (wow > 0) return { kind: "grow", text: "Up this week" };
      if (wow < 0 && down) return { kind: "slow", text: "Likely to slow" };
      return { kind: "slow", text: "Down this week" };
    }
    return { kind: "steady", text: "No history yet" };
  }
  function monthTotals(hist) {
    if (!hist.some((h) => h.date)) return [];
    const byMonth = new Map();
    hist.forEach((h) => {
      if (!h.date) return;
      const k = h.date.getUTCFullYear() * 100 + h.date.getUTCMonth();
      let m = byMonth.get(k);
      if (!m) {
        m = { key: k, label: h.date.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }), orders: 0, weeks: 0, partial: false };
        byMonth.set(k, m);
      }
      m.orders += h.orders; m.weeks += 1;
      if (h.current) m.partial = true;
    });
    const months = [...byMonth.values()].sort((a, b) => a.key - b.key);
    // Months compare on orders per week, so a month with one week on the
    // Sheet (or the month still running) is not read against a full one.
    months.forEach((m) => { m.perWeek = m.weeks ? m.orders / m.weeks : 0; });
    months.forEach((m, i) => { m.change = i > 0 ? pctChange(m.perWeek, months[i - 1].perWeek) : null; });
    return months;
  }
  function volumeChart(hist, stats) {
    const n = hist.length;
    const hasForecast = stats.forecast != null;
    const barW = n > 30 ? 12 : n > 18 ? 18 : 28;
    const gap = n > 30 ? 4 : 8;
    const left = 40, top = 28, plotH = 170, bottom = 40;
    const slots = n + (hasForecast ? 1 : 0);
    const width = left + slots * (barW + gap) + 16;
    const height = top + plotH + bottom;
    const max = Math.max(1, Math.max.apply(null, hist.map((h) => h.orders).concat([stats.forecast || 0])));
    const svg = svgEl("svg", { class: "vol-chart", viewBox: "0 0 " + width + " " + height, width: width, height: height, role: "img" });
    svg.appendChild(svgEl("title", {})).textContent = "Orders by week";
    const baseline = top + plotH;
    const yOf = (v) => baseline - Math.round((v / max) * (plotH - 10));
    const xOf = (i) => left + i * (barW + gap);
    [0, 0.5, 1].forEach((f) => {
      const y = yOf(max * f);
      svg.appendChild(svgEl("line", { x1: left - 4, y1: y, x2: width - 8, y2: y, class: f ? "vol-grid" : "trend-base" }));
      const t = svgEl("text", { x: left - 8, y: y + 4, class: "bar-time", "text-anchor": "end" });
      t.textContent = String(Math.round(max * f));
      svg.appendChild(t);
    });
    const every = Math.max(1, Math.ceil(n / 10));
    hist.forEach((h, i) => {
      const x = xOf(i);
      const y = yOf(h.orders);
      svg.appendChild(svgEl("rect", { x: x, y: y, width: barW, height: Math.max(baseline - y, h.orders ? 2 : 0), rx: 3, class: "vol-bar" + (h.current ? " current" : "") }));
      if (n <= 20 || h.current || h === stats.best) {
        const t = svgEl("text", { x: x + barW / 2, y: Math.max(14, y - 6), class: "bar-time", "text-anchor": "middle", stroke: "#fff", "stroke-width": "3", "paint-order": "stroke" });
        t.textContent = String(h.orders);
        svg.appendChild(t);
      }
      if (i % every === 0 || h.current || i === n - 1) {
        const d = svgEl("text", { x: x + barW / 2, y: baseline + 16, class: "bar-time", "text-anchor": "middle" });
        d.textContent = h.date ? formatMD(h.date) : h.label;
        svg.appendChild(d);
      }
    });
    if (stats.fit && n >= 3) {
      const s = stats.fitStart;
      const endIdx = hasForecast ? n : n - 1;
      const pts = [];
      for (let i = s; i <= endIdx; i++) {
        const v = stats.fit.intercept + stats.fit.slope * (i - s);
        pts.push((xOf(i) + barW / 2) + "," + yOf(Math.max(0, Math.min(max, v))));
      }
      svg.appendChild(svgEl("polyline", { points: pts.join(" "), class: "vol-trend" }));
    }
    if (hasForecast) {
      const x = xOf(n);
      const y = yOf(stats.forecast);
      svg.appendChild(svgEl("rect", { x: x, y: y, width: barW, height: Math.max(baseline - y, 2), rx: 3, class: "vol-bar forecast" }));
      const t = svgEl("text", { x: x + barW / 2, y: Math.max(14, y - 6), class: "bar-time", "text-anchor": "middle" });
      t.textContent = "~" + stats.forecast;
      svg.appendChild(t);
      const d = svgEl("text", { x: x + barW / 2, y: baseline + 16, class: "bar-time", "text-anchor": "middle" });
      d.textContent = "next";
      svg.appendChild(d);
    }
    return svg;
  }
  function volumeRead(model, stats, hist) {
    const out = [];
    const cur = model.current;
    const throughTxt = model.through && cur && cur.date ? (model.bdIn >= 5 ? "full week" : `through ${formatMD(model.through)}, ${model.bdIn} of 5 business days`) : "";
    out.push({ cls: "", text: `${weekLabelOf(cur) ? weekLabelOf(cur).replace(/^w/, "W") : "This week"}: ${fmtInt(stats.thisWeek)} orders${throughTxt ? " (" + throughTxt + ")" : ""}.` });
    if (stats.prevWeek != null) {
      const d = stats.thisWeek - stats.prevWeek;
      out.push({ cls: signClass(d), text: `${d >= 0 ? "Up" : "Down"} ${fmtInt(Math.abs(d))} vs ${weekLabelOf(model.prevWeek) || "the previous week"} (${fmtInt(stats.prevWeek)}), ${fmtPct(stats.wow)} week over week.` });
    }
    if (stats.pace != null && stats.prevWeek != null) {
      const vs = pctChange(stats.pace, stats.prevWeek);
      out.push({ cls: signClass(vs), text: `On pace for about ${fmtInt(stats.pace)} this week if the rest of Mon–Fri matches so far (${fmtPct(vs)} vs last week). Early read with ${model.bdIn} days in.` });
    }
    if (stats.recent4 != null && stats.prior4 != null) {
      out.push({ cls: signClass(stats.growth), text: `Recent 4 weeks ${fmtInt(stats.recent4)} vs prior 4 weeks ${fmtInt(stats.prior4)}: ${fmtPct(stats.growth)} growth.` });
    }
    if (stats.streak >= 2) out.push({ cls: "vol-up", text: `Up ${stats.streak} weeks in a row.` });
    else if (stats.streak <= -2) out.push({ cls: "vol-down", text: `Down ${-stats.streak} weeks in a row.` });
    else if (stats.cmp4 >= 2) out.push({ cls: "", text: `Up in ${stats.upOf4} of the last ${stats.cmp4} weeks.` });
    if (hist.length >= 2) {
      out.push({ cls: "", text: `Average ${fmtInt(stats.avg)} orders a week over ${hist.length} weeks on the Sheet${stats.best ? `; best week ${fmtInt(stats.best.orders)} (${stats.best.date ? formatMD(stats.best.date) : stats.best.label})` : ""}.` });
    }
    if (stats.forecast != null) {
      const perWeek = stats.slope;
      out.push({ cls: signClass(perWeek), text: `Next week read: about ${fmtInt(stats.forecast)} orders. The last ${Math.min(8, hist.length)} weeks trend ${perWeek >= 0 ? "+" : ""}${perWeek.toFixed(1)} orders a week.` });
    } else {
      out.push({ cls: "vol-flat", text: "Not enough weeks on the Sheet yet for a next-week read (needs 3)." });
    }
    return out;
  }
  function openVolumeDrawer(model, company) {
    const all = company == null;
    const hist = volumeHistory(model, all ? null : company);
    const sheetRows = model.rowsForWeek(model.current).filter((r) => all || model.companyOf(r) === company);
    const stats = volumeStats(model, hist, sheetRows);
    const outlook = volumeOutlook(stats);
    $("drawer-title").textContent = all ? "All companies" : company;
    if (!all && isNewCompany(model, company)) $("drawer-title").appendChild(el(` <span class="pill new">New</span>`));
    $("drawer-sub").textContent = `${weekLabelOf(model.current) ? "Week of " + formatMD(model.current.date || model.report) : "Present week"} · ${fmtInt(stats.thisWeek)} orders · ${fmtPct(stats.wow)} vs previous week`;
    const body = $("drawer-body"); body.innerHTML = "";

    const head = el(`<div class="vol-head"><span class="pill ${outlook.kind}">${esc(outlook.text)}</span><span class="muted">${stats.fromSheet ? "Prev week, WoW and 4-week numbers are the Sheet's own." : "Prev week, WoW and 4-week numbers are summed from Orders on the Sheet."}</span></div>`);
    body.appendChild(head);

    const tiles = [
      ["Orders this week", fmtInt(stats.thisWeek), ""],
      ["Prev week", fmtInt(stats.prevWeek), ""],
      ["WoW change", fmtPct(stats.wow), signClass(stats.wow)],
      ["Recent 4 weeks", fmtInt(stats.recent4), ""],
      ["Prior 4 weeks", fmtInt(stats.prior4), ""],
      ["Growth", fmtPct(stats.growth), signClass(stats.growth)],
    ];
    const grid = el(`<div class="vol-stats"></div>`);
    tiles.forEach(([k, v, cls]) => grid.appendChild(el(`<div class="vol-stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`)));
    body.appendChild(grid);

    body.appendChild(el(`<div class="section-title">Read</div>`));
    const ul = el(`<ul class="vol-read"></ul>`);
    volumeRead(model, stats, hist).forEach((line) => ul.appendChild(el(`<li class="${line.cls}">${esc(line.text)}</li>`)));
    body.appendChild(ul);

    body.appendChild(el(`<div class="section-title">Orders by week</div>`));
    const card = el(`<div class="chart-card"></div>`);
    if (hist.length) {
      card.appendChild(volumeChart(hist, stats));
      card.appendChild(el(`<div class="muted small vol-key"><span class="sw cur"></span> present week &nbsp; <span class="sw bar"></span> earlier weeks &nbsp; <span class="sw fc"></span> next-week read &nbsp; <span class="sw tr"></span> trend over the last ${Math.min(8, hist.length)} weeks</div>`));
    } else {
      card.appendChild(el(`<div class="empty">No week rows on the Sheet for this company.</div>`));
    }
    body.appendChild(card);

    const months = monthTotals(hist);
    if (months.length) {
      body.appendChild(el(`<div class="section-title">By month</div>`));
      const t = el(`<table class="vol-table"><thead><tr><th>Month</th><th class="num">Orders</th><th class="num">Weeks</th><th class="num">Per week</th><th class="num">Per week vs prior month</th></tr></thead><tbody></tbody></table>`);
      const tb = t.querySelector("tbody");
      months.slice(-8).forEach((m) => {
        tb.appendChild(el(`<tr><td>${esc(m.label)}${m.partial ? ' <span class="muted">(so far)</span>' : ""}</td><td class="num">${fmtInt(m.orders)}</td><td class="num">${m.weeks}</td><td class="num">${fmtInt(m.perWeek)}</td><td class="num ${signClass(m.change)}">${fmtPct(m.change, 0)}</td></tr>`));
      });
      body.appendChild(t);
    }

    if (sheetRows.length && !all) {
      body.appendChild(el(`<div class="section-title">On the Sheet this week</div>`));
      sheetRows.forEach((r) => {
        const dl = el(`<div class="po-card vol-row"></div>`);
        state.volumeCols.forEach((c) => {
          const v = r[c] == null ? "" : String(r[c]);
          if (v === "") return;
          dl.appendChild(el(`<div class="kv"><span class="k">${esc(c)}</span><span class="v">${esc(v)}</span></div>`));
        });
        body.appendChild(dl);
      });
    }
    if (all) {
      body.appendChild(el(`<div class="section-title">Companies this week</div>`));
      const list = el(`<table class="vol-table"><thead><tr><th>Company</th><th class="num">Orders</th><th class="num">Prev week</th><th class="num">WoW</th><th>Outlook</th></tr></thead><tbody></tbody></table>`);
      const tb = list.querySelector("tbody");
      const names = [...new Set(model.rowsForWeek(model.current).filter((r) => !isRollupRow(r)).map(model.companyOf))].filter(Boolean);
      const items = names.map((name) => {
        const h = volumeHistory(model, name);
        const s = volumeStats(model, h, model.rowsForWeek(model.current).filter((r) => model.companyOf(r) === name));
        return { name: name, s: s, o: volumeOutlook(s) };
      }).sort((a, b) => b.s.thisWeek - a.s.thisWeek);
      items.forEach((it) => {
        const tr = el(`<tr><td><button type="button" class="linklike">${esc(it.name)}</button>${isNewCompany(model, it.name) ? ' <span class="pill new">New</span>' : ""}</td><td class="num">${fmtInt(it.s.thisWeek)}</td><td class="num">${fmtInt(it.s.prevWeek)}</td><td class="num ${signClass(it.s.wow)}">${fmtPct(it.s.wow)}</td><td><span class="pill ${it.o.kind}">${esc(it.o.text)}</span></td></tr>`);
        tr.querySelector("button").onclick = () => openVolumeDrawer(model, it.name);
        tb.appendChild(tr);
      });
      body.appendChild(list);
    }
    $("drawer").hidden = false; $("scrim").hidden = false;
    $("drawer-body").scrollTop = 0;
  }
  function renderVolume() {
    const host = $("page-volume");
    if (!host) return;
    host.innerHTML = "";
    if (!state.volumeCols.length) {
      host.appendChild(el(`<div class="empty">No Company Volume Trends tab in this Sheet.</div>`));
      return;
    }
    const model = volumeModel();
    const p = model.picked;
    const rows = model.rowsForWeek(model.current);
    const pack = reportMonthDay();
    const packLabel = pack ? (pack.month + "/" + pack.day) : "today";
    if (!rows.length) {
      host.appendChild(el(`<div class="page-head"><h2>Company Volume Trends</h2></div>`));
      host.appendChild(el(`<div class="empty">No rows on the Sheet for the present week (pack ${esc(packLabel)}).${p.week ? "" : " No Week column was found; headers are " + esc(state.volumeCols.join(", ")) + "."}</div>`));
      return;
    }
    const companyRows = rows.filter((r) => !isRollupRow(r));
    const rollupRows = rows.filter(isRollupRow);
    const weekTxt = model.current ? (model.current.date ? `Week of ${formatMD(model.current.date)}–${formatMD(addDays(model.current.date, 4))}` : `Week ${esc(model.current.label)}`) : "All rows";
    const prevTxt = model.prevWeek ? ` compared with ${weekLabelOf(model.prevWeek)}` : "";
    const throughTxt = model.through && model.current && model.current.date ? (model.bdIn >= 5 ? "" : `, ${model.bdIn} of 5 business days in (through ${formatMD(model.through)})`) : "";
    const hidden = state.volume.length - rows.length;
    const legend = `${weekTxt} (pack ${packLabel})${prevTxt}${throughTxt}. ${companyRows.length} ${companyRows.length === 1 ? "company" : "companies"}`
      + (rollupRows.length ? `. ${rollupRows.length} ALL ${rollupRows.length === 1 ? "total is" : "totals are"} shown separately and not added in.` : "")
      + (hidden ? ` ${hidden} other-week ${hidden === 1 ? "row stays" : "rows stay"} on the Sheet.` : "")
      + " Click a company for its history and next-week read.";
    host.appendChild(el(`<div class="page-head"><h2>Company Volume Trends</h2><span class="legend">${legend}</span></div>`));

    // Overview sums companies only. ALL Clinical / ALL Consumer stay out.
    const allHist = volumeHistory(model, null);
    const allStats = volumeStats(model, allHist, []);
    const companies = [...new Set(companyRows.map(model.companyOf))].filter(Boolean);
    const perCompany = companies.map((name) => {
      const h = volumeHistory(model, name);
      const own = companyRows.filter((r) => model.companyOf(r) === name);
      const s = volumeStats(model, h, own);
      return { name: name, stats: s, outlook: volumeOutlook(s), isNew: isNewCompany(model, name) };
    });
    const rising = perCompany.filter((c) => c.outlook.kind === "grow").length;
    const falling = perCompany.filter((c) => c.outlook.kind === "slow").length;
    const strip = el(`<div class="vol-overview"></div>`);
    const total = el(`<button type="button" class="vol-card clickable"><div class="k">All companies · orders this week</div><div class="v">${fmtInt(allStats.thisWeek)}</div><div class="d ${signClass(allStats.wow)}">${fmtPct(allStats.wow)} vs ${weekLabelOf(model.prevWeek) || "previous week"} (${fmtInt(allStats.prevWeek)})</div></button>`);
    total.title = "Open the overall history";
    total.onclick = () => openVolumeDrawer(model, null);
    strip.appendChild(total);
    strip.appendChild(el(`<div class="vol-card"><div class="k">Recent 4 vs prior 4 weeks</div><div class="v ${signClass(allStats.growth)}">${fmtPct(allStats.growth)}</div><div class="d muted">${fmtInt(allStats.recent4)} vs ${fmtInt(allStats.prior4)}</div></div>`));
    strip.appendChild(el(`<div class="vol-card"><div class="k">Next week read</div><div class="v">${allStats.forecast == null ? "—" : "~" + fmtInt(allStats.forecast)}</div><div class="d muted">from the last ${Math.min(8, allHist.length)} weeks</div></div>`));
    if (allStats.pace != null) {
      strip.appendChild(el(`<div class="vol-card"><div class="k">This week's pace</div><div class="v ${signClass(pctChange(allStats.pace, allStats.prevWeek))}">~${fmtInt(allStats.pace)}</div><div class="d muted">${model.bdIn} of 5 business days in · ${fmtPct(pctChange(allStats.pace, allStats.prevWeek))} vs last week</div></div>`));
    }
    const newCount = perCompany.filter((c) => c.isNew).length;
    strip.appendChild(el(`<div class="vol-card"><div class="k">Companies</div><div class="v">${companies.length}</div><div class="d"><span class="vol-up">${rising} growing</span> · <span class="vol-down">${falling} slowing</span> · <span class="muted">${companies.length - rising - falling} steady</span>${newCount ? ` · <span class="pill new">${newCount} new</span>` : ""}</div></div>`));
    host.appendChild(strip);

    if (rollupRows.length) {
      host.appendChild(el(`<div class="section-title">Sheet totals</div>`));
      host.appendChild(el(`<p class="muted vol-note">ALL Clinical and ALL Consumer are the Sheet's own totals. They are not added to the companies.</p>`));
      host.appendChild(volumeSheetTable(model, rollupRows, false));
    }

    // Table: every column the Sheet has, in Sheet order, plus Outlook.
    const cols = state.volumeCols.slice();
    const signed = new Set([p.wow, p.growth].filter(Boolean));
    host.appendChild(el(`<div class="section-title">Companies</div>`));
    companyRows.sort((a, b) => model.ordersOf(b) - model.ordersOf(a) || model.companyOf(a).localeCompare(model.companyOf(b)));
    host.appendChild(volumeSheetTable(model, companyRows, true));
  }
  function volumeSheetTable(model, list, withCompany) {
    const p = model.picked;
    const cols = state.volumeCols.slice();
    const signed = new Set([p.wow, p.growth].filter(Boolean));
    const wrap = el(`<div class="grid-wrap"></div>`);
    const table = document.createElement("table");
    table.className = "grid";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    cols.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c;
      if (c === p.orders) { th.classList.add("vol-main"); th.title = "The week's order count."; }
      hr.appendChild(th);
    });
    if (withCompany) {
      const outTh = document.createElement("th");
      outTh.textContent = "Outlook";
      hr.appendChild(outTh);
    }
    thead.appendChild(hr);
    const tb = document.createElement("tbody");
    list.forEach((r) => {
      const tr = document.createElement("tr");
      const name = model.companyOf(r);
      cols.forEach((c) => {
        const td = document.createElement("td");
        const text = r[c] == null ? "" : String(r[c]);
        const n = metricNum(text);
        if (withCompany && c === p.company && name) {
          td.className = "clickable";
          td.textContent = text;
          if (isNewCompany(model, name)) td.appendChild(el(` <span class="pill new">New</span>`));
          td.title = "Open this company's history";
          td.onclick = () => openVolumeDrawer(model, name);
        } else {
          td.textContent = text;
          if (n !== null) td.classList.add("num");
          if (c === p.orders) td.classList.add("vol-main");
          if (signed.has(c) && n > 0) td.classList.add("up");
          else if (signed.has(c) && n < 0) td.classList.add("down");
        }
        tr.appendChild(td);
      });
      if (withCompany) {
        const h = volumeHistory(model, name);
        const own = list.filter((row) => model.companyOf(row) === name);
        const info = name ? { stats: volumeStats(model, h, own), outlook: null } : null;
        if (info) info.outlook = volumeOutlook(info.stats);
        const td = document.createElement("td");
        if (info && info.outlook) {
          const pill = el(`<span class="pill ${info.outlook.kind}">${esc(info.outlook.text)}</span>`);
          if (info.stats.forecast != null) pill.title = `Next week read: about ${fmtInt(info.stats.forecast)} orders`;
          td.appendChild(pill);
        }
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    });
    table.append(thead, tb);
    wrap.appendChild(table);
    return wrap;
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
