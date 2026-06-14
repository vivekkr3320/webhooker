'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../src/db');
const logger  = require('../src/logger');

// 1. Razorpay Webhook Endpoint
router.post('/api/billing/razorpay', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_sec_dev_123';
  const signature = req.headers['x-razorpay-signature'];

  if (!signature) {
    logger.warn('billing:webhook_rejected — missing x-razorpay-signature');
    return res.status(400).json({ error: 'Missing signature header' });
  }

  // Verify Razorpay Signature using rawBody buffer populated by express.json() verify hook
  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.warn('billing:webhook_rejected — missing rawBody buffer');
    return res.status(400).json({ error: 'Missing request payload' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  if (signature !== expectedSignature) {
    logger.warn({ signature, expectedSignature }, 'billing:webhook_rejected — signature mismatch');
    return res.status(400).json({ error: 'Signature validation failed' });
  }

  try {
    const payload = JSON.parse(rawBody.toString('utf8'));
    const event = payload.event;
    const subData = payload.payload?.subscription?.entity;

    if (!subData) {
      logger.warn({ payload }, 'billing:webhook_ignored — missing subscription entity');
      return res.status(200).json({ status: 'ignored' });
    }

    logger.info({ event, subscriptionId: subData.id }, 'billing:webhook_received');

    // Route the state machine
    switch (event) {
      case 'subscription.activated':
      case 'subscription.charged':
        await db.updateOrganizationSubscription(subData.id, {
          subscriptionStatus: 'active',
          planTier: subData.plan_id === 'plan_pro_002' ? 'pro' : (subData.plan_id === 'plan_ent_003' ? 'enterprise' : 'free'),
          quotaResetDate: new Date((subData.current_end || (Date.now() / 1000 + 30 * 24 * 3600)) * 1000).toISOString()
        });
        logger.info({ subscriptionId: subData.id, planId: subData.plan_id }, 'billing:organization_upgraded');
        break;

      case 'subscription.halted': // payment failed continuously
        await db.updateOrganizationSubscription(subData.id, {
          subscriptionStatus: 'halted'
        });
        logger.warn({ subscriptionId: subData.id }, 'billing:organization_halted');
        break;

      case 'subscription.cancelled':
        await db.updateOrganizationSubscription(subData.id, {
          subscriptionStatus: 'cancelled',
          planTier: 'free'
        });
        logger.warn({ subscriptionId: subData.id }, 'billing:organization_cancelled');
        break;

      default:
        logger.info({ event }, 'billing:webhook_ignored_event');
    }

    res.status(200).json({ status: 'processed' });
  } catch (err) {
    logger.error({ err: err.message }, 'billing:webhook_error');
    res.status(500).json({ error: 'Internal processing error' });
  }
});

// 2. Real / Simulated Checkout Initialization Route
router.post('/api/billing/create-subscription', async (req, res) => {
  try {
    const { planId } = req.body;
    const orgId = req.orgId; // Authenticated via authMiddleware

    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized — missing organization context' });
    }

    if (!planId || !['plan_pro_002', 'plan_ent_003', 'plan_free_001'].includes(planId)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    const org = await db.getOrganization(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (keyId && keySecret) {
      // Real Razorpay Initialization
      const Razorpay = require('razorpay');
      const razorpayInstance = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
      });

      const subscription = await razorpayInstance.subscriptions.create({
        plan_id: planId,
        customer_notify: 1,
        total_count: 12, // 12 billing cycles (e.g. 1 year)
        notes: {
          organizationId: orgId
        }
      });

      // Map subscription ID to organization record
      org.razorpaySubscriptionId = subscription.id;
      await db.saveOrganization(orgId, org);

      logger.info({ orgId, subscriptionId: subscription.id, planId }, 'billing:create_subscription_success (real)');
      
      return res.json({
        success: true,
        subscriptionId: subscription.id,
        razorpayKeyId: keyId,
        userEmail: org.ownerEmail,
        isSimulated: false
      });
    } else {
      // Fallback/Simulated Sandbox Mode
      const crypto = require('crypto');
      const mockSubId = 'sub_' + crypto.randomBytes(8).toString('hex');

      // Map mock subscription ID to organization record
      org.razorpaySubscriptionId = mockSubId;
      await db.saveOrganization(orgId, org);

      logger.info({ orgId, subscriptionId: mockSubId, planId }, 'billing:create_subscription_success (simulated)');

      return res.json({
        success: true,
        subscriptionId: mockSubId,
        razorpayKeyId: 'rzp_test_mockkey',
        userEmail: org.ownerEmail,
        isSimulated: true
      });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'billing:create_subscription_error');
    res.status(500).json({ error: err.message });
  }
});

// 3. Legacy Mock Checkout Route
router.post('/api/billing/checkout', async (req, res) => {
  try {
    const { planId } = req.body;
    const orgId = req.headers['x-org-id'] || req.orgId;

    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized — missing organization context' });
    }

    if (!planId || !['plan_pro_002', 'plan_ent_003', 'plan_free_001'].includes(planId)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Generate mock subscription ID
    const subId = 'sub_' + crypto.randomBytes(8).toString('hex');
    
    // Save mapping to organization
    const org = await db.getOrganization(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    org.razorpaySubscriptionId = subId;
    await db.saveOrganization(orgId, org);

    logger.info({ orgId, subId, planId }, 'billing:checkout_initialized');

    res.json({
      success: true,
      subscriptionId: subId,
      amount: planId === 'plan_pro_002' ? 2900 : (planId === 'plan_ent_003' ? 19900 : 0)
    });
  } catch (err) {
    logger.error({ err: err.message }, 'billing:checkout_error');
    res.status(500).json({ error: err.message });
  }
});

// 3. Webhook Simulation Trigger
router.post('/api/billing/simulate', async (req, res) => {
  try {
    const { event, subscriptionId, planId } = req.body;
    if (!event || !subscriptionId) {
      return res.status(400).json({ error: 'Event topic and subscription ID are required' });
    }

    // Construct mock Razorpay webhook payload
    const mockPayload = {
      entity: 'event',
      account_id: 'acc_dev_123',
      event: event,
      contains: ['subscription'],
      payload: {
        subscription: {
          entity: {
            id: subscriptionId,
            entity: 'subscription',
            plan_id: planId || 'plan_pro_002',
            status: event === 'subscription.activated' ? 'active' : (event === 'subscription.cancelled' ? 'cancelled' : 'halted'),
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000 + 30 * 24 * 3600),
            ended_at: event === 'subscription.cancelled' ? Math.floor(Date.now() / 1000) : null
          }
        }
      },
      created_at: Math.floor(Date.now() / 1000)
    };

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_sec_dev_123';
    const bodyStr = JSON.stringify(mockPayload);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(bodyStr)
      .digest('hex');

    // Make an internal HTTP call to our own endpoint
    const http = require('http');
    const port = process.env.PORT || 4000;

    const postReq = http.request({
      hostname: 'localhost',
      port: port,
      path: '/api/billing/razorpay',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, (postRes) => {
      let data = '';
      postRes.on('data', chunk => data += chunk);
      postRes.on('end', () => {
        logger.info({ event, subscriptionId, status: postRes.statusCode }, 'billing:simulation_webhook_delivered');
        res.json({
          success: postRes.statusCode === 200,
          statusCode: postRes.statusCode,
          response: data
        });
      });
    });

    postReq.on('error', (err) => {
      logger.error({ err: err.message }, 'billing:simulation_webhook_failed');
      res.status(500).json({ error: `Connection failed: ${err.message}` });
    });

    postReq.write(bodyStr);
    postReq.end();
  } catch (err) {
    logger.error({ err: err.message }, 'billing:simulation_error');
    res.status(500).json({ error: err.message });
  }
});

// 4. GET Billing & Usage metrics (Authenticated)
router.get('/api/billing/usage', async (req, res) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized — missing organization context' });
    }

    const org = await db.getOrganization(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const tier = org.planTier || 'free';
    const plan = db.PLAN_TIERS[tier] || db.PLAN_TIERS.free;
    const maxLimit = plan.monthlyLimit;

    // percentageUsed calculation (Infinity becomes 0.0)
    let percentageUsed = 0.0;
    if (maxLimit && maxLimit !== Infinity) {
      percentageUsed = ((org.monthlyUsageCount || 0) / maxLimit) * 100;
      percentageUsed = Math.min(100, percentageUsed);
    }

    res.json({
      planTier: tier,
      monthlyUsageCount: org.monthlyUsageCount || 0,
      maxLimit: maxLimit === Infinity ? "Unlimited" : maxLimit,
      percentageUsed: parseFloat(percentageUsed.toFixed(1)),
      quotaResetDate: org.quotaResetDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      subscriptionStatus: org.subscriptionStatus || 'active'
    });
  } catch (err) {
    logger.error({ err: err.message }, 'billing:usage_error');
    res.status(500).json({ error: 'Internal server error pulling metrics' });
  }
});

module.exports = router;
