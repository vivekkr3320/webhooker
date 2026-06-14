'use strict';

const bcrypt = require('bcrypt');
const db     = require('../src/db');
const logger = require('../src/logger');

/**
 * API Key authentication middleware.
 *
 * Reads the key from:
 *   - X-API-Key header (preferred)
 *   - Authorization: Bearer <key> header (alternative)
 *
 * Compares against the bcrypt hash in process.env.API_KEY_HASH.
 *
 * Public routes (no auth required):
 *   GET /api/system/info   — needed before the dashboard is unlocked
 */

// Cache the hash at load time
const API_KEY_HASH = process.env.API_KEY_HASH || '';

// Routes that bypass auth
const PUBLIC_PATHS = new Set([
  '/api/system/info',
  '/api/onboard',
  '/api/billing/razorpay',
  '/api/billing/simulate',
  '/api/auth/signup',
  '/api/auth/login',
  '/api/auth/logout',
]);

// Cache successful comparisons to avoid bcrypt overhead on every poll
// Maps rawKey → { orgId, expiresAt }
const authCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function authMiddleware(req, res, next) {
  // Allow public endpoints (use originalUrl to avoid issues with prefix mounts)
  const fullPath = req.originalUrl.split('?')[0];
  if (PUBLIC_PATHS.has(fullPath)) return next();

  // 1. Try Session Cookie first
  const sessionId = req.cookies?.session_id;
  if (sessionId) {
    try {
      const session = await db.getSession(sessionId);
      if (session && session.orgId) {
        req.orgId = session.orgId;
        return next();
      }
    } catch (err) {
      logger.error({ err: err.message }, 'auth:session_check_error');
    }
  }

  // 2. Fallback to API Key headers
  const key =
    req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();

  if (!key) {
    return res.status(401).json({ error: 'Missing session or API key', hint: 'Please sign in or provide X-API-Key header' });
  }

  try {
    // Check cache first
    const cached = authCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.orgId) {
        req.orgId = cached.orgId;
        return next();
      }
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Lookup organization ID by key
    const orgId = await db.getOrgIdByKey(key);

    // Cache the result
    authCache.set(key, { orgId, expiresAt: Date.now() + CACHE_TTL_MS });

    // Prune stale cache entries periodically
    if (authCache.size > 50) {
      const now = Date.now();
      for (const [k, v] of authCache) {
        if (v.expiresAt < now) authCache.delete(k);
      }
    }

    if (!orgId) {
      logger.warn({ ip: req.ip, path: req.path }, 'auth:rejected — invalid API key');
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.orgId = orgId;
    logger.debug({ path: req.path, orgId }, 'auth:accepted');
    next();
  } catch (err) {
    logger.error({ err: err.message }, 'auth:error');
    res.status(500).json({ error: 'Authentication error' });
  }
}

module.exports = authMiddleware;
