/* Synthetic sample data for ?demo=1. Every PO, company and workbench id below is
 * made up. This file exists so the layout can be reviewed without Google sign-in.
 * It mimics the tabs the real Sheet has and the Sheets API calls
 * app.js makes (metadata, values:batchGet, values:append / batchUpdate).
 */
(function () {
  "use strict";
  const P = "9_29";
  const TABS = {
    [`${P} Ops Summary`]: [
      ["timeframe", "factory", "category", "metric", "value"],
      ["Last 2d", "SOLEFORGE", "OTD", "Design Compliance %", 96.1],
      ["Last 2d", "SOLEFORGE", "OTD", "Printing Compliance %", 84.4],
      ["Last 2d", "SOLEFORGE", "OTD", "Production Compliance %", 87.3],
      ["Last 2d", "SOLEFORGE", "OTD", "Overall TAT P95 (BD)", 6],
      ["Last 2d", "SOLEFORGE", "Quality", "Overall Reject Rate", 12.89],
      ["Last 2d", "SOLEFORGE", "Quality", "Printing Scrap %", 8.93],
      ["Last 2d", "SOLEFORGE", "Volume", "Orders Placed", 212],
      ["Last 2d", "SOLEMATE", "OTD", "Design Compliance %", 97.4],
      ["Last 2d", "SOLEMATE", "OTD", "Printing Compliance %", 71.2],
      ["Last 2d", "SOLEMATE", "OTD", "Overall TAT P99 (BD)", 10],
      ["Last 2d", "SOLEMATE", "OTD", "OTS 1d Late", 67],
      ["Last 2d", "SOLEMATE", "OTD", "OTS 2d+ Late", 53],
      ["Last 2d", "SOLEMATE", "Quality", "Overall Reject Rate", 9.11],
      ["Last 2d", "SOLEMATE", "Volume", "Orders Placed", 388],
      ["Last 7d", "SOLEFORGE", "OTD", "Printing Compliance %", 88.0],
      ["Last 7d", "SOLEMATE", "OTD", "OTS 1d Late", 1],
      ["Last 7d", "SOLEMATE", "OTD", "Printing Compliance %", 74.9],
    ],
    [`${P} Delinquency by Station`]: [
      ["factory", "station_group", "status", "wip", "customer_overdue", "Step overdue", "due_today", "on_track", "completed_yesterday", "completed_2_days_ago", "rejected_yesterday", "rejected_2_days_ago"],
      ["SOLEFORGE", "Design", "SoleGen QC", 2, 2, 0, 0, 2, 0, 0, 0, 0],
      ["SOLEFORGE", "Printing", "PRINTING — Not Queued", 4, 0, 2, 1, 1, 3, 2, 1, 0],
      ["SOLEFORGE", "Production", "NEEDS_FINISHING", 3, 0, 2, 1, 0, 2, 1, 0, 0],
      ["SOLEFORGE", "Production", "NEEDS_QUALITY_CONTROL", 2, 0, 1, 1, 0, 1, 0, 1, 0],
      ["SOLEFORGE", "Shipping", "Needs Shipping", 1, 0, 0, 0, 1, 2, 1, 0, 0],
      ["SOLEMATE", "Printing", "PRINTING — Not Queued", 5, 1, 3, 1, 1, 4, 3, 0, 1],
      ["SOLEMATE", "Production", "NEEDS_GLUING", 3, 0, 2, 0, 1, 2, 2, 0, 0],
      ["SOLEMATE", "Production", "POST_PRINT_QA", 2, 1, 0, 1, 1, 1, 1, 0, 0],
      ["Unassigned", "Design", "Foot Model Design", 2, 0, 0, 1, 1, 0, 0, 0, 0],
      ["Unassigned", "On Hold", "On Hold External", 2, 0, 2, 0, 0, 0, 0, 0, 0],
    ],
    [`${P} Delinquency Detail`]: [["factory", "station_group", "status", "bucket_kind", "event_date", "po_number", "workbench_id", "order_id", "company_name", "customer_overdue", "classification", "days_past_step_due", "rework_category", "go_live", "step_start", "step_due_date"]],
    [`${P} OTS Report`]: [
      ["timeframe (based on completion date)", "factory", "rework_type", "ship_classification", "po_number", "company_name", "bd_over_sla", "workbench_id"],
      ["Last 2d", "SOLEMATE", "Reprint x2", "1BD_LATE", "demo-late-1", "Sample Clinic A", "1", "wb-demo-late-1"],
      ["Last 2d", "SOLEMATE", "", "1BD_LATE", "demo-late-2", "Sample Clinic B", "1", "wb-demo-late-2"],
      ["Last 7d", "SOLEMATE", "", "1BD_LATE", "demo-should-not-open", "Sample Clinic A", "1", "wb-no"],
    ],
    [`${P} Prev Day by Person`]: [
      ["lane_name", "station_group", "station", "completed_by", "target", "*9/17", "9/18", "9/21", "9/22", "9/23", "9/24", "9/25", "9/28", "9/29", "total_qty", "avg_daily_qty", "avg_min_per_insole"],
      ["Form", "Production", "NEEDS_GLUING", "alex.rivera@example.com", 225, "30 (1h 20m)", "34 (1h 28m)", "36 (1h 32m)", "30 (1h 18m)", "40 (1h 40m)", "42 (1h 44m)", "44 (1h 50m)", "50 (2h 4m)", "99 (4h 0m)", 306, 38.3, 2.4],
      ["Sport", "Production", "NEEDS_GLUING", "alex.rivera@example.com", 225, "20 (50m)", "22 (54m)", "22 (52m)", "19 (48m)", "25 (1h 2m)", "26 (1h 4m)", "28 (1h 8m)", "36 (1h 20m)", "1 (5m)", 198, 24.8, 2.2],
      ["Form", "Production", "NEEDS_GLUING", "jordan.lee@example.com", 225, "80 (3h 10m)", "76 (3h 2m)", "74 (2h 58m)", "70 (2h 50m)", "68 (2h 44m)", "66 (2h 40m)", "68 (2h 42m)", "71 (2h 48m)", "5 (20m)", 573, 71.6, 2.4],
      ["Form", "Production", "NEEDS_GLUING", "sam.patel@example.com", 225, "40 (1h 40m)", "44 (1h 48m)", "50 (2h 0m)", "55 (2h 10m)", "58 (2h 16m)", "60 (2h 20m)", "62 (2h 24m)", "64 (2h 28m)", "3 (10m)", 433, 54.1, 2.3],
      ["Form", "Production", "NEEDS_GLUING", "riley.chen@example.com", 225, "22 (1h 0m)", "28 (1h 10m)", "30 (1h 14m)", "33 (1h 18m)", "36 (1h 24m)", "38 (1h 28m)", "39 (1h 30m)", "40 (1h 32m)", "2 (8m)", 266, 33.3, 2.4],
      ["Form", "Production", "NEEDS_GLUING", "morgan.diaz@example.com", 225, "12 (36m)", "16 (44m)", "18 (48m)", "20 (52m)", "22 (56m)", "24 (1h 0m)", "25 (1h 2m)", "22 (54m)", "1 (4m)", 159, 19.9, 2.5],
      ["Form", "Production", "NEEDS_GLUING", "idle.zero@example.com", 225, "10 (30m)", "8 (24m)", "6 (18m)", "4 (12m)", "2 (8m)", "1 (4m)", "1 (4m)", "", "40 (1h 0m)", 32, 4, 2.5],
      ["Form", "Production", "NEEDS_FINISHING", "casey.nguyen@example.com", 225, "30 (1h 20m)", "32 (1h 24m)", "36 (1h 32m)", "40 (1h 40m)", "38 (1h 36m)", "42 (1h 46m)", "40 (1h 42m)", "44 (1h 52m)", "9 (20m)", 302, 37.8, 2.4],
      ["Form", "Production", "NEEDS_FINISHING", "alex.rivera@example.com", 225, "12 (40m)", "14 (44m)", "16 (48m)", "18 (52m)", "15 (46m)", "22 (1h 4m)", "26 (1h 12m)", "30 (1h 18m)", "7 (15m)", 153, 19.1, 2.6],
      ["Form", "Production", "NEEDS_FINISHING", "quinn.brooks@example.com", 225, "8 (28m)", "10 (32m)", "9 (30m)", "11 (34m)", "12 (36m)", "10 (32m)", "14 (40m)", "12 (36m)", "4 (10m)", 86, 10.8, 3.1],
      ["Ship", "Shipping", "NEEDS_SHIPPING", "devon.shaw@example.com", 225, "", "", 4, 6, 8, 5, 10, 15, 99, 48, 6, ""],
    ],
    [`${P} On Hold External Detail`]: [
      ["Factory", "PO Number", "Patient", "Language Preference", "Clinician", "Clinician Email", "Clinician Phone", "Company", "Held From", "Hold Kind", "Hold Reason", "Hold Placed On", "Days On Hold", "step_overdue_at", "authorization_date", "Placed By", "Placed By Email"],
      ["SOLEMATE", "demo-hold-1", "Demo Patient A", "English", "Casey Nguyen", "casey.nguyen@example.com", "555-0101", "Sample Clinic A", "NEEDS_GLUING", "Auth Flip", "", "9/12/2026", 14, "", "9/2/2026", "", ""],
      ["SOLEFORGE", "demo-hold-2", "Demo Patient B", "Spanish", "Jordan Lee", "jordan.lee@example.com", "555-0102", "Sample Clinic B", "NEEDS_FINISHING", "Manual", "Waiting on clinic photos", "9/28/2026", 3, "", "9/20/2026", "Sam Patel", "sam.patel@example.com"],
      ["SOLEFORGE", "demo-hold-3", "Demo Patient C", "English", "Riley Chen", "riley.chen@example.com", "555-0103", "Demo Orthotics", "NEEDS_SHIPPING", "Manual", "Other: clinic asked to pause", "9/20/2026", 9, "", "9/10/2026", "Alex Rivera", "alex.rivera@example.com"],
      ["SOLEMATE", "demo-hold-4", "Demo Patient D", "English", "Quinn Brooks", "quinn.brooks@example.com", "555-0104", "Example Foot Care", "DRAFT", "Auth Flip", "", "9/1/2026", 22, "", "8/28/2026", "", ""],
      ["SOLEFORGE", "demo-hold-5", "Demo Patient E", "Spanish", "Morgan Diaz", "morgan.diaz@example.com", "555-0105", "Sample Clinic A", "NEEDS_MANUFACTURING", "Manual", "Scan unreadable", "9/26/2026", 5, "", "9/18/2026", "Jordan Lee", "jordan.lee@example.com"],
    ],
    [`${P} Hanger Day 3+ TAT`]: [
      ["Factory", "PO Number", "Company", "Station", "Days", "workbench_id"],
      ["SOLEMATE", "demo-hanger-3", "Sample Clinic A", "NEEDS_GLUING", 3, "wb-demo-hanger-3"],
      ["SOLEFORGE", "demo-hanger-4", "Sample Clinic B", "NEEDS_FINISHING", 4, "wb-demo-hanger-4"],
      ["SOLEMATE", "demo-hanger-5", "Demo Orthotics", "NEEDS_SHIPPING", 5, "wb-demo-hanger-5"],
      ["SOLEFORGE", "demo-hanger-6", "Example Foot Care", "NEEDS_GLUING", 6, "wb-demo-hanger-6"],
      ["SOLEMATE", "demo-hanger-8", "Sample Clinic A", "NEEDS_FINISHING", 8, "wb-demo-hanger-8"],
    ],
    [`${P} Union Day 3+ TAT`]: [
      ["Factory", "PO Number", "Company", "Station", "Days", "workbench_id"],
      ["SOLEFORGE", "demo-union-3", "Sample Clinic B", "NEEDS_GLUING", 3, "wb-demo-union-3"],
      ["SOLEMATE", "demo-union-4", "Demo Orthotics", "NEEDS_FINISHING", 4, "wb-demo-union-4"],
      ["SOLEFORGE", "demo-union-5", "Example Foot Care", "NEEDS_SHIPPING", 5, "wb-demo-union-5"],
      ["SOLEMATE", "demo-union-7", "Sample Clinic A", "NEEDS_GLUING", 7, "wb-demo-union-7"],
    ],
    [`${P} TAT Report`]: [
      ["timeframe", "factory", "workstation", "sla_status", "current_status", "po_number", "days_over", "company_name", "workbench_id"],
      ["Last 2d", "SOLEFORGE", "Printing", "MISSED", "COMPLETED", "demo-print-1", "1", "Sample Clinic A", "wb-demo-print-1"],
      ["Last 2d", "SOLEFORGE", "Printing", "MET", "COMPLETED", "demo-print-ok", "0", "Sample Clinic B", "wb-demo-print-ok"],
    ],
    Notes: [["ts", "user", "page", "level", "factory", "station_group", "status", "bucket", "po_number", "note"],
      [new Date(Date.now() - 36e5).toISOString(), "sample.user@example.com", "delinquency", "station", "SOLEFORGE", "Production", "NEEDS_FINISHING", "", "", "Two people out; second shift caught up most of it."],
      [new Date(Date.now() - 30e5).toISOString(), "sample.user@example.com", "delinquency", "po", "SOLEMATE", "Printing", "PRINTING — Not Queued", "Step overdue", "demo-300101", "Design file failure, resent to print this morning."],
      [new Date(Date.now() - 20e5).toISOString(), "another.user@example.com", "summary", "metric", "SOLEFORGE", "OTD", "Printing Compliance %", "Last 2d", "", "1 order with no design files, 2 with incorrect routing."],
    ],
  };

  // Build detail rows that reconcile with the grid above.
  const companies = ["Sample Clinic A", "Sample Clinic B", "Demo Orthotics", "Example Foot Care"];
  let seq = 300100;
  const detail = TABS[`${P} Delinquency Detail`];
  function po() { seq += 1; return `demo-${seq}`; }
  function addWip(f, sg, st, cls, co, days, rework) {
    detail.push([f, sg, st, "wip", "", po(), `wb-${seq}`, `ord-${seq}`, companies[seq % companies.length], co ? "TRUE" : "FALSE", cls, days, rework || "", "2026-09-22", "2026-09-25", cls === "DUE_TODAY" ? "2026-09-29" : "2026-09-26"]);
  }
  function addEvent(f, base, kind, n) {
    for (let i = 0; i < n; i++) detail.push([f, "", base, kind, kind.includes("yesterday") ? "2026-09-26" : "2026-09-25", po(), `wb-${seq}`, `ord-${seq}`, companies[seq % companies.length], "", "", "", "", "", "", ""]);
  }
  function base(sg, st) {
    if (sg === "Printing") return st.split(" — ")[0];
    if (["Foot Model Design", "Insole Design", "Validation Complete"].includes(st)) return "DRAFT";
    if (st === "Needs Shipping") return "NEEDS_SHIPPING";
    return st;
  }
  TABS[`${P} Delinquency by Station`].slice(1).forEach((r) => {
    const [f, sg, st, wip, co, ov, dt, ot, cy, c2, ry, r2] = r;
    let coLeft = co;
    const mk = (cls, n) => { for (let i = 0; i < n; i++) { const isCo = coLeft > 0; if (isCo) coLeft--; addWip(f, sg, st, cls, isCo, cls === "OVERDUE" ? 1 + (i % 4) : cls === "DUE_TODAY" ? 0 : -1, i === 0 && cls === "OVERDUE" ? "Reprint" : ""); } };
    mk("OVERDUE", ov); mk("DUE_TODAY", dt); mk("ON_TRACK", ot);
    const b = base(sg, st);
    addEvent(f, b, "completed_yesterday", cy); addEvent(f, b, "completed_2_days_ago", c2);
    addEvent(f, b, "rejected_yesterday", ry); addEvent(f, b, "rejected_2_days_ago", r2);
  });
  // Make the pre-seeded PO note point at a real demo row.
  const firstSolemateOverdue = detail.find((r) => r[0] === "SOLEMATE" && r[2] === "PRINTING — Not Queued" && r[10] === "OVERDUE");
  if (firstSolemateOverdue) TABS.Notes[2][8] = firstSolemateOverdue[5];
  // Two of the On Hold External POs also sit on Delinquency Detail (as they do
  // on the real pack), so the Hold page can link them to a workbench. The
  // other three have no workbench anywhere on this Sheet and stay plain text.
  detail.filter((r) => r[2] === "On Hold External" && r[3] === "wip").slice(0, 2).forEach((r, i) => {
    r[5] = `demo-hold-${i + 1}`;
    r[6] = `wb-demo-hold-${i + 1}`;
  });

  // Company Volume Trends: every week for every company, like the real tab.
  // 14 Mondays ending 9/28/2026 (the week of the 9_29 pack) plus one row for
  // the following week, which the page must not show yet.
  const VOL_SERIES = {
    "Sample Clinic A": [30, 32, 31, 35, 36, 38, 37, 40, 42, 41, 44, 46, 36, 48],
    "Sample Clinic B": [28, 30, 27, 29, 31, 28, 30, 29, 28, 31, 30, 28, 28, 30],
    "Demo Orthotics": [40, 38, 39, 36, 35, 33, 34, 30, 29, 28, 26, 25, 25, 18],
    "Example Foot Care": [20, 21, 22, 20, 23, 22, 21, 24, 22, 23, 22, 21, 22, 22],
    "Paused Demo Clinic": [15, 14, 14, 12, 12, 10, 9, 9, 8, 7, 6, 5, 4, 0],
  };
  const volTab = [["Company", "Segment", "Week", "Orders", "Prev Week", "WoW Change", "Recent 4 Weeks", "Prior 4 Weeks", "Growth"]];
  const firstMonday = Date.UTC(2026, 5, 29);
  const mdy = (t) => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };
  const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(1) + "%" : "");
  const total = (arr) => arr.reduce((x, y) => x + y, 0);
  const pushVol = (co, segment, i, n, prev, recent, prior) => {
    volTab.push([co, segment, mdy(firstMonday + i * 7 * 86400000), n, prev, prev === "" ? "" : pct(n, prev), recent, prior, prior === "" ? "" : pct(recent, prior)]);
  };
  Object.keys(VOL_SERIES).forEach((co) => {
    VOL_SERIES[co].forEach((n, i) => {
      const prev = i > 0 ? VOL_SERIES[co][i - 1] : "";
      const recent = total(VOL_SERIES[co].slice(Math.max(0, i - 3), i + 1));
      const prior = i >= 4 ? total(VOL_SERIES[co].slice(Math.max(0, i - 7), i - 3)) : "";
      pushVol(co, "Clinical", i, n, prev, recent, prior);
    });
  });
  // First appears 9/21, still inside its first month on the 9/28 week.
  const newSeries = [7, 11];
  newSeries.forEach((n, j) => {
    const i = 12 + j;
    pushVol("New Demo Clinic", "Clinical", i, n, j ? newSeries[j - 1] : "", n, "");
  });
  for (let i = 0; i < 14; i++) {
    const clinical = Object.keys(VOL_SERIES).reduce((sum, co) => sum + VOL_SERIES[co][i], 0) + (i >= 12 ? newSeries[i - 12] : 0);
    const consumer = 10;
    const prevC = i > 0 ? Object.keys(VOL_SERIES).reduce((sum, co) => sum + VOL_SERIES[co][i - 1], 0) + (i - 1 >= 12 ? newSeries[i - 1 - 12] : 0) : "";
    pushVol("ALL", "Clinical", i, clinical, prevC, "", "");
    pushVol("ALL", "Consumer", i, consumer, i > 0 ? consumer : "", "", "");
  }
  volTab.push(["Sample Clinic A", "Clinical", "10/5/2026", 99, 48, "106.3%", 200, 140, "42.9%"]);
  TABS[`${P} Company Volume Trends`] = volTab;

  function unq(name) { return name.replace(/^'|'$/g, "").replace(/''/g, "'"); }

  window.OPS_STANDUP_DEMO = {
    async handle(url, opts) {
      await new Promise((r) => setTimeout(r, 120));
      if (url.includes("/oauth2/v3/userinfo")) return { email: "you@pebblehealth.io" };
      if (/\/spreadsheets\/demo\?fields=/.test(url)) {
        return { properties: { title: `${P} Ops Standup (demo)` }, sheets: Object.keys(TABS).map((t) => ({ properties: { title: t } })) };
      }
      if (url.includes("/values:batchGet")) {
        const ranges = [...new URL(url).searchParams.getAll("ranges")].map((t) => unq(t.split("!")[0]));
        return { valueRanges: ranges.map((t) => ({ range: `'${t}'!A1:Z`, values: TABS[t] || [] })) };
      }
      if (url.includes(":append")) {
        const body = JSON.parse(opts.body); TABS.Notes.push(body.values[0]);
        const row = TABS.Notes.length;
        return { updates: { updatedRows: 1, updatedRange: `Notes!A${row}:J${row}` } };
      }
      if (url.includes(":batchUpdate")) return { replies: [{}] };
      if (opts && opts.method === "PUT") {
        const body = opts.body ? JSON.parse(opts.body) : null;
        const decoded = decodeURIComponent(url);
        const m = decoded.match(/Notes'!A(\d+)/i) || decoded.match(/!A(\d+)/);
        if (body && body.values && m) TABS.Notes[Number(m[1]) - 1] = body.values[0];
        return {};
      }
      throw new Error("demo: unhandled " + url);
    },
  };
})();
