# reclaim-redirect

`reclaim.fusionparty.org.au` is retired. This Worker answers every request on
that hostname with a `301` to `https://engage.fusionparty.org.au`.

| Request | Redirects to |
| --- | --- |
| `/` | `/` |
| `/reclaim-our-economy/<proposal-slug>/` | `/proposals/<proposal-slug>/` |
| `/reclaim-our-future/<proposal-slug>/` | `/proposals/<proposal-slug>/` |
| `/reclaim-our-economy/` or `/reclaim-our-future/` | `/proposals/` |
| `/reclaim-our-economy/solve-the-housing-crisis/` (section index) | `/proposals/` |
| `/pending-vote/`, `/all-policies/`, anything else | same path on Engage |

Reclaim split its platform into the two division paths above; Engage publishes
the same proposals at `/proposals/<proposal-slug>/`, so the division segment
becomes `proposals`. Section index pages keep no equivalent and resolve to the
proposal list rather than a 404. Query strings are preserved throughout, so
Engage's own legacy redirects (`/pending-vote` → `?stage=decide`,
`/all-policies` → `/proposals/`) still resolve.

## Deploy

The hostname is a Workers **custom domain**, so it can only belong to one Worker
at a time. Detach it from the previous Worker, then deploy:

```sh
# 1. Detach reclaim.fusionparty.org.au from the old `reclaim` Worker.
ACCOUNT_ID=1f3874c076be70eb3435b8a505e3c3ed
DOMAIN_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains" \
  | jq -r '.result[] | select(.hostname=="reclaim.fusionparty.org.au") | .id')
curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains/$DOMAIN_ID"

# 2. Deploy this Worker with its custom domain.
cd workers/reclaim-redirect
wrangler deploy
```

## Verify

```sh
curl -sSI https://reclaim.fusionparty.org.au/ | head -5
curl -sSI https://reclaim.fusionparty.org.au/reclaim-our-economy/make-housing-tax-fair-across-generations/ | head -5
```

Both must return `301`; the second must point at
`https://engage.fusionparty.org.au/proposals/make-housing-tax-fair-across-generations/`.

## Roll back

The retired site's Worker (`reclaim`) is left deployed and untouched. To restore
the old site, detach the custom domain from `reclaim-redirect` and re-run
`wrangler deploy` inside that site's project, or attach the domain back through
the Cloudflare dashboard (Workers → reclaim → Settings → Domains & Routes).
