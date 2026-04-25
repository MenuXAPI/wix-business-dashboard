require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const redis = require('redis');
const app = express();
const PORT = process.env.PORT || 3000;
const MENUWIX_API_URL = process.env.MENUWIX_API_URL || 'https://menuwix-production.up.railway.app';
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const HANDSHAKE_SECRET = process.env.HANDSHAKE_SECRET || '';
const MENUWIX_SERVICE_KEY = process.env.MENUWIX_SERVICE_KEY || '';
const WIX_APP_ID = process.env.WIX_APP_ID || '';
const WIX_APP_SECRET = process.env.WIX_APP_SECRET || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';

// Redis client for storing per-user API keys
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.connect().catch(err => console.error('Redis connect error:', err));

// Store/retrieve per-user MenuWix API keys
// Key format: user_key:{wix_user_id}
async function getUserKey(wixUserId) {
    if (!wixUserId) return MENUWIX_SERVICE_KEY;
    const key = await redisClient.get('user_key:' + wixUserId);
    return key || null;
}

async function setUserKey(wixUserId, apiKey) {
    await redisClient.set('user_key:' + wixUserId, apiKey);
}

// Resolve Wix instance token → user ID
async function resolveWixUser(instance) {
    if (!instance || !WIX_APP_SECRET) return null;
    try {
        const r = await fetch('https://www.wixapis.com/apps/v1/instance', {
            headers: { 'Authorization': instance }
        });
        const data = await r.json();
        return data?.instance?.instanceId || null;
    } catch { return null; }
}

// Get or provision a user's API key (creates trial key if none exists)
async function getOrProvisionKey(wixUserId, email) {
    const existing = await getUserKey(wixUserId);
    if (existing) return existing;
    // Provision a trial key
    const r = await fetch(MENUWIX_API_URL + '/generate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Handshake-Secret': HANDSHAKE_SECRET },
        body: JSON.stringify({ user_id: wixUserId, email: email || '', plan: 'trial' })
    });
    const data = await r.json();
    if (data.api_key) {
        await setUserKey(wixUserId, data.api_key);
        return data.api_key;
    }
    return MENUWIX_SERVICE_KEY; // fallback
}

// Plan definitions — single source of truth
const PLANS = {
    starter:  { id: 'starter',  label: 'Starter',  price: 4.99,  extractions: 5   },
    pro:      { id: 'pro',      label: 'Pro',       price: 29.99, extractions: 50  },
    business: { id: 'business', label: 'Business',  price: 59.99, extractions: 150 },
};

app.use(express.json({ limit: '20mb' }));

const UPLOAD_DIR = path.join(__dirname, 'tmp_uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Images only'));
    }
});

// Allow embedding in Wix Dashboard iframe
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    next();
});

// ── Upload images and extract menu ───────────────────────────────────────────
app.post('/api/menu/upload', upload.array('images', 5), async (req, res) => {
    if (!req.files || req.files.length === 0)
        return res.status(400).json({ error: 'No images uploaded' });

    const BASE_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const imageUrls = req.files.map(f => `${BASE_URL}/uploads/${f.filename}`);
    console.log('Upload received:', req.files.length, 'files');
    console.log('Image URLs being sent to API:', imageUrls);

    setTimeout(() => { req.files.forEach(f => fs.unlink(f.path, () => {})); }, 5 * 60 * 1000);

    try {
        const r = await fetch(MENUWIX_API_URL + '/menu/from-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': MENUWIX_SERVICE_KEY },
            body: JSON.stringify({ image_urls: imageUrls, mode: 'smart', user_plan: req.body.user_plan || '' })
        });
        const data = await r.json();
        console.log('API response status:', r.status, 'data:', JSON.stringify(data).slice(0, 300));
        res.status(r.status).json(data);
    } catch (err) {
        console.error('menu/upload error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Google Places autocomplete proxy ─────────────────────────────────────────
app.get('/api/autocomplete', async (req, res) => {
    const input = req.query.input;
    if (!input || input.length < 2) return res.json({ predictions: [] });
    try {
        const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json?input='
            + encodeURIComponent(input) + '&types=establishment&key=' + GOOGLE_PLACES_API_KEY;
        const r = await fetch(url);
        const data = await r.json();
        res.json(data);
    } catch (err) {
        console.error('Autocomplete error:', err.message);
        res.status(502).json({ predictions: [] });
    }
});

// ── Key handshake ─────────────────────────────────────────────────────────────
app.post('/api/generate-key', async (req, res) => {
    const { user_id, email, plan } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
        const r = await fetch(MENUWIX_API_URL + '/generate-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Handshake-Secret': HANDSHAKE_SECRET },
            body: JSON.stringify({ user_id, email, plan: plan || 'trial' })
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        console.error('generate-key error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Menu preview ──────────────────────────────────────────────────────────────
app.post('/api/menu/preview', async (req, res) => {
    try {
        const wixUserId = await resolveWixUser(req.body.instance);
        const apiKey = wixUserId ? await getOrProvisionKey(wixUserId, req.body.email) : MENUWIX_SERVICE_KEY;
        const r = await fetch(MENUWIX_API_URL + '/menu/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
            body: JSON.stringify(req.body)
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        console.error('menu/preview error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Menu status ───────────────────────────────────────────────────────────────
app.get('/api/menu/status/:run_id', async (req, res) => {
    try {
        const wixUserId = await resolveWixUser(req.query.instance);
        const apiKey = wixUserId ? await getOrProvisionKey(wixUserId) : MENUWIX_SERVICE_KEY;
        const r = await fetch(MENUWIX_API_URL + '/menu/status/' + req.params.run_id, {
            headers: { 'X-API-KEY': apiKey }
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        console.error('menu/status error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Menu unlock ───────────────────────────────────────────────────────────────
app.post('/api/menu/unlock', async (req, res) => {
    try {
        const r = await fetch(MENUWIX_API_URL + '/menu/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': MENUWIX_SERVICE_KEY },
            body: JSON.stringify(req.body)
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        console.error('menu/unlock error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Menu from images ──────────────────────────────────────────────────────────
app.post('/api/menu/from-images', async (req, res) => {
    try {
        const r = await fetch(MENUWIX_API_URL + '/menu/from-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': MENUWIX_SERVICE_KEY },
            body: JSON.stringify(req.body)
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        console.error('menu/from-images error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Admin debug ───────────────────────────────────────────────────────────────
app.get('/api/admin/run/:run_id', async (req, res) => {
    try {
        const r = await fetch(MENUWIX_API_URL + '/admin/run/' + req.params.run_id, {
            headers: { 'X-Handshake-Secret': HANDSHAKE_SECRET }
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (err) {
        console.error('admin/run error:', err.message);
        res.status(502).json({ error: 'Failed to reach MenuWix API' });
    }
});

// ── Billing: create checkout ──────────────────────────────────────────────────
// Called by frontend when user selects a plan.
// Exchanges the Wix instance token for an access token, then creates a
// Wix Billing checkout session and returns the redirect URL.
app.post('/api/billing/create-checkout', async (req, res) => {
    const { plan, instance } = req.body;
    if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
    if (!instance) return res.status(400).json({ error: 'Wix instance token required' });
    if (!WIX_APP_ID || !WIX_APP_SECRET) return res.status(500).json({ error: 'Billing not configured' });

    try {
        // 1. Exchange instance token for access token
        const accessToken = await getWixAccessToken(instance);

        // 2. Create a Wix Billing checkout session
        const checkoutRes = await fetch('https://www.wixapis.com/billing/v1/checkout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': accessToken,
            },
            body: JSON.stringify({
                planId: plan, // matches plan slug registered in Wix Dev Center
                successUrl: `${process.env.PUBLIC_URL}/dashboard?payment=success`,
                cancelUrl: `${process.env.PUBLIC_URL}/dashboard?payment=cancelled`,
            }),
        });
        const checkoutData = await checkoutRes.json();
        if (!checkoutData.checkoutUrl) {
            console.error('Wix checkout creation failed:', checkoutData);
            return res.status(502).json({ error: 'Failed to create checkout session' });
        }

        res.json({ checkoutUrl: checkoutData.checkoutUrl });
    } catch (err) {
        console.error('billing/create-checkout error:', err.message);
        res.status(502).json({ error: 'Billing service unavailable' });
    }
});

// ── Billing: verify purchase and unlock run ───────────────────────────────────
// Called after Wix redirects back to /dashboard?payment=success.
// Verifies the order server-side, then unlocks the run on the MenuWix API.
app.post('/api/billing/verify', async (req, res) => {
    const { orderId, run_id, instance } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    if (!run_id) return res.status(400).json({ error: 'run_id required' });
    if (!instance) return res.status(400).json({ error: 'Wix instance token required' });
    if (!WIX_APP_ID || !WIX_APP_SECRET) return res.status(500).json({ error: 'Billing not configured' });

    try {
        // 1. Exchange instance token for access token
        const accessToken = await getWixAccessToken(instance);

        // 2. Verify the order exists and is paid
        const orderRes = await fetch(`https://www.wixapis.com/billing/v1/orders/${orderId}`, {
            headers: { 'Authorization': accessToken },
        });
        const orderData = await orderRes.json();
        const status = orderData?.order?.status;
        if (status !== 'PAID' && status !== 'ACTIVE') {
            return res.status(402).json({ error: 'Order not paid', status });
        }

        // 3. Unlock the run on MenuWix API (server-to-server, uses handshake secret)
        const unlockRes = await fetch(MENUWIX_API_URL + '/menu/unlock', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Handshake-Secret': HANDSHAKE_SECRET,
            },
            body: JSON.stringify({ run_id }),
        });
        const unlockData = await unlockRes.json();
        if (!unlockData.unlocked) {
            return res.status(502).json({ error: 'Failed to unlock run', detail: unlockData });
        }

        res.json({ verified: true, unlocked: true, run_id });
    } catch (err) {
        console.error('billing/verify error:', err.message);
        res.status(502).json({ error: 'Billing verification failed' });
    }
});

// ── Wix billing webhook ───────────────────────────────────────────────────────
// Receives order_created, order_updated, order_cancelled from Wix.
// Reissues the user's JWT key with the correct plan automatically.
app.post('/webhooks/wix', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const body = JSON.parse(req.body.toString());
        const eventType = body?.eventType || body?.event?.eventType || '';
        const data = body?.data || body?.event?.data || {};

        // Extract subscriber info
        const wixUserId = data?.subscriberId || data?.buyerId || data?.userId;
        const planSlug = data?.planId || data?.productId || '';
        const email = data?.email || '';

        if (!wixUserId || !planSlug) {
            console.warn('Webhook missing user or plan:', { wixUserId, planSlug, eventType });
            return res.sendStatus(200); // ack anyway
        }

        // Map event to plan
        let targetPlan = null;
        if (eventType.includes('order_created') || eventType.includes('order_updated')) {
            targetPlan = PLANS[planSlug] ? planSlug : null;
        } else if (eventType.includes('order_cancelled') || eventType.includes('order_canceled')) {
            targetPlan = 'trial';
        }

        if (!targetPlan) {
            console.warn('Unhandled webhook event or unknown plan:', { eventType, planSlug });
            return res.sendStatus(200);
        }

        // Reissue API key with new plan
        const r = await fetch(MENUWIX_API_URL + '/admin/set-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Handshake-Secret': HANDSHAKE_SECRET },
            body: JSON.stringify({ user_id: wixUserId, email, plan: targetPlan })
        });
        const result = await r.json();

        if (result.api_key) {
            await setUserKey(wixUserId, result.api_key);
            console.log(`Plan updated: user=${wixUserId} plan=${targetPlan}`);
        } else {
            console.error('set-plan failed:', result);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err.message);
        res.sendStatus(200); // always ack to prevent Wix retries on our errors
    }
});

// ── Shared: get Wix access token from instance ───────────────────────────────
async function getWixAccessToken(instance) {
    const r = await fetch('https://www.wixapis.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: WIX_APP_ID,
            client_secret: WIX_APP_SECRET,
            code: instance,
        }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error('Wix token exchange failed');
    return data.access_token;
}

// ── Menu import ───────────────────────────────────────────────────────────────
// After unlock, imports the full extracted menu into the merchant's Wix site.
// Detects Wix Restaurants — uses Restaurants Menus API if available,
// falls back to CMS Data Collections otherwise.
app.post('/api/menu/import', async (req, res) => {
    const { run_id, instance } = req.body;
    if (!run_id) return res.status(400).json({ error: 'run_id required' });
    if (!instance) return res.status(400).json({ error: 'instance required' });

    try {
        const accessToken = await getWixAccessToken(instance);

        // Fetch full result from MenuWix API
        const runRes = await fetch(MENUWIX_API_URL + '/admin/run/' + run_id, {
            headers: { 'X-Handshake-Secret': HANDSHAKE_SECRET }
        });
        const runData = await runRes.json();
        if (!runData.full_result) return res.status(404).json({ error: 'Run result not found or expired' });
        if (runData.is_unlocked !== 'True') return res.status(402).json({ error: 'Run not unlocked' });

        const fullResult = runData.full_result;
        const businessName = fullResult.business_name || 'My Menu';

        // Flatten all items across menus/sections
        const allItems = [];
        const menus = fullResult.menus || [];
        for (const menu of menus) {
            for (const item of (menu.items || [])) {
                allItems.push(item);
            }
        }
        // Also handle matched_items format (from image extraction)
        if (!allItems.length && fullResult.matched_items) {
            allItems.push(...fullResult.matched_items);
        }

        if (!allItems.length) return res.status(400).json({ error: 'No menu items found in result' });

        // ── Try Wix Restaurants Menus API ─────────────────────────────────────
        const restaurantsCheck = await fetch('https://www.wixapis.com/restaurants/menus-menu/v1/menus', {
            headers: { 'Authorization': accessToken }
        });

        if (restaurantsCheck.ok) {
            // Wix Restaurants is available — use the full import flow
            const result = await importToWixRestaurants(accessToken, businessName, allItems);
            return res.json({ method: 'wix_restaurants', ...result });
        }

        // ── Fallback: CMS Data Collections ───────────────────────────────────
        const result = await importToCmsCollection(accessToken, allItems);
        return res.json({ method: 'cms_collection', ...result });

    } catch (err) {
        console.error('menu/import error:', err.message);
        res.status(502).json({ error: err.message || 'Import failed' });
    }
});

async function importToWixRestaurants(accessToken, menuName, items) {
    const headers = { 'Content-Type': 'application/json', 'Authorization': accessToken };

    // Group items by category
    const byCategory = {};
    for (const item of items) {
        const cat = item.category || 'Menu Items';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(item);
    }

    // 1. Create all items
    const wixItemIds = {};
    for (const [cat, catItems] of Object.entries(byCategory)) {
        wixItemIds[cat] = [];
        for (const item of catItems) {
            const priceValue = item.price ? parseFloat(item.price.replace(/[^0-9.]/g, '')) : null;
            const payload = {
                item: {
                    name: { translated: item.name },
                    description: { translated: item.description || '' },
                    ...(priceValue ? { priceInfo: { price: String(priceValue.toFixed(2)) } } : {}),
                    visible: true,
                }
            };
            const r = await fetch('https://www.wixapis.com/restaurants/menus-item/v1/items', {
                method: 'POST', headers, body: JSON.stringify(payload)
            });
            const d = await r.json();
            if (d.item?._id) wixItemIds[cat].push(d.item._id);
        }
    }

    // 2. Create sections
    const sectionIds = [];
    for (const [cat, itemIds] of Object.entries(wixItemIds)) {
        if (!itemIds.length) continue;
        const r = await fetch('https://www.wixapis.com/restaurants/menus-section/v1/sections', {
            method: 'POST', headers,
            body: JSON.stringify({ section: { name: { translated: cat }, itemIds, visible: true } })
        });
        const d = await r.json();
        if (d.section?._id) sectionIds.push(d.section._id);
    }

    // 3. Create menu
    const r = await fetch('https://www.wixapis.com/restaurants/menus-menu/v1/menus', {
        method: 'POST', headers,
        body: JSON.stringify({ menu: { name: { translated: menuName }, sectionIds, visible: true } })
    });
    const d = await r.json();

    return {
        success: true,
        menuId: d.menu?._id,
        sectionsCreated: sectionIds.length,
        itemsCreated: Object.values(wixItemIds).flat().length,
    };
}

async function importToCmsCollection(accessToken, items) {
    const headers = { 'Content-Type': 'application/json', 'Authorization': accessToken };
    const inserted = [];

    for (const item of items) {
        const optionsText = (item.options || []).map(o => `${o.name}${o.price ? ' (' + o.price + ')' : ''}`).join(', ');
        const r = await fetch('https://www.wixapis.com/wix-data/v2/items', {
            method: 'POST', headers,
            body: JSON.stringify({
                dataCollectionId: 'MenuItems',
                dataItem: {
                    data: {
                        name: item.name || '',
                        description: item.description || '',
                        price: item.price || '',
                        category: item.category || '',
                        options: optionsText,
                    }
                }
            })
        });
        const d = await r.json();
        if (d.dataItem?._id) inserted.push(d.dataItem._id);
    }

    return { success: true, itemsInserted: inserted.length };
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'wix-business-dashboard' });
});


// ── Dashboard UI ──────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MenuWix</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
      background: #f4f5f7;
      color: #162d3d;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .page { max-width: 1248px; margin: 0 auto; padding: 48px 48px 64px; }

    /* Header */
    .page-header { margin-bottom: 32px; }
    .page-header h1 { font-size: 28px; font-weight: 600; color: #162d3d; letter-spacing: -0.3px; }
    .page-header p { color: #577083; font-size: 14px; margin-top: 6px; }
    .header-row { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }

    /* Status pill */
    .status-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 20px;
      font-size: 12px; font-weight: 500;
      background: #e8f5e9; color: #2e7d32;
    }
    .status-pill::before {
      content: ''; width: 6px; height: 6px;
      border-radius: 50%; background: #43a047; display: inline-block;
    }

    /* Tabs */
    .tabs { display: flex; border-bottom: 1px solid #dfe5eb; margin-bottom: 28px; }
    .tab {
      padding: 12px 20px; font-size: 14px; font-weight: 500;
      color: #577083; cursor: pointer;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s; user-select: none;
    }
    .tab:hover { color: #162d3d; }
    .tab.active { color: #116dff; border-bottom-color: #116dff; }

    /* Cards */
    .card { background: #fff; border: 1px solid #dfe5eb; border-radius: 8px; padding: 28px; margin-bottom: 16px; }
    .card-title { font-size: 16px; font-weight: 600; color: #162d3d; margin-bottom: 6px; }
    .card-subtitle { font-size: 13px; color: #577083; margin-bottom: 20px; }

    /* Form fields */
    .field-label { font-size: 13px; font-weight: 500; color: #162d3d; margin-bottom: 6px; display: block; }
    .input-wrap { position: relative; }
    .text-input {
      width: 100%; padding: 10px 14px;
      border: 1px solid #c1cdd6; border-radius: 6px;
      font-size: 14px; font-family: inherit; color: #162d3d;
      background: #fff; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .text-input::placeholder { color: #92a2ae; }
    .text-input:focus { border-color: #116dff; box-shadow: 0 0 0 3px rgba(17,109,255,0.15); }

    /* Autocomplete */
    .suggestions {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0;
      background: #fff; border: 1px solid #c1cdd6; border-radius: 6px;
      box-shadow: 0 4px 16px rgba(22,45,61,0.12);
      z-index: 200; max-height: 240px; overflow-y: auto; display: none;
    }
    .suggestions.open { display: block; }
    .suggestion-item {
      padding: 10px 14px; font-size: 14px; cursor: pointer;
      border-bottom: 1px solid #f0f4f7; color: #162d3d; transition: background 0.1s;
    }
    .suggestion-item:last-child { border-bottom: none; }
    .suggestion-item:hover, .suggestion-item.active { background: #f0f5ff; color: #116dff; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; gap: 7px;
      background: #116dff; color: #fff; border: none;
      padding: 10px 22px; border-radius: 6px;
      font-size: 14px; font-weight: 500; font-family: inherit;
      cursor: pointer; transition: background 0.15s, box-shadow 0.15s; white-space: nowrap;
    }
    .btn:hover { background: #0d5ce0; box-shadow: 0 2px 8px rgba(17,109,255,0.25); }
    .btn:active { background: #0a4fc7; }
    .btn:disabled { background: #c1cdd6; cursor: not-allowed; box-shadow: none; }
    .btn-ghost {
      background: #fff; color: #116dff; border: 1px solid #116dff;
    }
    .btn-ghost:hover { background: #f0f5ff; box-shadow: none; }

    /* Loading */
    .loading-row { display: none; align-items: center; gap: 10px; margin-top: 16px; color: #577083; font-size: 13px; }
    .loading-row.active { display: flex; }
    .spinner {
      width: 16px; height: 16px; flex-shrink: 0;
      border: 2px solid #dfe5eb; border-top-color: #116dff;
      border-radius: 50%; animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Error */
    .error-box {
      display: none; margin-top: 14px; padding: 12px 16px;
      background: #fef0f0; border: 1px solid #f5c0c0;
      border-radius: 6px; color: #c0392b; font-size: 13px;
    }
    .error-box.active { display: block; }

    /* Preview banner */
    .preview-banner {
      display: flex; justify-content: space-between; align-items: center;
      background: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px;
      padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #7c5800; gap: 12px;
    }

    /* Results */
    .result-section { display: none; }
    .result-section.active { display: block; }
    .result-meta { font-size: 13px; color: #92a2ae; margin-top: 4px; }
    .divider { border: none; border-top: 1px solid #f0f4f7; margin: 16px 0; }
    .section-label {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.8px; color: #92a2ae; margin: 20px 0 10px;
    }
    .section-label:first-child { margin-top: 0; }
    .menu-item {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding: 11px 0; border-bottom: 1px solid #f0f4f7;
    }
    .menu-item:last-child { border-bottom: none; }
    .item-name { font-size: 14px; font-weight: 500; color: #162d3d; }
    .item-desc { font-size: 12px; color: #92a2ae; margin-top: 2px; }
    .item-price { font-size: 14px; font-weight: 500; color: #116dff; white-space: nowrap; margin-left: 16px; }
    .locked-placeholder {
      text-align: center; padding: 18px;
      background: #f8fafc; border: 1px dashed #c1cdd6;
      border-radius: 6px; color: #92a2ae; font-size: 13px; margin-top: 12px;
    }

    /* Upload */
    .upload-zone {
      border: 2px dashed #c1cdd6; border-radius: 8px;
      padding: 40px 24px; text-align: center; cursor: pointer;
      transition: border-color 0.2s, background 0.2s; background: #fafbfc;
    }
    .upload-zone:hover, .upload-zone.dragover { border-color: #116dff; background: #f0f5ff; }
    .upload-zone input[type=file] { display: none; }
    .upload-icon { font-size: 36px; margin-bottom: 10px; }
    .upload-zone p { color: #577083; font-size: 14px; }
    .upload-zone .hint { font-size: 12px; color: #92a2ae; margin-top: 4px; }
    .upload-thumbs { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    .upload-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid #dfe5eb; }

    /* Actions row */
    .actions-row { display: flex; align-items: center; gap: 12px; margin-top: 20px; flex-wrap: wrap; }

    /* Modal overlay */
    .modal-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(22,45,61,0.5); z-index: 1000;
      align-items: center; justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: #fff; border-radius: 12px; padding: 32px;
      width: 100%; max-width: 520px; margin: 16px;
      box-shadow: 0 8px 40px rgba(22,45,61,0.18);
    }
    .modal-title { font-size: 20px; font-weight: 600; color: #162d3d; margin-bottom: 6px; }
    .modal-subtitle { font-size: 13px; color: #577083; margin-bottom: 24px; }
    .plan-cards { display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px; }
    .plan-card {
      border: 2px solid #dfe5eb; border-radius: 8px; padding: 16px 18px;
      cursor: pointer; transition: border-color 0.15s, background 0.15s;
      display: flex; justify-content: space-between; align-items: center;
    }
    .plan-card:hover { border-color: #116dff; background: #f8fbff; }
    .plan-card.selected { border-color: #116dff; background: #f0f5ff; }
    .plan-name { font-size: 15px; font-weight: 600; color: #162d3d; }
    .plan-desc { font-size: 12px; color: #577083; margin-top: 2px; }
    .plan-price { font-size: 16px; font-weight: 600; color: #116dff; white-space: nowrap; margin-left: 16px; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
    .modal-cancel { background: none; border: 1px solid #dfe5eb; color: #577083; padding: 9px 18px; border-radius: 6px; font-size: 14px; font-family: inherit; cursor: pointer; }
    .modal-cancel:hover { border-color: #c1cdd6; color: #162d3d; }

    @media (max-width: 700px) {
      .page { padding: 24px 20px 48px; }
      .page-header h1 { font-size: 22px; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Page header -->
  <div class="page-header">
    <div class="header-row">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="8" fill="#116dff"/>
        <path d="M8 10h16M8 16h10M8 22h13" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
      <h1>MenuWix</h1>
      <span class="status-pill">Connected</span>
    </div>
    <p>AI-powered menu extraction — find your business or upload a photo to get started.</p>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" id="tabSearch" onclick="switchTab('search')">Search by Location</div>
    <div class="tab" id="tabUpload" onclick="switchTab('upload')">Upload Menu Photo</div>
  </div>

  <!-- Search panel -->
  <div id="panelSearch">
    <div class="card">
      <div class="card-title">Find Your Business</div>
      <div class="card-subtitle">Search for your restaurant or business to automatically extract your menu.</div>
      <label class="field-label" for="addressInput">Business name or address</label>
      <div class="input-wrap">
        <input id="addressInput" class="text-input" type="text"
          placeholder="e.g. Starbucks, 123 Main St, New York" autocomplete="off" />
        <div class="suggestions" id="suggestions"></div>
      </div>
      <div class="actions-row">
        <button class="btn" id="extractBtn" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Extract Menu
        </button>
      </div>
      <div class="loading-row" id="loading">
        <div class="spinner"></div>
        <span id="loadingMsg">Submitting...</span>
      </div>
      <div class="error-box" id="errorMsg"></div>
    </div>

    <div class="result-section" id="resultSection">
      <div class="preview-banner" id="previewBanner">
        <span>🔒 Preview only — unlock to get the full menu JSON.</span>
        <button class="btn btn-ghost" id="unlockBtn" style="padding:7px 16px;font-size:13px;">Unlock Full Menu</button>
      </div>
      <div class="preview-banner" id="importBanner" style="display:none;background:#e8f5e9;border-color:#a5d6a7;color:#1b5e20;">
        <span>✅ Menu unlocked — import it directly into your Wix site.</span>
        <button class="btn" id="importBtn" style="padding:7px 16px;font-size:13px;background:#2e7d32;">Import to Wix</button>
      </div>
      <div class="card">
        <div class="card-title" id="resultTitle">Menu Preview</div>
        <div class="result-meta" id="resultMeta"></div>
        <hr class="divider">
        <div id="noMenuMsg" style="display:none;color:#92a2ae;font-size:13px;">No menu items found for this location.</div>
        <div id="menuSections"></div>
      </div>
    </div>
  </div>

  <!-- Upload panel -->
  <div id="panelUpload" style="display:none;">
    <div class="card">
      <div class="card-title">Upload Menu Photo</div>
      <div class="card-subtitle">Upload a photo of your menu and we'll extract all items automatically.</div>
      <div class="upload-zone" id="uploadArea" onclick="document.getElementById('fileInput').click()">
        <input type="file" id="fileInput" accept="image/*" multiple />
        <div class="upload-icon">📷</div>
        <p>Click to upload or drag &amp; drop</p>
        <p class="hint">PNG, JPG up to 10 MB &nbsp;·&nbsp; Max 5 images</p>
      </div>
      <div class="upload-thumbs" id="uploadPreview"></div>
      <div class="actions-row">
        <button class="btn" id="uploadExtractBtn" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
          Extract Menu
        </button>
        <button class="btn btn-ghost" id="clearUploadBtn" style="display:none;" onclick="clearUpload()">Clear</button>
      </div>
      <div class="loading-row" id="uploadLoading">
        <div class="spinner"></div>
        <span>Extracting menu items...</span>
      </div>
      <div class="error-box" id="uploadErrorMsg"></div>
    </div>

    <div class="result-section" id="uploadResultSection">
      <div class="preview-banner" id="uploadPreviewBanner" style="display:none;">
        <span>🔒 Preview only — upgrade to a paid or trial plan to unlock the full menu.</span>
      </div>
      <div class="card">
        <div class="card-title">Extracted Menu</div>
        <hr class="divider">
        <div id="uploadMenuSections"></div>
      </div>
    </div>
  </div>

  <!-- Pricing modal -->
  <div class="modal-overlay" id="pricingModal">
    <div class="modal">
      <div class="modal-title">Unlock Full Menu</div>
      <div class="modal-subtitle">Choose a plan to unlock the complete menu JSON and all items.</div>
      <div class="plan-cards">
        <div class="plan-card" data-plan="starter" onclick="selectPlan('starter')">
          <div><div class="plan-name">Starter</div><div class="plan-desc">5 extractions / month</div></div>
          <div class="plan-price">$4.99/mo</div>
        </div>
        <div class="plan-card" data-plan="pro" onclick="selectPlan('pro')">
          <div><div class="plan-name">Pro</div><div class="plan-desc">50 extractions / month</div></div>
          <div class="plan-price">$29.99/mo</div>
        </div>
        <div class="plan-card" data-plan="business" onclick="selectPlan('business')">
          <div><div class="plan-name">Business</div><div class="plan-desc">150 extractions / month</div></div>
          <div class="plan-price">$59.99/mo</div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn" id="checkoutBtn" disabled onclick="startCheckout()">Continue to Payment</button>
      </div>
    </div>
  </div>

  <!-- Dev toolbar (localhost only) -->
  <div id="devToolbar" style="display:none;position:fixed;bottom:20px;right:20px;background:#162d3d;color:#fff;border-radius:8px;padding:10px 14px;font-size:12px;font-family:inherit;box-shadow:0 4px 16px rgba(0,0,0,0.3);z-index:999;display:flex;align-items:center;gap:10px;">
    <span style="opacity:0.6;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;">Dev</span>
    <select id="devPlan" style="background:#253d50;color:#fff;border:1px solid #3a5568;border-radius:4px;padding:4px 8px;font-size:12px;font-family:inherit;cursor:pointer;outline:none;">
      <option value="">Preview (no plan)</option>
      <option value="trial">Trial</option>
      <option value="starter">Starter</option>
      <option value="pro">Pro</option>
      <option value="business">Business</option>
    </select>
  </div>

<script>
  // Show dev toolbar on localhost only
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    document.getElementById('devToolbar').style.display = 'flex';
  }

  function getDevPlan() {
    return document.getElementById('devPlan') ? document.getElementById('devPlan').value : '';
  }
  var selectedPlaceId = null, currentRunId = null;
  var pollTimer = null, debounceTimer = null;
  var predictions = [], activeIndex = -1;

  var input = document.getElementById('addressInput');
  var suggestionsEl = document.getElementById('suggestions');
  var extractBtn = document.getElementById('extractBtn');

  input.addEventListener('input', function() {
    clearTimeout(debounceTimer);
    selectedPlaceId = null;
    extractBtn.disabled = true;
    var val = input.value.trim();
    if (val.length < 2) { closeSuggestions(); return; }
    debounceTimer = setTimeout(function() { fetchSuggestions(val); }, 250);
  });

  input.addEventListener('keydown', function(e) {
    var items = suggestionsEl.querySelectorAll('.suggestion-item');
    if (e.key === 'ArrowDown') { activeIndex = Math.min(activeIndex + 1, items.length - 1); highlight(items); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { activeIndex = Math.max(activeIndex - 1, 0); highlight(items); e.preventDefault(); }
    else if (e.key === 'Enter' && activeIndex >= 0) { selectPrediction(predictions[activeIndex]); e.preventDefault(); }
    else if (e.key === 'Escape') { closeSuggestions(); }
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.input-wrap')) closeSuggestions();
  });

  function highlight(items) {
    items.forEach(function(el, i) { el.classList.toggle('active', i === activeIndex); });
  }

  function fetchSuggestions(val) {
    fetch('/api/autocomplete?input=' + encodeURIComponent(val))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        predictions = data.predictions || [];
        if (!predictions.length) { closeSuggestions(); return; }
        activeIndex = -1;
        suggestionsEl.innerHTML = predictions.map(function(p, i) {
          return '<div class="suggestion-item" data-index="' + i + '">' + p.description + '</div>';
        }).join('');
        suggestionsEl.querySelectorAll('.suggestion-item').forEach(function(el) {
          el.addEventListener('mousedown', function(e) {
            e.preventDefault();
            selectPrediction(predictions[parseInt(el.dataset.index)]);
          });
        });
        suggestionsEl.classList.add('open');
      })
      .catch(function() { closeSuggestions(); });
  }

  function selectPrediction(p) {
    selectedPlaceId = p.place_id;
    input.value = p.description;
    extractBtn.disabled = false;
    closeSuggestions();
  }

  function closeSuggestions() {
    suggestionsEl.classList.remove('open');
    suggestionsEl.innerHTML = '';
  }

  extractBtn.addEventListener('click', function() {
    if (!selectedPlaceId) return;
    var loading = document.getElementById('loading');
    var errorMsg = document.getElementById('errorMsg');
    var resultSection = document.getElementById('resultSection');

    extractBtn.disabled = true;
    loading.classList.add('active');
    document.getElementById('loadingMsg').textContent = 'Submitting...';
    errorMsg.classList.remove('active');
    resultSection.classList.remove('active');

    fetch('/api/menu/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_id: selectedPlaceId, instance: wixInstance })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) throw new Error(data.error);
      currentRunId = data.run_id;
      document.getElementById('loadingMsg').textContent = 'Extracting menu... this may take a minute.';
      pollStatus();
    })
    .catch(function(err) {
      loading.classList.remove('active');
      extractBtn.disabled = false;
      errorMsg.textContent = err.message;
      errorMsg.classList.add('active');
    });
  });

  function renderMenuPreview(preview, isUnlocked) {
    var sectionsEl = document.getElementById('menuSections');
    var noMenuMsg = document.getElementById('noMenuMsg');
    sectionsEl.innerHTML = '';
    var items = preview.preview_items || [];
    if (!items.length) { noMenuMsg.style.display = 'block'; return; }
    noMenuMsg.style.display = 'none';
    var sectionName = (preview.first_section && preview.first_section.name) ? preview.first_section.name : 'Menu Items';
    var html = '<div class="section-label">' + sectionName + '</div>';
    items.forEach(function(item) {
      html += '<div class="menu-item">'
        + '<div><div class="item-name">' + (item.name || '') + '</div>'
        + (item.description ? '<div class="item-desc">' + item.description + '</div>' : '')
        + '</div>'
        + (item.price ? '<div class="item-price">' + item.price + '</div>' : '')
        + '</div>';
    });
    if (!isUnlocked && preview.locked_item_count > 0) {
      html += '<div class="locked-placeholder">🔒 ' + preview.locked_item_count + ' more items hidden — unlock to see the full menu.</div>';
    }
    sectionsEl.innerHTML = html;
  }

  function pollStatus() {
    clearTimeout(pollTimer);
    fetch('/api/menu/status/' + currentRunId + '?instance=' + encodeURIComponent(wixInstance))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.status === 'processing') { pollTimer = setTimeout(pollStatus, 3000); return; }
        document.getElementById('loading').classList.remove('active');
        extractBtn.disabled = false;
        if (data.status === 'failed' || data.error) {
          document.getElementById('errorMsg').textContent = data.error || 'Extraction failed.';
          document.getElementById('errorMsg').classList.add('active');
          return;
        }
        var preview = data.preview || data;
        var isUnlocked = data.is_unlocked === true || data.is_unlocked === 'True';
        document.getElementById('previewBanner').style.display = isUnlocked ? 'none' : 'flex';
        document.getElementById('importBanner').style.display = isUnlocked ? 'flex' : 'none';
        document.getElementById('resultTitle').textContent = (preview.business_name || 'Menu') + (isUnlocked ? '' : ' — Preview');
        var total = preview.total_items || 0;
        var sections = preview.total_sections || 0;
        document.getElementById('resultMeta').textContent = total
          ? sections + ' section' + (sections !== 1 ? 's' : '') + ', ' + total + ' items total'
          : '';
        renderMenuPreview(preview, isUnlocked);
        document.getElementById('resultSection').classList.add('active');
      })
      .catch(function(err) {
        document.getElementById('loading').classList.remove('active');
        extractBtn.disabled = false;
        document.getElementById('errorMsg').textContent = 'Error polling status: ' + err.message;
        document.getElementById('errorMsg').classList.add('active');
      });
  }

  // Read Wix instance token from URL query param (injected by Wix iframe)
  var wixInstance = (new URLSearchParams(window.location.search)).get('instance') || '';

  // On return from Wix checkout, verify payment and unlock
  (function() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success' && currentRunId) {
      var orderId = params.get('orderId') || '';
      if (orderId) {
        fetch('/api/billing/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: orderId, run_id: currentRunId, instance: wixInstance })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.unlocked) {
            document.getElementById('previewBanner').style.display = 'none';
            // Re-fetch the full result via status endpoint
            fetch('/api/menu/status/' + currentRunId + '?instance=' + encodeURIComponent(wixInstance))
              .then(function(r) { return r.json(); })
              .then(function(d) {
                var preview = d.preview || d;
                document.getElementById('resultTitle').textContent = (preview.business_name || 'Menu') + ' — Full Menu';
                renderMenuPreview(preview, true);
                document.getElementById('resultSection').classList.add('active');
              });
          }
        })
        .catch(function(err) { console.error('Verify error:', err); });
      }
    }
  })();

  // Pricing modal
  var selectedPlanId = null;

  function openModal() { document.getElementById('pricingModal').classList.add('open'); }
  function closeModal() { document.getElementById('pricingModal').classList.remove('open'); }

  function selectPlan(planId) {
    selectedPlanId = planId;
    document.querySelectorAll('.plan-card').forEach(function(el) {
      el.classList.toggle('selected', el.dataset.plan === planId);
    });
    document.getElementById('checkoutBtn').disabled = false;
  }

  function startCheckout() {
    if (!selectedPlanId || !currentRunId) return;
    var btn = document.getElementById('checkoutBtn');
    btn.disabled = true;
    btn.textContent = 'Redirecting...';
    fetch('/api/billing/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: selectedPlanId, instance: wixInstance, run_id: currentRunId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        alert(data.error || 'Could not start checkout. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Continue to Payment';
      }
    })
    .catch(function(err) {
      alert('Checkout error: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Continue to Payment';
    });
  }

  document.getElementById('unlockBtn').addEventListener('click', function() {
    if (!currentRunId) return;
    // Dev mode: bypass modal and call unlock directly
    if (getDevPlan()) {
      fetch('/api/menu/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: currentRunId })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { alert(data.error); return; }
        document.getElementById('previewBanner').style.display = 'none';
        document.getElementById('resultTitle').textContent = (data.business_name || 'Menu') + ' — Full Menu';
        renderMenuPreview(data, true);
      })
      .catch(function(err) { alert('Unlock failed: ' + err.message); });
      return;
    }
    openModal();
  });

  // Import to Wix
  document.getElementById('importBtn').addEventListener('click', function() {
    if (!currentRunId) return;
    var btn = document.getElementById('importBtn');
    btn.disabled = true;
    btn.textContent = 'Importing...';
    fetch('/api/menu/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: currentRunId, instance: wixInstance })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        var msg = data.method === 'wix_restaurants'
          ? '✅ Menu imported into Wix Restaurants (' + data.itemsCreated + ' items, ' + data.sectionsCreated + ' sections)'
          : '✅ ' + data.itemsInserted + ' items added to your MenuItems collection in Wix CMS';
        document.getElementById('importBanner').innerHTML = '<span>' + msg + '</span>';
        btn.style.display = 'none';
      } else {
        alert(data.error || 'Import failed. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Import to Wix';
      }
    })
    .catch(function(err) {
      alert('Import error: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Import to Wix';
    });
  });

  // Tab switching
  function switchTab(tab) {
    document.getElementById('panelSearch').style.display = tab === 'search' ? 'block' : 'none';
    document.getElementById('panelUpload').style.display = tab === 'upload' ? 'block' : 'none';
    document.getElementById('tabSearch').classList.toggle('active', tab === 'search');
    document.getElementById('tabUpload').classList.toggle('active', tab === 'upload');
  }

  // Upload tab
  var uploadedFiles = [];
  var fileInput = document.getElementById('fileInput');
  var uploadArea = document.getElementById('uploadArea');
  var uploadExtractBtn = document.getElementById('uploadExtractBtn');

  fileInput.addEventListener('change', function() { handleFiles(this.files); });
  uploadArea.addEventListener('dragover', function(e) { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', function() { uploadArea.classList.remove('dragover'); });
  uploadArea.addEventListener('drop', function(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  function handleFiles(files) {
    var preview = document.getElementById('uploadPreview');
    for (var i = 0; i < files.length && uploadedFiles.length < 5; i++) {
      var file = files[i];
      if (!file.type.startsWith('image/')) continue;
      uploadedFiles.push(file);
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:80px;height:80px;flex-shrink:0;';
      wrap.dataset.index = uploadedFiles.length - 1;
      var img = document.createElement('img');
      img.className = 'upload-thumb';
      img.style.cssText = 'width:100%;height:100%;';
      img.src = URL.createObjectURL(file);
      wrap.appendChild(img);
      preview.appendChild(wrap);
    }
    uploadExtractBtn.disabled = uploadedFiles.length === 0;
    document.getElementById('clearUploadBtn').style.display = uploadedFiles.length ? 'inline-flex' : 'none';
  }

  function markThumbIssue(imageUrl) {
    // Match thumb by stored object URL isn't possible after the fact,
    // so we mark by order — image_issues contains the server-side URL.
    // We store the server URLs on the wraps after upload completes.
    var wraps = document.querySelectorAll('#uploadPreview [data-server-url]');
    wraps.forEach(function(wrap) {
      if (wrap.dataset.serverUrl === imageUrl) {
        // Add warning overlay
        if (!wrap.querySelector('.thumb-warn')) {
          var badge = document.createElement('div');
          badge.className = 'thumb-warn';
          badge.title = 'Image quality issue';
          badge.innerHTML = '!';
          badge.style.cssText = 'position:absolute;top:4px;right:4px;width:18px;height:18px;'
            + 'background:#e53935;color:#fff;border-radius:50%;font-size:11px;font-weight:700;'
            + 'display:flex;align-items:center;justify-content:center;line-height:1;';
          wrap.appendChild(badge);
          wrap.querySelector('img').style.opacity = '0.5';
          wrap.querySelector('img').style.outline = '2px solid #e53935';
          wrap.querySelector('img').style.borderRadius = '6px';
        }
      }
    });
  }

  function clearUpload() {
    uploadedFiles = [];
    document.getElementById('uploadPreview').innerHTML = '';
    document.getElementById('fileInput').value = '';
    uploadExtractBtn.disabled = true;
    document.getElementById('clearUploadBtn').style.display = 'none';
    document.getElementById('uploadResultSection').classList.remove('active');
    document.getElementById('uploadErrorMsg').classList.remove('active');
  }

  uploadExtractBtn.addEventListener('click', function() {
    if (!uploadedFiles.length) return;
    var loading = document.getElementById('uploadLoading');
    var errorMsg = document.getElementById('uploadErrorMsg');
    var resultSection = document.getElementById('uploadResultSection');

    uploadExtractBtn.disabled = true;
    loading.classList.add('active');
    errorMsg.classList.remove('active');
    resultSection.classList.remove('active');

    var formData = new FormData();
    uploadedFiles.forEach(function(file) { formData.append('images', file); });
    var devPlanEl = document.getElementById('devPlan');
    if (devPlanEl) formData.append('user_plan', devPlanEl.value);

    fetch('/api/menu/upload', { method: 'POST', body: formData })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        loading.classList.remove('active');
        uploadExtractBtn.disabled = false;
        if (data.error && !data.unreadable) throw new Error(data.error);

        // Store server-side URLs on thumb wrappers so we can match issues
        var imageUrls = (data.result && data.result.image_urls) || [];
        var wraps = document.querySelectorAll('#uploadPreview [data-index]');
        wraps.forEach(function(wrap, i) {
          if (imageUrls[i]) wrap.dataset.serverUrl = imageUrls[i];
        });

        // Mark any problem thumbnails
        var issues = data.image_issues || [];
        issues.forEach(function(issue) {
          if (issue.unreadable && issue.image_url) markThumbIssue(issue.image_url);
        });

        // Check for unreadable image (single image case)
        if (data.unreadable) {
          document.getElementById('uploadMenuSections').innerHTML =
            '<div style="display:flex;align-items:flex-start;gap:12px;padding:16px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;">'
            + '<span style="font-size:20px;line-height:1;">📷</span>'
            + '<div><div style="font-weight:500;color:#7c5800;margin-bottom:4px;">Image quality too low</div>'
            + '<div style="font-size:13px;color:#92a2ae;">' + (data.error || 'Please try a clearer photo.') + '</div></div>'
            + '</div>';
          resultSection.classList.add('active');
          return;
        }

        var items = (data.result && data.result.matched_items) || (data.result && data.result.items) || [];
        var isPreview = data.is_preview === true;
        var lockedCount = data.locked_item_count || 0;
        if (!items.length) {
          document.getElementById('uploadMenuSections').innerHTML = '<p style="color:#92a2ae;font-size:13px;">No menu items found in the image(s).</p>';
        } else {
          // Show per-image issue notice if some images failed
          var issueHtml = '';
          if (issues.length > 0) {
            var msgs = issues.map(function(iss) { return iss.error || 'One image could not be read.'; });
            issueHtml = '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;'
              + 'background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;margin-bottom:14px;">'
              + '<span style="font-size:16px;line-height:1.4;">⚠️</span>'
              + '<div style="font-size:13px;color:#7c5800;">' + msgs.join('<br>') + '</div></div>';
          }
          var byCategory = {};
          items.forEach(function(item) {
            var cat = item.category || 'Other';
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(item);
          });
          var html = issueHtml;
          Object.keys(byCategory).forEach(function(cat) {
            html += '<div class="section-label">' + cat + '</div>';
            byCategory[cat].forEach(function(item) {
              html += '<div class="menu-item">'
                + '<div><div class="item-name">' + (item.name || '') + '</div>'
                + (item.description ? '<div class="item-desc">' + item.description + '</div>' : '')
                + '</div>'
                + (item.price ? '<div class="item-price">' + item.price + '</div>' : '')
                + '</div>';
            });
          });
          if (isPreview && lockedCount > 0) {
            html += '<div class="locked-placeholder">🔒 ' + lockedCount + ' more items hidden — upgrade to see the full menu.</div>';
          }
          document.getElementById('uploadMenuSections').innerHTML = html;
        }
        // Show/hide preview banner on upload result card
        var uploadBanner = document.getElementById('uploadPreviewBanner');
        uploadBanner.style.display = isPreview ? 'flex' : 'none';
        resultSection.classList.add('active');
      })
      .catch(function(err) {
        loading.classList.remove('active');
        uploadExtractBtn.disabled = false;
        errorMsg.textContent = err.message;
        errorMsg.classList.add('active');
      });
  });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log('Wix Business Dashboard running on port ' + PORT);
});
