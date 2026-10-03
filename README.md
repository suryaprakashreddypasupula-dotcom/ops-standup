# Ops Standup — front end

A static page that shows one night's **Ops Standup** pack the way the team already
reviews it, with two additions:

1. **Ops Summary** (page 1) — same rows as the Sheet, plus a Notes column.
2. **Delinquency by Station** (page 2) — same grid as the Sheet. Every number opens
   the POs behind it; every PO links to its workbench; notes can be written on a PO
   or on a station row.

Notes are appended to the **`Notes`** tab of that night's Sheet, so each pack carries
its own comments and nothing from previous days is shown.

## What is (and is not) in this repo

This repo is public because GitHub Pages needs it to be. It contains **only** the
shell: `index.html`, `app.js`, `styles.css`, `config.js`, `demo.js`. There is no data,
no SQL, no secret and no Sheet id here, and none may ever be committed.

All data lives in the Google Sheet the nightly build uploads to Drive. The page reads
it in the visitor's browser with the visitor's own Google sign-in. Someone outside the
Hike domain who finds the URL sees a sign-in button and nothing else, because the
Sheet itself is only shared inside the domain.

## How a night flows

1. The nightly build (private `ops-daily-reports` repo) writes the Ops Standup workbook
   with two extra tabs: **`<date> Delinquency Detail`** (one row per PO behind each grid
   number, incl. `workbench_id`) and an empty **`Notes`** tab. The Drive step converts
   it to a Google Sheet shared to the domain.
2. Open the page, paste the Sheet link from the email, sign in. The page remembers the
   last Sheet in this browser and puts the id in the URL (`?sheet=…`) for bookmarking.
3. Click a number on Delinquency by Station → PO list → click a PO → workbench opens.
   Type a note on the PO or on the row; it is saved to the Sheet's `Notes` tab with
   your email and a timestamp, and shows for everyone who opens that Sheet.

## Preview without any setup

`https://<user>.github.io/ops-standup/?demo=1` (or `index.html?demo=1` locally) renders
synthetic sample data from `demo.js` — fake POs and companies — with no sign-in. Use it
to review layout and behaviour.


## Local run

```sh
python3 -m http.server 8765 --bind 127.0.0.1
# then open http://127.0.0.1:8765/index.html?demo=1
```

## Notes tab schema

| column | meaning |
| --- | --- |
| `ts` | ISO timestamp (UTC) |
| `user` | email of the signed-in author |
| `page` | `summary` or `delinquency` |
| `level` | `po`, `station`, or `metric` |
| `factory` `station_group` `status` | grid row key (for `metric` notes: factory / category / metric) |
| `bucket` | grid column the note was written from (for `metric` notes: timeframe) |
| `po_number` | set for `po` notes |
| `note` | free text |

The tab is created automatically if a Sheet lacks it.
