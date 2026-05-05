# Cloudflare DDNS Worker

Cloudflare Worker endpoint for UniFi/Inadyn Dynamic DNS updates.

The production Worker name is `unifi-cloudflare-ddns`, and the router calls:

```text
unifi-cloudflare-ddns.yavor.workers.dev/update?ip=%i&hostname=%h
```

## Runtime Configuration

Configure these in Cloudflare Workers > `unifi-cloudflare-ddns` > Settings > Variables and Secrets.

Required secrets:

```text
CF_API_TOKEN
DDNS_USERNAME
DDNS_PASSWORD
CF_ZONE_ID
```

Required plaintext variables:

```text
DDNS_HOSTNAME=h.yavor.com
DDNS_UPDATE_PATH=/update
```

## Git Deployment

This repo includes `wrangler.jsonc` so Cloudflare Workers Builds can deploy it from GitHub.

Recommended Cloudflare build settings:

```text
Git repository: yavor7512/cloudfare-ddns
Production branch: main
Build command: npm test
Deploy command: npm run upload
```

`npm run upload` runs `wrangler versions upload`, which creates a new Worker version without immediately serving it. To release it when ready, go to the Worker in Cloudflare, open Deployments, and deploy the uploaded version.

If you want every push to `main` to deploy immediately instead, use:

```text
Deploy command: npm run deploy
```

## Local Checks

```sh
npm test
npx wrangler deploy --dry-run
```
