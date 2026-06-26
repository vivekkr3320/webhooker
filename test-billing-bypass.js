'use strict';

const http = require('http');
const crypto = require('crypto');
const PORT = process.env.PORT || 4000;
const db   = require('./src/db');
const WebhookEngine = require('./src/WebhookEngine');

function request(path, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        } catch {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Spin up a simple local receiver to absorb the successful webhook send
let localReceiverEvent = null;
const express = require('express');
const receiverApp = express();
const RECEIVER_PORT = 4098;
receiverApp.use(express.json());
receiverApp.post('/webhook-target', (req, res) => {
  localReceiverEvent = req.body;
  res.status(200).json({ status: 'received' });
});
const receiverServer = receiverApp.listen(RECEIVER_PORT, () => {
  console.log(`Local webhook receiver running on port ${RECEIVER_PORT}`);
});

async function runTests() {
  console.log('🚀 Starting Billing Bypass Loophole Verification Tests...');

  let testEmail = `delinquent_dev_${Date.now()}@test.io`;
  let apiKey = '';
  let orgId = '';
  let endpointId = 'ep-billing-bypass-test';

  // 1. Onboard organization
  console.log('\n--- 1. Onboarding organization ---');
  const onboardRes = await request('/api/onboard', 'POST', {}, { email: testEmail });
  if (onboardRes.statusCode === 200 && onboardRes.body.apiKey) {
    apiKey = onboardRes.body.apiKey;
    orgId = onboardRes.body.orgId;
    console.log(`✅ Onboard successful! OrgId: ${orgId}`);
  } else {
    console.error('❌ Onboarding failed:', onboardRes);
    process.exit(1);
  }

  // 2. Initialize checkout
  console.log('\n--- 2. Initializing billing checkout for pro ---');
  const checkoutRes = await request('/api/billing/checkout', 'POST', { 'X-API-Key': apiKey }, { planId: 'plan_pro_002' });
  let subscriptionId = '';
  if (checkoutRes.statusCode === 200 && checkoutRes.body.subscriptionId) {
    subscriptionId = checkoutRes.body.subscriptionId;
    console.log(`✅ Checkout initialized! Subscription ID: ${subscriptionId}`);
  } else {
    console.error('❌ Checkout initialization failed:', checkoutRes);
    process.exit(1);
  }

  // 3. Upgrade to active
  console.log('\n--- 3. Activating subscription via webhook simulation ---');
  const activatedRes = await request('/api/billing/simulate', 'POST', { 'X-API-Key': apiKey }, {
    event: 'subscription.activated',
    subscriptionId: subscriptionId,
    planId: 'plan_pro_002'
  });
  if (activatedRes.statusCode === 200 && activatedRes.body.success) {
    console.log('✅ Subscription activated.');
  } else {
    console.error('❌ Activation simulation failed:', activatedRes);
    process.exit(1);
  }

  // 4. Register a valid endpoint pointing to local receiver
  console.log('\n--- 4. Registering test endpoint ---');
  const regRes = await request('/api/endpoints', 'POST', { 'X-API-Key': apiKey }, {
    id: endpointId,
    url: `http://localhost:${RECEIVER_PORT}/webhook-target`,
    events: ['*']
  });
  if (regRes.statusCode === 200 && regRes.body.success) {
    console.log('✅ Endpoint registered.');
  } else {
    console.error('❌ Endpoint registration failed:', regRes);
    process.exit(1);
  }

  // 5. Send event under active status (should deliver successfully)
  console.log('\n--- 5. Sending test event under active status ---');
  const sendRes = await request('/api/send', 'POST', { 'X-API-Key': apiKey }, {
    event: 'order.placed',
    data: { orderId: '9999' }
  });
  let initialLogId = '';
  if (sendRes.statusCode === 200 && sendRes.body.success) {
    console.log('✅ Event sent successfully. Results:', JSON.stringify(sendRes.body.results));
    // Fetch logs to extract a valid log ID
    const logsRes = await request('/api/logs', 'GET', { 'X-API-Key': apiKey });
    if (logsRes.statusCode === 200 && logsRes.body.length > 0) {
      initialLogId = logsRes.body[0].id;
      console.log(`✅ Extracted delivery log ID: ${initialLogId}`);
    } else {
      console.error('❌ Failed to fetch logs:', logsRes);
      process.exit(1);
    }
  } else {
    console.error('❌ Send event failed:', sendRes);
    process.exit(1);
  }

  // 6. Simulate payment failure (subscription.halted)
  console.log('\n--- 6. Simulating subscription suspension (halted) ---');
  const haltedRes = await request('/api/billing/simulate', 'POST', { 'X-API-Key': apiKey }, {
    event: 'subscription.halted',
    subscriptionId: subscriptionId,
    planId: 'plan_pro_002'
  });
  if (haltedRes.statusCode === 200) {
    console.log('✅ subscription.halted simulated successfully.');
  } else {
    console.error('❌ subscription.halted simulation failed:', haltedRes);
    process.exit(1);
  }

  // Verify status is halted
  console.log('Verifying status in database stats...');
  const verifyStatsRes = await request('/api/stats', 'GET', { 'X-API-Key': apiKey });
  if (verifyStatsRes.statusCode === 200 && verifyStatsRes.body.subscriptionStatus === 'halted') {
    console.log('✅ Verified: status is "halted".');
  } else {
    console.error('❌ Status is not halted:', verifyStatsRes);
    process.exit(1);
  }

  // 7. Verify single replay route is blocked with HTTP 402
  console.log('\n--- 7. Testing single replay route on delinquent account ---');
  const singleReplayRes = await request(`/api/logs/${initialLogId}/replay`, 'POST', { 'X-API-Key': apiKey });
  if (singleReplayRes.statusCode === 402) {
    console.log('✅ Replay correctly rejected with HTTP 402. Response:', JSON.stringify(singleReplayRes.body));
  } else {
    console.error(`❌ Expected HTTP 402, got ${singleReplayRes.statusCode}:`, singleReplayRes.body);
    process.exit(1);
  }

  // 8. Verify bulk-replay route is blocked with HTTP 402
  console.log('\n--- 8. Testing bulk-replay route on delinquent account ---');
  const bulkReplayRes = await request('/api/logs/bulk-replay', 'POST', { 'X-API-Key': apiKey }, {
    deliveryIds: [initialLogId]
  });
  if (bulkReplayRes.statusCode === 402) {
    console.log('✅ Bulk replay correctly rejected with HTTP 402. Response:', JSON.stringify(bulkReplayRes.body));
  } else {
    console.error(`❌ Expected HTTP 402, got ${bulkReplayRes.statusCode}:`, bulkReplayRes.body);
    process.exit(1);
  }

  // 9. Verify bulk-retry route is blocked with HTTP 402
  console.log('\n--- 9. Testing bulk-retry (DLQ) route on delinquent account ---');
  const bulkRetryRes = await request('/api/logs/bulk-retry', 'POST', { 'X-API-Key': apiKey }, {
    startTime: new Date(Date.now() - 3600000).toISOString(),
    endTime: new Date(Date.now() + 3600000).toISOString()
  });
  if (bulkRetryRes.statusCode === 402) {
    console.log('✅ Bulk retry correctly rejected with HTTP 402. Response:', JSON.stringify(bulkRetryRes.body));
  } else {
    console.error(`❌ Expected HTTP 402, got ${bulkRetryRes.statusCode}:`, bulkRetryRes.body);
    process.exit(1);
  }

  // 10. Verify egress gatekeeper in the WebhookEngine directly (direct method call)
  console.log('\n--- 10. Testing egress gatekeeper directly in WebhookEngine ---');
  const engineInstance = new WebhookEngine({
    secret: 'test-direct-engine-secret',
    maxRetries: 0
  });

  const directEndpoint = {
    id: 'ep-direct-test',
    orgId: orgId,
    url: `http://localhost:${RECEIVER_PORT}/webhook-target`,
    active: true,
    events: ['*']
  };

  const payload = {
    id: 'evt_test_direct',
    event: 'user.signup',
    data: { userId: '123' },
    timestamp: new Date().toISOString()
  };

  try {
    console.log('Triggering engine._deliver with halted organization status...');
    await engineInstance._deliver(directEndpoint, payload);
    console.error('❌ Error: engine._deliver did not throw on delinquent organization status!');
    process.exit(1);
  } catch (err) {
    if (err.message.includes('402 Payment Required')) {
      console.log('✅ Engine correctly threw error:', err.message);
      
      // Let's verify that the dropped event is recorded in delivery logs with status failed and code 402
      const orgDeliveries = await Promise.resolve(db.getDeliveries(orgId));
      const blockedDelivery = orgDeliveries.find(d => d.endpointId === 'ep-direct-test' && d.statusCode === 402);
      if (blockedDelivery && blockedDelivery.status === 'failed') {
        console.log('✅ Verified: Dropped delivery is logged in DB history with statusCode 402 and status "failed".');
      } else {
        console.error('❌ Failed to find blocked delivery log or properties were wrong:', orgDeliveries);
        process.exit(1);
      }
    } else {
      console.error('❌ Threw unexpected error:', err.message);
      process.exit(1);
    }
  }

  console.log('\n========================================================');
  console.log('🎉 ALL BILLING BYPASS INTEGRATION TESTS PASSED!');
  console.log('========================================================');
  
  // Cleanup receiver server
  receiverServer.close(() => {
    process.exit(0);
  });
}

runTests().catch(err => {
  console.error('Test run failed with error:', err);
  process.exit(1);
});
