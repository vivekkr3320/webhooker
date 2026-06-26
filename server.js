'use strict';

require('dotenv').config();

// ── Hardened Production Configuration Assertion ───────────────────────────────
if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
  const criticalKeys = ['WEBHOOK_SECRET', 'API_KEY_HASH', 'STORAGE_TYPE'];
  for (const key of criticalKeys) {
    const val = process.env[key];
    if (!val || val.includes('change_me') || val === 'fallback_string') {
      console.error(`[CRITICAL SECURITY EXPOSITION BARS LAUNCH]: Missing or unhardened value for environment variable: ${key}`);
      process.exit(1);
    }
  }

  const storageType = (process.env.STORAGE_TYPE || '').toLowerCase();
  if (storageType !== 'postgres' && storageType !== 'redis') {
    console.error(`[CRITICAL DEPLOYMENT FAULT]: Production deployment cannot run on local file fallbacks. Set STORAGE_TYPE to 'postgres' or 'redis'.`);
    process.exit(1);
  }

  if (storageType === 'postgres') {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl || dbUrl.includes('mock_') || (dbUrl.includes('localhost') && process.env.ALLOW_LOCALHOST_DB !== 'true')) {
      console.error(`[CRITICAL SECURITY EXPOSITION BARS LAUNCH]: Missing or unhardened value for DATABASE_URL in production.`);
      process.exit(1);
    }
  } else if (storageType === 'redis') {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || redisUrl.includes('mock_') || (redisUrl.includes('localhost') && process.env.ALLOW_LOCALHOST_DB !== 'true')) {
      console.error(`[CRITICAL SECURITY EXPOSITION BARS LAUNCH]: Missing or unhardened value for REDIS_URL in production.`);
      process.exit(1);
    }
  }

  const billingKeys = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
  for (const key of billingKeys) {
    const val = process.env[key];
    if (!val || val.includes('dev_') || val.includes('mock_') || val.includes('change_me')) {
      console.error(`[CRITICAL SECURITY EXPOSITION BARS LAUNCH]: Missing or unhardened value for billing environment variable: ${key}`);
      process.exit(1);
    }
  }
}

const express = require('express');
const path    = require('path');
const https   = require('https');
const WebhookEngine = require('./src/WebhookEngine');
const { createReceiver } = require('./middleware/receiver');
const authMiddleware = require('./middleware/auth');
const quotaGate = require('./middleware/quotaGate');
const { stealthGuard, responseSanitizer, sanitizeOrgForClient } = require('./middleware/tenantGuard');
const db     = require('./src/db');
const logger = require('./src/logger');
const Transformer = require('./src/Transformer');

// ── Graceful crash handlers ───────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — process will exit');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandledRejection');
});

// ── Egress IP (non-blocking at startup) ──────────────────────────────────────
let egressIp = 'Resolving...';
https.get('https://api.ipify.org?format=json', (res) => {
  let raw = '';
  res.on('data', c => raw += c);
  res.on('end', () => {
    try { egressIp = JSON.parse(raw).ip || 'Unknown'; } catch { egressIp = 'Unknown'; }
    logger.info({ egressIp }, 'Egress IP resolved');
  });
}).on('error', () => { egressIp = 'Unavailable (offline)'; });

const app  = express();
const PORT = process.env.PORT || 4000;

// ── WebhookEngine ─────────────────────────────────────────────────────────────
const engine = new WebhookEngine({
  secret:      process.env.WEBHOOK_SECRET || 'whsec_supersecret123',
  maxRetries:  3,
  retryDelays: [5, 15, 30],
  timeout:     5000,
});

// ── Static dashboard ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Cookie Parser ─────────────────────────────────────────────────────────────
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Apply API key auth to all remaining /api/* routes (bypasses system info and onboarding)
app.use('/api', authMiddleware);

// Zero-Trust Layer: Strip confidential fields from ALL /api responses automatically
app.use('/api', responseSanitizer());

// Pre-flight billing check for replay and retry endpoints
const billingReplayGate = async (req, res, next) => {
  try {
    const org = await db.getOrganization(req.orgId);
    if (org && (org.subscriptionStatus === 'suspended' || org.subscriptionStatus === 'halted')) {
      return res.status(402).json({
        error: "Action Denied: Your account is currently locked. Upgrade or settle your invoice to redrive failed webhooks."
      });
    }
    next();
  } catch (err) {
    logger.error({ err: err.message }, 'billingReplayGate:error');
    res.status(500).json({ error: 'Internal gateway error' });
  }
};

// Mount Auth Routes
const authRouter = require('./routes/auth');
app.use(authRouter);

// Mount Billing Routes
const billingRouter = require('./routes/billing');
app.use(billingRouter);

// Public endpoint — must come BEFORE auth middleware
app.get('/api/system/info', (req, res) => {
  res.json({
    egressIp,
    signatureHeader:   'X-Webhook-Signature',
    idempotencyHeader: 'X-Webhook-Idempotency-Key',
    version:           '1.0',
    maxRetries:        engine.maxRetries,
    retryDelays:       engine.retryDelays,
    storageType:       process.env.STORAGE_TYPE || 'json',
    authEnabled:       true, // Always enabled in multi-tenant mode
  });
});

// Register / Onboard New Organization (Public)
app.post('/api/onboard', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');

    // Generate tenant ID
    const orgId = 'org_' + crypto.randomBytes(8).toString('hex');
    
    // Generate fresh API Key
    const rawKey = 'whk_' + crypto.randomBytes(28).toString('hex');
    const hash = await bcrypt.hash(rawKey, 12);

    // Save Organization
    const orgData = {
      ownerEmail: email,
      razorpayCustomerId: null,
      razorpaySubscriptionId: null,
      planTier: 'free',
      subscriptionStatus: 'active',
      monthlyUsageCount: 0,
      quotaResetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await db.saveOrganization(orgId, orgData);
    await db.createApiKey(orgId, rawKey, hash);

    logger.info({ orgId, email }, 'org:onboarded');
    res.json({
      success: true,
      apiKey: rawKey,
      orgId,
      planTier: 'free'
    });
  } catch (err) {
    logger.error({ err: err.message }, 'org:onboard_error');
    res.status(500).json({ error: err.message });
  }
});

// Scoped Endpoints and Console Actions

// List Configured Endpoints
app.get('/api/endpoints', (req, res) => {
  res.json([...engine.endpoints.values()].filter(ep => ep.orgId === req.orgId));
});

// Register New Endpoint
app.post('/api/endpoints', (req, res) => {
  try {
    const { id, url, events, secret, description, integration, headers, maxRPM, circuitThreshold, transformationScript } = req.body;
    if (!id || !url) return res.status(400).json({ error: 'Endpoint id and url are required' });

    let parsedHeaders = headers || {};
    if (typeof headers === 'string') {
      try { parsedHeaders = JSON.parse(headers); }
      catch { return res.status(400).json({ error: 'Custom headers must be valid JSON' }); }
    }

    engine.register(req.orgId, id, url, {
      events:           events || ['*'],
      secret:           secret || undefined,
      integration:      integration || 'standard',
      headers:          parsedHeaders,
      maxRPM:           maxRPM || null,
      circuitThreshold: circuitThreshold || 5,
      transformationScript: transformationScript || null,
      metadata:         { description: description || '' },
    });

    logger.info({ orgId: req.orgId, endpointId: id, url }, 'endpoint:registered');
    res.json({ success: true, endpoint: engine.endpoints.get(`${req.orgId}:${id}`) });
  } catch (err) {
    logger.error({ err: err.message }, 'endpoint:register_error');
    res.status(500).json({ error: err.message });
  }
});

// Unregister Endpoint — stealth guard: 404 if not owned
app.delete('/api/endpoints/:id', stealthGuard('endpoint'), (req, res) => {
  try {
    engine.unregister(req.orgId, req.params.id);
    logger.info({ orgId: req.orgId, endpointId: req.params.id }, 'endpoint:unregistered');
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Activate Endpoint — stealth guard: 404 if not owned
app.post('/api/endpoints/:id/activate', stealthGuard('endpoint'), (req, res) => {
  try {
    engine.activate(req.orgId, req.params.id);
    res.json({ success: true, endpoint: engine.endpoints.get(`${req.orgId}:${req.params.id}`) });
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Deactivate Endpoint — stealth guard: 404 if not owned
app.post('/api/endpoints/:id/deactivate', stealthGuard('endpoint'), (req, res) => {
  try {
    engine.deactivate(req.orgId, req.params.id);
    res.json({ success: true, endpoint: engine.endpoints.get(`${req.orgId}:${req.params.id}`) });
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Get Live Stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await engine.stats(req.orgId);
    const org = await db.getOrganization(req.orgId);
    const tier = org?.planTier || 'free';
    const plan = db.PLAN_TIERS[tier] || db.PLAN_TIERS.free;

    res.json({
      ...stats,
      orgId: req.orgId,
      planTier: tier,
      subscriptionStatus: org?.subscriptionStatus || 'active',
      monthlyUsageCount: org?.monthlyUsageCount || 0,
      quotaLimit: plan.monthlyLimit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Delivery Logs
app.get('/api/logs', async (req, res) => {
  try {
    res.json(await engine.logs(req.orgId, { limit: 100 }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Consumer Webhook Logs (Svix-style)
app.get('/api/webhook-logs', async (req, res) => {
  try {
    const logs = await Promise.resolve(db.getWebhookLogs(req.orgId));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Delivery Logs
app.post('/api/logs/clear', (req, res) => {
  db.clearDeliveries(req.orgId);
  logger.info({ orgId: req.orgId }, 'delivery_logs:cleared');
  res.json({ success: true });
});

// Trigger Webhook send dispatches
app.post('/api/send', quotaGate, async (req, res) => {
  try {
    const { event, data } = req.body;
    if (!event) return res.status(400).json({ error: 'Event name is required' });

    logger.info({ orgId: req.orgId, event }, 'event:fired via API');
    const results = await engine.send(req.orgId, event, data || {});
    res.json({ success: true, results });
  } catch (err) {
    logger.error({ err: err.message }, 'send:error');
    res.status(500).json({ error: err.message });
  }
});

// One-Click Replay — stealth guard: 404 if delivery not owned
app.post('/api/logs/:id/replay', stealthGuard('delivery'), billingReplayGate, quotaGate, async (req, res) => {
  try {
    logger.info({ orgId: req.orgId, deliveryId: req.params.id }, 'delivery:replay requested');
    const result = await engine.replay(req.orgId, req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Bulk Replay / Redrive — stealth validation for IDORs and quotaGate check
app.post('/api/logs/bulk-replay', billingReplayGate, quotaGate, async (req, res) => {
  try {
    const { deliveryIds, status, endpointId, since, before } = req.body;

    // IDOR protection: Verify ownership of all specified delivery IDs
    if (Array.isArray(deliveryIds)) {
      for (const id of deliveryIds) {
        const delivery = await Promise.resolve(db.getDelivery(req.orgId, id));
        if (!delivery) {
          logger.warn({ orgId: req.orgId, deliveryId: id }, 'bulkReplay:stealth_reject — delivery not owned or not found');
          return res.status(404).json({ error: 'Not found' });
        }
      }
    }

    logger.info({ orgId: req.orgId, count: deliveryIds ? deliveryIds.length : 'filtered' }, 'bulkReplay:requested');
    const result = await engine.bulkReplay(req.orgId, { deliveryIds, status, endpointId, since, before });
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, orgId: req.orgId }, 'bulkReplay:error');
    res.status(500).json({ error: err.message });
  }
});

// Non-blocking background execution queue wrapper
async function processBulkRedrive(orgId, logsToReplay) {
  logger.info(`Starting background redrive of ${logsToReplay.length} events for Org: ${orgId}`);
  
  for (const log of logsToReplay) {
    try {
      // Replay original webhook attempt
      await engine.replay(orgId, log.id);
      
      // Throttle execution by 50ms to prevent downstream destination flooding
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (err) {
      logger.error({ err: err.message, logId: log.id }, 'Background bulk redrive item failed execution');
    }
  }
  logger.info(`Finished background redrive batch for Org: ${orgId}`);
}

// Bulk DLQ Mass Redrive endpoint with time windows and status code filters
app.post('/api/logs/bulk-retry', billingReplayGate, quotaGate, async (req, res) => {
  try {
    const orgId = req.orgId;
    const { endpointId, startTime, endTime, filterStatus } = req.body;

    if (!startTime || !endTime) {
      return res.status(400).json({ error: "Missing required time window parameters (startTime, endTime)" });
    }

    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();

    // 1. Fetch historical logs and filter strictly within tenant boundaries (IDOR prevention)
    let logs = await Promise.resolve(db.getDeliveries(orgId));

    // 2. Filter by time window boundaries
    logs = logs.filter(log => {
      const logTime = new Date(log.timestamp).getTime();
      return logTime >= startMs && logTime <= endMs;
    });

    // 3. Filter by endpoint ID if specified
    if (endpointId) {
      logs = logs.filter(log => log.endpointId === endpointId);
    }

    // 4. Filter down to failed items and match specific HTTP status if specified
    const failedLogs = logs.filter(log => {
      const matchesStatus = filterStatus ? log.statusCode === parseInt(filterStatus, 10) : true;
      const isFailure = log.status !== 'delivered';
      return isFailure && matchesStatus;
    });

    if (failedLogs.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: "No failed events found matching criteria."
      });
    }

    // 5. Trigger Non-blocking Background processing queue
    processBulkRedrive(orgId, failedLogs);

    return res.status(200).json({
      success: true,
      count: failedLogs.length,
      message: `Successfully queued ${failedLogs.length} events for background redrive.`
    });
  } catch (err) {
    logger.error({ err: err.message }, 'bulk-retry:error');
    return res.status(500).json({ error: "Internal server error initializing bulk replay sequence" });
  }
});

// Test Payload Transformation script (Dry-run)
app.post('/api/endpoints/test-transformation', (req, res) => {
  try {
    const { payload, scriptString } = req.body;

    if (!payload) {
      return res.status(400).json({ error: "Missing required mock evaluation payload." });
    }

    const output = Transformer.transform(payload, scriptString);

    return res.status(200).json({
      success: true,
      transformedPayload: output
    });

  } catch (err) {
    return res.status(422).json({
      success: false,
      error: err.message
    });
  }
});

// Get Alert Configuration
app.get('/api/org/alert-settings', async (req, res) => {
  try {
    const org = await db.getOrganization(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ success: true, alertConfig: org.alertConfig || null });
  } catch (err) {
    logger.error({ err: err.message }, 'get-alert-settings:error');
    res.status(500).json({ error: err.message });
  }
});

// Save Alert Configuration
app.post('/api/org/alert-settings', async (req, res) => {
  try {
    const org = await db.getOrganization(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const { slackWebhookUrl, pagerDutyRoutingKey, notifyOnFailureCount, enabled } = req.body;

    org.alertConfig = {
      slackWebhookUrl: slackWebhookUrl || '',
      pagerDutyRoutingKey: pagerDutyRoutingKey || '',
      notifyOnFailureCount: parseInt(notifyOnFailureCount, 10) || 3,
      enabled: enabled === true
    };

    await db.saveOrganization(req.orgId, org);
    logger.info({ orgId: req.orgId }, 'alert-settings:updated');
    res.json({ success: true, alertConfig: org.alertConfig });
  } catch (err) {
    logger.error({ err: err.message }, 'save-alert-settings:error');
    res.status(500).json({ error: err.message });
  }
});

// Test Alert Integration Configuration
app.post('/api/org/alert-settings/test', async (req, res) => {
  try {
    const { slackWebhookUrl, pagerDutyRoutingKey } = req.body;
    if (!slackWebhookUrl && !pagerDutyRoutingKey) {
      return res.status(400).json({ error: 'At least one integration key/url must be provided to test.' });
    }

    const AlertManager = require('./src/AlertManager');
    const testConfig = {
      slackWebhookUrl: slackWebhookUrl || '',
      pagerDutyRoutingKey: pagerDutyRoutingKey || '',
      notifyOnFailureCount: 1,
      enabled: true
    };

    await AlertManager.sendTestAlert(testConfig);
    res.json({ success: true, message: 'Test alert dispatched successfully' });
  } catch (err) {
    logger.error({ err: err.message }, 'test-alert-settings:error');
    res.status(500).json({ error: err.message });
  }
});

// Circuit Breaker Health — stealth guard: 404 if endpoint not owned
app.get('/api/endpoints/:id/health', stealthGuard('endpoint'), async (req, res) => {
  try {
    const health = await engine.circuitHealth(req.params.id);
    res.json({ endpointId: req.params.id, ...health });
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    logger.info({ port: PORT, storageType: process.env.STORAGE_TYPE || 'json' }, 'WebhookEngine started');
    logger.info(`Dashboard → http://localhost:${PORT}`);
    if (!process.env.API_KEY_HASH) {
      logger.warn('⚠️  No API_KEY_HASH set. Run: node scripts/generate-api-key.js');
    }
  });
}

module.exports = app;
