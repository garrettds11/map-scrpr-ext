# Map Scrpr

Map Scrpr is a browser extension for Google Chrome. It records map data from web sites that show a map with pins,
layers, or other features, and turns it into GeoJSON you can load into your own datasets.

It is **passive**: it only records data a page already loads while you use the map normally, and never makes requests
of its own. Every record is kept in the site's **native format** and also gets a **normalized view** in
one uniform schema, so the next unknown site lands in the same shape.

> **Status:** v2.0, early. The router, sniffer and normalizer are tested against captured traffic from real map sites
> plus synthetic fixtures for other common map-data shapes, and it has captured several thousand points in a live Chrome
> session. It has not been run for long sessions or on many sites, so start small and check the popup's counts.

## Quick start

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this folder.
   After changing files, click the reload icon on the extension's card, then reload the site tab.
2. Open a page with a map and click the toolbar icon, then **Enable capture on this site**. Chrome asks for permission
   on that one site only.
3. **Reload the tab**, then use the map normally. You do not need to click individual pins: panning and zooming makes
   the page request the data for the area you are looking at, and that is what gets captured (see
   [What gets captured](#what-gets-captured)).
4. Click the toolbar icon to see counts per source, a coverage map of captured points, and the export buttons.
   The popup shows the counts as of when you opened it, so close and reopen it to refresh.

Capture starts only on pages that load **after** you enable the site. If the counts stay at zero, reload the tab.

## What gets captured

Only what the page itself requests, so what you see is what you get:

- **Panning and zooming** is usually enough. Most maps load the pins for the visible area as it changes. Areas you never
  looked at are not captured.
- **Opening items (clicking a pin, scrolling a results list)** only matters on sites that send a pin's position first
  and fetch its full details separately. Whether a site does that varies. If exports look thin, for example records
  with coordinates but little else, open a few items or scroll the results list. Details are captured only for the
  items whose details the page loaded, and they are joined to the pins on export (see below).
- Nothing is clicked or requested for you.

## How it works

```
page JSON (fetch/XHR) -> hook.js -> bridge.js -> background.js -> lib/route.js
                                                                    |-- sites/*  (known endpoints)
                                                                    |-- lib/sniff.js (generic point finder)
                                                                    `-- lib/normalize.js (uniform view)
                                                                -> IndexedDB (lib/db.js) -> popup export
```

`hook.js` runs in the page and forwards JSON-looking responses (trackers, ads, images and scripts are skipped). The
background worker decides what to keep:

1. **A site rule matches** (`sites/`): the site's parser extracts records and the response is archived.
2. **Otherwise the generic point sniffer** looks for arrays or objects where most items have coordinates: GeoJSON
   features, `lat`/`lng`-style keys in any case or style, nested `location` objects, `[lat,lng]` or `[lng,lat]`
   arrays, `"lat,lng"` strings, WKT `POINT`, and ArcGIS `{attributes, geometry:{x,y}}`. Found points are kept.
3. **Details:** a list of objects that have ids but no coordinates (titles, types and so on, the "details" half of a map
   API) is kept as **detail records**, but only once the site already has map records, so a site with no map data
   never gets anything written.
4. **Nothing found:** the response is discarded and never written to disk, unless **Learn mode** is on for that site.
   Learn mode archives every JSON response from the site (except login, account, token, session and payment-style
   paths) so unknown endpoints can be studied.

## What is stored

Everything lives in IndexedDB (`map_scrpr`), in three layers:

| Layer | What it is | Trust |
|---|---|---|
| **responses** | Every archived HTTP response, verbatim: `{ts, method, url, status, page, via, reqBody, body}`. Deduped by SHA-256. | Ground truth. Anything can be re-parsed from it. |
| **records (native)** | Each item exactly as the site sent it: strings stay strings, `&amp;` stays, emails and phones are kept. Latest capture wins. | Verbatim. Never modified. |
| **records (normalized)** | A uniform view derived from the native data, with `norm_from` recording which native field each value came from. | Derived. Recompute any time with **Re-normalize all**. |

`lat`, `lng` and `geometry` on a record are also derived. GeoJSON sources keep their original geometry, so polygons and
lines are not flattened to points.

Safeguards: the raw archive is capped at about 300 MB (native records keep being captured past that), responses over
32 MB are skipped and flagged, exports stream in batches so memory stays flat, and errors turn the toolbar badge red.

### Kinds

Each record has a `kind` that says which endpoint and response shape it came from, so records with different schemas
never mix. A site rule declares its own kinds. For sites without a rule, the kind is built from the request path and
where the points sit in the JSON, for example `api.example.com/v2/places/search#data.results`.

If a site sends a pin's position in one response and its details in another, the two have different schemas, so they
are stored as separate kinds. Detail records have `geometry: null` and `meta.detail: true`. On export, each detail kind
is joined to the one pin kind of the same source whose ids it overlaps most (at least half of its ids), because
unrelated endpoints can reuse the same ids. A detail that arrives before the site's first pins is not kept; reloading
or panning again captures it.

## Normalized schema

Every source gets the same keys, with `null` or `[]` when a value is missing:

`name, description, categories[], address_text, street, city, region, postal_code, country, website, phone, email,
image, url, rating, attributes{}`, plus `source, kind, source_id, first_seen, last_seen` and `_norm_from`.

Values are filled first from the site's declarative profile, then by generic key-name heuristics (case- and
style-insensitive aliases, nested `address` and `location` objects, validators for email, URL and phone). Heuristic
fills are marked `(heuristic)` in `_norm_from`. Site-specific extras that have no home in the uniform schema go in `attributes`,
for example a `verified` flag or a list of related IDs. A joined detail is kept whole under
`attributes.details[<detail kind>]`.

## Export

From the popup:

- **Normalized GeoJSON:** all sources in one file with identical property keys, with joined details merged into their
  pins (empty fields are filled from the detail, and `_norm_from` says so). This is the one to load into a dataset.
- **Native GeoJSON per kind** and **native `.ndjson` per kind:** the sites' own fields untouched (GeoJSON adds one
  `_capture` key with bookkeeping). Detail kinds are separate files, not joined.
- **Raw responses `.ndjson`:** the verbatim archive.

Also: **Re-normalize all** and **Clear**.

## Scripts

`scripts/join.mjs` joins details onto pins offline, from exported files. It makes no network requests. Use it on
exports from before details were captured, or when you want the native fields kept as they are.

```
node scripts/join.mjs --pins pins.geojson --details raw_responses.ndjson --url 'detail/endpoint' [--key id] [--all] [--out joined.geojson]
```

- `--pins`: GeoJSON (native or normalized export) or `.ndjson` of native objects with coordinates.
- `--details`: a raw-responses `.ndjson` (select the detail responses with `--url`, a regex on the response URL), a
  native `.ndjson`, or GeoJSON.
- Output: one feature per matched pin, with the pin's properties plus `detail`, the detail object verbatim. `--all`
  also keeps pins that have no detail. If an id appears more than once, the last one in the file wins.
- It prints how many pins and details it read and how many matched. Check that it is not zero before using the file.

`scripts/to-datamodel.mjs` turns a normalized GeoJSON export into import-ready GeoJSON for the GeoVivé data model, which
allows only a fixed set of feature properties and says specifics go in `description`. It makes no network requests.

```
node scripts/to-datamodel.mjs --in normalized.geojson [--name-fallback "Place {id}"] [--include-contact] [--source label]
```

- Each output feature has exactly `name`, `category` (always `location`), `description`, `source` and `externalId`.
  The description is Markdown: address, categories, links and rating, then a short **Details** list (up to 15) of the
  other fields, including any joined details.
- `name` is required by the data model, so features with no name are skipped and counted. `--name-fallback` keeps them
  under a placeholder name, where `{id}` is the source id. `--name-kind MATCH=TEMPLATE` sets a placeholder per kind of
  record (it matches against the record's `kind`, case-insensitive, and can be repeated; the first match wins), so
  different record types get accurate placeholders: `--name-kind "/cafes/=Cafe {id}" --name-kind "/parks/=Park {id}"`.
  Run `node scripts/to-datamodel.mjs --help` to see the kinds in a file's `kind` property, or open the popup's kind list.
- Phone and email are left out unless you pass `--include-contact`.
- Output is split into parts of at most 20,000 features and about 45 MB (`--max-features`, `--max-mb`) to fit the
  importer's limits. Features without geometry are skipped. Names over 200 characters and descriptions over 5,000 are cut.

## Add a site

Unknown sites already work through the sniffer and heuristics. For a site with a known endpoint, create
`sites/<id>.js` (a complete, working example is in `sites/example.js`):

```js
export default {
  id: 'example',
  hosts: ['example.com'],
  match: [/api\.example\.com\/places/],      // responses this site rule owns
  skip: [],
  parse(url, reqBody, json) { /* return [{source, kind, id, native, lat, lng, meta}] */ },
  profiles: { example_place: { fields: { name: 'title', city: 'town' }, attributes: { open: 'is_open' } } },
  defaultProfile: null,
};
```

then add it to the list in `sites/index.js`. A profile maps normalized fields to native paths (`'a.b'`, a list of
fallbacks, or `{from, map}`); `sites/example.js` is a working example. Rules you don't want to publish can live in a git-ignored `private/` folder.

## Project layout

```
manifest.json        MV3 manifest; sites are enabled one at a time via optional permissions
icons/               toolbar and extension icons
hook.js              page-world fetch/XHR wrapper (adds no requests)
bridge.js            relays page messages to the background worker
background.js        routes captures, enforces the archive budget, updates the badge
lib/route.js         site rule -> sniffer -> normalizer
lib/sniff.js         generic point and detail detection for unknown sites
lib/join.js          joins detail records onto pins by id at export
lib/normalize.js     uniform schema + heuristics
lib/db.js            IndexedDB access, streaming, GeoJSON conversion
lib/util.js          coordinate parsing and helpers
sites/               optional per-site rules and the registry (index.js, example.js)
popup/               popup UI, per-site enable, exports
scripts/             offline tools (join.mjs, to-datamodel.mjs)
test/                run-generic.mjs, run-join.mjs, run-scripts.mjs, run-to-datamodel.mjs, run-har.mjs
```

## Tests

Requires Node 18 or newer. No dependencies.

```
node test/run-generic.mjs                 # 15 synthetic unknown-site shapes (GeoJSON, ArcGIS, Leaflet-style, details, ...)
node test/run-join.mjs                    # detail-to-pin joining, including colliding ids
node test/run-scripts.mjs                 # scripts/join.mjs
node test/run-to-datamodel.mjs            # scripts/to-datamodel.mjs
node test/run-har.mjs a.har b.har         # replay captured HAR files; checks native == what the site sent
```

## Known limits

- Only JSON over `fetch` and XHR. Not handled: vector tiles (`.pbf`), WebSockets, data embedded in the page HTML or
  script tags, and Google Maps' own protobuf and tiles.
- Points need coordinates. Coordinate-less lists are kept only as detail records, and only if each item has an id and
  at least three fields, the list has at least three items, and the site already has map records. A single detail
  object on its own (not in a list) is not captured as a detail; it is only in the raw archive under Learn mode.
- Details join to pins by id within one source. If a site's detail ids do not match its pin ids, nothing joins; the
  detail records are still exported natively.
- An `[a,b]` coordinate array with no hint in its key is assumed to be `[lng,lat]`; `meta.coord_note` flags these.
- Coverage is whatever the page loads: the map area you view, plus any items you open on sites that load details on
  demand. A site changing its API shape may need a new profile.
- Responses the site rules and the sniffer do not recognise are only kept in **Learn mode**, so an unfamiliar detail
  endpoint can be missed until you turn it on and look at the raw archive. Turn it on before you start panning.

## Privacy and terms

Contact data (emails and phones) is captured because native format was requested, so treat exports as private. Never
commit HAR files, exports or session tokens; `.gitignore` blocks the common ones. Check each site's terms before
collecting or sharing its data, and keep data from behind a sign-in in a private dataset.
