'use strict';

const http = require('http');

const PORT = process.env.PORT || 4000;
const BASE_URL = `http://localhost:${PORT}`;

// Helper to make HTTP requests and return parsed JSON + headers
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
  console.log('🚀 Starting Authentication Integration Tests...');
  const testEmail = `test_developer_${Date.now()}@company.com`;
  const testPassword = 'supersecretpwd';
  let sessionCookie = '';

  try {
    // 1. Sign Up
    console.log(`\n1. Registering new tenant org: ${testEmail}...`);
    const signupRes = await request('POST', '/api/auth/signup', {
      email: testEmail,
      password: testPassword
    });

    if (signupRes.statusCode !== 200 || !signupRes.body.success) {
      throw new Error(`Signup failed: ${JSON.stringify(signupRes.body)}`);
    }
    console.log('✅ Signup success! Received raw key:', signupRes.body.apiKey);

    // Extract cookie
    const signupCookieHeader = signupRes.headers['set-cookie'];
    if (!signupCookieHeader || signupCookieHeader.length === 0) {
      throw new Error('No Set-Cookie header received on signup!');
    }
    sessionCookie = signupCookieHeader[0].split(';')[0];
    console.log('✅ Session cookie extracted from signup:', sessionCookie);

    // 2. Duplicate Registration Rejection
    console.log('\n2. Attempting duplicate signup (should fail)...');
    const dupRes = await request('POST', '/api/auth/signup', {
      email: testEmail,
      password: testPassword
    });

    if (dupRes.statusCode === 400 && dupRes.body.error === 'Email is already registered') {
      console.log('✅ Duplicate signup rejected correctly with 400 Bad Request');
    } else {
      throw new Error(`Duplicate signup should have failed with 400. Got: ${dupRes.statusCode} - ${JSON.stringify(dupRes.body)}`);
    }

    // 3. Login with Wrong Password
    console.log('\n3. Logging in with wrong password (should fail)...');
    const wrongLogin = await request('POST', '/api/auth/login', {
      email: testEmail,
      password: 'wrongpassword'
    });

    if (wrongLogin.statusCode === 401 && wrongLogin.body.error === 'Invalid email or password') {
      console.log('✅ Invalid password rejected correctly with 401 Unauthorized');
    } else {
      throw new Error(`Invalid password should have failed with 401. Got: ${wrongLogin.statusCode} - ${JSON.stringify(wrongLogin.body)}`);
    }

    // 4. Login with Correct Credentials
    console.log('\n4. Logging in with correct credentials...');
    const loginRes = await request('POST', '/api/auth/login', {
      email: testEmail,
      password: testPassword
    });

    if (loginRes.statusCode !== 200 || !loginRes.body.success) {
      throw new Error(`Correct login failed: ${JSON.stringify(loginRes.body)}`);
    }
    console.log('✅ Login success!');

    const loginCookieHeader = loginRes.headers['set-cookie'];
    if (!loginCookieHeader || loginCookieHeader.length === 0) {
      throw new Error('No Set-Cookie header received on login!');
    }
    sessionCookie = loginCookieHeader[0].split(';')[0];
    console.log('✅ Session cookie extracted from login:', sessionCookie);

    // 5. Query /api/auth/me with Cookie
    console.log('\n5. Querying /api/auth/me session context...');
    const meRes = await request('GET', '/api/auth/me', null, {
      'Cookie': sessionCookie
    });

    if (meRes.statusCode !== 200 || meRes.body.email !== testEmail) {
      throw new Error(`Session verification failed: ${JSON.stringify(meRes.body)}`);
    }
    console.log('✅ Session verification success! Org ID:', meRes.body.orgId);

    // 6. Log Out
    console.log('\n6. Logging out and invalidating session...');
    const logoutRes = await request('POST', '/api/auth/logout', null, {
      'Cookie': sessionCookie
    });

    if (logoutRes.statusCode !== 200) {
      throw new Error(`Logout failed: ${JSON.stringify(logoutRes.body)}`);
    }
    console.log('✅ Logout request successful.');

    // 7. Verify Cookie is now invalidated
    console.log('\n7. Verifying request with old session cookie is rejected...');
    const oldMeRes = await request('GET', '/api/auth/me', null, {
      'Cookie': sessionCookie
    });

    if (oldMeRes.statusCode === 401) {
      console.log('✅ Verification with invalidated cookie correctly rejected with 401 Unauthorized');
    } else {
      throw new Error(`Verification with logged-out cookie should have returned 401. Got: ${oldMeRes.statusCode} - ${JSON.stringify(oldMeRes.body)}`);
    }

    console.log('\n========================================================');
    console.log('🎉 ALL AUTHENTICATION TESTS PASSED SUCCESSFULLY!');
    console.log('========================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  }
}

runTests();
