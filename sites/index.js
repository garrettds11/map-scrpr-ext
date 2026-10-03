import example from './example.js';

/**
 * Site registry. Unknown sites need NO entry here: they are handled by the generic point finder and the
 * heuristic normalizer. Add a rule only when you need precise control for a particular site (see example.js),
 * then list it below.
 */
export const SITES = [example];

const hostIs = (host, h) => host === h || host.endsWith(`.${h}`);
export const siteForHost = (host) => SITES.find((s) => s.hosts.some((h) => hostIs(host, h))) || null;
export const siteBySource = (id) => SITES.find((s) => s.id === id) || null;
