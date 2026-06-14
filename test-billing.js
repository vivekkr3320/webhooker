'use strict';

const http = require('http');
const PORT = process.env.PORT || 4000;
const db   = require('./src/db');

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

async function runTests() {
  console.log('🚀 Starting SaaS Billing & Multi-Tenant Integration Tests...');

  let testEmail = `developer_${Date.now()}@test.io`;
  let apiKey = '';
  let orgId = '';

  // Test 1: Onboard a new organization
  console.log('\n--- Test 1: Onboarding New Organization ---');
  const onboardRes = await request('/api/onboard', 'POST', {}, { email: testEmail });
  if (onboardRes.statusCode === 200 && onboardRes.body.apiKey) {
    apiKey = onboardRes.body.apiKey;
    orgId = onboardRes.body.orgId;
    console.log(`✅ Onboard successful! OrgId: ${orgId}, API Key: ${apiKey.slice(0, 12)}...`);
  } else {
    console.error('❌ Onboarding failed:', onboardRes);
    process.exit(1);
  }

  // Test 2: Verify API Key Access to Stats
  console.log('\n--- Test 2: Verify Authenticated Stats Access ---');
  const statsRes = await request('/api/stats', 'GET', { 'X-API-Key': apiKey });
  if (statsRes.statusCode === 200 && statsRes.body.planTier === 'free') {
    console.log(`✅ Stats authenticated! Plan Tier is: ${statsRes.body.planTier}`);
  } else {
    console.error('❌ Stats authentication failed:', statsRes);
    process.exit(1);
  }

  // Test 3: Initialize Mock Checkout
  console.log('\n--- Test 3: Initialize Billing Checkout ---');
  const checkoutRes = await request('/api/billing/checkout', 'POST', { 'X-API-Key': apiKey }, { planId: 'plan_pro_002' });
  let subscriptionId = '';
  if (checkoutRes.statusCode === 200 && checkoutRes.body.subscriptionId) {
    subscriptionId = checkoutRes.body.subscriptionId;
    console.log(`✅ Checkout initialized! Subscription ID: ${subscriptionId}`);
  } else {
    console.error('❌ Checkout initialization failed:', checkoutRes);
    process.exit(1);
  }

  // Test 4: Simulate Razorpay subscription.activated webhook
  console.log('\n--- Test 4: Simulate subscription.activated Webhook ---');
  const activatedRes = await request('/api/billing/simulate', 'POST', {}, {
    event: 'subscription.activated',
    subscriptionId: subscriptionId,
    planId: 'plan_pro_002'
  });
  if (activatedRes.statusCode === 200 && activatedRes.body.success) {
    console.log('✅ subscription.activated simulated successfully.');
  } else {
    console.error('❌ subscription.activated simulation failed:', activatedRes);
    process.exit(1);
  }

  // Verify DB update
  console.log('Verifying upgraded state in database...');
  const verifyStatsRes = await request('/api/stats', 'GET', { 'X-API-Key': apiKey });
  if (verifyStatsRes.statusCode === 200 && verifyStatsRes.body.planTier === 'pro' && verifyStatsRes.body.subscriptionStatus === 'active') {
    console.log('✅ DB updated successfully: Tier upgraded to "pro", status active.');
  } else {
    console.error('❌ Upgraded DB state mismatch:', verifyStatsRes);
    process.exit(1);
  }

  // Test 5: Simulate subscription.halted webhook (payment decline)
  console.log('\n--- Test 5: Simulate subscription.halted Webhook ---');
  const haltedRes = await request('/api/billing/simulate', 'POST', {}, {
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

  // Verify Halted Pipeline Block
  console.log('Verifying pipeline block (403 suspended check)...');
  const sendRes = await request('/api/send', 'POST', { 'X-API-Key': apiKey }, { event: 'test.event', data: {} });
  if (sendRes.statusCode === 403 && sendRes.body.error === 'Subscription Suspended') {
    console.log('✅ quotaGate working: Blocked send on halted subscription (403 Forbidden).');
  } else {
    console.error('❌ Quota check failed to block suspended subscription:', sendRes);
    process.exit(1);
  }

  // Test 6: Simulate subscription.cancelled webhook
  console.log('\n--- Test 6: Simulate subscription.cancelled Webhook ---');
  const cancelledRes = await request('/api/billing/simulate', 'POST', {}, {
    event: 'subscription.cancelled',
    subscriptionId: subscriptionId,
    planId: 'plan_pro_002'
  });
  if (cancelledRes.statusCode === 200) {
    console.log('✅ subscription.cancelled simulated successfully.');
  } else {
    console.error('❌ subscription.cancelled simulation failed:', cancelledRes);
    process.exit(1);
  }

  // Verify Degradation to free
  console.log('Verifying plan degradation to free...');
  const finalStatsRes = await request('/api/stats', 'GET', { 'X-API-Key': apiKey });
  if (finalStatsRes.statusCode === 200 && finalStatsRes.body.planTier === 'free') {
    console.log('✅ DB downgraded organization plan to "free" correctly.');
  } else {
    console.error('❌ Failed to degrade organization plan on cancel:', finalStatsRes);
    process.exit(1);
  }

  console.log('\n========================================================');
  console.log('🎉 ALL SAAS MULTI-TENANT INTEGRATION TESTS PASSED!');
  console.log('========================================================');
}

runTests().catch(err => {
  console.error('Test run failed with error:', err);
  process.exit(1);
});
