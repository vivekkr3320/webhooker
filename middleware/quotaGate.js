'use strict';

const db = require('../src/db');
const logger = require('../src/logger');

async function quotaGate(req, res, next) {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized — missing organization context' });
    }

    const org = await db.getOrganization(orgId);
    if (!org) {
      // STEALTH: 404 not 403 — never confirm org existence to outsiders
      return res.status(404).json({ error: 'Not found' });
    }

    // Guard Clause 1: Account Delinquent (pro/enterprise subscriptions must be active)
    if (org.planTier !== 'free' && org.subscriptionStatus !== 'active') {
      logger.warn({ orgId, status: org.subscriptionStatus }, 'quotaGate:blocked — subscription suspended');
      return res.status(403).json({
        error: 'Subscription Suspended',
        message: 'Please update your billing credentials to reactivate your webhook pipeline.'
      });
    }

    // Guard Clause 2: Usage Quota Met
    const plan = db.PLAN_TIERS[org.planTier] || db.PLAN_TIERS.free;
    if (org.monthlyUsageCount >= plan.monthlyLimit) {
      logger.warn({ orgId, count: org.monthlyUsageCount, limit: plan.monthlyLimit }, 'quotaGate:blocked — quota exhausted');
      return res.status(402).json({
        error: 'Quota Exhausted',
        message: `You have processed 100% of your allocated monthly limits (${plan.monthlyLimit} requests). Please upgrade your plan tier.`
      });
    }

    next();
  } catch (err) {
    logger.error({ err: err.message }, 'quotaGate:error');
    res.status(500).json({ error: 'Internal gateway error' });
  }
}

module.exports = quotaGate;
