'use strict';

const http = require('http');
const db = require('./src/db');
const path = require('path');

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

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Helper to manually update database organization stats for testing
async function setMockOrgUsage(orgId, count) {
  const org = await db.getOrganization(orgId);
  if (org) {
    org.monthlyUsageCount = count;
    await db.saveOrganization(orgId, org);
    console.log(`[MOCK] Artificially set org ${orgId} usage to ${count}`);
  } else {
    throw new Error(`Org ${orgId} not found in database`);
  }
}

async function runTests() {
  console.log('🚀 Starting Usage Monitor Integration Tests...');
  const testEmail = `usage_dev_${Date.now()}@company.com`;
  const testPassword = 'pwd123456';
  let sessionCookie = '';
  let orgId = '';
  let apiKey = '';

  try {
    // 1. Sign Up
    console.log(`\n1. Creating user session for ${testEmail}...`);
    const signupRes = await request('POST', '/api/auth/signup', {
      email: testEmail,
      password: testPassword
    });

    if (signupRes.statusCode !== 200 || !signupRes.body.success) {
      throw new Error(`Signup failed: ${JSON.stringify(signupRes.body)}`);
    }

    orgId = signupRes.body.orgId;
    apiKey = signupRes.body.apiKey;
    const signupCookieHeader = signupRes.headers['set-cookie'];
    sessionCookie = signupCookieHeader[0].split(';')[0];
    console.log(`✅ Session cookie acquired. Org ID: ${orgId}`);

    // 2. Fetch Usage (0% Safe State)
    console.log('\n2. Fetching usage statistics (should be 0%)...');
    const usageRes1 = await request('GET', '/api/billing/usage', null, {
      'Cookie': sessionCookie
    });

    if (usageRes1.statusCode !== 200) {
      throw new Error(`Failed to load usage: ${JSON.stringify(usageRes1.body)}`);
    }

    console.log('✅ Usage statistics payload:', JSON.stringify(usageRes1.body));
    if (usageRes1.body.percentageUsed !== 0 || usageRes1.body.monthlyUsageCount !== 0) {
      throw new Error('Initial usage count should be zero');
    }

    // 3. Set Mock Usage to 90% (Warning State)
    console.log('\n3. Incrementing usage mock to 4,500 requests (90% limit)...');
    await setMockOrgUsage(orgId, 4500);

    const usageRes2 = await request('GET', '/api/billing/usage', null, {
      'Cookie': sessionCookie
    });

    if (usageRes2.statusCode !== 200) {
      throw new Error(`Failed to load usage: ${JSON.stringify(usageRes2.body)}`);
    }

    console.log('✅ Usage statistics warning check:', JSON.stringify(usageRes2.body));
    if (usageRes2.body.percentageUsed !== 90.0) {
      throw new Error(`Expected 90% usage. Got: ${usageRes2.body.percentageUsed}%`);
    }

    // 4. Set Mock Usage to 100% (Exhausted State)
    console.log('\n4. Incrementing usage mock to 5,000 requests (100% limit)...');
    await setMockOrgUsage(orgId, 5000);

    const usageRes3 = await request('GET', '/api/billing/usage', null, {
      'Cookie': sessionCookie
    });

    if (usageRes3.statusCode !== 200) {
      throw new Error(`Failed to load usage: ${JSON.stringify(usageRes3.body)}`);
    }

    console.log('✅ Usage statistics exhausted check:', JSON.stringify(usageRes3.body));
    if (usageRes3.body.percentageUsed !== 100.0) {
      throw new Error(`Expected 100% usage. Got: ${usageRes3.body.percentageUsed}%`);
    }

    // 5. Test endpoint blocker (should reject with 402)
    console.log('\n5. Verifying event dispatch blocker (should reject with 402)...');
    const sendRes = await request('POST', '/api/send', {
      event: 'payment.success',
      data: { id: 'evt_123' }
    }, {
      'X-API-Key': apiKey
    });

    if (sendRes.statusCode === 402 && sendRes.body.error === 'Quota Exhausted') {
      console.log('✅ Correctly blocked event dispatch with 402 Payment Required / Quota Exhausted');
    } else {
      throw new Error(`Event dispatch should have failed with 402. Got: ${sendRes.statusCode} - ${JSON.stringify(sendRes.body)}`);
    }

    // 6. Clean up / Logout
    console.log('\n6. Logging out...');
    await request('POST', '/api/auth/logout', null, {
      'Cookie': sessionCookie
    });
    console.log('✅ Logged out.');

    console.log('\n========================================================');
    console.log('🎉 USAGE MONITOR TESTS PASSED SUCCESSFULLY!');
    console.log('========================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ USAGE TESTS FAILED:', err);
    process.exit(1);
  }
}

runTests();
