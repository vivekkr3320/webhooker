'use strict';

const db     = require('../src/db');
const logger = require('../src/logger');

// ─── Confidential Field Registry ──────────────────────────────────────────────
// These fields are NEVER sent to the frontend under any circumstances.
// They are stripped at the middleware layer as a last line of defense,
// supplementing the database projection layer in db.js.

const CONFIDENTIAL_FIELDS = new Set([
  // Credential material
  'hash', 'bcryptHash', 'passwordHash', 'apiKeyHash',
  // Razorpay internal secrets
  'razorpayApiKey', 'razorpayApiSecret', 'razorpayWebhookSecret',
  // Internal system tokens
  'internalToken', 'systemSecret', 'signingKey',
  // Raw key material that should never persist in responses
  'rawKey', 'plaintext',
]);

// Fields to redact from organization data sent to the client
const ORG_REDACTED_FIELDS = new Set([
  'razorpayApiKey', 'razorpayApiSecret', 'razorpayWebhookSecret',
  'internalToken', 'systemSecret',
]);

/**
 * Deep-strip confidential fields from any object before it leaves the server.
 * Handles nested objects and arrays recursively.
 *
 * @param {*} data - The data to sanitize
 * @param {number} depth - Current recursion depth (circuit breaker)
 * @returns {*} Sanitized copy (original is never mutated)
 */
function sanitizeForClient(data, depth = 0) {
  if (depth > 10) return data; // Prevent infinite recursion
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(item => sanitizeForClient(item, depth + 1));
  }

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    // Strip any field in the confidential registry
    if (CONFIDENTIAL_FIELDS.has(key)) continue;

    // Recursively sanitize nested objects
    clean[key] = sanitizeForClient(value, depth + 1);
  }
  return clean;
}

/**
 * Sanitize organization data specifically — applies ORG_REDACTED_FIELDS
 * on top of the standard CONFIDENTIAL_FIELDS strip.
 */
function sanitizeOrgForClient(org) {
  if (!org) return null;
  const clean = sanitizeForClient(org);
  for (const field of ORG_REDACTED_FIELDS) {
    delete clean[field];
  }
  return clean;
}

// ─── Stealth Rejection Middleware ─────────────────────────────────────────────
//
// When a route contains a resource identifier (e.g., /api/logs/:id or
// /api/endpoints/:id), this middleware verifies that the resource belongs
// to the authenticated organization. If it doesn't, we return 404 — NOT 403.
//
// A 403 tells an attacker "this exists but you can't have it."
// A 404 tells them "there's nothing here" — complete digital cloaking.

/**
 * Factory: creates a stealth guard for a specific resource type.
 *
 * @param {'endpoint'|'delivery'} resourceType
 * @param {string} paramName - The Express route param to check (default: 'id')
 * @returns {Function} Express middleware
 */
function stealthGuard(resourceType, paramName = 'id') {
  return async function (req, res, next) {
    const orgId = req.orgId;
    const resourceId = req.params[paramName];

    if (!orgId) {
      // No org context — this shouldn't happen after auth middleware,
      // but defend in depth
      return res.status(404).json({ error: 'Not found' });
    }

    if (!resourceId) {
      return next(); // No param to check, proceed
    }

    try {
      let resource = null;

      if (resourceType === 'delivery') {
        resource = await Promise.resolve(db.getDelivery(orgId, resourceId));
      } else if (resourceType === 'endpoint') {
        // For endpoints, check the engine's in-memory map via composite key
        // The engine stores endpoints as orgId:endpointId
        // We verify the endpoint belongs to this org by checking the composite key
        const endpoints = await Promise.resolve(db.getEndpoints(orgId));
        resource = endpoints.find(ep => ep.id === resourceId);
      }

      if (!resource) {
        // STEALTH: 404, not 403. The resource doesn't exist *for this tenant*.
        logger.warn({
          orgId,
          resourceType,
          resourceId,
          ip: req.ip,
          path: req.path,
        }, 'tenantGuard:stealth_reject — IDOR attempt blocked');

        return res.status(404).json({ error: 'Not found' });
      }

      // Attach the verified resource to the request for downstream use
      req.verifiedResource = resource;
      next();
    } catch (err) {
      logger.error({ err: err.message, resourceType, resourceId }, 'tenantGuard:error');
      return res.status(404).json({ error: 'Not found' });
    }
  };
}

// ─── Response Sanitization Middleware ──────────────────────────────────────────
//
// Intercepts res.json() to automatically strip confidential fields from
// ALL API responses. This is the nuclear option — even if a route handler
// accidentally includes sensitive data, it gets caught here.

function responseSanitizer() {
  return function (req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = function (data) {
      const sanitized = sanitizeForClient(data);
      return originalJson(sanitized);
    };

    next();
  };
}

module.exports = {
  stealthGuard,
  responseSanitizer,
  sanitizeForClient,
  sanitizeOrgForClient,
  CONFIDENTIAL_FIELDS,
};
