# MenuWix — Project Context

_Last updated: April 17, 2026_

---

## What We're Building

MenuWix is an AI-powered menu extraction SaaS embedded as a Wix Dashboard Plugin. Users can find their restaurant by location or upload menu photos, and the app extracts all menu items automatically. There's a preview/unlock monetization model — free users see a partial preview, paid users unlock the full menu JSON.

---

## Architecture

Two separate Railway services:

### 1. MenuWix API — `menuwix-production.up.railway.app`
- Python/Flask backend
- Handles menu extraction via Google Places and vision AI (OpenAI/Groq)
- Manages the preview/unlock model
- Repo: `MenuWix/`

Key endpoints:
- `POST /menu/preview` — start extraction job, returns `run_id`
- `GET /menu/status/:run_id` — poll for job completion
- `POST /menu/unlock` — unlock full menu (requires valid plan)
- `POST /menu/from-images` — extract from uploaded image URLs
- `POST /generate-key` — handshake to issue user API keys

Auth:
- `X-API-KEY` — service key for normal operations
- `X-Handshake-Secret` — admin/internal operations

### 2. Wix Business Dashboard — `wix-business-dashboard-production.up.railway.app`
- Node/Express server
- Serves the dashboard UI as a single inline HTML page at `/dashboard`
- Proxies all API calls to the MenuWix API (keeps secrets server-side)
- Repo: `wix-business-dashboard/`

Proxy routes (all forward to MenuWix API):
- `GET /api/autocomplete?input=` — server-side Google Places autocomplete proxy (keeps API key off client)
- `POST /api/menu/upload` — multipart image upload; converts files to public URLs, forwards to `/menu/from-images`
- `POST /api/menu/preview` — start extraction job
- `GET /api/menu/status/:run_id` — poll job status
- `POST /api/menu/unlock` — unlock full menu
- `POST /api/menu/from-images` — extract from image URLs directly
- `POST /api/generate-key` — handshake to issue user API keys (uses `X-Handshake-Secret`)
- `GET /api/admin/run/:run_id` — admin debug endpoint (uses `X-Handshake-Secret`)
- `POST /api/billing/create-checkout` — exchanges Wix `instance` token for access token, creates Wix Billing checkout session, returns `checkoutUrl`
- `POST /api/billing/verify` — verifies Wix order is `PAID`/`ACTIVE`, then calls `/menu/unlock` on MenuWix API via handshake secret
- `POST /webhooks/wix` — receives Wix billing events; reissues user JWT via `/admin/set-plan` and stores in Redis keyed by Wix user ID
- `POST /api/menu/import` — detects Wix Restaurants availability; routes to `importToWixRestaurants()` or `importToCmsCollection()` automatically

---

## Wix App Registration

- App Name: "My New App-0" (not yet renamed)
- App ID: `6eb0cd6e-eddd-4f83-aff4-b38a3bb98b07`
- App Secret Key: exists in Dev Center (not yet in Railway env vars)
- Status: Draft

### Dashboard Plugin config:
```json
{
  "hostingPlatform": "BUSINESS_MANAGER",
  "extends": "3ca518a6-8ae7-45aa-8cb9-afb3da945081",
  "title": "Business Setup",
  "iframeUrl": "https://wix-business-dashboard-production.up.railway.app/dashboard",
  "componentName": "BusinessSetupPlugin"
}
```

The dashboard is loaded as a self-hosted iframe inside the Wix Business Manager. The Site Page extension ("Auto Data for Business") has no widget/iframe URL configured yet.

---

## Environment Variables

### MenuWix API (Railway)
- `API_SIGNING_SECRET`
- `ENABLE_SYNC_ENDPOINTS`
- `GOOGLE_MAPS_API_KEY`
- `GROQ_API_KEY`
- `HANDSHAKE_SECRET`
- `OPENAI_API_KEY`
- `OUTSCRAPER_API_KEY`
- `REDIS_URL`

### Wix Business Dashboard (Railway)
- `GOOGLE_PLACES_API_KEY`
- `HANDSHAKE_SECRET`
- `MENUWIX_API_URL`
- `MENUWIX_SERVICE_KEY`
- `PORT`
- `PUBLIC_URL`
- `REDIS_URL` — shared with MenuWix API Redis instance; stores per-user JWT keys (`user_key:{wix_user_id}`)

### Missing (need to add to Railway):
- ~~`WIX_APP_ID`~~ — ✅ added to Railway
- ~~`WIX_APP_SECRET`~~ — ✅ added to Railway
- `REDIS_URL` — needs to be added to wix-business-dashboard Railway service (same value as MenuWix API)

---

## Current UI Flows

### Search by Location
1. User types business name → debounced fetch to `/api/autocomplete` (server-side Google Places proxy)
2. Selects a result from dropdown → `place_id` and address string stored
3. Clicks "Extract Menu" → `POST /api/menu/preview` with `place_id`
4. Polls `GET /api/menu/status/:run_id` every 3s
5. Shows partial preview with locked items banner
6. "Unlock Full Menu" button → opens pricing modal (dev mode bypasses modal and calls unlock directly)
7. User selects plan → `POST /api/billing/create-checkout` → redirect to Wix checkout
8. On return (`?payment=success&orderId=...`) → `POST /api/billing/verify` → run unlocked, full menu shown

### Upload Menu Photo
1. User uploads 1–5 images (drag & drop or click)
2. Clicks "Extract Menu" → `POST /api/menu/upload` (multipart)
3. Dashboard proxies images to MenuWix API
4. Results rendered with category sections
5. Preview banner shown if user is on free plan

### Dev Toolbar
- Visible on localhost only
- Dropdown to simulate plan tiers: Preview / Trial / Starter / Pro / Business
- In dev mode, unlock button bypasses modal and calls `/menu/unlock` directly

---

## Payment — Planned Implementation

**Decision: Use Wix App Billing, not Stripe.**

Reasons:
- Dashboard is already inside a Wix iframe — Stripe embedded checkout is a poor fit
- Wix has a native billing flow built for apps in the ecosystem
- Cleaner UX for Wix customers

### Planned flow:
1. User clicks "Unlock Full Menu"
2. A pricing modal opens inside the dashboard (no payment here, just plan selection)
3. User picks a plan:
   - 1 unlock
   - 10 unlocks
   - 50 unlocks
   - Monthly plan
   - Free trial
4. Frontend calls `POST /api/billing/create-checkout` with selected plan
5. Backend calls Wix Billing API, returns a checkout URL
6. Frontend redirects user to Wix checkout page
7. After payment, Wix redirects back to dashboard
8. Backend verifies purchase server-side via `GET /api/billing/verify`
9. Only then calls `POST /api/menu/unlock`

**Starting model:** Monthly subscriptions only — no one-time packs.

### Decided pricing tiers (all monthly subscriptions, 3-tier launch):
| Plan | Extractions/mo | Price | Est. cost | Margin |
|------|----------------|-------|-----------|--------|
| Starter | 5/mo | $4.99/mo | ~$0.30 | ~94% |
| Pro | 50/mo | $29.99/mo | ~$3.00 | ~90% |
| Business | 150/mo | $59.99/mo | ~$9.00 | ~85% |

No unlimited tier — "unlimited" is a liability before usage data exists. Cost per extraction is ~$0.06 at medium Outscraper tier (photos ~$0.04 + OpenAI vision/filter ~$0.02).

Free/trial: 2 lifetime extractions (already implemented via `TRIAL_LIFETIME_LIMIT = 2` in `api.py`).

Note: `PAID_MONTHLY_LIMIT` removed — replaced with `PLAN_MONTHLY_LIMITS` dict in `api.py` (`starter=5`, `pro=50`, `business=150`). `get_plan_limit(plan)` and `is_paid_plan(plan)` helpers used throughout. Legacy `paid` slug maps to 50 as fallback.

### What's needed before implementation:
- [x] Add `WIX_APP_ID` and `WIX_APP_SECRET` values to Railway env vars
- [x] Define pricing plans in Wix Dev Center with slugs `starter`, `pro`, `business`
- [x] Wire up Wix `instance` token from iframe URL query param in frontend JS
- [x] Build `/api/billing/create-checkout` route
- [x] Build `/api/billing/verify` route
- [x] Replace `unlockBtn` handler with modal → redirect flow
- [x] Add webhook endpoint `POST /webhooks/wix` to receive Wix billing events (`order_created`, `order_updated`, `order_cancelled`)
- [x] Register webhook URL in Wix Dev Center (Develop → Webhooks) pointing to `POST /webhooks/wix`
- [x] Add `REDIS_URL` to wix-business-dashboard Railway service

`PLANS` constant in `index.js` is the single source of truth for tier definitions (slugs, prices, extraction limits).

**Wix Dev Center billing setup (complete):**
- Business model set to Premium (recurring subscription)
- Plans registered: Starter $4.99/mo, Pro $29.99/mo, Business $59.99/mo
- Slugs auto-generated from plan names: `starter`, `pro`, `business`
- Pricing page URL set to `https://wix-business-dashboard-production.up.railway.app/dashboard`
- OAuth keys found at Develop → OAuth in Dev Center
- Webhook events: `wix.pricing_plans.v2.order_created`, `order_updated`, `order_canceled` (Wix spells it with one L — handler accepts both spellings)
- `REDIS_URL` in wix-business-dashboard uses the public Railway proxy URL (different project from MenuWix API)

---

## Key Technical Notes

- Frontend is vanilla JS/HTML rendered as a template string inside `index.js` — no framework
- Wix `instance` token is read from `?instance=` query param on page load and passed to all billing calls
- Rate limits in `api.py`: `/menu/preview` capped at 1000/day globally (raised from 100 for dev headroom), `/menu/from-images` at 500/day; per-minute limits unchanged
- Pricing modal implemented in dashboard UI with 3 plan cards (Starter/Pro/Business)
- Unlock access must be verified server-side, never trusted from frontend state
- Per-user API keys: dashboard resolves the Wix `instance` token → looks up stored JWT in Redis → uses it for all MenuWix API calls. Auto-provisions a trial key on first visit. Plan upgrades/downgrades reissue the key transparently via webhook — user never touches a key manually.
- `MENUWIX_SERVICE_KEY` is now a fallback only (used when no user context is available)
- Google Maps JS SDK is not used — autocomplete is fully server-side via `/api/autocomplete` proxy
- Uploaded images are saved to `tmp_uploads/`, served at `/uploads/:filename`, and auto-deleted after 5 minutes
- A soft-lock bug (extract button staying disabled after failed request) was fixed — button is always re-enabled on error or completion

---

## Wix Menu Import (Implemented)

**Status: MVP built.** The import flow is live in `index.js`.

### How it works:
- After unlock, a green "Import to Wix" banner appears
- User clicks → `POST /api/menu/import` is called with `run_id` and `instance`
- Backend fetches full result from MenuWix API, detects Wix Restaurants availability, routes automatically:
  - **Wix Restaurants detected** → `importToWixRestaurants()`: items → sections → menu via 3 REST endpoints
  - **Not detected** → `importToCmsCollection()`: bulk insert into `MenuItems` CMS collection via Wix Data Items API
- Success message shows item/section counts inline

### Shared helper:
- `getWixAccessToken(instance)` — shared across billing and import routes (token exchange deduped)

### Wix API targets (Restaurants Menus — New):
- `POST /restaurants/menus-item/v1/items`
- `POST /restaurants/menus-section/v1/sections`
- `POST /restaurants/menus-menu/v1/menus`
- **Required app permission:** "Manage Restaurants - all permissions" ✅ added in Dev Center

### CMS fallback:
- `POST /wix-data/v2/items` with `dataCollectionId: 'MenuItems'`
- `MenuItems` collection schema: `name`, `description`, `price`, `category`, `options` (text) ✅ created via data collections extension
- `item.options` flattened to text string for MVP

### MenuWix → Wix item mapping:
| MenuWix field | Wix field |
|---------------|-----------|
| `item.name` | `name.translated` |
| `item.description` | `description.translated` |
| `item.price` | `priceInfo.price` (parsed float) |
| `item.options` | flattened to text (v2: `modifierGroups`) |
| `item.category` | groups items into sections |

### Still to do:
- v2: map `item.options` into Wix modifier groups
- v3: upsert/update logic (Wix requires current `revision` field on updates)
- Wix Media Manager research — image upload URL handling
- Copy-to-clipboard fallback for users who decline import

### App naming:
- "MenuWix" will likely be rejected by Wix review (policy against using "Wix" in third-party app names)
- Leading candidate: **Menu AI**
