'use strict';

require('dotenv').config();

const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const { EventEmitter } = require('events');
const db      = require('./db');
const { maskSensitiveHeaders } = require('./db');
const logger  = require('./logger');
const AlertManager = require('./AlertManager');
const Transformer = require('./Transformer');

/**
 * WebhookEngine — the core of the framework.
 */
class WebhookEngine extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string}   [opts.secret]       - Global HMAC signing secret
   * @param {number}   [opts.maxRetries]   - Max delivery attempts (default 5)
   * @param {number[]} [opts.retryDelays]  - Delays between retries in seconds
   * @param {number}   [opts.timeout]      - HTTP request timeout in ms (default 30 000)
   */
  constructor(opts = {}) {
    super();
    this.secret      = opts.secret      ?? crypto.randomBytes(32).toString('hex');
    this.maxRetries  = opts.maxRetries  ?? 5;
    this.retryDelays = opts.retryDelays ?? [10, 30, 60, 300, 900];
    this.timeout     = opts.timeout     ?? 30_000;

    this.endpoints    = new Map();   // id → endpoint object
    this._retryQueue  = new Map();   // key → { timer, meta }

    // In-memory fallbacks used when storage adapter doesn't support
    // distributed state (JsonAdapter). RedisAdapter overrides these.
    this._circuitState = new Map(); // id → { state, failCount, openedAt }
    this._rateBuckets  = new Map(); // id → { tokens, lastRefill }

    // Low-priority execution queue state for Dual-Lane priority routing
    this._activeLowPriorityCount = 0;
    this._lowPriorityConcurrency = opts.lowPriorityConcurrency ?? 3;

    // Start background poller for delayed tasks and worker processor
    this._workerPollInterval = opts.workerPollInterval ?? 1000; // 1s
    this._startWorker();

    // Load initial endpoints from persistent storage on boot
    this._init();
  }
  async _init() {
    try {
      const persisted = await Promise.resolve(db.getAllEndpoints());
      persisted.forEach(ep => {
        this.endpoints.set(`${ep.orgId}:${ep.id}`, ep);
      });
      logger.info({ count: this.endpoints.size }, 'Engine loaded endpoints from storage');
    } catch (err) {
      logger.error({ err: err.message }, 'Engine failed to load endpoints from storage');
    }
  }

  // ─── Dual-Lane Priority Queue helpers (Persistent) ─────────────────────────

  _startWorker() {
    this._workerTimer = setInterval(() => {
      this._pollAndProcessQueue().catch(err => {
        logger.error({ err: err.message }, 'Queue worker polling cycle error');
      });
    }, this._workerPollInterval);
  }

  async _pollAndProcessQueue() {
    const now = Date.now();
    
    // 1. Move due delayed tasks to the active queue
    await db.pollDelayedTasks(now);

    // 2. Process tasks from active queue up to local concurrency limit
    while (this._activeLowPriorityCount < this._lowPriorityConcurrency) {
      const task = await db.popLowPriorityTask();
      if (!task) {
        break; // active queue is empty
      }

      this._activeLowPriorityCount++;
      this._executeQueueTask(task)
        .catch(err => {
          logger.error({ err: err.message, task }, 'Queue task execution failure');
        })
        .finally(() => {
          this._activeLowPriorityCount--;
          // Run immediately again to fill the empty slot
          setImmediate(() => this._pollAndProcessQueue().catch(() => {}));
        });
    }
  }

  async _executeQueueTask(task) {
    if (task.type === 'replay') {
      const { orgId, deliveryId } = task;
      const record = await Promise.resolve(db.getDelivery(orgId, deliveryId));
      if (!record) throw new Error(`Delivery '${deliveryId}' not found in logs`);

      const endpoint = this.endpoints.get(`${orgId}:${record.endpointId}`);
      if (!endpoint) throw new Error(`Endpoint '${record.endpointId}' no longer registered`);

      const payload = {
        id:        record.payloadId,
        event:     record.event,
        data:      record.replayData || {},
        timestamp: new Date().toISOString(),
        version:   '1.0',
        replayed:  true,
      };

      this.emit('delivery:replay', { orgId, deliveryId, endpointId: record.endpointId });
      await this._deliver(endpoint, payload, record.attempt + 1);
    } else if (task.type === 'retry') {
      const { orgId, endpointId, payload, attempt } = task;
      
      // Clear key from observability queue since it's now executing
      const key = `${orgId}:${endpointId}:${payload.id}:${attempt}`;
      this._retryQueue.delete(key);

      const endpoint = this.endpoints.get(`${orgId}:${endpointId}`);
      if (!endpoint) throw new Error(`Endpoint '${endpointId}' no longer registered for org '${orgId}'`);

      const isolatedEndpoint = Object.freeze({ ...endpoint, orgId });
      await this._deliver(isolatedEndpoint, payload, attempt);
    } else {
      throw new Error(`Unknown queue task type: ${task.type}`);
    }
  }

  // ─── Endpoint management ─────────────────────────────────────────────────

  register(orgId, id, url, opts = {}) {
    if (!orgId || !id || !url) throw new TypeError('register(orgId, id, url) — all arguments required');
    
    const endpoint = {
      id,
      orgId,
      url,
      events:      opts.events      ?? ['*'],
      secret:      opts.secret      ?? this.secret,
      active:      opts.active      ?? true,
      headers:     opts.headers     ?? {},
      integration: opts.integration ?? 'standard',
      transformationScript: opts.transformationScript ?? null,
      metadata:    opts.metadata    ?? {},
      createdAt:   opts.createdAt   ?? new Date().toISOString(),
    };

    this.endpoints.set(`${orgId}:${id}`, endpoint);
    db.saveEndpoint(orgId, endpoint);

    this.emit('endpoint:registered', { orgId, id, url });
    return this;
  }

  deactivate(orgId, id) {
    const ep = this._ep(orgId, id);
    ep.active = false;
    db.saveEndpoint(orgId, ep);
    this.emit('endpoint:deactivated', { orgId, id });
    return this;
  }

  activate(orgId, id) {
    const ep = this._ep(orgId, id);
    ep.active = true;
    db.saveEndpoint(orgId, ep);
    this.emit('endpoint:activated', { orgId, id });
    return this;
  }

  unregister(orgId, id) {
    this.endpoints.delete(`${orgId}:${id}`);
    db.removeEndpoint(orgId, id);
    this.emit('endpoint:removed', { orgId, id });
    return this;
  }
  // ─── Replay ──────────────────────────────────────────────────────────────

  /**
   * Replay a previously attempted delivery by its delivery log ID.
   * Creates a new delivery attempt with attempt+1 so it is distinguishable.
   *
   * @param {string} deliveryId  - The delivery log ID (del_*)
   * @returns {object} New delivery result
   */

  async replay(orgId, deliveryId) {
    const record = await Promise.resolve(db.getDelivery(orgId, deliveryId));
    if (!record) throw new Error(`Delivery '${deliveryId}' not found in logs`);

    const endpoint = this.endpoints.get(`${orgId}:${record.endpointId}`);
    if (!endpoint) throw new Error(`Endpoint '${record.endpointId}' no longer registered`);

    const task = {
      type: 'replay',
      orgId,
      deliveryId
    };

    await db.enqueueLowPriority(task);
    return { success: true, message: 'Replay task enqueued' };
  }

  /**
   * Bulk redrive failed webhook delivery attempts.
   * Processes replays in parallel (bounded by event loop concurrency).
   *
   * @param {string} orgId
   * @param {object} [options]
   * @param {string[]} [options.deliveryIds] - Explicit array of delivery IDs to retry
   * @param {string}   [options.endpointId]  - Filter by endpoint
   * @param {string}   [options.status]      - Filter by status
   * @param {string}   [options.since]       - Downtime start time (ISO string)
   * @param {string}   [options.before]      - Downtime end time (ISO string)
   * @returns {object} Summary of replay operations
   */
  async bulkReplay(orgId, options = {}) {
    let targetIds = [];

    if (Array.isArray(options.deliveryIds)) {
      targetIds = options.deliveryIds;
    } else {
      let entries = await Promise.resolve(db.getDeliveries(orgId));
      
      if (options.endpointId) {
        entries = entries.filter(e => e.endpointId === options.endpointId);
      }
      
      if (options.status) {
        entries = entries.filter(e => e.status === options.status);
      } else {
        // Default to filtering for unsuccessful delivery attempts
        const failedStatuses = ['failed', 'error', 'rate_limited', 'circuit_open'];
        entries = entries.filter(e => failedStatuses.includes(e.status));
      }
      
      if (options.since) {
        const sinceTime = new Date(options.since).getTime();
        entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
      }
      
      if (options.before) {
        const beforeTime = new Date(options.before).getTime();
        entries = entries.filter(e => new Date(e.timestamp).getTime() <= beforeTime);
      }
      
      targetIds = entries.map(e => e.id);
    }

    if (targetIds.length === 0) {
      return { success: true, count: 0, results: [] };
    }

    const promises = targetIds.map(async (id) => {
      try {
        const result = await this.replay(orgId, id);
        return { deliveryId: id, success: true, result };
      } catch (err) {
        return { deliveryId: id, success: false, error: err.message };
      }
    });

    const results = await Promise.all(promises);
    
    return {
      success: true,
      count: targetIds.length,
      results
    };
  }

  // ─── Sending ─────────────────────────────────────────────────────────────

  async send(orgId, event, data = {}) {
    const payload = {
      id:        'evt_' + crypto.randomBytes(12).toString('hex'),
      event,
      data,
      timestamp: new Date().toISOString(),
      version:   '1.0',
    };

    this.emit('event:fired', { orgId, ...payload });

    const targets = [...this.endpoints.values()].filter(ep =>
      ep.orgId === orgId && ep.active && (ep.events.includes('*') || ep.events.includes(event))
    );

    if (targets.length === 0) {
      this.emit('event:no_endpoints', { orgId, event });
      return [];
    }

    const settled = await Promise.allSettled(
      targets.map(ep => this._deliver(ep, payload))
    );

    return settled.map((r, i) => ({
      endpointId: targets[i].id,
      result:     r.status === 'fulfilled' ? r.value : { error: r.reason?.message },
    }));
  }

  // ─── Signature helpers ────────────────────────────────────────────────────

  sign(body, secret = this.secret) {
    const ts     = Date.now();
    const signed = crypto.createHmac('sha256', secret)
                         .update(`${ts}.${body}`)
                         .digest('hex');
    return `t=${ts},v1=${signed}`;
  }

  verify(rawBody, signatureHeader, secret = this.secret, toleranceSec = 300) {
    const parts = Object.fromEntries(
      signatureHeader.split(',').map(p => p.split('=').map((v, i) => i === 1 ? p.slice(p.indexOf('=') + 1) : v))
    );

    const ts = parseInt(parts.t, 10);
    if (!ts) throw new Error('Invalid signature: missing timestamp');

    const ageSec = (Date.now() - ts) / 1000;
    if (ageSec > toleranceSec) {
      throw new Error(`Webhook timestamp too old (${Math.round(ageSec)}s > ${toleranceSec}s)`);
    }

    const body    = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expect  = crypto.createHmac('sha256', secret)
                          .update(`${ts}.${body}`)
                          .digest('hex');
    const received = parts.v1;
    if (!received) throw new Error('Invalid signature: missing v1');

    const expBuf = Buffer.from(expect,   'hex');
    const rcvBuf = Buffer.from(received, 'hex');

    if (expBuf.length !== rcvBuf.length || !crypto.timingSafeEqual(expBuf, rcvBuf)) {
      throw new Error('Signature mismatch');
    }
    return true;
  }

  // ─── Observability ────────────────────────────────────────────────────────

  async stats(orgId) {
    const log       = await Promise.resolve(db.getDeliveries(orgId));
    const total     = log.length;
    const success   = log.filter(d => d.status === 'delivered').length;
    const failed    = log.filter(d => d.status === 'failed' || d.status === 'error').length;
    const pending   = log.filter(d => d.status === 'pending').length;
    const times     = log.filter(d => d.responseTime != null).map(d => d.responseTime);
    const avgRT     = times.length ? Math.round(times.reduce((a, t) => a + t, 0) / times.length) : 0;

    return {
      total,
      success,
      failed,
      pending,
      successRate:    total ? +(success / total * 100).toFixed(1) : 0,
      avgResponseTime: avgRT,
      activeEndpoints: [...this.endpoints.values()].filter(e => e.orgId === orgId && e.active).length,
      pendingRetries:  [...this._retryQueue.values()].filter(r => r.orgId === orgId).length,
    };
  }

  async logs(orgId, filter = {}) {
    let entries = await Promise.resolve(db.getDeliveries(orgId));
    if (filter.endpointId) entries = entries.filter(e => e.endpointId === filter.endpointId);
    if (filter.event)      entries = entries.filter(e => e.event      === filter.event);
    if (filter.status)     entries = entries.filter(e => e.status     === filter.status);
    return entries.slice(0, filter.limit ?? 100);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  _ep(orgId, id) {
    const ep = this.endpoints.get(`${orgId}:${id}`);
    if (!ep) throw new Error(`Endpoint '${id}' not found for org '${orgId}'`);
    return ep;
  }

  async _deliver(endpoint, payload, attempt = 1) {
    // ── Zero-Trust: Assert tenant context is bound ────────────────
    if (!endpoint.orgId) {
      logger.error({ endpointId: endpoint.id }, 'SECURITY:_deliver called without orgId — aborting');
      throw new Error('Tenant context missing: endpoint.orgId is required');
    }

    // Freeze the orgId at invocation time — prevents late-binding mutation
    const orgId = endpoint.orgId;

    // ── Circuit Breaker guard ─────────────────────────────────────
    const circuit = await this._getCircuit(endpoint.id);
    if (circuit.state === 'OPEN') {
      const elapsed = (Date.now() - circuit.openedAt) / 1000;
      const cooldown = endpoint.circuitCooldownSec ?? 60;
      if (elapsed < cooldown) {
        const entry = {
          id:         'del_' + crypto.randomBytes(8).toString('hex'),
          endpointId: endpoint.id,
          url:        endpoint.url,
          event:      payload.event,
          payloadId:  payload.id,
          attempt,
          timestamp:  new Date().toISOString(),
          status:     'circuit_open',
          integration: endpoint.integration,
          requestHeaders: maskSensitiveHeaders(endpoint.headers || {}),
          error: `Circuit OPEN — cooldown ${Math.round(cooldown - elapsed)}s remaining`,
        };
        db.addDelivery(endpoint.orgId, entry);
        this.emit('delivery:circuit_open', entry);
        return entry;
      }
      // Cooldown expired → transition to HALF_OPEN probe
      circuit.state = 'HALF_OPEN';
      await this._setCircuit(endpoint.id, circuit);
    }

    // ── Rate Limiter guard ────────────────────────────────────────
    const org = await Promise.resolve(db.getOrganization(endpoint.orgId));
    if (!org) {
      throw new Error(`Delivery Aborted: Organization context '${endpoint.orgId}' could not be resolved.`);
    }

    if (org.subscriptionStatus === 'suspended' || org.subscriptionStatus === 'halted') {
      logger.warn({ orgId: endpoint.orgId, endpointId: endpoint.id }, 'Egress Blocked: Delivery dropped due to account delinquency.');
      const entry = {
        id:         'del_' + crypto.randomBytes(8).toString('hex'),
        endpointId: endpoint.id,
        url:        endpoint.url,
        event:      payload.event,
        payloadId:  payload.id,
        attempt,
        timestamp:  new Date().toISOString(),
        status:     'failed',
        statusCode: 402,
        integration: endpoint.integration,
        requestHeaders: maskSensitiveHeaders(endpoint.headers || {}),
        error: "402 Payment Required: Outbound data stream frozen due to billing suspension.",
      };
      db.addDelivery(endpoint.orgId, entry);
      this.emit('delivery:failed', entry);
      throw new Error("402 Payment Required: Workspace delivery quota completely locked.");
    }

    const tier = org.planTier || 'free';
    const plan = db.PLAN_TIERS[tier] || db.PLAN_TIERS.free;
    const planMaxRPM = plan.maxRPM || 60;
    const effectiveMaxRPM = endpoint.maxRPM ? Math.min(endpoint.maxRPM, planMaxRPM) : planMaxRPM;

    if (!await this._checkRateLimit(endpoint.id, effectiveMaxRPM)) {
      const entry = {
        id:         'del_' + crypto.randomBytes(8).toString('hex'),
        endpointId: endpoint.id,
        url:        endpoint.url,
        event:      payload.event,
        payloadId:  payload.id,
        attempt,
        timestamp:  new Date().toISOString(),
        status:     'rate_limited',
        integration: endpoint.integration,
        requestHeaders: maskSensitiveHeaders(endpoint.headers || {}),
        error: `Rate limit exceeded (max ${effectiveMaxRPM} RPM for ${plan.name})`,
      };
      db.addDelivery(endpoint.orgId, entry);
      this.emit('delivery:rate_limited', entry);
      return entry;
    }

    let finalPayload = payload;
    if (endpoint.transformationScript) {
      try {
        logger.info({ endpointId: endpoint.id }, 'Executing sandboxed script payload transformation');
        finalPayload = Transformer.transform(payload, endpoint.transformationScript);
      } catch (transformError) {
        logger.error({ err: transformError.message }, 'Payload transformation pipeline crash');
        const entry = {
          id:         'del_' + crypto.randomBytes(8).toString('hex'),
          endpointId: endpoint.id,
          url:        endpoint.url,
          event:      payload.event,
          payloadId:  payload.id,
          attempt,
          timestamp:  new Date().toISOString(),
          status:     'error',
          statusCode: 422,
          integration: endpoint.integration,
          error:      `Transformation Pipeline Failed: ${transformError.message}`
        };
        db.addDelivery(endpoint.orgId, entry);
        this.emit('delivery:error', entry);
        await this._circuitFailure(endpoint.id, endpoint, `Transformation Failed: ${transformError.message}`, payload.event);
        return entry;
      }
    }

    let body;
    let signature = '';

    // Transform payload natively if targeting Slack/Discord integrations
    if (endpoint.integration === 'slack') {
      body = JSON.stringify(formatSlackPayload(finalPayload));
    } else if (endpoint.integration === 'discord') {
      body = JSON.stringify(formatDiscordPayload(finalPayload));
    } else {
      body      = JSON.stringify(finalPayload);
      signature = this.sign(body, endpoint.secret);
    }

    const entry = {
      id:         'del_' + crypto.randomBytes(8).toString('hex'),
      endpointId: endpoint.id,
      url:        endpoint.url,
      event:      finalPayload.event,
      payloadId:  finalPayload.id,
      replayData: finalPayload.data,
      attempt,
      timestamp:  new Date().toISOString(),
      status:     'pending',
      signature,
      integration: endpoint.integration,
      // Store masked copy of outgoing headers — never raw credentials
      requestHeaders: maskSensitiveHeaders(endpoint.headers || {}),
    };

    // Save to persistent database logs
    db.addDelivery(endpoint.orgId, entry);
    this.emit('delivery:attempt', entry);

    try {
      const res = await this._request(endpoint.url, body, signature, endpoint.headers || {}, payload.id, endpoint.id);

      const updates = {
        statusCode:   res.statusCode,
        responseTime: res.responseTime,
        responseBody: res.body?.slice(0, 500)
      };

      if (res.ok) {
        updates.status = 'delivered';
        db.updateDelivery(endpoint.orgId, entry.id, updates);
        this.emit('delivery:success', { ...entry, ...updates });
        logger.info({ endpointId: endpoint.id, attempt, status: 'delivered', responseTime: updates.responseTime }, 'delivery:success');
        // Success → reset circuit breaker
        await this._circuitSuccess(endpoint.id);

        // Increment monthly usage count for the organization
        try {
          const org = await db.getOrganization(endpoint.orgId);
          if (org) {
            org.monthlyUsageCount = (org.monthlyUsageCount || 0) + 1;
            await db.saveOrganization(endpoint.orgId, org);
          }
        } catch (orgErr) {
          logger.error({ orgId: endpoint.orgId, err: orgErr.message }, 'Failed to increment usage count');
        }
      } else {
        updates.status = 'failed';
        db.updateDelivery(endpoint.orgId, entry.id, updates);
        this.emit('delivery:failed', { ...entry, ...updates });
        // Failure → record for circuit breaker
        await this._circuitFailure(endpoint.id, endpoint, `HTTP status code ${updates.statusCode}`, payload.event);
        logger.warn({ endpointId: endpoint.id, attempt, statusCode: updates.statusCode }, 'delivery:failed');
        if (attempt <= this.maxRetries) this._scheduleRetry(endpoint, payload, attempt);
      }
      return { ...entry, ...updates };
    } catch (err) {
      const updates = {
        status: 'error',
        error:  err.message
      };
      db.updateDelivery(endpoint.orgId, entry.id, updates);
      this.emit('delivery:error', { ...entry, ...updates });
      await this._circuitFailure(endpoint.id, endpoint, err.message, payload.event);
      logger.error({ endpointId: endpoint.id, attempt, err: err.message }, 'delivery:error');
      if (attempt <= this.maxRetries) this._scheduleRetry(endpoint, payload, attempt);
      return { ...entry, ...updates };
    }
  }

  // ─── Circuit Breaker Helpers (Redis-backed when available) ───────────────

  async _getCircuit(endpointId) {
    try {
      const adapter = db.adapter;
      if (adapter && typeof adapter.getCircuit === 'function') {
        return await adapter.getCircuit(endpointId);
      }
    } catch (err) {
      logger.warn({ endpointId, err: err.message }, 'circuit:redis_fallback');
    }
    // In-memory fallback
    if (!this._circuitState.has(endpointId)) {
      this._circuitState.set(endpointId, { state: 'CLOSED', failCount: 0, openedAt: null });
    }
    return this._circuitState.get(endpointId);
  }

  async _setCircuit(endpointId, state) {
    try {
      const adapter = db.adapter;
      if (adapter && typeof adapter.setCircuit === 'function') {
        await adapter.setCircuit(endpointId, state);
        return;
      }
    } catch (err) {
      logger.warn({ endpointId, err: err.message }, 'circuit:set_redis_fallback');
    }
    this._circuitState.set(endpointId, state);
  }

  async _circuitFailure(endpointId, endpoint, lastError = 'Unknown error', eventName = 'N/A') {
    const circuit = await this._getCircuit(endpointId);
    circuit.failCount++;
    const threshold = endpoint.circuitThreshold ?? 5;
    if (circuit.state === 'HALF_OPEN' || circuit.failCount >= threshold) {
      circuit.state = 'OPEN';
      circuit.openedAt = Date.now();
      this.emit('circuit:open', { endpointId, failCount: circuit.failCount });
      logger.warn({ endpointId, failCount: circuit.failCount }, 'circuit:OPEN');
    }
    await this._setCircuit(endpointId, circuit);

    if (endpoint.orgId) {
      this._checkAndTriggerAlert(endpoint.orgId, endpoint, circuit.failCount, lastError, eventName).catch(err => {
        logger.error({ err: err.message, endpointId }, 'Alert trigger background error');
      });
    }
  }

  async _checkAndTriggerAlert(orgId, endpoint, failCount, lastError, eventName) {
    try {
      const org = await Promise.resolve(db.getOrganization(orgId));
      if (!org || !org.alertConfig || !org.alertConfig.enabled) {
        return;
      }
      const config = org.alertConfig;
      if (failCount === parseInt(config.notifyOnFailureCount, 10)) {
        AlertManager.triggerAlert(orgId, endpoint, {
          failCount,
          lastError,
          eventName,
          alertConfig: config
        }).catch(err => {
          logger.error({ err: err.message, orgId }, 'Failed to dispatch alert via AlertManager');
        });
      }
    } catch (err) {
      logger.error({ err: err.message, orgId }, 'Error checking alert configuration');
    }
  }

  async _circuitSuccess(endpointId) {
    const circuit = await this._getCircuit(endpointId);
    if (circuit.state !== 'CLOSED') {
      logger.info({ endpointId }, 'circuit:CLOSED — recovered');
    }
    await this._setCircuit(endpointId, { state: 'CLOSED', failCount: 0, openedAt: null });
  }

  async circuitHealth(endpointId) {
    const circuit = await this._getCircuit(endpointId);
    const ep = this.endpoints.get(endpointId);
    const cooldown = ep?.circuitCooldownSec ?? 60;
    const cooldownRemaining = circuit.state === 'OPEN'
      ? Math.max(0, Math.round(cooldown - (Date.now() - circuit.openedAt) / 1000))
      : 0;
    return { ...circuit, cooldownRemaining };
  }

  // ─── Token Bucket Rate Limiter (Redis-backed when available) ─────────────

  async _checkRateLimit(endpointId, maxRPM) {
    const now = Date.now();
    let bucket;

    try {
      const adapter = db.adapter;
      if (adapter && typeof adapter.getRateBucket === 'function') {
        bucket = await adapter.getRateBucket(endpointId);
        if (!bucket) bucket = { tokens: maxRPM, lastRefill: now };

        const elapsed = (now - bucket.lastRefill) / 60000;
        bucket.tokens = Math.min(maxRPM, bucket.tokens + elapsed * maxRPM);
        bucket.lastRefill = now;

        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          await adapter.setRateBucket(endpointId, bucket);
          return true;
        }
        await adapter.setRateBucket(endpointId, bucket);
        logger.warn({ endpointId, maxRPM }, 'rate_limit:exceeded');
        return false;
      }
    } catch (err) {
      logger.warn({ endpointId, err: err.message }, 'ratelimit:redis_fallback');
    }

    // In-memory fallback
    if (!this._rateBuckets.has(endpointId)) {
      this._rateBuckets.set(endpointId, { tokens: maxRPM, lastRefill: now });
    }
    const memBucket = this._rateBuckets.get(endpointId);
    const elapsed = (now - memBucket.lastRefill) / 60000;
    memBucket.tokens = Math.min(maxRPM, memBucket.tokens + elapsed * maxRPM);
    memBucket.lastRefill = now;
    if (memBucket.tokens >= 1) {
      memBucket.tokens -= 1;
      return true;
    }
    return false;
  }
  _scheduleRetry(endpoint, payload, attempt) {
    const delaySec = this.retryDelays[attempt - 1] ?? 900;
    const frozenOrgId = endpoint.orgId;
    const frozenEndpointId = endpoint.id;
    const executeAtTimestamp = Date.now() + delaySec * 1000;
    const key = `${frozenOrgId}:${frozenEndpointId}:${payload.id}:${attempt + 1}`;

    const task = {
      type: 'retry',
      orgId: frozenOrgId,
      endpointId: frozenEndpointId,
      payload,
      attempt: attempt + 1
    };

    Promise.resolve(db.scheduleDelayed(task, executeAtTimestamp)).catch(err => {
      logger.error({ err: err.message, key }, 'Failed to schedule retry task in storage');
    });

    this._retryQueue.set(key, {
      orgId:        frozenOrgId,
      endpointId:   frozenEndpointId,
      payloadId:    payload.id,
      attempt:      attempt + 1,
      scheduledFor: new Date(executeAtTimestamp).toISOString(),
      delaySec,
    });

    this.emit('delivery:retry_scheduled', {
      orgId:      frozenOrgId,
      endpointId: frozenEndpointId,
      payloadId:  payload.id,
      attempt:    attempt + 1,
      delaySec,
    });
  }

  _request(url, body, signature, customHeaders = {}, payloadId = '', endpointId = '') {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let parsed;
      try { parsed = new URL(url); }
      catch { return reject(new Error(`Invalid URL: ${url}`)); }

      const lib = parsed.protocol === 'https:' ? https : http;

      // Derive stable idempotency key from payload + endpoint identifiers
      const idempotencyKey = crypto
        .createHash('sha256')
        .update(`${payloadId}::${endpointId}`)
        .digest('hex')
        .slice(0, 32);

      // Base request headers
      const headers = {
        'Content-Type':                'application/json',
        'Content-Length':              Buffer.byteLength(body),
        'X-Webhook-Delivery':          crypto.randomBytes(8).toString('hex'),
        'X-Webhook-Idempotency-Key':   idempotencyKey,
        'User-Agent':                  'WebhookEngine/1.0',
      };

      // Append X-Webhook-Signature only if signing is active
      if (signature) {
        headers['X-Webhook-Signature'] = signature;
      }

      // Merge per-endpoint custom headers (raw — sent to receiver, not stored)
      Object.assign(headers, customHeaders);

      const req = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  headers,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          ok:           res.statusCode >= 200 && res.statusCode < 300,
          statusCode:   res.statusCode,
          body:         Buffer.concat(chunks).toString('utf8'),
          responseTime: Date.now() - start,
        }));
      });

      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
  close() {
    if (this._workerTimer) {
      clearInterval(this._workerTimer);
    }
  }
}

// ─── Native Slack & Discord Layout Transformers ──────────────────────────

function formatSlackPayload(payload) {
  const isFail = payload.event.includes('failed') || payload.event.includes('error');
  const color = isFail ? '#f43f5e' : '#10b981';
  return {
    attachments: [
      {
        color: color,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `🔔 Webhook Fired: ${payload.event}`,
              emoji: true
            }
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*Payload ID:*\n\`${payload.id}\``
              },
              {
                type: "mrkdwn",
                text: `*Timestamp:*\n${payload.timestamp}`
              }
            ]
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Data Context:* \`\`\`json\n${JSON.stringify(payload.data, null, 2)}\n\`\`\``
            }
          }
        ]
      }
    ]
  };
}

function formatDiscordPayload(payload) {
  const isFail = payload.event.includes('failed') || payload.event.includes('error');
  const color = isFail ? 16006990 : 1095937; // Integer color mappings
  return {
    embeds: [
      {
        title: `🔔 Webhook Dispatch: ${payload.event}`,
        color: color,
        description: `Visual integration message mapped from engine parameters.`,
        fields: [
          {
            name: "Payload UUID",
            value: `\`${payload.id}\``,
            inline: true
          },
          {
            name: "Timestamp",
            value: payload.timestamp,
            inline: true
          },
          {
            name: "Data payload Context",
            value: `\`\`\`json\n${JSON.stringify(payload.data, null, 2)}\n\`\`\``
          }
        ],
        footer: {
          text: "WebhookEngine Integration Engine"
        }
      }
    ]
  };
}

module.exports = WebhookEngine;
