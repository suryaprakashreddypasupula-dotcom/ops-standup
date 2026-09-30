// Public configuration for the Ops Standup shell.
// Nothing here is secret: an OAuth *client id* is meant to be public. Access to
// data is decided by Google — by who the Sheet is shared with.
window.OPS_STANDUP_CONFIG = {
  // Google Cloud OAuth 2.0 Web client id, created in the Hike Google Workspace
  // project with the consent screen set to "Internal". See README.md.
  GOOGLE_CLIENT_ID: "",

  // Only accounts on this domain are offered at sign-in (hint only; the Sheet's
  // sharing is what actually enforces access).
  HOSTED_DOMAIN: "pebblehealth.io",

  // Order page in the Hike admin. The Delinquency Detail tab carries workbench_id.
  WORKBENCH_BASE: "https://admin.hikemedical.com/hike/operations/workbenches",

  // Optional: a Sheet id to open when the URL has no ?sheet= and nothing is
  // remembered in this browser. Leave empty to always ask.
  DEFAULT_SHEET_ID: "",
};
