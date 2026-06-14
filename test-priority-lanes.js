'use strict';

const express = require('express');
const crypto = require('crypto');
const WebhookEngine = require('./src/WebhookEngine');
const db = require('./src/db');

const RECEIVER_PORT = 4097;
const app = express();
app.use(express.json());

const receivedEvents = [];

// Low-priority receiver delays response by 400ms to block the execution queue lane
app.post('/low-priority', (req, res) => {
  const eventId = req.body.id;
  const receivedAt = Date.now();
  setTimeout(() => {
    receivedEvents.push({ type: 'low', id: eventId, receivedAt });
    res.status(200).json({ status: 'ok' });
  }, 400);
});

// High-priority receiver responds immediately
app.post('/high-priority', (req, res) => {
  const eventId = req.body.id;
  const receivedAt = Date.now();
  receivedEvents.push({ type: 'high', id: eventId, receivedAt });
  res.status(200).json({ status: 'ok' });
});

const server = app.listen(RECEIVER_PORT, async () => {
  console.log(`Test receiver listening on port ${RECEIVER_PORT}`);

  try {
    // 1. Create WebhookEngine instance with low-priority concurrency capped at 1
    const engine = new WebhookEngine({
      secret: 'priority_test_secret_123',
      lowPriorityConcurrency: 1,
      maxRetries: 0
    });

    const orgId = 'org-priority-test';
    
    // Satisfy egress gatekeeper by saving the organization in the DB
    await Promise.resolve(db.saveOrganization(orgId, {
      ownerEmail: 'priority@test.io',
      planTier: 'enterprise',
      subscriptionStatus: 'active',
      monthlyUsageCount: 0
    }));

    // Register endpoints
    engine.register(orgId, 'ep-low', `http://localhost:${RECEIVER_PORT}/low-priority`);
    engine.register(orgId, 'ep-high', `http://localhost:${RECEIVER_PORT}/high-priority`);

    console.log('--- Step 1: Fire an initial event to generate a log to replay ---');
    const initRes = await engine.send(orgId, 'init.event', { text: 'baseline' });
    
    // Wait for the baseline request to finish
    await new Promise(res => setTimeout(res, 600));

    // Fetch baseline delivery logs to acquire log ID
    const deliveries = await Promise.resolve(db.getDeliveries(orgId));
    const baselineLog = deliveries.find(d => d.endpointId === 'ep-low');
    if (!baselineLog) {
      throw new Error('Could not find baseline delivery log for ep-low');
    }
    const logIdToReplay = baselineLog.id;
    console.log(`✅ Baseline delivery log ID extracted: ${logIdToReplay}`);

    console.log('\n--- Step 2: Triggering 5 bulk replays (will run sequentially due to concurrency = 1) ---');
    receivedEvents.length = 0; // Reset trace

    // Trigger 5 parallel replays. Because of concurrency limit 1, these will run one after the other.
    const replayPromises = Promise.all([
      engine.replay(orgId, logIdToReplay),
      engine.replay(orgId, logIdToReplay),
      engine.replay(orgId, logIdToReplay),
      engine.replay(orgId, logIdToReplay),
      engine.replay(orgId, logIdToReplay)
    ]);

    // Wait 100ms so that the first replay has started executing and occupying the queue lane,
    // and the other 4 are sitting queued.
    await new Promise(res => setTimeout(res, 100));

    console.log('\n--- Step 3: Firing a real-time event (high priority) ---');
    const realTimeStart = Date.now();
    const realTimeSendRes = await engine.send(orgId, 'critical.checkout', { amount: 150 });
    console.log(`✅ Real-time event dispatch response completed in ${Date.now() - realTimeStart}ms.`);

    // Wait for all replays to completely settle
    await replayPromises;
    await new Promise(res => setTimeout(res, 500));

    console.log('\n--- Step 4: Analysing request execution order ---');
    console.log('Received events sequence:');
    receivedEvents.forEach((ev, idx) => {
      console.log(`[${idx + 1}] Type: ${ev.type.toUpperCase()}, ID: ${ev.id}, ReceivedAt: ${ev.receivedAt}`);
    });

    // Verify ordering
    const highPriorityIndex = receivedEvents.findIndex(ev => ev.type === 'high');
    
    if (highPriorityIndex === -1) {
      throw new Error('High priority event was never received!');
    }

    // Since low priority concurrency is 1, and each takes 400ms:
    // - Replay 1 starts at 0ms, finishes at 400ms.
    // - Real-time event is fired at 100ms, processed immediately (high priority), finishes around 110-130ms.
    // - Replay 2 starts at 400ms, finishes at 800ms.
    // Therefore, the high-priority event should be received BEFORE Replay 2, 3, 4, and 5!
    console.log(`High priority event was received at index ${highPriorityIndex + 1} of ${receivedEvents.length}`);

    if (highPriorityIndex <= 1) { // It should be at index 0 or 1 (i.e. first or second, because Replay 1 started first)
      console.log('✅ Success: The high-priority real-time event successfully bypassed the low-priority queue queue!');
    } else {
      throw new Error(`Priority Lane Failure: High-priority event was delayed and sat at index ${highPriorityIndex + 1} behind queued replays.`);
    }

    console.log('\n========================================================');
    console.log('🎉 DUAL-LANE PRIORITY QUEUE INTEGRATION TESTS PASSED!');
    console.log('========================================================');
    
    server.close(() => process.exit(0));

  } catch (err) {
    console.error('❌ Priority queue test failed:', err);
    server.close(() => process.exit(1));
  }
});
