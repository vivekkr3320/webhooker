'use strict';

const http = require('http');
const crypto = require('crypto');
const WebhookEngine = require('./src/WebhookEngine');
const db = require('./src/db');

async function testSSRFAndHardening() {
  console.log('🏁 Starting Hardening and Security validation...');

  const engine = new WebhookEngine({
    secret: 'test_global_secret',
    maxRetries: 3
  });

  // 1. Verify Unique webhook_secret generation
  console.log('\n--- 1. Testing Webhook Secret Generation ---');
  engine.register('org_test', 'ep_unique_secret', 'https://example.com/webhook');
  const ep = engine.endpoints.get('org_test:ep_unique_secret');
  console.log(`Endpoint generated secret: ${ep.secret}`);
  if (!ep.secret || !ep.secret.startsWith('whsec_')) {
    throw new Error('Endpoint secret was not generated correctly with whsec_ prefix!');
  }
  console.log('✅ Unique secret generated successfully!');

  // 2. Verify SSRF Block deactivation & error logging
  console.log('\n--- 2. Testing SSRF/Loopback Protection ---');
  // Register local subnet URLs
  engine.register('org_test', 'ep_local_localhost', 'http://localhost:8080/callback');
  engine.register('org_test', 'ep_local_ip', 'http://127.0.0.1/callback');

  console.log('Dispatching webhook to localhost (should block)...');
  const resultsLocalhost = await engine.send('org_test', 'user.updated', { test: true });
  console.log('Localhost dispatch results:', JSON.stringify(resultsLocalhost));

  const epLocalhost = engine.endpoints.get('org_test:ep_local_localhost');
  console.log(`Endpoint active state after block: ${epLocalhost.active}`);
  if (epLocalhost.active !== false) {
    throw new Error('Localhost endpoint was not deactivated!');
  }
  console.log('✅ Localhost endpoint successfully blocked and auto-deactivated.');

  console.log('Dispatching webhook to 127.0.0.1 (should block)...');
  const resultsIp = await engine.send('org_test', 'user.updated', { test: true });
  const epIp = engine.endpoints.get('org_test:ep_local_ip');
  if (epIp.active !== false) {
    throw new Error('127.0.0.1 endpoint was not deactivated!');
  }
  console.log('✅ 127.0.0.1 endpoint successfully blocked and auto-deactivated.');

  // 3. Verify Jitter Delay formula
  console.log('\n--- 3. Testing Jittered Exponential Retry calculation ---');
  // Capture retryQueue state during scheduling
  const fakeEndpoint = { id: 'ep_fail', orgId: 'org_test', url: 'http://example.com', active: true };
  const fakePayload = { id: 'evt_123', event: 'test.failed', data: {} };
  
  engine._scheduleRetry(fakeEndpoint, fakePayload, 1); // attempt 1 failed, scheduling attempt 2
  const retryRecord = [...engine._retryQueue.values()][0];
  console.log(`Scheduled delay: ${retryRecord.delaySec} seconds`);
  
  // (5 * 2^1) = 10 + random(0-4) => should be between 10 and 14
  if (retryRecord.delaySec < 10 || retryRecord.delaySec > 14) {
    throw new Error(`Delay out of jitter exponential range! Expected 10-14, got ${retryRecord.delaySec}`);
  }
  console.log('✅ Retry delay contains expected exponential backoff + random jitter.');

  // 4. Verify HMAC Signatures
  console.log('\n--- 4. Testing HMAC Signature Verification ---');
  const testSecret = 'whsec_my_secret';
  const testBody = JSON.stringify({ id: 'evt_sig_test', val: 42 });
  const sigHeader = engine.sign(testBody, testSecret, 'evt_sig_test');
  console.log(`Generated header: ${sigHeader}`);

  const verified = engine.verify(testBody, sigHeader, testSecret);
  if (!verified) {
    throw new Error('HMAC verification failed!');
  }
  console.log('✅ HMAC-SHA256 signature generated and verified successfully.');

  // 5. Verify Consumer Webhook Logs persistence
  console.log('\n--- 5. Testing Consumer Webhook Logs (webhook_logs) ---');
  const logs = await db.getWebhookLogs('org_test');
  console.log(`Retrieved ${logs.length} consumer event logs:`);
  logs.forEach(l => {
    console.log(`- [${l.status.toUpperCase()}] ${l.event} to ${l.url} (Error: ${l.error || 'None'})`);
  });

  if (logs.length === 0) {
    throw new Error('No consumer logs found in database!');
  }
  console.log('✅ Consumer logs successfully persisted and queried.');

  console.log('\n🎉 ALL HARDENING INTEGRATION TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

testSSRFAndHardening().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
