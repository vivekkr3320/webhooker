'use strict';

const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 4000;

// Global storage for intercepted HTTPS requests
const interceptedRequests = [];

// Intercept https.request globally BEFORE loading the server
const originalRequest = https.request;
https.request = function(options, callback) {
  const reqObj = {
    options,
    chunks: [],
    write: function(data) {
      this.chunks.push(data);
    },
    end: function() {
      interceptedRequests.push({
        hostname: options.hostname || options.host,
        path: options.path,
        method: options.method,
        headers: options.headers,
        body: this.chunks.join('')
      });

      // Simulate asynchronous response callback
      const mockRes = {
        statusCode: 200,
        on: function(event, cb) {
          if (event === 'data') cb(Buffer.from('{"status":"success"}'));
          if (event === 'end') cb();
        }
      };
      if (callback) {
        callback(mockRes);
      }
    },
    on: function(event, cb) {
      return this;
    },
    setTimeout: function(timeout, cb) {
      return this;
    },
    destroy: function() {
      return this;
    }
  };
  return reqObj;
};

// Start the server in the same process
console.log('Starting backend server in-process...');
require('./server.js');

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
  // Wait 1 second to ensure server is listening
  await new Promise(res => setTimeout(res, 1000));

  console.log('🚀 Starting Incident Alerting Engine Integration Tests...');

  const tenantEmail = `alert_dev_${Date.now()}@company.com`;
  let apiKey = '';
  let orgId = '';

  try {
    // 1. Onboard fresh tenant
    console.log('\n--- Step 1: Onboarding fresh tenant ---');
    const onboardRes = await request('POST', '/api/onboard', { email: tenantEmail });
    if (onboardRes.statusCode === 200 && onboardRes.body.apiKey) {
      apiKey = onboardRes.body.apiKey;
      orgId = onboardRes.body.orgId;
      console.log(`✅ Tenant onboarded. OrgId: ${orgId}`);
    } else {
      throw new Error(`Onboarding failed: ${JSON.stringify(onboardRes)}`);
    }

    // 2. Read default alert config (should be null or empty)
    console.log('\n--- Step 2: Fetching default alert settings ---');
    const getSettings1 = await request('GET', '/api/org/alert-settings', null, { 'X-API-Key': apiKey });
    if (getSettings1.statusCode === 200) {
      console.log('✅ Fetched default alert config:', getSettings1.body.alertConfig);
    } else {
      throw new Error(`Failed to fetch alert settings: ${JSON.stringify(getSettings1)}`);
    }

    // 3. Save new alert settings
    console.log('\n--- Step 3: Saving alert configuration ---');
    const saveRes = await request('POST', '/api/org/alert-settings', {
      slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/MOCK_SLACK_WEBHOOK_URL',
      pagerDutyRoutingKey: 'pd-mock-routing-key-here',
      notifyOnFailureCount: 3,
      enabled: true
    }, { 'X-API-Key': apiKey });

    if (saveRes.statusCode === 200 && saveRes.body.success) {
      console.log('✅ Alert settings saved successfully.');
    } else {
      throw new Error(`Failed to save alert settings: ${JSON.stringify(saveRes)}`);
    }

    // 4. Test Alert integration route
    console.log('\n--- Step 4: Testing integration endpoints ---');
    interceptedRequests.length = 0; // Clear history
    const testPingRes = await request('POST', '/api/org/alert-settings/test', {
      slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/MOCK_SLACK_WEBHOOK_URL',
      pagerDutyRoutingKey: 'pd-mock-routing-key-here'
    }, { 'X-API-Key': apiKey });

    if (testPingRes.statusCode === 200 && testPingRes.body.success) {
      console.log('✅ Test ping request returned 200.');
    } else {
      throw new Error(`Failed to run test ping: ${JSON.stringify(testPingRes)}`);
    }

    // Assert test alerts were intercepted
    console.log('Verifying intercepted test ping requests...');
    const slackTest = interceptedRequests.find(r => r.hostname === 'hooks.slack.com');
    const pdTest = interceptedRequests.find(r => r.hostname === 'events.pagerduty.com');

    if (slackTest && slackTest.body.includes('simulated verification ping')) {
      console.log('✅ Slack test alert intercepted successfully.');
    } else {
      throw new Error(`Slack test alert validation failed: ${JSON.stringify(slackTest)}`);
    }

    if (pdTest && pdTest.body.includes('simulated verification ping')) {
      console.log('✅ PagerDuty test alert intercepted successfully.');
    } else {
      throw new Error(`PagerDuty test alert validation failed: ${JSON.stringify(pdTest)}`);
    }

    // 5. Register failing endpoint
    console.log('\n--- Step 5: Registering failing endpoint ---');
    const registerEp = await request('POST', '/api/endpoints', {
      id: 'alert-fail-ep',
      url: 'http://localhost:9998/fail-econnrefused', // Point to offline port
      description: 'Failing endpoint for alerting test'
    }, { 'X-API-Key': apiKey });

    if (registerEp.statusCode === 200 && registerEp.body.success) {
      console.log('✅ Registered offline endpoint successfully.');
    } else {
      throw new Error(`Failed to register endpoint: ${JSON.stringify(registerEp)}`);
    }

    // 6. Fire events and trigger failure path
    console.log('\n--- Step 6: Dispatching events to trigger alerting threshold ---');
    interceptedRequests.length = 0; // Clear intercepts

    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    console.log('Firing Failure Event 1...');
    await request('POST', '/api/send', { event: 'payment.success', data: { amount: 100 } }, { 'X-API-Key': apiKey });
    await delay(100);

    console.log('Firing Failure Event 2...');
    await request('POST', '/api/send', { event: 'payment.success', data: { amount: 200 } }, { 'X-API-Key': apiKey });
    await delay(100);

    console.log('Firing Failure Event 3 (Should trigger alerts)...');
    await request('POST', '/api/send', { event: 'payment.success', data: { amount: 300 } }, { 'X-API-Key': apiKey });
    await delay(200); // Give background AlertManager request loop some time

    console.log('Verifying intercepted alerts for consecutive failure event #3...');
    const slackAlert = interceptedRequests.find(r => r.hostname === 'hooks.slack.com');
    const pdAlert = interceptedRequests.find(r => r.hostname === 'events.pagerduty.com');

    if (slackAlert) {
      const body = JSON.parse(slackAlert.body);
      if (body.text.includes('alert-fail-ep') && slackAlert.body.includes('payment.success')) {
        console.log('✅ Slack consecutive failure alert intercepted successfully!');
      } else {
        throw new Error(`Slack failure alert structure invalid: ${slackAlert.body}`);
      }
    } else {
      throw new Error('Slack consecutive failure alert was NOT sent!');
    }

    if (pdAlert) {
      const body = JSON.parse(pdAlert.body);
      if (body.payload.summary.includes('alert-fail-ep') && body.payload.custom_details.consecutiveFailures === 3) {
        console.log('✅ PagerDuty consecutive failure alert intercepted successfully!');
      } else {
        throw new Error(`PagerDuty failure alert structure invalid: ${pdAlert.body}`);
      }
    } else {
      throw new Error('PagerDuty consecutive failure alert was NOT sent!');
    }

    console.log('\n🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
    process.exit(0);

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTests();
