'use strict';

process.env.ALLOW_LOOPBACK = 'true';

const express = require('express');
const { WebhookEngine, createReceiver } = require('./index');
const db = require('./src/db');

const app = express();
const PORT = 4099;
const SECRET = 'test_secret_key_123';

// Set up server with receiver middleware
let receivedEvent = null;

app.post('/webhook-endpoint', createReceiver({ secret: SECRET }), (req, res) => {
  receivedEvent = req.webhook;
  res.status(200).json({ status: 'ok' });
});

const server = app.listen(PORT, async () => {
  console.log(`Test server running on port ${PORT}`);

  // Create webhook engine
  const engine = new WebhookEngine({
    secret: SECRET,
    timeout: 2000
  });

  // Register organization context in database
  await Promise.resolve(db.saveOrganization('test-org', {
    ownerEmail: 'test@example.com',
    planTier: 'free',
    subscriptionStatus: 'active',
    monthlyUsageCount: 0
  }));

  // Register the test endpoint
  engine.register('test-org', 'test-receiver', `http://localhost:${PORT}/webhook-endpoint`, { secret: SECRET });

  try {
    // Send event
    console.log('Sending test event: user.updated...');
    const results = await engine.send('test-org', 'user.updated', { userId: '123', status: 'active' });
    console.log('Send results:', JSON.stringify(results));

    // Wait slightly for events to settle
    await new Promise(r => setTimeout(r, 500));

    // Verify received event
    if (receivedEvent && receivedEvent.event === 'user.updated' && receivedEvent.data.userId === '123') {
      console.log('========================================================');
      console.log('SUCCESS: Webhook delivered and verified successfully!');
      console.log('========================================================');
      server.close(() => process.exit(0));
    } else {
      console.error('ERROR: Webhook event was not received or failed validation.');
      console.log('Received event data:', receivedEvent);
      server.close(() => process.exit(1));
    }
  } catch (err) {
    console.error('Test failed with error:', err);
    server.close(() => process.exit(1));
  }
});
