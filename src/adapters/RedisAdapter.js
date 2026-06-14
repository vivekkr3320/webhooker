'use strict';

/**
 * RedisAdapter — full ioredis-backed storage adapter.
 *
 * KEY SCHEMA:
 *   webhook:endpoints              → HASH  { [id]: JSON }
 *   webhook:deliveries             → LIST  [ delivery_id, ... ] (capped at 200)
 *   webhook:delivery:{id}          → STRING JSON (TTL: 7 days)
 *   webhook:circuit:{endpointId}   → STRING JSON (TTL: 24h)
 *   webhook:ratelimit:{endpointId} → STRING JSON (TTL: 2 min)
 *
 * SET REDIS_URL in .env and STORAGE_TYPE=redis to activate.
 */

const Redis = require('ioredis');
const logger = require('../logger');

const DELIVERY_TTL_SEC   = 60 * 60 * 24 * 7;  // 7 days
const CIRCUIT_TTL_SEC    = 60 * 60 * 24;       // 24 hours
const RATE_TTL_SEC       = 60 * 2;             // 2 minutes
const MAX_DELIVERIES     = 200;

class RedisAdapter {
  constructor(redisUrl) {
    this.client = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });

    this.client.on('connect',  () => logger.info('Redis connected'));
    this.client.on('error',    (err) => logger.error({ err: err.message }, 'Redis error'));
    this.client.on('reconnecting', () => logger.warn('Redis reconnecting...'));

    // Define custom Lua script command for atomic queue migration
    this.client.defineCommand('pollDelayed', {
      numberOfKeys: 2,
      lua: `
        local due_tasks = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
        if #due_tasks > 0 then
          redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
          for i = 1, #due_tasks do
            redis.call('RPUSH', KEYS[2], due_tasks[i])
          end
        end
        return #due_tasks
      `
    });
  }

  // ─── Organizations & API Keys ─────────────────────────────────────────────

  async getOrganization(orgId) {
    const raw = await this.client.get(`webhook:org:${orgId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async saveOrganization(orgId, orgData) {
    const data = { id: orgId, ...orgData };
    await this.client.set(`webhook:org:${orgId}`, JSON.stringify(data));
    if (orgData.ownerEmail) {
      await this.client.set(`webhook:org:email:${orgData.ownerEmail}`, orgId);
    }
    if (orgData.razorpaySubscriptionId) {
      await this.client.set(`webhook:subscription:${orgData.razorpaySubscriptionId}`, orgId);
    }
  }

  async getOrganizationBySubscriptionId(subId) {
    const orgId = await this.client.get(`webhook:subscription:${subId}`);
    if (!orgId) return null;
    return this.getOrganization(orgId);
  }

  async updateOrganizationSubscription(subId, subscriptionFields) {
    const orgId = await this.client.get(`webhook:subscription:${subId}`);
    if (!orgId) return;
    const org = await this.getOrganization(orgId);
    if (org) {
      const updated = { ...org, ...subscriptionFields };
      await this.saveOrganization(orgId, updated);
    }
  }

  async getOrgIdByKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('whk_')) return null;
    const pubId = apiKey.slice(4, 16);
    
    // 1. Direct indexed lookup
    const rawVal = await this.client.hget('webhook:apikeys', pubId);
    if (rawVal) {
      const record = JSON.parse(rawVal);
      return record.orgId;
    }

    // 2. Fallback to process.env.API_KEY_HASH
    const bcrypt = require('bcrypt');
    if (process.env.API_KEY_HASH && await bcrypt.compare(apiKey, process.env.API_KEY_HASH)) {
      const record = {
        pubId,
        hash: process.env.API_KEY_HASH,
        orgId: "org_dev_default",
        createdAt: new Date().toISOString()
      };
      await this.client.hset('webhook:apikeys', pubId, JSON.stringify(record));
      return "org_dev_default";
    }

    return null;
  }

  async createApiKey(orgId, rawKey, bcryptHash) {
    if (!rawKey || !rawKey.startsWith('whk_')) throw new Error('Invalid key format');
    const pubId = rawKey.slice(4, 16);
    const record = {
      pubId,
      hash: bcryptHash,
      orgId,
      createdAt: new Date().toISOString()
    };
    await this.client.hset('webhook:apikeys', pubId, JSON.stringify(record));
  }

  // ─── Endpoints ──────────────────────────────────────────────────────────

  async getAllEndpoints() {
    const keys = await this.client.keys('webhook:endpoints:*');
    if (!keys || keys.length === 0) return [];
    const all = [];
    for (const key of keys) {
      const raw = await this.client.hgetall(key);
      if (raw) {
        all.push(...Object.values(raw).map(v => JSON.parse(v)));
      }
    }
    return all;
  }

  async getEndpoints(orgId) {
    const raw = await this.client.hgetall(`webhook:endpoints:${orgId}`);
    if (!raw) return [];
    return Object.values(raw).map(v => JSON.parse(v));
  }

  async saveEndpoint(orgId, endpoint) {
    await this.client.hset(`webhook:endpoints:${orgId}`, endpoint.id, JSON.stringify({ ...endpoint, orgId }));
  }

  async removeEndpoint(orgId, id) {
    await this.client.hdel(`webhook:endpoints:${orgId}`, id);
  }

  // ─── Deliveries ─────────────────────────────────────────────────────────

  async getDeliveries(orgId) {
    const ids = await this.client.lrange(`webhook:deliveries:${orgId}`, 0, MAX_DELIVERIES - 1);
    if (!ids || ids.length === 0) return [];

    const pipeline = this.client.pipeline();
    ids.forEach(id => pipeline.get(`webhook:delivery:${orgId}:${id}`));
    const results = await pipeline.exec();

    return results
      .map(([err, val]) => (!err && val ? JSON.parse(val) : null))
      .filter(Boolean);
  }

  async getDelivery(orgId, id) {
    const val = await this.client.get(`webhook:delivery:${orgId}:${id}`);
    return val ? JSON.parse(val) : null;
  }

  async addDelivery(orgId, delivery) {
    const pipeline = this.client.pipeline();
    pipeline.lpush(`webhook:deliveries:${orgId}`, delivery.id);
    pipeline.ltrim(`webhook:deliveries:${orgId}`, 0, MAX_DELIVERIES - 1);
    pipeline.set(`webhook:delivery:${orgId}:${delivery.id}`, JSON.stringify({ ...delivery, orgId }), 'EX', DELIVERY_TTL_SEC);
    await pipeline.exec();
  }

  async updateDelivery(orgId, id, fields) {
    const val = await this.client.get(`webhook:delivery:${orgId}:${id}`);
    if (!val) return;
    const updated = { ...JSON.parse(val), ...fields };
    await this.client.set(`webhook:delivery:${orgId}:${id}`, JSON.stringify(updated), 'EX', DELIVERY_TTL_SEC);
  }

  async clearDeliveries(orgId) {
    const ids = await this.client.lrange(`webhook:deliveries:${orgId}`, 0, -1);
    const pipeline = this.client.pipeline();
    ids.forEach(id => pipeline.del(`webhook:delivery:${orgId}:${id}`));
    pipeline.del(`webhook:deliveries:${orgId}`);
    await pipeline.exec();
  }

  // ─── Circuit Breaker State (Distributed) ────────────────────────────────

  async getCircuit(endpointId) {
    const val = await this.client.get(`webhook:circuit:${endpointId}`);
    return val ? JSON.parse(val) : { state: 'CLOSED', failCount: 0, openedAt: null };
  }

  async setCircuit(endpointId, state) {
    await this.client.set(
      `webhook:circuit:${endpointId}`,
      JSON.stringify(state),
      'EX', CIRCUIT_TTL_SEC
    );
  }

  // ─── Rate Limit State (Distributed) ─────────────────────────────────────

  async getRateBucket(endpointId) {
    const val = await this.client.get(`webhook:ratelimit:${endpointId}`);
    return val ? JSON.parse(val) : null;
  }

  async setRateBucket(endpointId, bucket) {
    await this.client.set(
      `webhook:ratelimit:${endpointId}`,
      JSON.stringify(bucket),
      'EX', RATE_TTL_SEC
    );
  }

  // ─── Healthcheck ─────────────────────────────────────────────────────────

  async ping() {
    return this.client.ping();
  }

  async getOrganizationByEmail(email) {
    const orgId = await this.client.get(`webhook:org:email:${email}`);
    if (!orgId) return null;
    return this.getOrganization(orgId);
  }

  async createSession(sessionId, orgId, expiresAt) {
    const ttlSeconds = Math.max(1, Math.ceil((new Date(expiresAt) - Date.now()) / 1000));
    await this.client.set(`webhook:session:${sessionId}`, orgId, 'EX', ttlSeconds);
  }

  async getSession(sessionId) {
    const orgId = await this.client.get(`webhook:session:${sessionId}`);
    if (!orgId) return null;
    // Keep format compatible with JsonAdapter: { sessionId, orgId }
    return { sessionId, orgId };
  }

  async deleteSession(sessionId) {
    await this.client.del(`webhook:session:${sessionId}`);
  }

  // ─── Dual-Lane Queue (Distributed) ───────────────────────────────────────

  async enqueueLowPriority(task) {
    await this.client.rpush('webhook:queue:active', JSON.stringify(task));
  }

  async scheduleDelayed(task, executeAtTimestamp) {
    await this.client.zadd('webhook:queue:delayed', executeAtTimestamp, JSON.stringify(task));
  }

  async pollDelayedTasks(now) {
    await this.client.pollDelayed('webhook:queue:delayed', 'webhook:queue:active', now);
  }

  async popLowPriorityTask() {
    const raw = await this.client.lpop('webhook:queue:active');
    return raw ? JSON.parse(raw) : null;
  }
}

module.exports = RedisAdapter;
