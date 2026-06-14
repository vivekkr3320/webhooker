'use strict';

/**
 * JsonAdapter — default file-system backed storage adapter.
 *
 * Implements the StorageAdapter interface using a single `database.json` file.
 * All reads and writes are synchronous (Node `fs.readFileSync` / `fs.writeFileSync`)
 * to avoid race conditions in single-process deployments.
 *
 * Interface contract (all adapters must implement):
 *   getEndpoints()             → Endpoint[]
 *   saveEndpoint(endpoint)     → void
 *   removeEndpoint(id)         → void
 *   getDeliveries()            → Delivery[]
 *   getDelivery(id)            → Delivery | null
 *   addDelivery(delivery)      → void
 *   updateDelivery(id, fields) → void
 *   clearDeliveries()          → void
 */

const fs   = require('fs');
const path = require('path');

class JsonAdapter {
  constructor(dbPath) {
    this.dbPath = dbPath || path.join(__dirname, '..', '..', 'database.json');
    this._init();
    this._inMemActiveQueue = [];
    this._inMemDelayedQueue = [];
  }

  _init() {
    let raw = { endpoints: [], deliveries: [], organizations: [], apiKeys: [], sessions: [] };
    if (fs.existsSync(this.dbPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        raw = { ...raw, ...parsed };
      } catch {
        // ignore and overwrite on write if corrupt
      }
    }

    let changed = false;

    // Standard bootstrap for default org
    if (!raw.organizations || raw.organizations.length === 0) {
      raw.organizations = [{
        id: "org_dev_default",
        ownerEmail: "admin@localhost",
        razorpayCustomerId: "cust_mock",
        razorpaySubscriptionId: "sub_mock",
        planTier: "pro",
        subscriptionStatus: "active",
        monthlyUsageCount: 0,
        quotaResetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }];
      changed = true;
    }
    if (!raw.apiKeys) {
      raw.apiKeys = [];
      changed = true;
    }
    if (!raw.endpoints) {
      raw.endpoints = [];
      changed = true;
    }
    if (!raw.deliveries) {
      raw.deliveries = [];
      changed = true;
    }
    if (!raw.sessions) {
      raw.sessions = [];
      changed = true;
    }

    // Migration of legacy un-scoped items
    raw.endpoints.forEach(e => {
      if (!e.orgId) {
        e.orgId = "org_dev_default";
        changed = true;
      }
    });

    raw.deliveries.forEach(d => {
      if (!d.orgId) {
        d.orgId = "org_dev_default";
        changed = true;
      }
    });

    if (changed || !fs.existsSync(this.dbPath)) {
      fs.writeFileSync(this.dbPath, JSON.stringify(raw, null, 2), 'utf8');
    }
  }

  _read() {
    try {
      this._init();
      return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    } catch {
      return { endpoints: [], deliveries: [], organizations: [], apiKeys: [], sessions: [] };
    }
  }

  _write(data) {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[JsonAdapter] Write error:', err);
    }
  }

  // ─── Organizations & API Keys ─────────────────────────────────────────────

  getOrganization(orgId) {
    const db = this._read();
    return db.organizations.find(o => o.id === orgId) || null;
  }

  saveOrganization(orgId, orgData) {
    const db = this._read();
    const idx = db.organizations.findIndex(o => o.id === orgId);
    if (idx !== -1) {
      db.organizations[idx] = { ...db.organizations[idx], ...orgData };
    } else {
      db.organizations.push({ id: orgId, ...orgData });
    }
    this._write(db);
  }

  getOrganizationBySubscriptionId(subId) {
    const db = this._read();
    return db.organizations.find(o => o.razorpaySubscriptionId === subId) || null;
  }

  updateOrganizationSubscription(subId, subscriptionFields) {
    const db = this._read();
    const idx = db.organizations.findIndex(o => o.razorpaySubscriptionId === subId);
    if (idx !== -1) {
      db.organizations[idx] = { ...db.organizations[idx], ...subscriptionFields };
      this._write(db);
    }
  }

  getOrgIdByKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('whk_')) return null;
    const pubId = apiKey.slice(4, 16);
    const db = this._read();

    const keyRecord = db.apiKeys.find(k => k.pubId === pubId);
    if (keyRecord) {
      return keyRecord.orgId;
    }

    // Seamless fallback to process.env.API_KEY_HASH
    const bcrypt = require('bcrypt');
    if (process.env.API_KEY_HASH && bcrypt.compareSync(apiKey, process.env.API_KEY_HASH)) {
      db.apiKeys.push({
        pubId,
        hash: process.env.API_KEY_HASH,
        orgId: "org_dev_default",
        createdAt: new Date().toISOString()
      });
      this._write(db);
      return "org_dev_default";
    }

    return null;
  }

  createApiKey(orgId, rawKey, bcryptHash) {
    if (!rawKey || !rawKey.startsWith('whk_')) throw new Error('Invalid key format');
    const pubId = rawKey.slice(4, 16);
    const db = this._read();
    db.apiKeys.push({
      pubId,
      hash: bcryptHash,
      orgId,
      createdAt: new Date().toISOString()
    });
    this._write(db);
  }

  // ─── Scoped Endpoints ──────────────────────────────────────────────────────

  getAllEndpoints() {
    return this._read().endpoints || [];
  }

  getEndpoints(orgId) {
    return this._read().endpoints.filter(e => e.orgId === orgId) || [];
  }

  saveEndpoint(orgId, endpoint) {
    const db = this._read();
    const idx = db.endpoints.findIndex(e => e.id === endpoint.id && e.orgId === orgId);
    const data = { ...endpoint, orgId };
    if (idx !== -1) {
      db.endpoints[idx] = data;
    } else {
      db.endpoints.push(data);
    }
    this._write(db);
  }

  removeEndpoint(orgId, id) {
    const db = this._read();
    db.endpoints = db.endpoints.filter(e => !(e.id === id && e.orgId === orgId));
    this._write(db);
  }

  // ─── Scoped Deliveries ─────────────────────────────────────────────────────

  getDeliveries(orgId) {
    return this._read().deliveries.filter(d => d.orgId === orgId) || [];
  }

  getDelivery(orgId, id) {
    return this._read().deliveries.find(d => d.id === id && d.orgId === orgId) || null;
  }

  addDelivery(orgId, delivery) {
    const db = this._read();
    const data = { ...delivery, orgId };
    db.deliveries.unshift(data);
    if (db.deliveries.length > 200) db.deliveries = db.deliveries.slice(0, 200);
    this._write(db);
  }

  updateDelivery(orgId, id, fields) {
    const db = this._read();
    const idx = db.deliveries.findIndex(d => d.id === id && d.orgId === orgId);
    if (idx !== -1) {
      db.deliveries[idx] = { ...db.deliveries[idx], ...fields };
      this._write(db);
    }
  }

  clearDeliveries(orgId) {
    const db = this._read();
    db.deliveries = db.deliveries.filter(d => d.orgId !== orgId);
    this._write(db);
  }

  getOrganizationByEmail(email) {
    const db = this._read();
    return db.organizations.find(o => o.ownerEmail === email) || null;
  }

  createSession(sessionId, orgId, expiresAt) {
    const db = this._read();
    if (!db.sessions) db.sessions = [];
    db.sessions.push({ sessionId, orgId, expiresAt });
    this._write(db);
  }

  getSession(sessionId) {
    const db = this._read();
    if (!db.sessions) return null;
    const session = db.sessions.find(s => s.sessionId === sessionId);
    if (!session) return null;
    if (new Date(session.expiresAt) < new Date()) {
      // Clean expired sessions
      db.sessions = db.sessions.filter(s => s.sessionId !== sessionId);
      this._write(db);
      return null;
    }
    return session;
  }

  deleteSession(sessionId) {
    const db = this._read();
    if (!db.sessions) return;
    db.sessions = db.sessions.filter(s => s.sessionId !== sessionId);
    this._write(db);
  }

  // ─── Dual-Lane Queue (In-Memory Fallback) ────────────────────────────────

  enqueueLowPriority(task) {
    this._inMemActiveQueue.push(task);
  }

  scheduleDelayed(task, executeAtTimestamp) {
    this._inMemDelayedQueue.push({ task, executeAtTimestamp });
  }

  pollDelayedTasks(now) {
    const due = this._inMemDelayedQueue.filter(item => item.executeAtTimestamp <= now);
    this._inMemDelayedQueue = this._inMemDelayedQueue.filter(item => item.executeAtTimestamp > now);
    due.forEach(item => {
      this._inMemActiveQueue.push(item.task);
    });
  }

  popLowPriorityTask() {
    return this._inMemActiveQueue.shift() || null;
  }
}

module.exports = JsonAdapter;
