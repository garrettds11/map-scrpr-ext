// A fully working example of a site rule, for a fictional site. Copy it as a starting point.
//
// You only need a rule when the generic point finder (lib/sniff.js) plus the heuristic normalizer
// (lib/normalize.js) are not good enough for a site: for instance when records are not self-describing,
// when you want fields mapped precisely, or when several endpoints must be told apart.
//
//   hosts    registrable hosts this rule applies to (page host or API host)
//   match    regexes for the response URLs this rule owns (those responses are always archived)
//   skip     regexes for URLs to ignore even if they match
//   parse    (url, requestBody, json) -> [{ source, kind, id, native, lat, lng, meta }]
//              `native` must be the object exactly as the site sent it; lat/lng are only for placement
//   profiles { [kind]: { fields, attributes } }   how to map native fields into the uniform schema
//              fields:     { <core field>: 'native.path' | ['a','b'] | { from: 'path', map: fn } }
//              attributes: { <name>: same spec }, for extras that have no core field
export default {
  id: 'example',
  hosts: ['example.test'],
  match: [/api\.example\.test\/v1\/places/],
  skip: [],

  parse(_url, _requestBody, json) {
    if (!Array.isArray(json?.places)) return [];
    return json.places
      .filter((p) => p && p.pid != null)
      .map((p) => ({
        source: 'example',
        kind: 'example_place',
        id: String(p.pid),
        native: p,
        lat: Number.isFinite(parseFloat(p.lat)) ? parseFloat(p.lat) : null,
        lng: Number.isFinite(parseFloat(p.lon)) ? parseFloat(p.lon) : null,
        meta: {},
      }));
  },

  profiles: {
    example_place: {
      fields: {
        name: 'title',
        city: 'town',
        url: { from: 'path', map: (v) => `https://example.test${v}` },
        categories: { from: 'tags', map: (v) => String(v).trim().split(/\s+/).filter(Boolean) },
      },
      attributes: {
        verified: { from: 'is_verified', map: (v) => v === '1' || v === 1 },
      },
    },
  },
  defaultProfile: null,
};
