#!/usr/bin/env node
'use strict';

/**
 * One-time setup: generate a secure API key and write its bcrypt hash to .env
 *
 * Usage:
 *   node scripts/generate-api-key.js
 *
 * What it does:
 *   1. Generates a cryptographically secure 32-byte random key
 *   2. Displays the RAW key ONCE — copy it now, it will not be shown again
 *   3. Bcrypt-hashes the key and writes API_KEY_HASH= to .env
 */

const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');
const readline = require('readline');

const ENV_PATH = path.join(__dirname, '..', '.env');

async function main() {
  // Generate raw key
  const rawKey = 'whk_' + crypto.randomBytes(28).toString('hex');

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         WebhookEngine — API Key Generator                ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log('🔑  Your new API key (copy this NOW — shown only once):\n');
  console.log(`    \x1b[32m${rawKey}\x1b[0m\n`);
  console.log('⚠️   Store this key somewhere safe (e.g. a password manager).');
  console.log('    It will be required every time you open the dashboard.\n');

  // Hash with bcrypt (12 rounds — ~300ms, safe for API key comparison)
  process.stdout.write('🔒  Hashing key with bcrypt (rounds=12)...');
  const hash = await bcrypt.hash(rawKey, 12);
  console.log(' done.\n');

  // Read or create .env file
  let envContent = '';
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  } else {
    // Bootstrap from .env.example
    const examplePath = path.join(__dirname, '..', '.env.example');
    if (fs.existsSync(examplePath)) {
      envContent = fs.readFileSync(examplePath, 'utf8');
    }
  }

  // Replace or append API_KEY_HASH
  if (/^API_KEY_HASH=.*/m.test(envContent)) {
    envContent = envContent.replace(/^API_KEY_HASH=.*/m, `API_KEY_HASH=${hash}`);
  } else {
    envContent += `\nAPI_KEY_HASH=${hash}\n`;
  }

  // Also ensure WEBHOOK_SECRET is set if placeholder
  if (/^WEBHOOK_SECRET=whsec_change_me_in_production/m.test(envContent)) {
    const newSecret = 'whsec_' + crypto.randomBytes(24).toString('hex');
    envContent = envContent.replace(
      /^WEBHOOK_SECRET=.*/m,
      `WEBHOOK_SECRET=${newSecret}`
    );
    console.log(`🔐  Auto-generated WEBHOOK_SECRET: \x1b[36m${newSecret}\x1b[0m`);
    console.log('    (also saved to .env)\n');
  }

  fs.writeFileSync(ENV_PATH, envContent, 'utf8');
  console.log(`✅  Hash written to: ${ENV_PATH}`);
  console.log('\n🚀  Next steps:');
  console.log('    1. Start the server:  node server.js  (or  npm run prod)');
  console.log('    2. Open the dashboard and enter your API key when prompted.\n');
}

main().catch(err => {
  console.error('Error generating key:', err.message);
  process.exit(1);
});
