'use strict';

/**
 * Express middleware for receiving and verifying webhooks.
 *
 * Usage:
 *   const { createReceiver } = require('./middleware/receiver');
 *   app.use('/webhooks', createReceiver({ secret: 'whsec_...' }));
 *   app.post('/webhooks', (req, res) => {
 *     console.log('Verified event:', req.webhook.event);
 *     res.sendStatus(200);
 *   });
 */

const crypto = require('crypto');

/**
 * Build a raw-body capturing middleware + signature verifier.
 *
 * @param {object} opts
 * @param {string}   opts.secret       - Signing secret to verify against
 * @param {number}   [opts.tolerance]  - Max signature age in seconds (default 300)
 * @param {string}   [opts.header]     - Header name to read (default 'x-webhook-signature')
 * @param {number}   [opts.maxBytes]   - Max body size in bytes (default 1 MB)
 */
function createReceiver(opts = {}) {
  const {
    secret,
    tolerance = 300,
    header    = 'x-webhook-signature',
    maxBytes  = 1_048_576,
  } = opts;

  if (!secret) throw new TypeError('createReceiver({ secret }) — secret is required');

  return [
    // 1. Capture raw body (needed for signature verification)
    rawBody(maxBytes),
    // 2. Verify signature and attach parsed payload to req.webhook
    verifySignature(secret, tolerance, header),
  ];
}

function rawBody(maxBytes) {
  return (req, res, next) => {
    const chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });

    req.on('error', next);
  };
}

function verifySignature(secret, tolerance, headerName) {
  return (req, res, next) => {
    const sigHeader = req.headers[headerName];
    if (!sigHeader) {
      return res.status(400).json({ error: `Missing header: ${headerName}` });
    }

    try {
      const rawBody = req.rawBody?.toString('utf8') ?? '';

      const parts = Object.fromEntries(
        sigHeader.split(',').map(part => {
          const idx = part.indexOf('=');
          return [part.slice(0, idx), part.slice(idx + 1)];
        })
      );

      const ts = parseInt(parts.t, 10);
      if (!ts) throw new Error('Invalid signature: missing timestamp');

      const ageSec = (Date.now() - ts) / 1000;
      if (ageSec > tolerance) {
        throw new Error(`Webhook timestamp too old (${Math.round(ageSec)}s)`);
      }

      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${ts}.${rawBody}`)
        .digest('hex');

      const received = parts.v1;
      if (!received) throw new Error('Invalid signature: missing v1');

      const expBuf = Buffer.from(expected, 'hex');
      const rcvBuf = Buffer.from(received, 'hex');

      if (expBuf.length !== rcvBuf.length || !crypto.timingSafeEqual(expBuf, rcvBuf)) {
        throw new Error('Signature mismatch');
      }

      // Attach verified payload to request
      try {
        req.webhook = JSON.parse(rawBody);
      } catch {
        req.webhook = { raw: rawBody };
      }

      next();
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  };
}

module.exports = { createReceiver };
