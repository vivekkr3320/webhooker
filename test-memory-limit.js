'use strict';

const http = require('http');
const PORT = process.env.PORT || 4000;

// Global storage for intercepted outbound HTTP requests made by the WebhookEngine
const outboundRequests = [];

// Intercept http.request globally BEFORE loading the server.
const originalRequest = http.request;
http.request = function(options, callback) {
  if (options.port === PORT || options.port === String(PORT)) {
    return originalRequest.apply(this, arguments);
  }

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

const memoryExhaustionScript = `
  function transform(payload) {
    const data = [];
    // Allocate huge strings continuously to trigger V8 isolate OOM
    for (let i = 0; i < 50000; i++) {
      data.push(new Array(1000).fill('OOM_EXHAUSTION_ATTACK_STRING_DATA').join(''));
    }
    return payload;
  }
`;

async function runTests() {
  await new Promise(res => setTimeout(res, 1000));

  console.log('🚀 Starting V8 Isolate Memory Sandboxing Integration Tests...');

  const tenantEmail = `memory_dev_${Date.now()}@company.com`;
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

    // 2. Test dry-run API with a memory exhaustion script
    console.log('\n--- Step 2: Testing dry-run API with memory exhaustion script ---');
    const oomDryRun = await request('POST', '/api/endpoints/test-transformation', {
      payload: { event: 'user.created', data: {} },
      scriptString: memoryExhaustionScript
    }, { 'X-API-Key': apiKey });

    if (oomDryRun.statusCode === 422 && !oomDryRun.body.success) {
      if (oomDryRun.body.error.includes('Memory allocation limit of 16MB exceeded')) {
        console.log('✅ Dry-run correctly caught memory exhaustion and returned 422:', oomDryRun.body.error);
      } else {
        throw new Error(`Expected memory allocation limit error message, got: ${oomDryRun.body.error}`);
      }
    } else {
      throw new Error(`Expected dry-run to fail with 422. Got: ${oomDryRun.statusCode} - ${JSON.stringify(oomDryRun.body)}`);
    }

    // 3. Register endpoint with memory exhaustion script
    console.log('\n--- Step 3: Registering endpoint with memory exhaustion script ---');
    const registerEpRes = await request('POST', '/api/endpoints', {
      id: 'transform-ep-oom',
      url: 'http://localhost:9003/webhook-receiver',
      description: 'Endpoint with OOM transformation',
      transformationScript: memoryExhaustionScript
    }, { 'X-API-Key': apiKey });

    if (registerEpRes.statusCode === 200 && registerEpRes.body.success) {
      console.log('✅ Registered endpoint with OOM script successfully.');
    } else {
      throw new Error(`Failed to register endpoint: ${JSON.stringify(registerEpRes)}`);
    }

    // 4. Register a second, normal endpoint (to verify server remains alive and responsive afterwards)
    console.log('\n--- Step 4: Registering a normal endpoint for post-crash validation ---');
    const registerNormalRes = await request('POST', '/api/endpoints', {
      id: 'transform-ep-normal',
      url: 'http://localhost:9004/webhook-receiver',
      description: 'Normal endpoint',
      transformationScript: `
        function transform(payload) {
          payload.data.processed = true;
          return payload;
        }
      `
    }, { 'X-API-Key': apiKey });

    if (registerNormalRes.statusCode === 200 && registerNormalRes.body.success) {
      console.log('✅ Registered normal endpoint successfully.');
    } else {
      throw new Error(`Failed to register normal endpoint: ${JSON.stringify(registerNormalRes)}`);
    }

    // 5. Fire event to trigger memory limit breach
    console.log('\n--- Step 5: Firing event targeting memory exhaustion endpoint ---');
    outboundRequests.length = 0; // Clear intercepts
    const fireRes = await request('POST', '/api/send', {
      event: 'test.oom',
      data: { key: 'val' }
    }, { 'X-API-Key': apiKey });

    if (fireRes.statusCode === 200 && fireRes.body.success) {
      console.log('✅ Event send request executed.');
    } else {
      throw new Error(`Failed to fire event: ${JSON.stringify(fireRes)}`);
    }

    // Wait short delay for background request loops
    await new Promise(res => setTimeout(res, 200));

    // 6. Check delivery logs for OOM crash log entry
    console.log('\n--- Step 6: Checking delivery logs for OOM failure entry ---');
    const logsRes = await request('GET', '/api/logs', null, { 'X-API-Key': apiKey });
    const oomFailureLog = logsRes.body.find(l => l.endpointId === 'transform-ep-oom');

    if (oomFailureLog) {
      if (oomFailureLog.status === 'error' && oomFailureLog.statusCode === 422 && oomFailureLog.error.includes('Memory allocation limit of 16MB exceeded')) {
        console.log('✅ Out-Of-Memory failure logged successfully with status 422:');
        console.log(`   Error: "${oomFailureLog.error}"`);
      } else {
        throw new Error(`Log entry was invalid: ${JSON.stringify(oomFailureLog)}`);
      }
    } else {
      throw new Error('No delivery log was found for the memory-exhausting endpoint!');
    }

    // Assert that no request was sent to the OOM target port 9003
    const oomDispatched = outboundRequests.filter(r => r.port === '9003');
    if (oomDispatched.length === 0) {
      console.log('✅ Confirmed that no request was dispatched to the OOM endpoint.');
    } else {
      throw new Error('Security Alert: A webhook dispatch was sent to the OOM target despite heap limit breach!');
    }

    // 7. Verify the parent process did not crash and is fully functional
    console.log('\n--- Step 7: Verifying parent process stability (sending webhook on normal endpoint) ---');
    const normalDispatched = outboundRequests.filter(r => r.port === '9004');
    if (normalDispatched.length === 1) {
      const normalBody = JSON.parse(normalDispatched[0].body);
      if (normalBody.data.processed === true) {
        console.log('✅ Parent Express server is fully stable and running!');
        console.log('✅ Verified: Webhook on normal endpoint processed successfully post-OOM breach!');
      } else {
        throw new Error(`Normal payload was wrong: ${JSON.stringify(normalBody)}`);
      }
    } else {
      throw new Error(`Expected normal endpoint port 9004 to receive 1 webhook, got: ${normalDispatched.length}`);
    }

    console.log('\n🎉 ALL V8 ISOLATE MEMORY SANDBOXING INTEGRATION TESTS PASSED! 🎉');
    process.exit(0);

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTests();
