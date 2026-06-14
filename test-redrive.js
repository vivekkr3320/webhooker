'use strict';

const http = require('http');
const PORT = process.env.PORT || 4000;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    
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

    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('🚀 Starting Bulk Replay & Redrive Security Tests...');

  const tenant1Email = `redrive_t1_${Date.now()}@test.io`;
  const tenant2Email = `redrive_t2_${Date.now()}@test.io`;

  let t1ApiKey = '';
  let t1OrgId = '';
  let t2ApiKey = '';
  let t2OrgId = '';

  // 1. Onboard Tenant 1
  console.log('\n--- Step 1: Onboarding Tenant 1 ---');
  const t1Onboard = await request('POST', '/api/onboard', { email: tenant1Email });
  if (t1Onboard.statusCode === 200 && t1Onboard.body.apiKey) {
    t1ApiKey = t1Onboard.body.apiKey;
    t1OrgId = t1Onboard.body.orgId;
    console.log(`✅ Tenant 1 onboarded. OrgId: ${t1OrgId}`);
  } else {
    throw new Error(`Tenant 1 onboarding failed: ${JSON.stringify(t1Onboard)}`);
  }

  // 2. Onboard Tenant 2
  console.log('\n--- Step 2: Onboarding Tenant 2 ---');
  const t2Onboard = await request('POST', '/api/onboard', { email: tenant2Email });
  if (t2Onboard.statusCode === 200 && t2Onboard.body.apiKey) {
    t2ApiKey = t2Onboard.body.apiKey;
    t2OrgId = t2Onboard.body.orgId;
    console.log(`✅ Tenant 2 onboarded. OrgId: ${t2OrgId}`);
  } else {
    throw new Error(`Tenant 2 onboarding failed: ${JSON.stringify(t2Onboard)}`);
  }

  // 3. Register Offline Endpoints for Tenant 1
  console.log('\n--- Step 3: Registering endpoints for Tenant 1 ---');
  const ep1 = await request('POST', '/api/endpoints', {
    id: 'ep-fail-1',
    url: 'http://localhost:9999/offline-dest-1',
    description: 'Failing endpoint 1'
  }, { 'X-API-Key': t1ApiKey });

  const ep2 = await request('POST', '/api/endpoints', {
    id: 'ep-fail-2',
    url: 'http://localhost:9999/offline-dest-2',
    description: 'Failing endpoint 2'
  }, { 'X-API-Key': t1ApiKey });

  if (ep1.statusCode === 200 && ep2.statusCode === 200) {
    console.log('✅ Endpoints registered successfully.');
  } else {
    throw new Error(`Endpoint registration failed. Ep1: ${ep1.statusCode}, Ep2: ${ep2.statusCode}`);
  }

  // 4. Fire Webhook Event to Generate Failed Deliveries
  console.log('\n--- Step 4: Dispatching event to trigger failed deliveries ---');
  const sendRes = await request('POST', '/api/send', {
    event: 'order.created',
    data: { orderId: 'ord_xyz' }
  }, { 'X-API-Key': t1ApiKey });

  if (sendRes.statusCode === 200) {
    console.log('✅ Webhook dispatch requested.');
  } else {
    throw new Error(`Dispatch failed: ${sendRes.statusCode}`);
  }

  // Wait for delivery timeouts
  console.log('Waiting for timeouts to write to logs database...');
  await new Promise(r => setTimeout(r, 1200));

  // 5. Query Logs to Extract Log IDs
  console.log('\n--- Step 5: Querying Tenant 1 delivery logs ---');
  const logsRes = await request('GET', '/api/logs', null, { 'X-API-Key': t1ApiKey });
  if (logsRes.statusCode !== 200 || !Array.isArray(logsRes.body) || logsRes.body.length < 2) {
    throw new Error(`Expected at least 2 logs. Got: ${JSON.stringify(logsRes.body)}`);
  }

  const log1 = logsRes.body.find(l => l.endpointId === 'ep-fail-1');
  const log2 = logsRes.body.find(l => l.endpointId === 'ep-fail-2');

  if (!log1 || !log2) {
    throw new Error('Logs for ep-fail-1 and ep-fail-2 not found.');
  }
  console.log(`✅ Found failed logs. Log 1: ${log1.id}, Log 2: ${log2.id}`);

  // 6. Test IDOR Tenant Isolation Rejection (Tenant 2 trying to replay Tenant 1's log)
  console.log('\n--- Step 6: Testing IDOR protection (Tenant 2 replaying Tenant 1 log) ---');
  const idorRes1 = await request('POST', `/api/logs/${log1.id}/replay`, null, { 'X-API-Key': t2ApiKey });
  if (idorRes1.statusCode === 404) {
    console.log('✅ Single replay IDOR correctly rejected with 404 Not Found');
  } else {
    throw new Error(`Expected 404 for IDOR single replay, got: ${idorRes1.statusCode}`);
  }

  const idorRes2 = await request('POST', '/api/logs/bulk-replay', {
    deliveryIds: [log1.id, log2.id]
  }, { 'X-API-Key': t2ApiKey });

  if (idorRes2.statusCode === 404) {
    console.log('✅ Bulk replay IDOR correctly rejected with 404 Not Found');
  } else {
    throw new Error(`Expected 404 for IDOR bulk replay, got: ${idorRes2.statusCode}`);
  }

  // 7. Verify Checkbox Bulk Redrive (Tenant 1 redriving own logs explicitly)
  console.log('\n--- Step 7: Performing checkbox redrive for selected items ---');
  const bulkRes = await request('POST', '/api/logs/bulk-replay', {
    deliveryIds: [log1.id, log2.id]
  }, { 'X-API-Key': t1ApiKey });

  if (bulkRes.statusCode === 200 && bulkRes.body.success && bulkRes.body.count === 2) {
    console.log('✅ Bulk redrive successful! Count:', bulkRes.body.count);
  } else {
    throw new Error(`Bulk redrive failed: ${JSON.stringify(bulkRes.body)}`);
  }

  // 8. Verify Filter-Based Bulk Redrive (Tenant 1 redriving filtered by endpoint-1)
  console.log('\n--- Step 8: Performing filter-based redrive (Filter: endpoint-1) ---');
  const filterRes = await request('POST', '/api/logs/bulk-replay', {
    endpointId: 'ep-fail-1'
  }, { 'X-API-Key': t1ApiKey });

  if (filterRes.statusCode === 200 && filterRes.body.success) {
    console.log(`✅ Filter bulk redrive triggered successfully. Count: ${filterRes.body.count}`);
  } else {
    throw new Error(`Filter bulk redrive failed: ${JSON.stringify(filterRes.body)}`);
  }

  // 9. Verify DLQ Mass Redrive (POST /api/logs/bulk-retry)
  console.log('\n--- Step 9: Testing DLQ Mass Redrive (/api/logs/bulk-retry) ---');
  const now = Date.now();
  const startTime = new Date(now - 120000).toISOString(); // 2 minutes ago
  const endTime = new Date(now + 120000).toISOString();   // 2 minutes from now

  const dlqRes = await request('POST', '/api/logs/bulk-retry', {
    startTime,
    endTime,
    endpointId: 'ep-fail-1'
  }, { 'X-API-Key': t1ApiKey });

  if (dlqRes.statusCode === 200 && dlqRes.body.success) {
    console.log(`✅ DLQ Mass Redrive successful! Count queued in background: ${dlqRes.body.count}`);
  } else {
    throw new Error(`DLQ Mass Redrive failed: ${JSON.stringify(dlqRes.body)}`);
  }

  // 10. Verify IDOR on DLQ Mass Redrive
  console.log('\n--- Step 10: Testing IDOR protection on DLQ Mass Redrive ---');
  const idorDlq = await request('POST', '/api/logs/bulk-retry', {
    startTime,
    endTime
  }, { 'X-API-Key': t2ApiKey });

  if (idorDlq.statusCode === 200 && idorDlq.body.success && idorDlq.body.count === 0) {
    console.log('✅ DLQ Mass Redrive correctly isolated cross-tenant logs (count is 0 for Tenant 2)');
  } else {
    throw new Error(`Expected count 0 for Tenant 2 bulk-retry, got: ${JSON.stringify(idorDlq.body)}`);
  }

  console.log('\n========================================================');
  console.log('🎉 ALL BULK REDRIVE, DLQ AND SECURITY TESTS PASSED!');
  console.log('========================================================');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
