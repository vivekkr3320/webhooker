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

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('🚀 Starting Subscription Checkout Integration Tests...');
  const testEmail = `billing_dev_${Date.now()}@company.com`;
  const testPassword = 'pwd123456';
  let sessionCookie = '';

  try {
    // 1. Sign Up to get a valid session
    console.log(`\n1. Creating user session for ${testEmail}...`);
    const signupRes = await request('POST', '/api/auth/signup', {
      email: testEmail,
      password: testPassword
    });

    if (signupRes.statusCode !== 200 || !signupRes.body.success) {
      throw new Error(`Signup failed: ${JSON.stringify(signupRes.body)}`);
    }

    const signupCookieHeader = signupRes.headers['set-cookie'];
    if (!signupCookieHeader) {
      throw new Error('No cookie header received on signup!');
    }
    sessionCookie = signupCookieHeader[0].split(';')[0];
    console.log('✅ Session cookie acquired:', sessionCookie);

    // 2. Call create-subscription (unauthenticated - should fail)
    console.log('\n2. Attempting to initialize subscription without session cookie (should fail)...');
    const unauthSub = await request('POST', '/api/billing/create-subscription', {
      planId: 'plan_pro_002'
    });

    if (unauthSub.statusCode === 401) {
      console.log('✅ Correctly rejected unauthenticated request with 401 Unauthorized');
    } else {
      throw new Error(`Unauthenticated request should have failed with 401. Got: ${unauthSub.statusCode} - ${JSON.stringify(unauthSub.body)}`);
    }

    // 3. Call create-subscription (authenticated - should succeed)
    console.log('\n3. Creating Pro subscription with session cookie...');
    const subRes = await request('POST', '/api/billing/create-subscription', {
      planId: 'plan_pro_002'
    }, {
      'Cookie': sessionCookie
    });

    if (subRes.statusCode !== 200 || !subRes.body.success) {
      throw new Error(`Subscription creation failed: ${JSON.stringify(subRes.body)}`);
    }

    console.log('✅ Subscription generated successfully!');
    console.log('   Subscription ID:', subRes.body.subscriptionId);
    console.log('   Razorpay Key ID:', subRes.body.razorpayKeyId);
    console.log('   Is Simulated Mode:', subRes.body.isSimulated);
    console.log('   User Prefill Email:', subRes.body.userEmail);

    if (!subRes.body.subscriptionId.startsWith('sub_')) {
      throw new Error('Subscription ID should start with "sub_"');
    }
    if (subRes.body.userEmail !== testEmail) {
      throw new Error('Prefill email does not match test user email');
    }

    // 4. Verify organization record has subscription ID mapped
    console.log('\n4. Verifying organization record in database maps the subscription ID...');
    const meRes = await request('GET', '/api/auth/me', null, {
      'Cookie': sessionCookie
    });

    if (meRes.statusCode !== 200) {
      throw new Error('Could not fetch org info');
    }

    // Read database.json to verify mapping directly
    const fs = require('fs');
    const path = require('path');
    const dbPath = path.join(__dirname, 'database.json');
    const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const org = dbData.organizations.find(o => o.id === meRes.body.orgId);

    if (org && org.razorpaySubscriptionId === subRes.body.subscriptionId) {
      console.log('✅ Subscription ID successfully mapped in database JSON!');
    } else {
      throw new Error(`Subscription mapping failed in database record: ${JSON.stringify(org)}`);
    }

    // 5. Clean up / Logout
    console.log('\n5. Logging out...');
    await request('POST', '/api/auth/logout', null, {
      'Cookie': sessionCookie
    });
    console.log('✅ Logged out.');

    console.log('\n========================================================');
    console.log('🎉 SUBSCRIPTION CHECKOUT TESTS PASSED SUCCESSFULLY!');
    console.log('========================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ CHECKOUT TESTS FAILED:', err);
    process.exit(1);
  }
}

runTests();
