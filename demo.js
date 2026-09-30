/* Synthetic sample data for ?demo=1. Every PO, company and workbench id below is
 * made up. This file exists so the layout can be reviewed without Google sign-in.
 * It mimics the four tabs the real Sheet has and the three Sheets API calls
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

  function unq(name) { return name.replace(/^'|'$/g, "").replace(/''/g, "'"); }

  window.OPS_STANDUP_DEMO = {
    async handle(url, opts) {
      await new Promise((r) => setTimeout(r, 120));
      if (url.includes("/oauth2/v3/userinfo")) return { email: "you@pebblehealth.io" };
      if (/\/spreadsheets\/demo\?fields=/.test(url)) {
        return { properties: { title: `${P} Ops Standup (demo)` }, sheets: Object.keys(TABS).map((t) => ({ properties: { title: t } })) };
      }
      if (url.includes("/values:batchGet")) {
        const ranges = [...new URL(url).searchParams.getAll("ranges")].map(unq);
        return { valueRanges: ranges.map((t) => ({ range: `'${t}'!A1:Z`, values: TABS[t] || [] })) };
      }
      if (url.includes(":append")) {
        const body = JSON.parse(opts.body); TABS.Notes.push(body.values[0]); return { updates: { updatedRows: 1 } };
      }
      if (url.includes(":batchUpdate")) return { replies: [{}] };
      if (opts && opts.method === "PUT") return {};
      throw new Error("demo: unhandled " + url);
    },
  };
})();
