# UTC — United Trading Company

UTC's website is a Cloudflare Pages app with site-wide Cloudflare Access authentication. A Pages Function fetches stock data from Alpha Vantage. The market panel shows daily data by default and can use entitled real-time quotes. This website does not place trades, accept deposits, or process withdrawals.

## Local Development

Install dependencies and enable the explicitly local-only Access bypass:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev:cloudflare
```

The command copies `.dev.vars.example` to `.dev.vars` for local preview only. This local bypass is not honored on preview or production deployments. Never commit `.dev.vars`. The site runs at `http://localhost:8788`; the market endpoint is `/api/v1/markets/daily`.

Run the Node API tests with `npm test`. `npm start` runs the Express development server on port 3000; its market API uses the same `ALPHA_VANTAGE_API_KEY` and `STOCK_SYMBOLS` environment variables.

The Express server is for local development/tests only. Production is Cloudflare Pages with the Access middleware and Access application configured; do not expose the Express port as a production site.

## Cloudflare Pages Deployment

Wrangler is included as a project development dependency. Authenticate with the Cloudflare account that will own the Pages project:

```powershell
npx wrangler login
npx wrangler pages project create utc-united-trading-company --production-branch main
```

Before publishing, configure a Cloudflare Access self-hosted application covering the full production hostname (including all paths), choose an identity provider such as One-time PIN, and create the site's Allow policy. Add the first administrator email to both this policy and `ADMIN_EMAILS` before login. The Access application audience is shown in its settings. New users added by an administrator receive eligibility for the Access login challenge through this same policy.

Cloudflare Access must protect the complete Pages hostname. The Pages middleware also validates the signed `Cf-Access-Jwt-Assertion` on every request, checks the issuer and application audience, and fails closed when Access is misconfigured. The user-management API checks the verified identity against `ADMIN_EMAILS` on the server; hiding the admin link is not used as authorization.

Create a Cloudflare API token restricted to the required account with **Access: Apps and Policies Read** and **Access: Apps and Policies Write**. Set these Pages secrets; each command prompts for its value, so do not pass secret values on the command line:

```powershell
npx wrangler pages secret put ACCESS_TEAM_DOMAIN --project-name utc-united-trading-company
npx wrangler pages secret put ACCESS_AUD --project-name utc-united-trading-company
npx wrangler pages secret put ADMIN_EMAILS --project-name utc-united-trading-company
npx wrangler pages secret put CF_ACCESS_API_TOKEN --project-name utc-united-trading-company
npx wrangler pages secret put CF_ACCESS_ACCOUNT_ID --project-name utc-united-trading-company
npx wrangler pages secret put CF_ACCESS_POLICY_ID --project-name utc-united-trading-company
npx wrangler pages secret put ALPHA_VANTAGE_API_KEY --project-name utc-united-trading-company
```

`CF_ACCESS_POLICY_ID` must identify the site's dedicated reusable Allow policy, attached to the full-site Access application. The policy is the source of truth for sign-in eligibility; the admin page appends email identities to it. Admin authorization is a separate `ADMIN_EMAILS` allowlist. Use a dedicated Cloudflare API token limited to this account and Access policy operations; it is used only server-side and never sent to the browser. In Access, configure One-time PIN or an identity provider so newly allowed email addresses can complete login.

The admin page at `/admin.html` lists email rules in the configured Access policy. Adding a user appends an email rule; it grants site access but does not grant administrator status. Add or remove administrator emails only through the protected deployment configuration. Users complete login using the Access identity provider configured for the application.

Only after the Access application, initial admin, policy IDs, and required secrets are configured, deploy:

```powershell
npm run deploy:cloudflare
```

For Git-based continuous deployment, connect the repository to this Pages project and set the production branch to `main`; Pages discovers the root `functions/` directory automatically. `wrangler.jsonc` sets the Pages output to `public/` and the default market-data mode/watchlist.

`LOCAL_AUTH_BYPASS=true` works only for Wrangler's local Pages dev mode. Production and preview requests fail closed unless a valid Access JWT and required config are present.

To use a custom domain, add it under the Pages project's **Custom domains** settings and follow Cloudflare's DNS verification. Only connect `utc.asia` or another UTC domain if you control its DNS.

## Market Data

The server-side Function calls Alpha Vantage and returns open, high, low, close, volume, and change for the latest daily session. `MARKET_DATA_MODE=daily` is the default and is cached for up to six hours. Real-time quote mode uses Alpha Vantage `GLOBAL_QUOTE` with `entitlement=realtime`, refreshes at most every 30 seconds at the edge, and requires a provider plan that includes real-time access. Set `MARKET_DATA_MODE=realtime` in Wrangler variables only after the account has the required market-data entitlement and display rights. `ALPHA_VANTAGE_API_KEY` is required; without it, the API returns an explicit configuration error and the UI displays no invented prices. `STOCK_SYMBOLS` accepts one to five comma-separated ticker symbols.

Create an Alpha Vantage key at [alphavantage.co/support](https://www.alphavantage.co/support/#api-key). Confirm the provider's current rate limits and terms for public/commercial display of exchange data before launch; Alpha Vantage requires contacting sales for commercial real-time market data. Real-money order routing, brokerage, payments, KYC/AML, and jurisdiction-specific licensing are not implemented by this website.

## Docker Development

```powershell
docker compose up --build
```

The web app runs on port 3000. Compose reads `ALPHA_VANTAGE_API_KEY` and `STOCK_SYMBOLS` from the shell or an untracked `.env` file.
