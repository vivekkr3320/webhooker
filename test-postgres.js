'use strict';

const PostgreSqlAdapter = require('./src/adapters/PostgreSqlAdapter');
const pg = require('pg');

// Setup a small helper to delay execution in tests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
  console.log('🚀 Starting PostgreSQL Storage Adapter Tests...');

  let adapter;
  let useMock = false;

  // 1. Try to connect to a real PostgreSQL instance
  const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
  try {
    const client = new pg.Client({ connectionString });
    await client.connect();
    await client.end();
    console.log('⚡ Real PostgreSQL server detected. Running real database integration tests.');
    adapter = new PostgreSqlAdapter(connectionString);
  } catch (err) {
    console.log('⚠️ PostgreSQL database offline. Activating Mock Database layer for unit testing.');
    useMock = true;
    adapter = new PostgreSqlAdapter(connectionString);

    // Mock Pool client inside adapter
    const mockPoolInstance = new MockPool();
    adapter.pool = mockPoolInstance;
    adapter.query = async (text, params) => mockPoolInstance.query(text, params);
    adapter.bootstrapPromise = Promise.resolve(); // Bypass async SQL reading
  }

  try {
    const orgId = 'org_pg_test_123';

    // ─── Test 1: Organizations ─────────────────────────────────────────────
    console.log('\n--- Test 1: Organization operations ---');
    const testOrg = {
      ownerEmail: 'pg_test@company.com',
      razorpayCustomerId: 'cust_pg_123',
      razorpaySubscriptionId: 'sub_pg_123',
      planTier: 'free',
      subscriptionStatus: 'active',
      monthlyUsageCount: 0,
      quotaResetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };

    await adapter.saveOrganization(orgId, testOrg);
    console.log('✅ Organization saved successfully.');

    const retrievedOrg = await adapter.getOrganization(orgId);
    if (!retrievedOrg || retrievedOrg.ownerEmail !== testOrg.ownerEmail) {
      throw new Error(`Failed to retrieve organization. Expected ownerEmail: ${testOrg.ownerEmail}, Got: ${retrievedOrg?.ownerEmail}`);
    }
    console.log('✅ Organization retrieved successfully.');

    // ─── Test 2: Scoped Endpoints ───────────────────────────────────────────
    console.log('\n--- Test 2: Endpoint operations ---');
    const endpointId = 'ep_pg_001';
    const endpointData = {
      id: endpointId,
      url: 'http://localhost:5000/callback',
      secret: 'whsec_pgsecret',
      events: ['order.created', 'order.paid'],
      active: true
    };

    await adapter.saveEndpoint(orgId, endpointData);
    console.log('✅ Endpoint saved.');

    const endpoints = await adapter.getEndpoints(orgId);
    if (endpoints.length !== 1 || endpoints[0].id !== endpointId) {
      throw new Error('Failed to retrieve endpoints or endpoint ID mismatch.');
    }
    console.log('✅ Endpoints retrieved successfully.');

    // ─── Test 3: API Keys ──────────────────────────────────────────────────
    console.log('\n--- Test 3: API Key operations ---');
    const rawApiKey = 'whk_pgapikey_12345678'; // 12 pubId prefix characters: whk_pgapikey
    const bcrypt = require('bcrypt');
    const keyHash = bcrypt.hashSync(rawApiKey, 10);
    await adapter.createApiKey(orgId, rawApiKey, keyHash);
    console.log('✅ API Key created.');

    const keyOrgId = await adapter.getOrgIdByKey(rawApiKey);
    if (keyOrgId !== orgId) {
      throw new Error(`API key lookup orgId mismatch. Expected: ${orgId}, Got: ${keyOrgId}`);
    }
    console.log('✅ API Key lookup matched correct org ID.');

    // ─── Test 4: Deliveries and Capping ────────────────────────────────────
    console.log('\n--- Test 4: Delivery Logs & Log Capping ---');
    const del1 = {
      id: 'del_pg_001',
      endpointId,
      url: endpointData.url,
      event: 'order.created',
      payloadId: 'evt_001',
      payload: { id: 1 },
      headers: { 'content-type': 'application/json' },
      attempt: 1,
      timestamp: new Date().toISOString(),
      status: 'delivered',
      responseTime: 20,
      responseBody: 'success',
      error: null
    };

    await adapter.addDelivery(orgId, del1);
    console.log('✅ Initial delivery added.');

    const deliveries = await adapter.getDeliveries(orgId);
    if (deliveries.length !== 1 || deliveries[0].id !== 'del_pg_001') {
      throw new Error('Failed to retrieve deliveries.');
    }
    console.log('✅ Deliveries retrieved.');

    // Test Capping: insert 205 deliveries and verify it caps at 200
    console.log('Inserting 205 delivery records to test auto-capping log rules...');
    for (let i = 0; i < 205; i++) {
      await adapter.addDelivery(orgId, {
        ...del1,
        id: `del_pg_cap_${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString()
      });
    }

    const cappedList = await adapter.getDeliveries(orgId);
    console.log(`✅ Deliveries list length: ${cappedList.length} (Expected: 200)`);
    if (cappedList.length !== 200) {
      throw new Error(`Log capping failed. Expected 200 records, got ${cappedList.length}`);
    }

    // ─── Test 5: Sessions ──────────────────────────────────────────────────
    console.log('\n--- Test 5: User Session lifecycle ---');
    const sessId = 'sess_pg_session_token';
    const expiresAt = new Date(Date.now() + 60000).toISOString(); // 1 min future
    await adapter.createSession(sessId, orgId, expiresAt);
    console.log('✅ Session created.');

    const session = await adapter.getSession(sessId);
    if (!session || session.orgId !== orgId) {
      throw new Error('Session retrieval failed.');
    }
    console.log('✅ Session retrieved successfully.');

    await adapter.deleteSession(sessId);
    const deletedSession = await adapter.getSession(sessId);
    if (deletedSession) {
      throw new Error('Session was not deleted.');
    }
    console.log('✅ Session invalidated and deleted.');

    // ─── Test 6: Queue Lanes (FOR UPDATE SKIP LOCKED) ───────────────────────
    console.log('\n--- Test 6: Priority Queue operations ---');
    const task1 = { type: 'replay', deliveryId: 'del_pg_001', orgId };
    const task2 = { type: 'retry', endpointId, attempt: 2 };

    await adapter.enqueueLowPriority(task1);
    await adapter.scheduleDelayed(task2, Date.now() + 500); // 500ms delay
    console.log('✅ Active and Delayed tasks scheduled.');

    // Try popping active task
    const poppedActive = await adapter.popLowPriorityTask();
    if (!poppedActive || poppedActive.type !== 'replay') {
      throw new Error('Failed to pop active queue task.');
    }
    console.log('✅ Popped active task successfully.');

    const poppedBeforeDelay = await adapter.popLowPriorityTask();
    if (poppedBeforeDelay) {
      throw new Error('Task popped before execute delay timestamp elapsed.');
    }
    console.log('✅ Delayed task remained in scheduled state.');

    // Wait and poll
    await sleep(600);
    await adapter.pollDelayedTasks(Date.now());
    console.log('Polled delayed tasks.');

    const poppedAfterDelay = await adapter.popLowPriorityTask();
    if (!poppedAfterDelay || poppedAfterDelay.type !== 'retry') {
      throw new Error('Delayed task was not migrated or popped successfully.');
    }
    console.log('✅ Popped delayed retry task successfully after timestamp elapsed.');

    // Clean up
    console.log('\n--- Test 7: Cleanup ---');
    await adapter.clearDeliveries(orgId);
    await adapter.removeEndpoint(orgId, endpointId);
    await adapter.close();

    console.log('\n========================================================');
    console.log('🎉 ALL POSTGRESQL PERSISTENCE ADAPTER TESTS PASSED!');
    console.log('========================================================');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ POSTGRESQL ADAPTER TESTS FAILED:', err);
    try {
      await adapter.close();
    } catch {}
    process.exit(1);
  }
}

// ─── Database Mock Pool class definition ────────────────────────────────────
class MockPool {
  constructor() {
    this.queryHistory = [];
    this.organizations = [];
    this.apiKeys = [];
    this.sessions = [];
    this.endpoints = [];
    this.deliveries = [];
    this.queueTasks = [];
    this.autoIncrement = 1;
  }

  async query(sql, params = []) {
    this.queryHistory.push({ sql, params });
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // 1. Bootstrapping
    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('--') || (normalized.startsWith('INSERT INTO organizations') && params.length === 0)) {
      if (normalized.includes('org_dev_default')) {
        this.organizations.push({
          id: 'org_dev_default',
          ownerEmail: 'admin@localhost',
          razorpayCustomerId: 'cust_mock',
          razorpaySubscriptionId: 'sub_mock',
          planTier: 'pro',
          subscriptionStatus: 'active',
          monthlyUsageCount: 0,
          quotaResetDate: '2026-07-14T10:27:26.316Z'
        });
      }
      return { rows: [] };
    }

    // 2. getOrganization
    if (normalized.startsWith('SELECT * FROM organizations WHERE id = $1')) {
      const org = this.organizations.find(o => o.id === params[0]);
      return { rows: org ? [org] : [] };
    }

    // 3. saveOrganization
    if (normalized.startsWith('INSERT INTO organizations')) {
      const [id, ownerEmail, razorpayCustomerId, razorpaySubscriptionId, planTier, subscriptionStatus, monthlyUsageCount, quotaResetDate] = params;
      const existingIdx = this.organizations.findIndex(o => o.id === id);
      const data = { id, ownerEmail, razorpayCustomerId, razorpaySubscriptionId, planTier, subscriptionStatus, monthlyUsageCount, quotaResetDate };
      if (existingIdx !== -1) {
        this.organizations[existingIdx] = data;
      } else {
        this.organizations.push(data);
      }
      return { rows: [] };
    }

    // 4. getOrganizationBySubscriptionId
    if (normalized.startsWith('SELECT * FROM organizations WHERE "razorpaySubscriptionId" = $1')) {
      const org = this.organizations.find(o => o.razorpaySubscriptionId === params[0]);
      return { rows: org ? [org] : [] };
    }

    // 5. updateOrganizationSubscription
    if (normalized.startsWith('UPDATE organizations SET')) {
      const subId = params[0];
      const org = this.organizations.find(o => o.razorpaySubscriptionId === subId);
      if (org) {
        org.planTier = params[1] || org.planTier;
        org.subscriptionStatus = params[2] || org.subscriptionStatus;
      }
      return { rows: [] };
    }

    // 6. getOrgIdByKey
    if (normalized.startsWith('SELECT "orgId" FROM "apiKeys" WHERE "pubId" = $1')) {
      const key = this.apiKeys.find(k => k.pubId === params[0]);
      return { rows: key ? [key] : [] };
    }

    // 7. createApiKey
    if (normalized.startsWith('INSERT INTO "apiKeys"')) {
      const [pubId, hash, orgId, createdAt] = params;
      this.apiKeys.push({ pubId, hash, orgId, createdAt });
      return { rows: [] };
    }

    // 8. getEndpoints
    if (normalized.startsWith('SELECT * FROM endpoints WHERE "orgId" = $1')) {
      const list = this.endpoints.filter(e => e.orgId === params[0]);
      return { rows: list };
    }

    // 9. saveEndpoint
    if (normalized.startsWith('INSERT INTO endpoints')) {
      const [id, orgId, url, secret, events, active, createdAt] = params;
      const existingIdx = this.endpoints.findIndex(e => e.id === id);
      const data = { id, orgId, url, secret, events: JSON.parse(events), active, createdAt };
      if (existingIdx !== -1) {
        this.endpoints[existingIdx] = data;
      } else {
        this.endpoints.push(data);
      }
      return { rows: [] };
    }

    // 10. removeEndpoint
    if (normalized.startsWith('DELETE FROM endpoints WHERE id = $1')) {
      this.endpoints = this.endpoints.filter(e => !(e.id === params[0] && e.orgId === params[1]));
      return { rows: [] };
    }

    // 11. addDelivery
    if (normalized.startsWith('INSERT INTO deliveries')) {
      const [id, orgId, endpointId, url, event, payloadId, payload, headers, attempt, timestamp, status, responseTime, responseBody, error] = params;
      this.deliveries.push({
        id, orgId, endpointId, url, event, payloadId,
        payload: JSON.parse(payload), headers: JSON.parse(headers),
        attempt, timestamp, status, responseTime, responseBody, error
      });
      return { rows: [] };
    }

    // 12. getDeliveries
    if (normalized.startsWith('SELECT * FROM deliveries WHERE "orgId" = $1')) {
      const list = this.deliveries.filter(d => d.orgId === params[0]);
      return { rows: list };
    }

    // 13. Maintain 200 delivery cap
    if (normalized.startsWith('DELETE FROM deliveries WHERE "orgId" = $1 AND id NOT IN')) {
      const orgId = params[0];
      const orgDeliveries = this.deliveries.filter(d => d.orgId === orgId);
      if (orgDeliveries.length > 200) {
        // keep the newest 200
        const toKeep = orgDeliveries.slice(-200);
        this.deliveries = this.deliveries.filter(d => d.orgId !== orgId).concat(toKeep);
      }
      return { rows: [] };
    }

    // 14. createSession
    if (normalized.startsWith('INSERT INTO sessions')) {
      const [sessionId, orgId, expiresAt] = params;
      this.sessions.push({ sessionId, orgId, expiresAt });
      return { rows: [] };
    }

    // 15. getSession
    if (normalized.startsWith('SELECT * FROM sessions WHERE "sessionId" = $1')) {
      const session = this.sessions.find(s => s.sessionId === params[0]);
      return { rows: session ? [session] : [] };
    }

    // 16. deleteSession
    if (normalized.startsWith('DELETE FROM sessions WHERE "sessionId" = $1')) {
      this.sessions = this.sessions.filter(s => s.sessionId !== params[0]);
      return { rows: [] };
    }

    // 17. enqueueLowPriority
    if (normalized.startsWith('INSERT INTO queue_tasks (task, "executeAt", status) VALUES ($1, 0, \'active\')')) {
      this.queueTasks.push({
        id: this.autoIncrement++,
        task: JSON.parse(params[0]),
        executeAt: 0,
        status: 'active'
      });
      return { rows: [] };
    }

    // 18. scheduleDelayed
    if (normalized.startsWith('INSERT INTO queue_tasks (task, "executeAt", status) VALUES ($1, $2, \'delayed\')')) {
      this.queueTasks.push({
        id: this.autoIncrement++,
        task: JSON.parse(params[0]),
        executeAt: params[1],
        status: 'delayed'
      });
      return { rows: [] };
    }

    // 19. pollDelayedTasks
    if (normalized.startsWith('UPDATE queue_tasks SET status = \'active\' WHERE status = \'delayed\' AND "executeAt" <= $1')) {
      const now = params[0];
      this.queueTasks.forEach(t => {
        if (t.status === 'delayed' && t.executeAt <= now) {
          t.status = 'active';
        }
      });
      return { rows: [] };
    }

    // 20. popLowPriorityTask
    if (normalized.includes('FOR UPDATE SKIP LOCKED') && normalized.includes('DELETE FROM queue_tasks')) {
      const activeTaskIdx = this.queueTasks.findIndex(t => t.status === 'active');
      if (activeTaskIdx !== -1) {
        const [taskRecord] = this.queueTasks.splice(activeTaskIdx, 1);
        return { rows: [{ task: taskRecord.task }] };
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  async end() {
    return Promise.resolve();
  }
}

runTests();
