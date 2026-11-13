# reclaim-redirect

`reclaim.fusionparty.org.au` is retired. This Worker answers every request on
that hostname with a `301` to the same path on
`https://engage.fusionparty.org.au`.

```text
https://reclaim.fusionparty.org.au/pending-vote/?x=1
→ https://engage.fusionparty.org.au/pending-vote/?x=1
```

The path and query string are preserved rather than flattened to the homepage,
because Engage already redirects the Reclaim sections (`/pending-vote`,
`/all-policies`, `/reclaim-our-economy`, `/reclaim-our-future`) to the relevant
proposal views.

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
curl -sSI https://reclaim.fusionparty.org.au/pending-vote/?stage=decide | head -5
```

Both must return `301` with a `location` on `https://engage.fusionparty.org.au`.

## Roll back

The retired site's Worker (`reclaim`) is left deployed and untouched. To restore
the old site, detach the custom domain from `reclaim-redirect` and re-run
`wrangler deploy` inside that site's project, or attach the domain back through
the Cloudflare dashboard (Workers → reclaim → Settings → Domains & Routes).
