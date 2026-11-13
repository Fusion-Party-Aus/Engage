/**
 * Permanent redirect from the retired Reclaim policy site to Engage.
 *
 * Reclaim published proposals under its two division paths:
 *
 *   /reclaim-our-economy/<proposal-slug>/
 *   /reclaim-our-future/<proposal-slug>/
 *
 * Engage publishes the same proposals at `/proposals/<proposal-slug>/`, so the
 * division segment becomes `proposals`. Every other path keeps its shape and the
 * query string is preserved, which keeps Engage's own legacy redirects
 * (`/pending-vote`, `/all-policies`, `/reviews`) working.
 */
const TARGET_ORIGIN = "https://engage.fusionparty.org.au";

const DIVISIONS = new Set(["reclaim-our-economy", "reclaim-our-future"]);

/**
 * Section index pages on the retired site (e.g. `/reclaim-our-economy/solve-the-housing-crisis/`).
 * Their names are not proposal slugs, so they resolve to the proposal list
 * instead of a 404.
 */
const RETIRED_SECTIONS = new Set([
  "build-up-small-businesses",
  "fix-the-tax-exploits",
  "grow-a-clean-economy",
  "restore-the-fair-go",
  "solve-the-housing-crisis",
  "rebuild-our-communities",
  "renew-our-democracy",
  "repair-our-environment",
  "transform-our-industries",
  "update-our-schools",
]);

function resolvePath(pathname) {
  const [, division, rest = ""] = pathname.match(/^\/([^/]+)(\/.*)?$/) ?? [];
  if (!DIVISIONS.has(division)) return pathname;

  const [section] = rest.split("/").filter(Boolean);
  if (!section || RETIRED_SECTIONS.has(section)) return "/proposals/";

  return `/proposals${rest}`;
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(TARGET_ORIGIN + resolvePath(url.pathname) + url.search, 301);
  },
};
