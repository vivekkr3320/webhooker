'use strict';

const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const router  = express.Router();
const db      = require('../src/db');
const logger  = require('../src/logger');

// 1. Sign Up Route (Public)
router.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    // Check if email already registered
    const existing = await db.getOrganizationByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Email is already registered' });
    }

    // Hash the password
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate Tenant ID and API Key
    const orgId = 'org_' + crypto.randomBytes(8).toString('hex');
    const rawKey = 'whk_' + crypto.randomBytes(28).toString('hex');
    const keyHash = await bcrypt.hash(rawKey, 12);

    // Save Organization
    const orgData = {
      ownerEmail: email,
      passwordHash,
      razorpayCustomerId: null,
      razorpaySubscriptionId: null,
      planTier: 'free',
      subscriptionStatus: 'active',
      monthlyUsageCount: 0,
      quotaResetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await db.saveOrganization(orgId, orgData);
    await db.createApiKey(orgId, rawKey, keyHash);

    // Create a new session
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    await db.createSession(sessionId, orgId, expiresAt);

    // Set secure HttpOnly cookie
    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    logger.info({ orgId, email }, 'auth:signup_success');
    res.json({
      success: true,
      orgId,
      email,
      apiKey: rawKey // Provide API key once so they can save it for external usage
    });
  } catch (err) {
    logger.error({ err: err.message }, 'auth:signup_error');
    res.status(500).json({ error: 'Internal registration error' });
  }
});

// 2. Login Route (Public)
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find organization/user by email
    const org = await db.getOrganizationByEmail(email);
    if (!org || !org.passwordHash) {
      logger.warn({ email }, 'auth:login_failed — user not found or no password set');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const match = await bcrypt.compare(password, org.passwordHash);
    if (!match) {
      logger.warn({ email }, 'auth:login_failed — password mismatch');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Create session
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    await db.createSession(sessionId, org.id, expiresAt);

    // Set cookie
    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    logger.info({ orgId: org.id, email }, 'auth:login_success');
    res.json({
      success: true,
      orgId: org.id,
      email
    });
  } catch (err) {
    logger.error({ err: err.message }, 'auth:login_error');
    res.status(500).json({ error: 'Internal login error' });
  }
});

// 3. Logout Route (Public)
router.post('/api/auth/logout', async (req, res) => {
  try {
    const sessionId = req.cookies?.session_id;
    if (sessionId) {
      await db.deleteSession(sessionId);
    }
    res.clearCookie('session_id');
    logger.info('auth:logout_success');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err.message }, 'auth:logout_error');
    res.status(500).json({ error: 'Internal logout error' });
  }
});

// 4. Current User Session Check (Protected by authMiddleware globally)
router.get('/api/auth/me', async (req, res) => {
  try {
    const org = await db.getOrganization(req.orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization context not found' });
    }
    res.json({
      success: true,
      orgId: org.id,
      email: org.ownerEmail,
      planTier: org.planTier,
      subscriptionStatus: org.subscriptionStatus,
      monthlyUsageCount: org.monthlyUsageCount
    });
  } catch (err) {
    logger.error({ err: err.message }, 'auth:me_error');
    res.status(500).json({ error: 'Internal session check error' });
  }
});

module.exports = router;
