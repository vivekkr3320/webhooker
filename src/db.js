'use strict';

/**
 * db.js — Storage facade / factory.
 *
 * Selects the correct storage adapter based on STORAGE_TYPE env var:
 *   json  (default) → JsonAdapter (file-based, single-node)
 *   redis           → RedisAdapter (distributed, multi-node)
 *
 * All consumers import this module and call the same interface regardless
 * of which adapter is active underneath.
 */

require('dotenv').config();

const JsonAdapter = require('./adapters/JsonAdapter');

// ─── Storage Factory ─────────────────────────────────────────────────────────

let _adapter = null;

function getAdapter() {
  if (_adapter) return _adapter;

  const type = (process.env.STORAGE_TYPE || 'json').toLowerCase();

  if (type === 'redis') {
    const RedisAdapter = require('./adapters/RedisAdapter');
    _adapter = new RedisAdapter(process.env.REDIS_URL);
  } else if (type === 'postgres') {
    const PostgreSqlAdapter = require('./adapters/PostgreSqlAdapter');
    _adapter = new PostgreSqlAdapter(process.env.DATABASE_URL);
  } else {
    _adapter = new JsonAdapter();
  }

  return _adapter;
}

// ─── Security: mask sensitive header values before persistence ────────────────

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization', 'x-api-key', 'cookie', 'x-secret',
  'x-auth-token', 'x-access-token', 'api-key',
]);

function maskSensitiveHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return {};
  const masked = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
      if (typeof value === 'string') {
        const parts = value.split(' ');
        masked[key] = parts.length > 1
          ? `${parts[0]} ${'•'.repeat(12)}`
          : '•'.repeat(12);
      } else {
        masked[key] = '•'.repeat(12);
      }
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

const PLAN_TIERS = {
  free: { name: 'Developer Free', planId: 'plan_free_001', monthlyLimit: 5000, maxRPM: 60 },
  pro: { name: 'Scale Pro', planId: 'plan_pro_002', monthlyLimit: 500000, maxRPM: 1200 },
  enterprise: { name: 'Enterprise', planId: 'plan_ent_003', monthlyLimit: Infinity, maxRPM: 5000 }
};

// ─── Proxy interface — delegates all calls to the active adapter ──────────────
// Supports both sync (JsonAdapter) and async (RedisAdapter) return values.

module.exports = {
  // Expose the raw adapter for advanced use (e.g. circuit state)
  get adapter() { return getAdapter(); },

  PLAN_TIERS,

  // Organization & API key methods
  getOrganization:                 (orgId) => getAdapter().getOrganization(orgId),
  saveOrganization:                (orgId, orgData) => getAdapter().saveOrganization(orgId, orgData),
  getOrgIdByKey:                   (apiKey) => getAdapter().getOrgIdByKey(apiKey),
  createApiKey:                    (orgId, rawKey, bcryptHash) => getAdapter().createApiKey(orgId, rawKey, bcryptHash),
  getOrganizationBySubscriptionId: (subId) => getAdapter().getOrganizationBySubscriptionId(subId),
  updateOrganizationSubscription:  (subId, subscriptionFields) => getAdapter().updateOrganizationSubscription(subId, subscriptionFields),
  getOrganizationByEmail:          (email) => getAdapter().getOrganizationByEmail(email),
  createSession:                   (sessionId, orgId, expiresAt) => getAdapter().createSession(sessionId, orgId, expiresAt),
  getSession:                      (sessionId) => getAdapter().getSession(sessionId),
  deleteSession:                   (sessionId) => getAdapter().deleteSession(sessionId),

  // Scoped endpoints
  getAllEndpoints: () => getAdapter().getAllEndpoints(),
  getEndpoints:    (orgId) => getAdapter().getEndpoints(orgId),
  saveEndpoint:    (orgId, endpoint) => getAdapter().saveEndpoint(orgId, endpoint),
  removeEndpoint:  (orgId, id) => getAdapter().removeEndpoint(orgId, id),

  // Queue methods
  enqueueLowPriority: (task) => getAdapter().enqueueLowPriority(task),
  scheduleDelayed:    (task, executeAtTimestamp) => getAdapter().scheduleDelayed(task, executeAtTimestamp),
  pollDelayedTasks:   (now) => getAdapter().pollDelayedTasks(now),
  popLowPriorityTask: () => getAdapter().popLowPriorityTask(),

  // Scoped deliveries
  getDeliveries:   (orgId) => getAdapter().getDeliveries(orgId),
  getDelivery:     (orgId, id) => getAdapter().getDelivery(orgId, id),
  addDelivery:     (orgId, delivery) => getAdapter().addDelivery(orgId, delivery),
  updateDelivery:  (orgId, id, fields) => getAdapter().updateDelivery(orgId, id, fields),
  clearDeliveries: (orgId) => getAdapter().clearDeliveries(orgId),

  // Scoped consumer logs
  addWebhookLog:  (orgId, logEntry) => getAdapter().addWebhookLog(orgId, logEntry),
  getWebhookLogs: (orgId) => getAdapter().getWebhookLogs(orgId),

  maskSensitiveHeaders,
};
