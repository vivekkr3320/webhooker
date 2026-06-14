'use strict';

const http = require('http');
const PORT = process.env.PORT || 4000;

// Global storage for intercepted outbound HTTP requests made by the WebhookEngine
const outboundRequests = [];

// Intercept http.request globally BEFORE loading the server.
// WebhookEngine uses standard http or https to dispatch events.
const originalRequest = http.request;
http.request = function(options, callback) {
  // If it's hitting the backend server's port 4000, let it pass through normally
  if (options.port === PORT || options.port === String(PORT)) {
    return originalRequest.apply(this, arguments);
  }

  // Otherwise, it is an outbound webhook event being sent to a destination!
  // Intercept and record it, then simulate a mock 200 response immediately.
  const reqObj = {
    options,
    chunks: [],
    write: function(data) {
      this.chunks.push(data);
    },
    end: function() {
      outboundRequests.push({
        hostname: options.hostname || options.host,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        body: this.chunks.join('')
      });

      // Simulate async response
      const mockRes = {
        statusCode: 200,
        on: function(event, cb) {
          if (event === 'data') cb(Buffer.from('{"ok":true}'));
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

    // Call the original, unmocked HTTP request so we can talk to the local server
    const req = originalRequest(options, (res) => {
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

  console.log('🚀 Starting JavaScript Payload Transformations Integration Tests...');

  const tenantEmail = `transform_dev_${Date.now()}@company.com`;
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

    // 2. Test dry-run endpoint with valid script
    console.log('\n--- Step 2: Testing dry-run API with a valid script ---');
    const validDryRun = await request('POST', '/api/endpoints/test-transformation', {
      payload: { event: 'user.created', data: { name: 'Sarah' } },
      scriptString: `
        function transform(payload) {
          payload.data.mutated = true;
          payload.data.customValue = 42;
          return payload;
        }
      `
    }, { 'X-API-Key': apiKey });

    if (validDryRun.statusCode === 200 && validDryRun.body.success) {
      const output = validDryRun.body.transformedPayload;
      if (output.data.mutated === true && output.data.customValue === 42) {
        console.log('✅ Dry-run executed successfully and returned mutated payload:', output);
      } else {
        throw new Error(`Dry-run output mismatch: ${JSON.stringify(output)}`);
      }
    } else {
      throw new Error(`Dry-run failed: ${JSON.stringify(validDryRun)}`);
    }

    // 3. Test dry-run endpoint with invalid script (syntax/runtime error)
    console.log('\n--- Step 3: Testing dry-run API with an invalid script ---');
    const invalidDryRun = await request('POST', '/api/endpoints/test-transformation', {
      payload: { event: 'user.created', data: { name: 'Sarah' } },
      scriptString: `
        function transform(payload) {
          throw new Error("Simulated script exception");
        }
      `
    }, { 'X-API-Key': apiKey });

    if (invalidDryRun.statusCode === 422 && !invalidDryRun.body.success) {
      console.log('✅ Dry-run caught runtime exception correctly:', invalidDryRun.body.error);
    } else {
      throw new Error(`Expected dry-run to fail with 422. Got: ${invalidDryRun.statusCode} - ${JSON.stringify(invalidDryRun.body)}`);
    }

    // 4. Register endpoint with valid payload transformation script
    console.log('\n--- Step 4: Registering endpoint with a transformation script ---');
    const registerEpRes = await request('POST', '/api/endpoints', {
      id: 'transform-ep-ok',
      url: 'http://localhost:9001/webhook-receiver',
      description: 'Endpoint with active transformation',
      transformationScript: `
        function transform(payload) {
          payload.data.processedByTransformer = true;
          payload.data.appendedValue = 999;
          return payload;
        }
      `
    }, { 'X-API-Key': apiKey });

    if (registerEpRes.statusCode === 200 && registerEpRes.body.success) {
      console.log('✅ Registered endpoint with transformation script successfully.');
    } else {
      throw new Error(`Failed to register endpoint: ${JSON.stringify(registerEpRes)}`);
    }

    // 5. Fire webhook and verify payload was transformed before signature and outbound request
    console.log('\n--- Step 5: Firing event and checking transformed outbound payload ---');
    outboundRequests.length = 0; // Clear intercepts
    const fireRes = await request('POST', '/api/send', {
      event: 'order.placed',
      data: { orderId: 'ord_123' }
    }, { 'X-API-Key': apiKey });

    if (fireRes.statusCode === 200 && fireRes.body.success) {
      console.log('✅ Event fired successfully.');
    } else {
      throw new Error(`Failed to fire event: ${JSON.stringify(fireRes)}`);
    }

    // Wait short delay for background request loops
    await new Promise(res => setTimeout(res, 100));

    const dispatchedWebhooks = outboundRequests.filter(r => r.port === '9001');
    if (dispatchedWebhooks.length === 1) {
      const body = JSON.parse(dispatchedWebhooks[0].body);
      if (body.data.processedByTransformer === true && body.data.appendedValue === 999) {
        console.log('✅ Outbound webhook payload was transformed successfully before dispatch!', body);
      } else {
        throw new Error(`Dispatched payload did not match expected transformation: ${JSON.stringify(body)}`);
      }
    } else {
      throw new Error(`Expected exactly 1 outbound request to port 9001, got ${dispatchedWebhooks.length}`);
    }

    // 6. Register endpoint with infinite loop script to test timeout guardrails
    console.log('\n--- Step 6: Testing VM loop timeout security guardrails ---');
    const registerLoopEp = await request('POST', '/api/endpoints', {
      id: 'transform-ep-loop',
      url: 'http://localhost:9002/webhook-receiver',
      description: 'Endpoint with infinite loop transformation',
      transformationScript: `
        function transform(payload) {
          while (true) {
            // Infinite loop
          }
          return payload;
        }
      `
    }, { 'X-API-Key': apiKey });

    if (registerLoopEp.statusCode === 200 && registerLoopEp.body.success) {
      console.log('✅ Registered infinite loop endpoint.');
    } else {
      throw new Error(`Failed to register loops endpoint: ${JSON.stringify(registerLoopEp)}`);
    }

    // Fire webhook to infinite loop endpoint
    console.log('Firing event targeting infinite loop endpoint (should fail after 50ms timeout)...');
    outboundRequests.length = 0;
    const fireLoopRes = await request('POST', '/api/send', {
      event: 'order.placed',
      data: { orderId: 'ord_loop' }
    }, { 'X-API-Key': apiKey });

    // Wait short delay to allow async thread execution to complete
    await new Promise(res => setTimeout(res, 200));

    // Verify logs in the database for the failure
    console.log('Checking delivery logs for transformation timeout error...');
    const logsRes = await request('GET', '/api/logs', null, { 'X-API-Key': apiKey });
    const loopFailureLog = logsRes.body.find(l => l.endpointId === 'transform-ep-loop');

    if (loopFailureLog) {
      if (loopFailureLog.status === 'error' && loopFailureLog.statusCode === 422 && loopFailureLog.error.includes('security breach')) {
        console.log('✅ Infinite loop was caught and terminated correctly by the 50ms sandbox watchdog:', loopFailureLog.error);
      } else {
        throw new Error(`Log entry for infinite loop was invalid: ${JSON.stringify(loopFailureLog)}`);
      }
    } else {
      throw new Error('No delivery log was recorded for the infinite loop failure!');
    }

    // Assert that no request was sent to the loop destination port 9002
    const loopsDispatched = outboundRequests.filter(r => r.port === '9002');
    if (loopsDispatched.length === 0) {
      console.log('✅ Confirmed that no request was dispatched to the loop destination.');
    } else {
      throw new Error('Security Alert: A webhook dispatch was sent to the loop destination despite sandbox timeout crash!');
    }

    console.log('\n🎉 ALL PAYLOAD TRANSFORMATION TESTS PASSED SUCCESSFULLY! 🎉');
    process.exit(0);

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTests();
