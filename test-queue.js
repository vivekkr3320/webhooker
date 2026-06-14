'use strict';

const WebhookEngine = require('./src/WebhookEngine');
const db = require('./src/db');
const logger = require('./src/logger');

// Setup a small helper to delay execution in tests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
  console.log('🚀 Starting Persistent Queue Integration Tests...');
  const orgId = 'org_queue_test';
  
  // Ensure the test organization exists in DB
  try {
    const existing = await db.getOrganization(orgId);
    if (!existing) {
      await db.saveOrganization(orgId, {
        ownerEmail: 'queue_test@company.com',
        planTier: 'free',
        subscriptionStatus: 'active',
        monthlyUsageCount: 0
      });
    }
  } catch (err) {
    console.error('Failed to bootstrap test organization:', err.message);
  }

  // 1. Instantiate WebhookEngine with rapid retry interval (1s) and worker check rate
  const engine = new WebhookEngine({
    secret: 'whsec_queuetestsecret',
    maxRetries: 3,
    retryDelays: [1, 2, 3], // 1 second, 2 seconds, 3 seconds
    workerPollInterval: 500, // Check database every 500ms
  });

  try {
    // 2. Register mock endpoints
    console.log('\n1. Registering endpoints...');
    const epSuccessId = 'ep-ok';
    const epFailId = 'ep-fail';
    
    // We will register a listener on localhost which we know will fail immediately if no server is there, or mock it.
    // Let's register standard endpoints.
    engine.register(orgId, epSuccessId, 'http://localhost:9999/ok', { events: ['*'] });
    engine.register(orgId, epFailId, 'http://localhost:9999/fail-endpoint', { events: ['*'] });

    // Mock the HTTP request handler in engine to avoid hitting real ports and control the success/fail states
    const originalRequest = engine._request;
    engine._request = async (url, body, signature, headers, payloadId, endpointId) => {
      await sleep(50); // Simulate network roundtrip latency
      if (url.includes('/ok')) {
        return { ok: true, statusCode: 200, responseTime: 10, body: 'OK Response' };
      } else {
        return { ok: false, statusCode: 500, responseTime: 15, body: 'Internal Error' };
      }
    };

    // 3. Verify Replay Task Enqueuing & Execution
    console.log('\n2. Verifying Replay Task enqueuing...');
    
    // Add a fake delivery log to database so we can replay it
    const mockDeliveryId = 'del_mock_123';
    const mockDelivery = {
      id: mockDeliveryId,
      endpointId: epSuccessId,
      url: 'http://localhost:9999/ok',
      event: 'test.replay',
      payloadId: 'evt_mock_123',
      replayData: { key: 'value' },
      attempt: 1,
      timestamp: new Date().toISOString(),
      status: 'failed',
    };
    
    await db.addDelivery(orgId, mockDelivery);

    let replayCompleted = false;
    engine.on('delivery:success', (delivery) => {
      if (delivery.payloadId === 'evt_mock_123' && delivery.attempt === 2) {
        console.log('✅ Replay task successfully popped, executed, and completed delivery!');
        replayCompleted = true;
      }
    });

    console.log('Triggering engine.replay()...');
    await engine.replay(orgId, mockDeliveryId);

    // Wait for worker loop to pick it up and process
    await sleep(1200);

    if (!replayCompleted) {
      throw new Error('Replay task was not executed by background worker loop.');
    }

    // 4. Verify Delayed Retry Scheduling & Execution
    console.log('\n3. Verifying Delayed Retry queue scheduling...');
    
    let retryScheduled = false;
    let retryExecuted = false;

    engine.on('delivery:retry_scheduled', (retry) => {
      if (retry.endpointId === epFailId) {
        console.log(`✅ Retry scheduled correctly: attempt=${retry.attempt}, delay=${retry.delaySec}s`);
        retryScheduled = true;
      }
    });

    engine.on('delivery:attempt', (delivery) => {
      if (delivery.endpointId === epFailId && delivery.attempt === 2) {
        console.log('✅ Retry attempt 2 popped and executed by background queue worker!');
        retryExecuted = true;
      }
    });

    console.log('Triggering failed event send (should trigger failure and schedule retry)...');
    await engine.send(orgId, 'order.failed', { amount: 100 });

    // Wait a brief moment to check if retry was scheduled
    await sleep(400);
    if (!retryScheduled) {
      throw new Error('Failure did not schedule a retry task.');
    }

    // Now sleep 1.5s to let the 1s delay elapse and background poller process it
    console.log('Waiting for execute timestamp to elapse (1 second)...');
    await sleep(1500);

    if (!retryExecuted) {
      throw new Error('Scheduled retry was not executed after the delay elapsed.');
    }

    // Clean up
    console.log('\n4. Cleaning up...');
    engine.close();
    console.log('✅ Queue worker stopped.');

    console.log('\n========================================================');
    console.log('🎉 ALL PERSISTENT DUAL-LANE QUEUE TESTS PASSED!');
    console.log('========================================================');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ QUEUE INTEGRATION TESTS FAILED:', err);
    engine.close();
    process.exit(1);
  }
}

runTests();
