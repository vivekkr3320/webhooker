'use strict';

/**
 * PostgreSqlAdapter — PostgreSQL-backed storage adapter.
 *
 * Implements the polymorphic StorageAdapter interface.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

class PostgreSqlAdapter {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres'
    });

    this.pool.on('connect', () => logger.info('PostgreSQL connection established'));
    this.pool.on('error', (err) => logger.error({ err: err.message }, 'PostgreSQL pool error'));

    // Bootstrap database tables asynchronously
    this.bootstrapPromise = this._bootstrap();
  }

  async _bootstrap() {
    try {
      const sqlPath = path.join(__dirname, '..', '..', 'scripts', 'init-db.sql');
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await this.pool.query(sql);
      logger.info('PostgreSQL schema successfully bootstrapped');
    } catch (err) {
      logger.error({ err: err.message }, 'PostgreSQL bootstrap failed');
    }
  }

  async query(text, params) {
    await this.bootstrapPromise;
    return this.pool.query(text, params);
  }

  async close() {
    await this.pool.end();
    logger.info('PostgreSQL pool shut down');
  }

  // ─── Organizations & API Keys ─────────────────────────────────────────────

  async getOrganization(orgId) {
    const res = await this.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    return res.rows[0] || null;
  }

  async saveOrganization(orgId, orgData) {
    await this.query(
      `INSERT INTO organizations (
        id, "ownerEmail", "razorpayCustomerId", "razorpaySubscriptionId", 
        "planTier", "subscriptionStatus", "monthlyUsageCount", "quotaResetDate"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        "ownerEmail" = EXCLUDED."ownerEmail",
        "razorpayCustomerId" = EXCLUDED."razorpayCustomerId",
        "razorpaySubscriptionId" = EXCLUDED."razorpaySubscriptionId",
        "planTier" = EXCLUDED."planTier",
        "subscriptionStatus" = EXCLUDED."subscriptionStatus",
        "monthlyUsageCount" = EXCLUDED."monthlyUsageCount",
        "quotaResetDate" = EXCLUDED."quotaResetDate"`,
      [
        orgId,
        orgData.ownerEmail,
        orgData.razorpayCustomerId,
        orgData.razorpaySubscriptionId,
        orgData.planTier,
        orgData.subscriptionStatus,
        orgData.monthlyUsageCount,
        orgData.quotaResetDate
      ]
    );
  }

  async getOrganizationBySubscriptionId(subId) {
    const res = await this.query('SELECT * FROM organizations WHERE "razorpaySubscriptionId" = $1', [subId]);
    return res.rows[0] || null;
  }

  async updateOrganizationSubscription(subId, subscriptionFields) {
    const keys = Object.keys(subscriptionFields);
    if (keys.length === 0) return;
    const setClause = keys.map((key, i) => `"${key}" = $${i + 2}`).join(', ');
    const values = Object.values(subscriptionFields);
    await this.query(
      `UPDATE organizations SET ${setClause} WHERE "razorpaySubscriptionId" = $1`,
      [subId, ...values]
    );
  }

  async getOrgIdByKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('whk_')) return null;
    const pubId = apiKey.slice(4, 16);
    const res = await this.query('SELECT "orgId" FROM "apiKeys" WHERE "pubId" = $1', [pubId]);
    if (res.rows[0]) {
      return res.rows[0].orgId;
    }

    const bcrypt = require('bcrypt');
    if (process.env.API_KEY_HASH && await bcrypt.compare(apiKey, process.env.API_KEY_HASH)) {
      await this.query(
        `INSERT INTO "apiKeys" ("pubId", hash, "orgId", "createdAt") 
         VALUES ($1, $2, 'org_dev_default', $3) 
         ON CONFLICT ("pubId") DO NOTHING`,
        [pubId, process.env.API_KEY_HASH, new Date().toISOString()]
      );
      return "org_dev_default";
    }

    return null;
  }

  async createApiKey(orgId, rawKey, bcryptHash) {
    if (!rawKey || !rawKey.startsWith('whk_')) throw new Error('Invalid key format');
    const pubId = rawKey.slice(4, 16);
    await this.query(
      `INSERT INTO "apiKeys" ("pubId", hash, "orgId", "createdAt") VALUES ($1, $2, $3, $4)
       ON CONFLICT ("pubId") DO UPDATE SET hash = EXCLUDED.hash, "orgId" = EXCLUDED."orgId"`,
      [pubId, bcryptHash, orgId, new Date().toISOString()]
    );
  }

  // ─── Scoped Endpoints ──────────────────────────────────────────────────────

  async getAllEndpoints() {
    const res = await this.query('SELECT * FROM endpoints');
    return res.rows;
  }

  async getEndpoints(orgId) {
    const res = await this.query('SELECT * FROM endpoints WHERE "orgId" = $1', [orgId]);
    return res.rows;
  }

  async saveEndpoint(orgId, endpoint) {
    await this.query(
      `INSERT INTO endpoints (id, "orgId", url, secret, events, active, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         url = EXCLUDED.url,
         secret = EXCLUDED.secret,
         events = EXCLUDED.events,
         active = EXCLUDED.active,
         "createdAt" = EXCLUDED."createdAt"`,
      [
        endpoint.id,
        orgId,
        endpoint.url,
        endpoint.secret,
        JSON.stringify(endpoint.events || ['*']),
        endpoint.active !== undefined ? endpoint.active : true,
        endpoint.createdAt || new Date().toISOString()
      ]
    );
  }

  async removeEndpoint(orgId, id) {
    await this.query('DELETE FROM endpoints WHERE id = $1 AND "orgId" = $2', [id, orgId]);
  }

  // ─── Scoped Deliveries ─────────────────────────────────────────────────────

  async getDeliveries(orgId) {
    const res = await this.query(
      'SELECT * FROM deliveries WHERE "orgId" = $1 ORDER BY timestamp DESC LIMIT 200',
      [orgId]
    );
    return res.rows;
  }

  async getDelivery(orgId, id) {
    const res = await this.query('SELECT * FROM deliveries WHERE id = $1 AND "orgId" = $2', [id, orgId]);
    return res.rows[0] || null;
  }

  async addDelivery(orgId, delivery) {
    await this.query(
      `INSERT INTO deliveries (
        id, "orgId", "endpointId", url, event, "payloadId", payload, headers,
        attempt, timestamp, status, "responseTime", "responseBody", error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        delivery.id,
        orgId,
        delivery.endpointId,
        delivery.url,
        delivery.event,
        delivery.payloadId,
        JSON.stringify(delivery.payload || {}),
        JSON.stringify(delivery.headers || {}),
        delivery.attempt,
        delivery.timestamp,
        delivery.status,
        delivery.responseTime,
        delivery.responseBody,
        delivery.error
      ]
    );

    // Maintain 200 delivery cap
    await this.query(
      `DELETE FROM deliveries 
       WHERE "orgId" = $1 
         AND id NOT IN (
           SELECT id FROM deliveries 
           WHERE "orgId" = $1 
           ORDER BY timestamp DESC 
           LIMIT 200
         )`,
      [orgId]
    );
  }

  async updateDelivery(orgId, id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const setClause = keys.map((key, i) => `"${key}" = $${i + 3}`).join(', ');
    const values = Object.values(fields).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    await this.query(
      `UPDATE deliveries SET ${setClause} WHERE id = $1 AND "orgId" = $2`,
      [id, orgId, ...values]
    );
  }

  async clearDeliveries(orgId) {
    await this.query('DELETE FROM deliveries WHERE "orgId" = $1', [orgId]);
  }

  // ─── Consumer Webhook Event Logs (Svix-style) ──────────────────────────────

  async getWebhookLogs(orgId) {
    const res = await this.query(
      'SELECT * FROM webhook_logs WHERE "orgId" = $1 ORDER BY timestamp DESC LIMIT 100',
      [orgId]
    );
    return res.rows;
  }

  async addWebhookLog(orgId, logEntry) {
    await this.query(
      `INSERT INTO webhook_logs (
        id, "orgId", "endpointId", url, event, payload, "statusCode", timestamp, status, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        logEntry.id,
        orgId,
        logEntry.endpointId,
        logEntry.url,
        logEntry.event,
        JSON.stringify(logEntry.payload || {}),
        logEntry.statusCode,
        logEntry.timestamp,
        logEntry.status,
        logEntry.error
      ]
    );

    // Limit to 200 logs per org to conserve space
    await this.query(
      `DELETE FROM webhook_logs 
       WHERE "orgId" = $1 
         AND id NOT IN (
           SELECT id FROM webhook_logs 
           WHERE "orgId" = $1 
           ORDER BY timestamp DESC 
           LIMIT 200
         )`,
      [orgId]
    );
  }

  async getOrganizationByEmail(email) {
    const res = await this.query('SELECT * FROM organizations WHERE "ownerEmail" = $1', [email]);
    return res.rows[0] || null;
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  async createSession(sessionId, orgId, expiresAt) {
    await this.query(
      'INSERT INTO sessions ("sessionId", "orgId", "expiresAt") VALUES ($1, $2, $3)',
      [sessionId, orgId, expiresAt]
    );
  }

  async getSession(sessionId) {
    const res = await this.query('SELECT * FROM sessions WHERE "sessionId" = $1', [sessionId]);
    const session = res.rows[0];
    if (!session) return null;
    if (new Date(session.expiresAt) < new Date()) {
      await this.query('DELETE FROM sessions WHERE "sessionId" = $1', [sessionId]);
      return null;
    }
    return session;
  }

  async deleteSession(sessionId) {
    await this.query('DELETE FROM sessions WHERE "sessionId" = $1', [sessionId]);
  }

  // ─── Dual-Lane Queue (PostgreSQL Implementation) ──────────────────────────

  async enqueueLowPriority(task) {
    await this.query(
      'INSERT INTO queue_tasks (task, "executeAt", status) VALUES ($1, 0, \'active\')',
      [JSON.stringify(task)]
    );
  }

  async scheduleDelayed(task, executeAtTimestamp) {
    await this.query(
      'INSERT INTO queue_tasks (task, "executeAt", status) VALUES ($1, $2, \'delayed\')',
      [JSON.stringify(task), executeAtTimestamp]
    );
  }

  async pollDelayedTasks(now) {
    await this.query(
      'UPDATE queue_tasks SET status = \'active\' WHERE status = \'delayed\' AND "executeAt" <= $1',
      [now]
    );
  }

  async popLowPriorityTask() {
    const res = await this.query(
      `WITH popped AS (
         SELECT id FROM queue_tasks 
         WHERE status = 'active' 
         ORDER BY id ASC 
         LIMIT 1 
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM queue_tasks 
       WHERE id = (SELECT id FROM popped) 
       RETURNING task`
    );
    return res.rows[0] ? res.rows[0].task : null;
  }
}

module.exports = PostgreSqlAdapter;
