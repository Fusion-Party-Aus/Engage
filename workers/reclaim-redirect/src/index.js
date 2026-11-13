/**
 * Permanent redirect from the retired Reclaim policy site to Engage.
 *
 * Path and query string are preserved, so legacy deep links keep their shape and
 * Engage's own legacy redirects (`/pending-vote`, `/all-policies`, `/reviews`,
 * `/reclaim-our-economy`, `/reclaim-our-future`) continue to work.
 */
const TARGET_ORIGIN = "https://engage.fusionparty.org.au";

export default {
  fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, TARGET_ORIGIN);
    return Response.redirect(target.toString(), 301);
  },
};
