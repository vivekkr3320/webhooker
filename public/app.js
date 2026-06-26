/* =============================================================
   WEBHOOKENGINE — SANDBOX MODE
   Try without signup — by UtilityOS
   ============================================================= */

const SANDBOX_DURATION_MS = 30 * 60 * 1000;

const SANDBOX_DATA = {
  stats: {
    successRate:          98.4,
    totalVolume:          1247,
    activeDestinations:   3,
    avgLatency:           142,
    retryBacklog:         2,
    planTier:             'Developer Free',
    usageCurrent:         1247,
    usageMax:             5000,
    usagePct:             24.9,
    resetDate: (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1, 0);
      return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    })()
  },
  endpoints: [
    {
      name:   'stripe-payments',
      url:    'https://api.yourdomain.com/webhooks/stripe',
      events: ['payment.success', 'payment.failed', 'refund.created'],
      rpm:    100
    },
    {
      name:   'github-ci-pipeline',
      url:    'https://api.yourdomain.com/webhooks/github',
      events: ['push', 'pull_request', 'release'],
      rpm:    60
    },
    {
      name:   'razorpay-subscriptions',
      url:    'https://api.yourdomain.com/webhooks/razorpay',
      events: ['payment.captured', 'subscription.charged', 'subscription.halted'],
      rpm:    50
    }
  ],
  logs: [
    { status:'delivered', dest:'stripe-payments',       topic:'payment.success',         attempt:1, latency:'138ms', code:200 },
    { status:'delivered', dest:'github-ci-pipeline',    topic:'push',                    attempt:1, latency:'94ms',  code:200 },
    { status:'retrying',  dest:'razorpay-subscriptions',topic:'payment.captured',        attempt:2, latency:'2103ms',code:503 },
    { status:'delivered', dest:'stripe-payments',       topic:'payment.failed',          attempt:1, latency:'121ms', code:200 },
    { status:'failed',    dest:'github-ci-pipeline',    topic:'pull_request',            attempt:3, latency:'5041ms',code:500 },
    { status:'delivered', dest:'razorpay-subscriptions',topic:'subscription.charged',    attempt:1, latency:'109ms', code:200 },
    { status:'delivered', dest:'stripe-payments',       topic:'refund.created',          attempt:1, latency:'144ms', code:200 },
  ]
};

window._sandboxMode    = false;
window._sandboxInterval = null;

/* ---- Activate ---- */
window.activateSandboxMode = function() {
  window._sandboxMode = true;

  // Push dashboard down so banner doesn't overlap
  document.body.style.paddingTop = '42px';

  // Show sandbox banner
  const banner = document.getElementById('sandbox-banner');
  if (banner) banner.style.display = 'flex';

  // Hide auth modal
  const modal = document.getElementById('modal-auth');
  if (modal) modal.classList.remove('active');

  // Load all demo data
  _sbLoadStats();
  _sbLoadEndpoints();
  _sbLoadLogs();
  _sbStartCountdown();

  console.log('[WebhookEngine] Sandbox mode active');
};

/* ---- Stats ---- */
function _sbLoadStats() {
  const s = SANDBOX_DATA.stats;

  // Stat cards — using YOUR exact IDs
  _sbSet('val-success-rate',    s.successRate.toFixed(1) + '%');
  _sbSet('val-total-deliveries', s.totalVolume.toLocaleString());
  _sbSet('val-active-endpoints', s.activeDestinations);
  _sbSet('val-avg-response',    s.avgLatency + ' ms');
  _sbSet('val-pending-retries', s.retryBacklog);
  _sbSet('val-plan-tier',       s.planTier);

  // Success rate progress bar
  const barSuccess = document.getElementById('bar-success-rate');
  if (barSuccess) barSuccess.style.width = s.successRate + '%';

  // Billing monitor card — YOUR exact IDs
  const monitorCard = document.getElementById('billing-monitor-card');
  if (monitorCard) monitorCard.style.display = 'block';
  _sbSet('display-plan-tier',   s.planTier);
  _sbSet('usage-current',       s.usageCurrent.toLocaleString());
  _sbSet('usage-max',           s.usageMax.toLocaleString());
  _sbSet('txt-quota-fraction',  s.usageCurrent.toLocaleString() + ' / ' + s.usageMax.toLocaleString() + ' dispatches consumed');
  _sbSet('usage-reset-date',    s.resetDate);

  const barQuota = document.getElementById('usage-progress-bar');
  if (barQuota) barQuota.style.width = s.usagePct + '%';

  // Hide warning banners — usage is healthy in demo
  const alertBanner = document.getElementById('usage-alert-banner');
  if (alertBanner) alertBanner.style.display = 'none';

  // Badge
  const badge = document.getElementById('badge-status');
  if (badge) {
    badge.textContent = 'Active';
    badge.style.color = '#2ECC8C';
  }
}

/* ---- Endpoints ---- */
function _sbLoadEndpoints() {
  const container = document.getElementById('endpoints-list');
  if (!container) return;

  _sbSet('endpoints-count', SANDBOX_DATA.endpoints.length);

  container.innerHTML = SANDBOX_DATA.endpoints.map(ep => `
    <div style="
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:13px 16px;
      border-bottom:1px solid #1E2130;
      font-size:13px;
      gap:12px;
    ">
      <div style="min-width:160px;">
        <span style="color:#F0F2F7;font-weight:600;">${ep.name}</span>
        <span style="
          background:#0d2a1a;
          color:#2ECC8C;
          font-size:10px;
          font-weight:700;
          padding:2px 6px;
          border-radius:3px;
          margin-left:7px;
          letter-spacing:0.04em;
        ">ACTIVE</span>
      </div>
      <div style="color:#8B92A5;font-size:12px;font-family:'JetBrains Mono',monospace;flex:1;">${ep.url}</div>
      <div style="color:#4B5267;font-size:11px;max-width:220px;text-align:right;">${ep.events.join(' · ')}</div>
      <div style="color:#2E3347;font-size:11px;font-style:italic;min-width:80px;text-align:right;">Demo</div>
    </div>
  `).join('');
}

/* ---- Delivery Logs ---- */
function _sbLoadLogs() {
  const tbody = document.getElementById('logs-stream-body');
  if (!tbody) return;

  const colors = { delivered:'#2ECC8C', retrying:'#F5A623', failed:'#EF4444' };

  tbody.innerHTML = SANDBOX_DATA.logs.map(log => {
    const uid = 'wh_' + Math.random().toString(36).substr(2, 9);
    return `
      <tr style="border-bottom:1px solid #1E2130;font-size:13px;">
        <td style="padding:10px 12px;text-align:center;"><input type="checkbox" disabled style="opacity:0.3;cursor:not-allowed;"></td>
        <td style="padding:10px 12px;">
          <span style="color:${colors[log.status]};font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">${log.status}</span>
        </td>
        <td style="padding:10px 12px;color:#8B92A5;">${log.dest}</td>
        <td style="padding:10px 12px;color:#F0F2F7;">${log.topic}</td>
        <td style="padding:10px 12px;color:#4B5267;font-family:'JetBrains Mono',monospace;font-size:11px;">${uid}</td>
        <td style="padding:10px 12px;color:#8B92A5;text-align:center;">${log.attempt}</td>
        <td style="padding:10px 12px;color:#8B92A5;">${log.latency}</td>
        <td style="padding:10px 12px;color:${log.code===200?'#2ECC8C':'#EF4444'};font-weight:600;">${log.code}</td>
        <td style="padding:10px 12px;">
          <span style="color:#2E3347;font-size:11px;font-style:italic;">demo</span>
        </td>
      </tr>
    `;
  }).join('');
}

/* ---- Countdown ---- */
function _sbStartCountdown() {
  const end = Date.now() + SANDBOX_DURATION_MS;

  window._sandboxInterval = setInterval(() => {
    const remaining = end - Date.now();

    if (remaining <= 0) {
      clearInterval(window._sandboxInterval);
      _sbExpire();
      return;
    }

    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const display = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    _sbSet('sandbox-countdown', display);

    // Red countdown in last 5 minutes
    if (remaining < 5 * 60 * 1000) {
      const el = document.getElementById('sandbox-countdown');
      if (el) el.style.color = '#EF4444';
    }
  }, 1000);
}

/* ---- Session Expired ---- */
function _sbExpire() {
  window._sandboxMode = false;
  const banner = document.getElementById('sandbox-banner');
  if (!banner) return;

  banner.style.background    = '#1a0a0a';
  banner.style.borderColor   = '#EF4444';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;color:#FCA5A5;">
      <span style="
        background:#EF4444;color:#fff;
        font-size:10px;font-weight:700;
        padding:2px 8px;border-radius:3px;
        letter-spacing:0.06em;
      ">SESSION EXPIRED</span>
      Your demo session has ended. Create a free account to save your work.
    </div>
    <button
      onclick="const m = document.getElementById('modal-auth'); if (m) m.classList.add('active');"
      style="
        background:#EF4444;color:#fff;border:none;
        border-radius:6px;padding:6px 16px;
        font-size:12px;font-weight:600;cursor:pointer;
        font-family:inherit;
      "
    >Create Free Account &rarr;</button>
  `;
}

/* ---- Helper ---- */
function _sbSet(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/* ---- Sandbox Guard — wrap around write API calls ---- */
window.sandboxGuard = function(label, apiFn) {
  if (window._sandboxMode) {
    console.log(`[Sandbox] Blocked write: ${label}`);
    alert('Demo mode — create a free account to save changes');
    return Promise.resolve(null);
  }
  return apiFn();
};

/* ---- Wire up buttons after DOM ready ---- */
document.addEventListener('DOMContentLoaded', () => {
  // Try Demo button
  const tryBtn = document.getElementById('try-demo-btn');
  if (tryBtn) tryBtn.addEventListener('click', window.activateSandboxMode);

  // Save My Progress CTA in banner
  const saveBtn = document.getElementById('sandbox-signup-cta');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const modal = document.getElementById('modal-auth');
      if (modal) modal.classList.add('active');
    });
  }
});

/* =============================================================
   END SANDBOX MODE
   ============================================================= */

'use strict';

// Global state variables
let currentEventTemplate = 'payment.success';
let logsDatabase = []; // Local cache of delivery logs
let pollingTimer = null;
let selectedLogIds = new Set();

// Sparkline history caches (Keep last 12 points)
const successHistory = [92, 94, 91, 95, 94, 96, 95, 98, 97, 99, 100, 100];
const latencyHistory = [120, 140, 110, 130, 95, 140, 105, 90, 85, 95, 75, 80];

// JSON templates for simulator
const PAYLOAD_TEMPLATES = {
  'payment.success': {
    amount: 5900,
    currency: 'USD',
    status: 'paid',
    customer: {
      name: 'John Doe',
      email: 'john.doe@example.com'
    },
    payment_method: 'card_visa'
  },
  'user.created': {
    user_id: 'usr_8f8e8a9',
    email: 'new_user@domain.com',
    name: 'Sarah Connor',
    role: 'administrator',
    profile_completed: true
  },
  'order.placed': {
    order_id: 'ord_779210',
    total_amount: 14999,
    currency: 'USD',
    items: [
      { sku: 'mechanical-keyboard', name: 'Keychron K2', price: 9900, qty: 1 },
      { sku: 'wrist-rest', name: 'Wooden Wrist Rest', price: 5099, qty: 1 }
    ],
    shipping_address: '123 Cyberpunk St, Neo Tokyo'
  },
  'custom': {
    test_mode: true,
    triggered_by: 'dashboard_ui',
    metadata: {
      client_ip: '127.0.0.1',
      session_id: 'sess_993a8d8e'
    }
  }
};

// ==========================================================================
// Initialization & Event Listeners
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Bind Code Editor highlighting synchronizations
  const textarea = document.getElementById('event-payload');
  const backdrop = document.getElementById('highlight-backdrop');
  
  textarea.addEventListener('input', runHighlight);
  textarea.addEventListener('scroll', () => {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  });

  // Load initial template
  loadPayloadTemplate(currentEventTemplate);

  // Set up default/placeholder reset date as the last day of the current month
  const resetDateDisplay = document.getElementById('usage-reset-date');
  if (resetDateDisplay) {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    resetDateDisplay.textContent = lastDay.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  // Set up forms and actions
  document.getElementById('form-register-endpoint').addEventListener('submit', handleRegisterEndpoint);
  document.getElementById('btn-fire-event').addEventListener('click', handleFireWebhook);
  document.getElementById('btn-clear-logs').addEventListener('click', handleClearLogs);
  document.getElementById('btn-copy-payload').addEventListener('click', handleCopyPayload);

  // Set up Bulk Action Bar Listeners
  document.getElementById('checkbox-select-all').addEventListener('change', handleSelectAllChange);
  document.getElementById('btn-bulk-deselect').addEventListener('click', clearLogSelection);
  document.getElementById('btn-bulk-redrive-selected').addEventListener('click', handleRedriveSelected);

  // Set up Bulk Redrive Modal Listeners
  document.getElementById('btn-bulk-redrive-open').addEventListener('click', openBulkRedriveModal);
  document.getElementById('bulk-redrive-close-btn').addEventListener('click', closeBulkRedriveModal);
  document.getElementById('bulk-redrive-range').addEventListener('change', handleBulkRangeChange);
  document.getElementById('form-bulk-redrive').addEventListener('submit', handleBulkRedriveSubmit);
  
  // Set up template selectors
  document.querySelectorAll('.btn-template').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-template').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      const eventName = e.target.getAttribute('data-event');
      currentEventTemplate = eventName;
      document.getElementById('event-name').value = eventName === 'custom' ? 'custom.event' : eventName;
      loadPayloadTemplate(eventName);
    });
  });

  // Modal actions
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  window.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-inspector')) {
      closeModal();
    }
  });

  // Holographic card border mouse tracking listener
  document.addEventListener('mousemove', (e) => {
    document.querySelectorAll('.glass-card, .stat-card').forEach(card => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      card.style.setProperty('--mouse-x', `${x}px`);
      card.style.setProperty('--mouse-y', `${y}px`);
    });
  });

  // Start polling loop (runs safely in background, returning early if auth modal is active)
  pollingTimer = setInterval(pollDashboard, 1500);
  const alertForm = document.getElementById('form-alert-settings');
  if (alertForm) alertForm.addEventListener('submit', handleSaveAlertSettings);
  const alertTestBtn = document.getElementById('btn-test-alerts');
  if (alertTestBtn) alertTestBtn.addEventListener('click', handleTestAlertSettings);

  const dryRunBtn = document.getElementById('btn-test-transform-dry-run');
  if (dryRunBtn) dryRunBtn.addEventListener('click', handleTestTransformDryRun);

  // Bind upgrade plan button click
  const upgradeBtn = document.getElementById('btn-upgrade-plan');
  if (upgradeBtn) upgradeBtn.addEventListener('click', handleUpgradeClick);

  // Bind simulated billing buttons
  document.querySelectorAll('.btn-simulate-billing').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const event = e.currentTarget.getAttribute('data-event');
      const statusEl = document.getElementById('sim-billing-status');
      
      // Get current subscription ID from stats
      if (statusEl) {
        statusEl.textContent = 'Simulating...';
        statusEl.style.color = 'rgba(255,255,255,0.6)';
      }

      try {
        const statsRes = await apiFetch('/api/stats');
        const stats = await statsRes.json();
        
        // Derive subscription ID or generate simulated default
        const subId = stats.razorpaySubscriptionId || (stats.orgId ? `sub_${stats.orgId.slice(4)}` : 'sub_sim_default');
        const nextPlan = stats.planTier === 'pro' ? 'plan_ent_003' : 'plan_pro_002';

        const res = await apiFetch('/api/billing/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event,
            subscriptionId: subId,
            planId: nextPlan
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          if (statusEl) {
            statusEl.textContent = 'Success!';
            statusEl.style.color = '#10b981';
          }
          if (window.triggerCanvasBurst) window.triggerCanvasBurst();
          setTimeout(() => pollDashboard(), 200);
        } else {
          if (statusEl) {
            statusEl.textContent = 'Failed';
            statusEl.style.color = '#f43f5e';
          }
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = 'Err: ' + err.message;
          statusEl.style.color = '#f43f5e';
        }
      }
    });
  });

  // Draw initial static sparklines
  updateSparklineChart('sparkline-success', successHistory);
  updateSparklineChart('sparkline-latency', latencyHistory);
});

// ==========================================================================
// Code Editor & Highlighter Engine
// ==========================================================================
function runHighlight() {
  const textarea = document.getElementById('event-payload');
  const codeEl = document.getElementById('highlight-code');
  const val = textarea.value;

  // Apply JSON Syntax highlighting
  codeEl.innerHTML = highlightJSON(val);

  // Update line counts
  const lines = val.split('\n');
  const lineNumbers = document.getElementById('line-numbers');
  lineNumbers.innerHTML = '';
  for (let i = 1; i <= lines.length; i++) {
    const span = document.createElement('span');
    span.className = 'line-number';
    span.textContent = i;
    lineNumbers.appendChild(span);
  }
}

// Regex-based JSON Token syntax colorizer
function highlightJSON(jsonStr) {
  if (!jsonStr) return '';
  
  // Clean HTML markup entities
  let escaped = jsonStr
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Classify regex matches
  let highlighted = escaped.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
    let cls = 'number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'key';
      } else {
        cls = 'string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'boolean';
    } else if (/null/.test(match)) {
      cls = 'null';
    }
    return '<span class="json-' + cls + '">' + match + '</span>';
  });

  // Inject structural braces glow highlights
  highlighted = highlighted.replace(/([\{\}\[\]])(?![^<>]*>)/g, '<span class="json-brace">$1</span>');

  return highlighted;
}

// Load Template Data to Code Editor
function loadPayloadTemplate(templateKey) {
  const payload = PAYLOAD_TEMPLATES[templateKey];
  const textarea = document.getElementById('event-payload');
  textarea.value = JSON.stringify(payload, null, 2);
  
  // Highlight and reset scroll alignment
  runHighlight();
  const backdrop = document.getElementById('highlight-backdrop');
  backdrop.scrollTop = 0;
  backdrop.scrollLeft = 0;
  textarea.scrollTop = 0;
  textarea.scrollLeft = 0;
}

// Handle Copy Payload with success checks and localized confetti
function handleCopyPayload() {
  const textarea = document.getElementById('event-payload');
  navigator.clipboard.writeText(textarea.value).then(() => {
    const btn = document.getElementById('btn-copy-payload');
    btn.classList.add('copied');
    btn.innerHTML = `<i data-lucide="check" style="width:0.75rem;height:0.75rem"></i> Copied!`;
    lucide.createIcons();
    
    // Spawn micro-confetti particles
    spawnConfetti(btn);
    
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<i data-lucide="copy" style="width:0.75rem;height:0.75rem"></i> Copy`;
      lucide.createIcons();
    }, 2000);
  });
}

function spawnConfetti(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const centerX = window.scrollX + rect.left + rect.width / 2;
  const centerY = window.scrollY + rect.top + rect.height / 2;
  
  const colors = ['#06b6d4', '#0070f3', '#00e5ff', '#10b981', '#fbbf24', '#f43f5e'];
  
  for (let i = 0; i < 20; i++) {
    const span = document.createElement('span');
    span.className = 'confetti-particle';
    
    const angle = Math.random() * Math.PI * 2;
    const velocity = 25 + Math.random() * 55;
    const tx = Math.cos(angle) * velocity;
    const ty = Math.sin(angle) * velocity;
    
    span.style.setProperty('--tx', `${tx}px`);
    span.style.setProperty('--ty', `${ty}px`);
    
    span.style.left = `${centerX}px`;
    span.style.top = `${centerY}px`;
    span.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    
    document.body.appendChild(span);
    
    setTimeout(() => {
      span.remove();
    }, 800);
  }
}

// ==========================================================================
// Dynamic SVG Sparkline Renderer
// ==========================================================================
function updateSparklineChart(pathId, data) {
  const pathEl = document.getElementById(pathId);
  if (!pathEl || !data || data.length === 0) return;

  const width = 100;
  const height = 30;
  const padding = 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = (max - min) || 1;

  const dx = width / (data.length - 1);
  let d = '';

  data.forEach((val, i) => {
    const x = i * dx;
    const y = padding + (height - padding * 2) * (1 - (val - min) / span);
    if (i === 0) {
      d += `M${x.toFixed(1)},${y.toFixed(1)}`;
    } else {
      d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
  });

  pathEl.setAttribute('d', d);
}

// ==========================================================================
// API Operations
// ==========================================================================

async function fetchEndpoints() {
  try {
    const res = await apiFetch('/api/endpoints');
    const endpoints = await res.json();
    renderEndpointsList(endpoints);
    document.getElementById('endpoints-count').textContent = endpoints.length;
  } catch (err) {
    console.error('Error fetching endpoints:', err);
  }
}

async function handleRegisterEndpoint(e) {
  e.preventDefault();
  
  const id = document.getElementById('ep-id').value.trim();
  const url = document.getElementById('ep-url').value.trim();
  const secret = document.getElementById('ep-secret').value.trim();
  const eventsRaw = document.getElementById('ep-events').value;
  const description = document.getElementById('ep-desc').value.trim();
  const integration = document.getElementById('ep-integration').value;
  const headers = document.getElementById('ep-headers').value.trim();
  const maxRPM = parseInt(document.getElementById('ep-max-rpm').value, 10) || null;
  const circuitThreshold = parseInt(document.getElementById('ep-circuit-threshold').value, 10) || 5;
  const transformationScript = document.getElementById('ep-transform-script').value;
  
  const events = eventsRaw.split(',').map(ev => ev.trim()).filter(Boolean);

  try {
    const res = await sandboxGuard('register-endpoint', () =>
      apiFetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, url, secret, events, description, integration, headers, maxRPM, circuitThreshold, transformationScript })
      })
    );
    if (!res) return;
    
    if (res.ok) {
      document.getElementById('ep-id').value = '';
      document.getElementById('ep-url').value = '';
      document.getElementById('ep-secret').value = '';
      document.getElementById('ep-events').value = '*';
      document.getElementById('ep-desc').value = '';
      document.getElementById('ep-integration').value = 'standard';
      document.getElementById('ep-headers').value = '';
      document.getElementById('ep-max-rpm').value = '';
      document.getElementById('ep-circuit-threshold').value = '5';
      document.getElementById('ep-transform-script').value = '';
      const resultBox = document.getElementById('transform-dry-run-result');
      if (resultBox) {
        resultBox.style.display = 'none';
        resultBox.innerHTML = '';
      }
      fetchEndpoints();
    } else {
      const errData = await res.json();
      alert(`Error registering endpoint: ${errData.error}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  }
}

async function deleteEndpoint(id) {
  if (!confirm(`Are you sure you want to unregister '${id}'?`)) return;

  try {
    const res = await sandboxGuard('delete-endpoint', () =>
      fetch(`/api/endpoints/${id}`, { method: 'DELETE' })
    );
    if (!res) return;
    if (res.ok) {
      fetchEndpoints();
    } else {
      const err = await res.json();
      alert(`Failed to delete: ${err.error}`);
    }
  } catch (err) {
    console.error(err);
  }
}

async function toggleEndpointStatus(id, active) {
  const endpoint = active ? 'activate' : 'deactivate';
  try {
    const res = await sandboxGuard('toggle-endpoint-status', () =>
      fetch(`/api/endpoints/${id}/${endpoint}`, { method: 'POST' })
    );
    if (!res) return;
    if (res.ok) {
      fetchEndpoints();
    } else {
      const err = await res.json();
      alert(`Failed to update status: ${err.error}`);
    }
  } catch (err) {
    console.error(err);
  }
}

async function handleFireWebhook() {
  const event = document.getElementById('event-name').value.trim();
  const payloadRaw = document.getElementById('event-payload').value;
  
  if (!event) {
    alert('Please enter an event name.');
    return;
  }

  let data;
  try {
    data = JSON.parse(payloadRaw);
  } catch (err) {
    alert(`Invalid JSON payload format: ${err.message}`);
    return;
  }

  const btn = document.getElementById('btn-fire-event');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="animate-spin margin-right-0.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Discharging Event...`;
  btn.disabled = true;

  // Trigger Masterpiece Light-speed simulation bursts on background canvas
  if (window.triggerCanvasBurst) {
    window.triggerCanvasBurst();
  }

  // Trigger localized button shockwave confetti
  spawnConfetti(btn);

  try {
    const res = await sandboxGuard('fire-event', () =>
      apiFetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, data })
      })
    );
    if (!res) return;
    
    if (res.ok) {
      setTimeout(pollDashboard, 100);
    } else {
      const errData = await res.json();
      alert(`Delivery trigger failed: ${errData.error}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

async function handleClearLogs() {
  if (!confirm('Clear all webhook engine logs?')) return;
  try {
    const res = await sandboxGuard('clear-logs', () =>
      apiFetch('/api/logs/clear', { method: 'POST' })
    );
    if (!res) return;
    pollDashboard();
  } catch (err) {
    console.error(err);
  }
}

async function loadSecurityPanel() {
  try {
    const res = await apiFetch('/api/system/info');
    const info = await res.json();
    const body = document.getElementById('security-info-body');
    if (!body) return;

    body.innerHTML = `
      <div class="security-grid-inner">
        <div class="security-item">
          <span class="security-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Outbound Egress IP
          </span>
          <span class="security-value">
            <code>${escapeHtml(info.egressIp)}</code>
            <button class="btn-copy-mini" onclick="navigator.clipboard.writeText('${escapeHtml(info.egressIp)}').then(()=>{ this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy IP',1500); })" title="Copy to clipboard">Copy IP</button>
          </span>
          <span class="security-desc">Whitelist this IP in your receiver's firewall / network ACL rules.</span>
        </div>
        <div class="security-item">
          <span class="security-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            HMAC Signature Header
          </span>
          <span class="security-value"><code>${escapeHtml(info.signatureHeader)}</code></span>
          <span class="security-desc">Your receiver must validate this header using HMAC-SHA256. Format: <code>t={timestamp},v1={signature}</code></span>
        </div>
        <div class="security-item">
          <span class="security-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
            Idempotency Header
          </span>
          <span class="security-value"><code>${escapeHtml(info.idempotencyHeader)}</code></span>
          <span class="security-desc">Stable per-delivery key. Safe to use as a deduplication key in your receiver to prevent double-processing on retries.</span>
        </div>
        <div class="security-item">
          <span class="security-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            Retry Schedule
          </span>
          <span class="security-value">
            ${info.retryDelays.map((d, i) => `<span class="badge badge-purple">Attempt ${i+2}: +${d}s</span>`).join(' ')}
          </span>
          <span class="security-desc">Max ${info.maxRetries} retries with exponential-style backoff. Intervals shown above.</span>
        </div>
        <div class="security-item">
          <span class="security-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 3 14 9-14 9V3z"/></svg>
            Engine Version
          </span>
          <span class="security-value"><code>WebhookEngine v${escapeHtml(info.version)}</code></span>
          <span class="security-desc">This engine is production-grade with HMAC-SHA256 signing, automatic retries, circuit breaker, and rate limiting.</span>
        </div>
      </div>
    `;
  } catch (e) {
    const body = document.getElementById('security-info-body');
    if (body) body.innerHTML = '<span class="text-muted">Failed to load system info.</span>';
  }
}




// ==========================================================================
// Dashboard Render Loops
// ==========================================================================

function renderEndpointsList(endpoints) {
  const container = document.getElementById('endpoints-list');
  
  if (endpoints.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="link-2"></i>
        <p>No endpoints registered yet.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = '';
  endpoints.forEach(ep => {
    const div = document.createElement('div');
    div.className = `endpoint-item ${ep.active ? '' : 'inactive'}`;
    
    const eventsHtml = ep.events.map(ev => `<span class="badge badge-purple">${ev}</span>`).join(' ');
    const descText = ep.metadata?.description || 'No description provided';
    const secretBadge = ep.secret === 'whsec_supersecret123' 
      ? '<span class="badge badge-purple">Global Secret</span>' 
      : '<span class="badge badge-warning">Custom Secret</span>';

    let integrationBadge = '';
    if (ep.integration === 'slack') {
      integrationBadge = '<span class="badge badge-slack"><i data-lucide="slack" style="width:0.75rem;height:0.75rem;margin-right:0.2rem"></i>Slack</span>';
    } else if (ep.integration === 'discord') {
      integrationBadge = '<span class="badge badge-discord">Discord</span>';
    } else {
      integrationBadge = '<span class="badge badge-purple">Standard</span>';
    }

    const transformBadge = ep.transformationScript 
      ? '<span class="badge badge-purple" title="JS Payload Transformation Active" style="border: 1px solid rgba(6, 182, 212, 0.3); background: rgba(6, 182, 212, 0.1); color: #06b6d4;"><i data-lucide="code" style="width:0.7rem;height:0.7rem;margin-right:0.2rem;display:inline-block;vertical-align:middle;"></i>Transform</span>' 
      : '';

    // Circuit breaker placeholder — populated async
    const circuitId = `circuit-${ep.id.replace(/[^a-zA-Z0-9]/g, '-')}`;

    div.innerHTML = `
      <div class="ep-header">
        <div class="ep-name-group">
          <span class="ep-id">
            ${escapeHtml(ep.id)} 
            ${integrationBadge}
            ${transformBadge}
          </span>
          <span class="ep-desc">${escapeHtml(descText)}</span>
        </div>
        <div class="ep-actions">
          <span id="${circuitId}" class="badge badge-success" title="Circuit Breaker">â— CLOSED</span>
          <label class="switch">
            <input type="checkbox" ${ep.active ? 'checked' : ''} onchange="toggleEndpointStatus('${ep.id}', this.checked)">
            <span class="slider"></span>
          </label>
          <button class="btn-icon-only" onclick="deleteEndpoint('${ep.id}')" title="Delete Endpoint">
            <i data-lucide="trash-2" style="width:0.85rem;height:0.85rem"></i>
          </button>
        </div>
      </div>
      <div class="ep-url">${escapeHtml(ep.url)}</div>
      <div class="ep-footer">
        <div class="ep-events-filter">
          <span>Filters:</span> ${eventsHtml}
        </div>
        <div>${secretBadge}</div>
      </div>
    `;
    container.appendChild(div);

    // Fetch circuit state async
    fetch(`/api/endpoints/${encodeURIComponent(ep.id)}/health`)
      .then(r => r.json())
      .then(h => {
        const el = document.getElementById(circuitId);
        if (!el) return;
        if (h.state === 'OPEN') {
          el.className = 'badge badge-danger';
          el.textContent = `â— OPEN${h.cooldownRemaining > 0 ? ` (${h.cooldownRemaining}s)` : ''}`;
          el.title = `Circuit OPEN â€” ${h.failCount} consecutive failures`;
        } else if (h.state === 'HALF_OPEN') {
          el.className = 'badge badge-warning';
          el.textContent = 'â—‘ HALF-OPEN';
          el.title = 'Circuit probing â€” 1 success will close it';
        } else {
          el.className = 'badge badge-success';
          el.textContent = 'â— CLOSED';
          el.title = `Healthy (${h.failCount} failures recorded)`;
        }
      })
      .catch(() => {});
  });
  
  lucide.createIcons();
}

async function pollDashboard() {
  if (window._sandboxMode) return;
  const modal = document.getElementById('modal-auth');
  if (modal && modal.classList.contains('active')) {
    return;
  }
  try {
    // 1. Fetch Stats
    const statsRes = await apiFetch('/api/stats');
    const stats = await statsRes.json();
    updateStatsCards(stats);

    // 2. Fetch Usage
    const usageRes = await apiFetch('/api/billing/usage');
    const usage = await usageRes.json();
    updateBillingUsagePanel(usage);

    // 3. Fetch Logs
    const logsRes = await apiFetch('/api/logs');
    const logs = await logsRes.json();
    logsDatabase = logs; 
    updateLogsStream(logs);

    // 4. Fetch Consumer Logs
    await pollConsumerLogs();
  } catch (err) {
    console.error('Polling error:', err);
  }
}

async function pollConsumerLogs() {
  try {
    const res = await apiFetch('/api/webhook-logs');
    if (!res.ok) return;
    const logs = await res.json();
    renderConsumerLogs(logs);
  } catch (err) {
    console.error('Error fetching consumer logs:', err);
  }
}

function renderConsumerLogs(logs) {
  const tbody = document.getElementById('consumer-logs-body');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">
          <div class="empty-state">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.5; margin-bottom: 8px;"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/><line x1="5" y1="9" x2="5.01" y2="9"/><line x1="5" y1="13" x2="5.01" y2="13"/><line x1="5" y1="17" x2="5.01" y2="17"/></svg>
            <p>No logged consumer webhook dispatches found.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  logs.forEach(log => {
    const tr = document.createElement('tr');
    
    let badgeClass = 'badge-purple';
    let statusText = log.status.toUpperCase();
    if (log.status === 'delivered') {
      badgeClass = 'badge-success';
    } else if (log.status === 'failed' || log.status === 'error') {
      badgeClass = 'badge-danger';
    }

    const codeText = log.statusCode ? `${log.statusCode}` : '—';
    let codeBadge = `<span class="badge badge-purple">${codeText}</span>`;
    if (log.statusCode && log.statusCode >= 200 && log.statusCode < 300) {
      codeBadge = `<span class="badge badge-success">${codeText}</span>`;
    } else if (log.statusCode) {
      codeBadge = `<span class="badge badge-danger">${codeText}</span>`;
    }

    const tsFormatted = new Date(log.timestamp).toLocaleString();
    const payloadId = `payload-toggle-${log.id}`;
    
    tr.innerHTML = `
      <td><span class="badge ${badgeClass}">${statusText}</span></td>
      <td>${codeBadge}</td>
      <td style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--cyan); word-break: break-all;">${escapeHtml(log.url)}</td>
      <td><span class="badge badge-purple">${escapeHtml(log.event)}</span></td>
      <td style="font-size: 0.8rem; color: var(--text-secondary);">${tsFormatted}</td>
      <td style="text-align: center;">
        <button class="btn-text-action" onclick="togglePayloadView('${payloadId}')" style="padding: 4px 10px; font-size: 0.7rem;">
          Inspect
        </button>
      </td>
    `;
    tbody.appendChild(tr);

    // Create the expandable detail row
    const detailTr = document.createElement('tr');
    detailTr.id = payloadId;
    detailTr.style.display = 'none';
    detailTr.className = 'payload-detail-row';
    
    const escapedPayload = escapeHtml(JSON.stringify(log.payload, null, 2));
    const errorText = log.error ? `<div style="color: var(--danger); font-weight: 600; margin-bottom: 8px;">Error Details: ${escapeHtml(log.error)}</div>` : '';
    
    detailTr.innerHTML = `
      <td colspan="6" style="padding: 15px 25px; background: rgba(0,0,0,0.25); border-bottom: 1px solid var(--border-color);">
        ${errorText}
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 5px; font-weight: 600; text-transform: uppercase;">Raw Payload:</div>
        <pre style="font-family: var(--font-mono); font-size: 0.75rem; background: rgba(0,0,0,0.5); padding: 12px; border-radius: 6px; overflow-x: auto; color: #fff; border: 1px solid var(--border-color); white-space: pre-wrap; word-break: break-all; max-height: 250px;">${escapedPayload}</pre>
      </td>
    `;
    tbody.appendChild(detailTr);
  });
}

window.togglePayloadView = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.style.display === 'none') {
    el.style.display = 'table-row';
  } else {
    el.style.display = 'none';
  }
};

function updateStatsCards(stats) {
  let displaySuccessRate = stats.successRate;
  let displayTotal = stats.total;
  let displayActiveEndpoints = stats.activeEndpoints;
  let displayAvgResponseTime = stats.avgResponseTime;
  let displayPendingRetries = stats.pendingRetries;

  // Demo data pre-load for new users (empty state)
  const isDemo = stats.total === 0;
  if (isDemo) {
    displaySuccessRate = 98.4;
    displayTotal = 1247;
    displayActiveEndpoints = stats.activeEndpoints || 3;
    displayAvgResponseTime = 142;
    displayPendingRetries = 2;
  }

  document.getElementById('val-success-rate').textContent = `${displaySuccessRate}%`;
  document.getElementById('bar-success-rate').style.width = `${displaySuccessRate}%`;

  document.getElementById('val-total-deliveries').textContent = displayTotal.toLocaleString();
  document.getElementById('val-active-endpoints').textContent = displayActiveEndpoints;
  document.getElementById('val-avg-response').textContent = `${displayAvgResponseTime} ms`;
  
  const pendingRetriesEl = document.getElementById('val-pending-retries');
  pendingRetriesEl.textContent = displayPendingRetries;
  
  const pendingCard = document.getElementById('stat-pending-card');
  if (displayPendingRetries > 0) {
    pendingCard.classList.add('border-pulse-warning');
  } else {
    pendingCard.classList.remove('border-pulse-warning');
  }

  // Update subscription card elements
  const planTierEl = document.getElementById('val-plan-tier');
  const upgradeBtn = document.getElementById('btn-upgrade-plan');
  const quotaFractionEl = document.getElementById('txt-quota-fraction');
  const quotaUsageBar = document.getElementById('bar-quota-usage');

  const tierNames = {
    free: 'Developer Free',
    pro: 'Scale Pro',
    enterprise: 'Enterprise'
  };

  const limitText = stats.quotaLimit === null || stats.quotaLimit === Infinity ? 'Unlimited' : stats.quotaLimit.toLocaleString();
  const usageText = `${(stats.monthlyUsageCount || 0).toLocaleString()} / ${limitText}`;
  
  if (planTierEl) {
    planTierEl.textContent = tierNames[stats.planTier] || stats.planTier;
    if (stats.planTier === 'pro') {
      planTierEl.style.color = '#06b6d4'; // Cyan
    } else if (stats.planTier === 'enterprise') {
      planTierEl.style.color = '#10b981'; // Green
    } else {
      planTierEl.style.color = '#fff';
    }
  }

  if (quotaFractionEl) quotaFractionEl.textContent = usageText;

  if (quotaUsageBar) {
    const pct = stats.quotaLimit && stats.quotaLimit !== Infinity
      ? Math.min(100, ((stats.monthlyUsageCount || 0) / stats.quotaLimit) * 100)
      : 0;
    quotaUsageBar.style.width = `${pct}%`;
  }

  if (upgradeBtn) {
    if (stats.planTier === 'enterprise') {
      upgradeBtn.style.display = 'none';
    } else {
      upgradeBtn.style.display = 'inline-flex';
      upgradeBtn.innerHTML = stats.planTier === 'pro'
        ? '<i data-lucide="sparkles" style="width:0.8rem;height:0.8rem"></i> To Enterprise'
        : '<i data-lucide="sparkles" style="width:0.8rem;height:0.8rem"></i> Upgrade';
    }
  }

  // Intertwine stats with canvas physics:
  // If average latency is warning level (> 150ms), particles slow down and turn amber
  if (displayAvgResponseTime > 150) {
    window.canvasConfig.speedMultiplier = 0.45;
    window.canvasConfig.baseColor = 'rgba(245, 158, 11, 0.7)'; // Warning Amber
  } else if (displaySuccessRate < 90 && displayTotal > 0) {
    window.canvasConfig.speedMultiplier = 0.8;
    window.canvasConfig.baseColor = 'rgba(244, 63, 94, 0.7)'; // Error Crimson
  } else {
    // Standard data flow physics: accelerate velocity based on volume spikes
    window.canvasConfig.speedMultiplier = 1.0 + Math.min(displayTotal / 100, 0.5);
    window.canvasConfig.baseColor = null; // Standard palette
  }

  // Update dynamic trend histories
  const finalSuccess = isDemo ? displaySuccessRate : stats.successRate;
  successHistory.push(finalSuccess);
  if (successHistory.length > 12) successHistory.shift();
  updateSparklineChart('sparkline-success', successHistory);

  const finalLatency = isDemo ? displayAvgResponseTime : (stats.avgResponseTime || (stats.total ? 100 : 0));
  latencyHistory.push(finalLatency);
  if (latencyHistory.length > 12) latencyHistory.shift();
  updateSparklineChart('sparkline-latency', latencyHistory);
}

function updateLogsStream(logs) {
  const tbody = document.getElementById('logs-stream-body');
  
  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">
          <div class="empty-state">
            <i data-lucide="activity"></i>
            <p>Trigger a simulated event to generate delivery attempts.</p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  const allCurrentChecked = logs.length > 0 && logs.every(log => selectedLogIds.has(log.id));
  document.getElementById('checkbox-select-all').checked = allCurrentChecked;

  tbody.innerHTML = '';
  logs.forEach(log => {
    const tr = document.createElement('tr');
    
    // Checkbox input HTML
    const isChecked = selectedLogIds.has(log.id) ? 'checked' : '';
    const checkboxHtml = `<td style="text-align: center;"><input type="checkbox" class="log-row-checkbox" data-log-id="${log.id}" ${isChecked} onchange="handleRowCheckboxChange(event)"></td>`;

    let statusBadge = '';
    if (log.status === 'delivered') {
      statusBadge = '<span class="badge badge-success"><i data-lucide="check-circle" style="width:0.75rem;height:0.75rem;margin-right:0.25rem"></i> OK</span>';
    } else if (log.status === 'pending') {
      statusBadge = '<span class="badge badge-warning"><i data-lucide="loader" class="animate-spin" style="width:0.75rem;height:0.75rem;margin-right:0.25rem"></i> Retrying</span>';
    } else if (log.status === 'failed') {
      statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" style="width:0.75rem;height:0.75rem;margin-right:0.25rem"></i> Fail</span>';
    } else {
      statusBadge = `<span class="badge badge-danger">${log.status}</span>`;
    }

    const respTimeStr = log.responseTime != null ? `${log.responseTime}ms` : '--';
    const codeStr = log.statusCode != null ? log.statusCode : '--';
    let codeClass = '';
    if (log.statusCode >= 200 && log.statusCode < 300) codeClass = 'code-success';
    else if (log.statusCode) codeClass = 'code-error';

    tr.innerHTML = `
      ${checkboxHtml}
      <td>${statusBadge}</td>
      <td><div class="endpoint-cell" title="${escapeHtml(log.endpointId)}">${escapeHtml(log.endpointId)}</div></td>
      <td><span class="badge badge-purple">${escapeHtml(log.event)}</span></td>
      <td><span class="payload-id-cell">${escapeHtml(log.payloadId)}</span></td>
      <td class="attempt-cell">${log.attempt}</td>
      <td class="time-cell text-muted">${respTimeStr}</td>
      <td class="code-cell ${codeClass}">${codeStr}</td>
      <td class="log-actions-cell">
        <button class="btn-inspect" onclick="inspectLog('${log.id}')">
          <i data-lucide="info" style="width:0.75rem;height:0.75rem"></i> View
        </button>
        ${(log.status === 'failed' || log.status === 'error' || log.status === 'circuit_open') ? `
        <button class="btn-replay" onclick="replayDelivery('${log.id}')" title="Replay this delivery">
          <i data-lucide="refresh-cw" style="width:0.75rem;height:0.75rem"></i> Replay
        </button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });

  lucide.createIcons();
}



window.inspectLog = function(logId) {
  const log = logsDatabase.find(l => l.id === logId);
  if (!log) return;

  const modal = document.getElementById('modal-inspector');
  const body = document.getElementById('inspector-body');
  
  let responseBlock = '';
  if (log.status === 'delivered') {
    responseBlock = `<div class="badge badge-success">Delivered Successfully</div>`;
  } else if (log.status === 'error') {
    responseBlock = `
      <div class="badge badge-danger">Connection Error</div>
      <div class="terminal-json" style="color:var(--danger); border-color:var(--danger-light)">
        ${escapeHtml(log.error || 'Unknown network error')}
      </div>
    `;
  } else {
    responseBlock = `<div class="badge badge-danger">Status Code: ${log.statusCode || 'Unknown'}</div>`;
  }

  const responseBodyText = log.responseBody 
    ? `<pre class="terminal-json">${escapeHtml(log.responseBody)}</pre>`
    : `<span class="text-muted">Empty response payload</span>`;

  // Determine integration display badge
  let integBadge = '';
  if (log.integration === 'slack') {
    integBadge = '<span class="badge badge-slack">Slack Blocks</span>';
  } else if (log.integration === 'discord') {
    integBadge = '<span class="badge badge-discord">Discord Embed</span>';
  } else {
    integBadge = '<span class="badge badge-purple">Standard Webhook</span>';
  }

  body.innerHTML = `
    <div class="inspector-grid">
      <div class="inspector-row">
        <span class="inspector-label">Delivery ID</span>
        <span class="inspector-val mono">${log.id}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Endpoint ID</span>
        <span class="inspector-val mono">${escapeHtml(log.endpointId)}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Format Type</span>
        <span class="inspector-val">${integBadge}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Target URL</span>
        <span class="inspector-val mono" style="color:var(--cyan)">${escapeHtml(log.url)}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Event Stream</span>
        <span class="inspector-val"><span class="badge badge-purple">${escapeHtml(log.event)}</span></span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Payload ID</span>
        <span class="inspector-val mono">${log.payloadId}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Signature Header</span>
        <span class="inspector-val mono" style="font-size:0.75rem">${log.signature || 'None (Slack/Discord integration)'}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Idempotency Key</span>
        <span class="inspector-val mono" style="font-size:0.75rem">${log.idempotencyKey || 'N/A'}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Outbound Headers</span>
        <span class="inspector-val">
          ${log.requestHeaders && Object.keys(log.requestHeaders).length > 0
            ? `<pre class="terminal-json" style="font-size:0.7rem;max-height:80px">${escapeHtml(JSON.stringify(log.requestHeaders, null, 2))}</pre>`
            : '<span class="text-muted">None configured</span>'}
        </span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Attempt Count</span>
        <span class="inspector-val"><strong>${log.attempt}</strong></span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Timestamp</span>
        <span class="inspector-val">${new Date(log.timestamp).toLocaleString()}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Delivery Result</span>
        <span class="inspector-val">${responseBlock}</span>
      </div>
      <div class="inspector-row">
        <span class="inspector-label">Response Payload</span>
        <span class="inspector-val">${responseBodyText}</span>
      </div>
    </div>
  `;

  modal.classList.add('active');
  lucide.createIcons();
};

window.replayDelivery = async function(logId) {
  const btn = event?.target?.closest?.('.btn-replay');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width:0.75rem;height:0.75rem"></i> Replaying...';
    lucide.createIcons();
  }
  try {
    const res = await sandboxGuard('replay-delivery', () =>
      fetch(`/api/logs/${logId}/replay`, { method: 'POST' })
    );
    if (!res) return;
    if (res.ok) {
      // Trigger canvas burst celebration
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      // Spawn confetti from the button position
      if (btn) spawnConfetti(btn);
      // Refresh log table
      setTimeout(pollDashboard, 200);
    } else {
      const err = await res.json();
      alert(`Replay failed: ${err.error}`);
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="refresh-cw" style="width:0.75rem;height:0.75rem"></i> Replay';
      lucide.createIcons();
    }
  }
};

function closeModal() {
  document.getElementById('modal-inspector').classList.remove('active');
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function handleUpgradeClick() {
  if (window._sandboxMode) {
    alert('Demo mode — create a free account to save changes');
    return;
  }
  const btn = document.getElementById('btn-upgrade-plan');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Initializing...';
  
  try {
    const statsRes = await apiFetch('/api/stats');
    const stats = await statsRes.json();
    const nextPlan = stats.planTier === 'pro' ? 'plan_ent_003' : 'plan_pro_002';

    const res = await apiFetch('/api/billing/create-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: nextPlan })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`Checkout initialization failed: ${data.error || 'Server error'}`);
      return;
    }

    if (data.isSimulated) {
      // Load sandbox mockup popup
      openMockCheckout(data.subscriptionId, nextPlan);
    } else {
      // Load real Razorpay SDK checkout frame options
      const options = {
        key: data.razorpayKeyId,
        subscription_id: data.subscriptionId,
        name: "WebhookEngine Pro",
        description: "Unlocking High-Throughput Stream Routing",
        prefill: {
          email: data.userEmail
        },
        theme: {
          color: "#0070f3"
        },
        handler: function (transactionResult) {
          if (window.triggerCanvasBurst) window.triggerCanvasBurst();
          alert('Payment Authorized! Provisioning subscription plan...');
          setTimeout(() => pollDashboard(), 2500);
        }
      };

      const rzp = new Razorpay(options);
      rzp.open();
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function openMockCheckout(subscriptionId, planId) {
  const overlay = document.createElement('div');
  overlay.id = 'mock-checkout-overlay';
  overlay.style = `
    position: fixed;
    top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(10, 10, 15, 0.75);
    backdrop-filter: blur(12px);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  const box = document.createElement('div');
  box.style = `
    background: rgba(20, 20, 30, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    width: 380px;
    padding: 30px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    text-align: center;
    transform: scale(0.9);
    transition: transform 0.3s ease;
    position: relative;
    font-family: 'Outfit', sans-serif;
  `;

  const isPro = planId === 'plan_pro_002';
  const planName = isPro ? 'Scale Pro' : 'Enterprise';
  const priceText = isPro ? '$29.00 / mo' : '$199.00 / mo';
  const priceVal = isPro ? '$29.00' : '$199.00';

  box.innerHTML = `
    <div style="background: rgba(0, 112, 243, 0.1); width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;">
      <i data-lucide="credit-card" style="width: 28px; height: 28px; color: #0070f3;"></i>
    </div>
    <h3 style="color: #fff; font-size: 1.4rem; margin-bottom: 8px; font-weight:600;">Upgrade to ${planName}</h3>
    <p style="color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-bottom: 24px; line-height: 1.4;">
      Checkout instance reference:<br>
      <code style="color: #06b6d4; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;">${subscriptionId}</code>
    </p>
    
    <div style="background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; padding: 16px; margin-bottom: 24px; text-align: left;">
      <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: rgba(255, 255, 255, 0.6); margin-bottom: 8px;">
        <span>${planName} Plan</span>
        <span style="color: #fff; font-weight: 600;">${priceText}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: rgba(255, 255, 255, 0.6);">
        <span>Developer Setup</span>
        <span style="color: #10b981; font-weight: 600;">Free</span>
      </div>
      <div style="border-top: 1px solid rgba(255,255,255,0.1); margin-top: 12px; padding-top: 12px; display: flex; justify-content: space-between; font-size: 1rem; color: #fff; font-weight: 700;">
        <span>Payment Amount</span>
        <span>${priceVal}</span>
      </div>
    </div>
    
    <button type="button" id="btn-mock-pay" style="width: 100%; padding: 14px; background: linear-gradient(135deg, #0070f3 0%, #06b6d4 100%); border: none; border-radius: 8px; color: #fff; font-family: inherit; font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px;">
      <i data-lucide="check" style="width:1.1rem;height:1.1rem"></i> Complete Sandbox Payment
    </button>
    <button type="button" id="btn-mock-cancel" style="background: none; border: none; color: rgba(255, 255, 255, 0.4); cursor: pointer; margin-top: 15px; font-size: 0.85rem; font-family: inherit; font-weight:500;">
      Cancel Checkout
    </button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = 1;
    box.style.transform = 'scale(1)';
  }, 10);

  if (typeof lucide !== 'undefined') lucide.createIcons();

  const payBtn = box.querySelector('#btn-mock-pay');
  const cancelBtn = box.querySelector('#btn-mock-cancel');

  payBtn.addEventListener('click', async () => {
    payBtn.disabled = true;
    payBtn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width:1.1rem;height:1.1rem"></i> Validating with Razorpay Sandbox...';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    
    try {
      const res = await apiFetch('/api/billing/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'subscription.activated',
          subscriptionId: subscriptionId,
          planId: planId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        payBtn.style.background = '#10b981';
        payBtn.innerHTML = '<i data-lucide="check-circle" style="width:1.1rem;height:1.1rem"></i> Sandbox Authorized!';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        
        if (window.triggerCanvasBurst) window.triggerCanvasBurst();
        spawnConfetti(payBtn);

        setTimeout(() => {
          closeOverlay();
          pollDashboard();
        }, 1500);
      } else {
        alert('Billing simulator failed: ' + (data.error || 'Server error'));
        payBtn.disabled = false;
        payBtn.innerHTML = '<i data-lucide="check" style="width:1.1rem;height:1.1rem"></i> Complete Sandbox Payment';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    } catch (err) {
      alert('Sandbox error: ' + err.message);
      payBtn.disabled = false;
      payBtn.innerHTML = '<i data-lucide="check" style="width:1.1rem;height:1.1rem"></i> Complete Sandbox Payment';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  });

  cancelBtn.addEventListener('click', closeOverlay);

  function closeOverlay() {
    overlay.style.opacity = 0;
    box.style.transform = 'scale(0.9)';
    setTimeout(() => {
      if (overlay.parentNode) document.body.removeChild(overlay);
    }, 300);
  }
}

function updateBillingUsagePanel(usage) {
  const card = document.getElementById('billing-monitor-card');
  const planDisplay = document.getElementById('display-plan-tier');
  const badgeStatus = document.getElementById('badge-status');
  const upgradeBtn = document.getElementById('billing-upgrade-btn');
  const alertBanner = document.getElementById('usage-alert-banner');
  const progressBar = document.getElementById('usage-progress-bar');
  const usageCurrent = document.getElementById('usage-current');
  const usageMax = document.getElementById('usage-max');
  const resetDateDisplay = document.getElementById('usage-reset-date');

  if (!card) return;

  // Reveal container card
  card.style.display = 'block';

  // Update Raw Text Fields
  const planNames = {
    free: 'Developer Free',
    pro: 'Scale Pro',
    enterprise: 'Enterprise'
  };
  if (planDisplay) {
    planDisplay.textContent = planNames[usage.planTier] || usage.planTier;
  }
  if (usageCurrent) usageCurrent.textContent = usage.monthlyUsageCount.toLocaleString();
  if (usageMax) usageMax.textContent = typeof usage.maxLimit === 'number' ? usage.maxLimit.toLocaleString() : usage.maxLimit;
  
  if (resetDateDisplay) {
    const formattedDate = new Date(usage.quotaResetDate).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    resetDateDisplay.textContent = formattedDate;
  }

  // Evaluate Subscription State Badges
  if (badgeStatus) {
    if (usage.subscriptionStatus === 'halted') {
      badgeStatus.textContent = 'Delinquent';
      badgeStatus.style = 'padding: 3px 8px; font-size: 0.75rem; border-radius: 4px; background: rgba(244, 63, 94, 0.15); border: 1px solid rgba(244, 63, 94, 0.3); color: #f43f5e; font-weight: 600; text-transform: uppercase;';
    } else {
      badgeStatus.textContent = usage.subscriptionStatus.toUpperCase();
      badgeStatus.style = 'padding: 3px 8px; font-size: 0.75rem; border-radius: 4px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #10b981; font-weight: 600; text-transform: uppercase;';
    }
  }

  // Toggle Upgrade Button Visibility based on tier
  if (upgradeBtn) {
    if (usage.planTier === 'free') {
      upgradeBtn.style.display = 'inline-flex';
    } else {
      upgradeBtn.style.display = 'none';
    }
  }

  // Update Progress Bar Scaling
  const pct = usage.percentageUsed;
  if (progressBar) {
    progressBar.style.width = `${pct}%`;
  }

  const billingWarningAlert = document.getElementById('billing-warning-alert');
  const billingWarningText = document.getElementById('billing-warning-text');
  const billingExhaustedAlert = document.getElementById('billing-exhausted-alert');

  // 🚦 Dynamic Threshold Enforcement States
  if (pct >= 100) {
    // RED STATE: Quota Completely Exhausted
    if (progressBar) progressBar.style.background = 'linear-gradient(90deg, #f43f5e, #e11d48)';
    if (alertBanner) {
      alertBanner.innerHTML = `🛑 <strong>Quota Exhausted!</strong> Service suspended. Please upgrade plan parameters to restore pipeline processing instantly.`;
      alertBanner.style = 'display: block; padding: 10px 14px; border-radius: 6px; font-size: 0.8rem; margin-bottom: 15px; border: 1px solid rgba(244, 63, 94, 0.3); background: rgba(244, 63, 94, 0.12); color: #f43f5e;';
    }
    if (billingExhaustedAlert) billingExhaustedAlert.style.display = 'flex';
    if (billingWarningAlert) billingWarningAlert.style.display = 'none';
    toggleDashboardLockdown(true);
  } else if (pct >= 80) {
    // AMBER STATE: High Resource Warning Buffer
    if (progressBar) progressBar.style.background = 'linear-gradient(90deg, #fbbf24, #f59e0b)';
    if (alertBanner) {
      alertBanner.innerHTML = `⚠️ <strong>Quota Warning:</strong> Your workspace has consumed over 80% of its monthly allocation. Upgrade to prevent automatic delivery blocking.`;
      alertBanner.style = 'display: block; padding: 10px 14px; border-radius: 6px; font-size: 0.8rem; margin-bottom: 15px; border: 1px solid rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.12); color: #fbbf24;';
    }
    if (billingWarningAlert) {
      billingWarningAlert.style.display = 'flex';
      if (billingWarningText) {
        billingWarningText.textContent = `Warning: You have consumed ${pct}% of your free allocation. Upgrade now to prevent immediate service disruption.`;
      }
    }
    if (billingExhaustedAlert) billingExhaustedAlert.style.display = 'none';
    toggleDashboardLockdown(false);
  } else {
    // COBALT BLUE STATE: Normal Operations Within Quota Bounds
    if (progressBar) progressBar.style.background = 'linear-gradient(90deg, #0070f3, #06b6d4)';
    if (alertBanner) alertBanner.style.display = 'none';
    if (billingWarningAlert) billingWarningAlert.style.display = 'none';
    if (billingExhaustedAlert) billingExhaustedAlert.style.display = 'none';
    toggleDashboardLockdown(false);
  }
}

function toggleDashboardLockdown(locked) {
  // Disable Form Inputs
  const inputs = document.querySelectorAll('#form-register-endpoint input, #form-register-endpoint select, #form-register-endpoint button');
  inputs.forEach(el => el.disabled = locked);
  
  // Disable Event trigger buttons
  const fireBtn = document.getElementById('btn-fire-event');
  if (fireBtn) fireBtn.disabled = locked;
  const payloadInput = document.getElementById('event-payload');
  if (payloadInput) payloadInput.disabled = locked;
  const eventNameInput = document.getElementById('event-name');
  if (eventNameInput) eventNameInput.disabled = locked;

  // Disable action buttons in lists
  const actionBtns = document.querySelectorAll('.ep-actions button, .ep-actions input, .btn-replay, .log-row-checkbox, #checkbox-select-all, #btn-bulk-redrive-open');
  actionBtns.forEach(el => el.disabled = locked);
}

// ==========================================================================
// Checkbox Selection & Bulk Redrive Actions
// ==========================================================================

window.handleRowCheckboxChange = function(e) {
  const logId = e.target.getAttribute('data-log-id');
  if (e.target.checked) {
    selectedLogIds.add(logId);
  } else {
    selectedLogIds.delete(logId);
  }
  updateBulkActionBar();
};

function handleSelectAllChange(e) {
  const checked = e.target.checked;
  const rowCheckboxes = document.querySelectorAll('.log-row-checkbox');
  rowCheckboxes.forEach(cb => {
    const logId = cb.getAttribute('data-log-id');
    cb.checked = checked;
    if (checked) {
      selectedLogIds.add(logId);
    } else {
      selectedLogIds.delete(logId);
    }
  });
  updateBulkActionBar();
}

function clearLogSelection() {
  selectedLogIds.clear();
  const selectAll = document.getElementById('checkbox-select-all');
  if (selectAll) selectAll.checked = false;
  document.querySelectorAll('.log-row-checkbox').forEach(cb => cb.checked = false);
  updateBulkActionBar();
}

function updateBulkActionBar() {
  const bar = document.getElementById('bulk-action-bar');
  const countEl = document.getElementById('bulk-selected-count');
  
  if (selectedLogIds.size > 0) {
    if (countEl) countEl.textContent = `${selectedLogIds.size} ${selectedLogIds.size === 1 ? 'item' : 'items'} selected`;
    if (bar) bar.style.display = 'flex';
  } else {
    if (bar) bar.style.display = 'none';
  }
}

async function handleRedriveSelected() {
  const btn = document.getElementById('btn-bulk-redrive-selected');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width:0.8rem;height:0.8rem"></i> Redriving...';
  lucide.createIcons();

  const deliveryIds = Array.from(selectedLogIds);

  try {
    const res = await sandboxGuard('redrive-selected', () =>
      apiFetch('/api/logs/bulk-replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryIds })
      })
    );
    if (!res) return;

    const data = await res.json();
    if (res.ok) {
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      spawnConfetti(btn);
      clearLogSelection();
      setTimeout(pollDashboard, 200);
    } else {
      alert(`Redrive failed: ${data.error || 'Server error'}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    lucide.createIcons();
  }
}

// Filter-Based Modal Logic
async function openBulkRedriveModal() {
  const modal = document.getElementById('modal-bulk-redrive');
  if (!modal) return;
  
  // Populate the endpoints dropdown
  try {
    const res = await apiFetch('/api/endpoints');
    const endpoints = await res.json();
    const select = document.getElementById('bulk-redrive-endpoint');
    if (select) {
      select.innerHTML = '<option value="">All Endpoints</option>';
      endpoints.forEach(ep => {
        const opt = document.createElement('option');
        opt.value = ep.id;
        opt.textContent = `${ep.id} (${ep.url.slice(0, 40)}...)`;
        select.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to load endpoints for modal:', err);
  }

  // Reset fields
  document.getElementById('bulk-redrive-endpoint').value = '';
  document.getElementById('bulk-redrive-status').value = '';
  document.getElementById('bulk-redrive-range').value = 'all';
  document.getElementById('bulk-redrive-custom-dates').style.display = 'none';
  document.getElementById('bulk-redrive-since').value = '';
  document.getElementById('bulk-redrive-before').value = '';
  document.getElementById('bulk-redrive-matched-info').textContent = '';

  modal.classList.add('active');
  lucide.createIcons();
}

function closeBulkRedriveModal() {
  const modal = document.getElementById('modal-bulk-redrive');
  if (modal) modal.classList.remove('active');
}

function handleBulkRangeChange(e) {
  const showCustom = e.target.value === 'custom';
  const customDates = document.getElementById('bulk-redrive-custom-dates');
  if (customDates) customDates.style.display = showCustom ? 'grid' : 'none';
}

async function handleBulkRedriveSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-trigger-bulk-redrive');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width:1rem;height:1rem"></i> Redriving...';
  lucide.createIcons();

  const endpointId = document.getElementById('bulk-redrive-endpoint').value;
  const status = document.getElementById('bulk-redrive-status').value;
  const range = document.getElementById('bulk-redrive-range').value;
  
  let since = null;
  let before = null;

  if (range === 'custom') {
    const sinceVal = document.getElementById('bulk-redrive-since').value;
    const beforeVal = document.getElementById('bulk-redrive-before').value;
    if (sinceVal) since = new Date(sinceVal).toISOString();
    if (beforeVal) before = new Date(beforeVal).toISOString();
  } else if (range !== 'all') {
    const mins = range === '15m' ? 15 : (range === '1h' ? 60 : (range === '4h' ? 240 : 1440));
    since = new Date(Date.now() - mins * 60 * 1000).toISOString();
  }

  try {
    const res = await sandboxGuard('bulk-redrive', () =>
      apiFetch('/api/logs/bulk-replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointId, status, since, before })
      })
    );
    if (!res) return;

    const data = await res.json();
    if (res.ok) {
      closeBulkRedriveModal();
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      spawnConfetti(btn);
      setTimeout(pollDashboard, 200);
      alert(`Successfully triggered bulk redrive for ${data.count} event(s)!`);
    } else {
      alert(`Bulk redrive failed: ${data.error || 'Server error'}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    lucide.createIcons();
  }
}

window.handleBulkRedriveExecution = async function() {
  const btn = document.getElementById('btn-trigger-bulk-redrive');
  const startTime = document.getElementById('bulk-start-time').value;
  const endTime = document.getElementById('bulk-end-time').value;
  const filterStatus = document.getElementById('bulk-filter-status').value;

  if (!startTime || !endTime) {
    alert("Please select both start and end boundary times to target redrive constraints.");
    return;
  }

  const confirmAction = confirm("Are you sure you want to mass-replay matching webhook failures within this time window?");
  if (!confirmAction) return;

  // Set visual loading lock state
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="animate-spin" style="width:1rem;height:1rem;margin-right:6px;"></i> Queuing Replays...`;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const response = await sandboxGuard('bulk-retry', () =>
      apiFetch('/api/logs/bulk-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          filterStatus: filterStatus || null
        })
      })
    );
    if (!response) return;

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to process batch routing request.");

    if (data.count === 0) {
      alert("No failed webhook logs found matching those metrics.");
    } else {
      alert(`Success! ${data.count} events have been dispatched to background workers.`);
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      spawnConfetti(btn);
      setTimeout(pollDashboard, 200);
    }

  } catch (err) {
    console.error("Bulk redrive error context:", err);
    alert(`Bulk Redrive Failed: ${err.message}`);
  } finally {
    // Unstick UI Action Button state
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

async function loadAlertSettings() {
  try {
    const res = await apiFetch('/api/org/alert-settings');
    if (!res.ok) return;
    const data = await res.json();
    if (data.alertConfig) {
      const config = data.alertConfig;
      document.getElementById('alert-slack-url').value = config.slackWebhookUrl || '';
      document.getElementById('alert-pd-key').value = config.pagerDutyRoutingKey || '';
      document.getElementById('alert-failure-count').value = config.notifyOnFailureCount || 3;
      document.getElementById('alert-enabled').checked = config.enabled !== false;
    }
  } catch (err) {
    console.error('Failed to load alert settings:', err);
  }
}

async function handleSaveAlertSettings(e) {
  e.preventDefault();
  
  const slackWebhookUrl = document.getElementById('alert-slack-url').value.trim();
  const pagerDutyRoutingKey = document.getElementById('alert-pd-key').value.trim();
  const notifyOnFailureCount = parseInt(document.getElementById('alert-failure-count').value, 10) || 3;
  const enabled = document.getElementById('alert-enabled').checked;

  const btn = document.getElementById('btn-save-alerts');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await sandboxGuard('save-alert-settings', () =>
      apiFetch('/api/org/alert-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackWebhookUrl, pagerDutyRoutingKey, notifyOnFailureCount, enabled })
      })
    );
    if (!res) return;

    if (res.ok) {
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      spawnConfetti(btn);
      alert('Alert settings saved successfully!');
    } else {
      const data = await res.json();
      alert(`Failed to save settings: ${data.error || 'Server error'}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

async function handleTestAlertSettings() {
  const slackWebhookUrl = document.getElementById('alert-slack-url').value.trim();
  const pagerDutyRoutingKey = document.getElementById('alert-pd-key').value.trim();

  if (!slackWebhookUrl && !pagerDutyRoutingKey) {
    alert('Please provide a Slack Webhook URL or PagerDuty Routing Key to test integration.');
    return;
  }

  const btn = document.getElementById('btn-test-alerts');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    const res = await sandboxGuard('test-alert-settings', () =>
      apiFetch('/api/org/alert-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackWebhookUrl, pagerDutyRoutingKey })
      })
    );
    if (!res) return;

    if (res.ok) {
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      spawnConfetti(btn);
      alert('Simulated test alert dispatched successfully!');
    } else {
      const data = await res.json();
      alert(`Test alert dispatch failed: ${data.error || 'Server error'}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

async function handleTestTransformDryRun() {
  const scriptString = document.getElementById('ep-transform-script').value;
  const payloadRaw = document.getElementById('event-payload').value;
  const resultBox = document.getElementById('transform-dry-run-result');

  if (!resultBox) return;

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (err) {
    resultBox.style.display = 'block';
    resultBox.style.borderColor = 'rgba(244, 63, 94, 0.4)';
    resultBox.style.color = '#f43f5e';
    resultBox.textContent = `Error: Simulator Payload is not valid JSON.\n${err.message}`;
    return;
  }

  const btn = document.getElementById('btn-test-transform-dry-run');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="animate-spin" style="width:0.75rem;height:0.75rem"></i> Running...`;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const res = await sandboxGuard('test-transformation', () =>
      apiFetch('/api/endpoints/test-transformation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, scriptString })
      })
    );
    if (!res) return;

    const data = await res.json();
    resultBox.style.display = 'block';

    if (res.ok && data.success) {
      resultBox.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      resultBox.style.color = '#10b981';
      resultBox.textContent = `Transformation Success:\n${JSON.stringify(data.transformedPayload, null, 2)}`;
      if (window.triggerCanvasBurst) window.triggerCanvasBurst();
      spawnConfetti(btn);
    } else {
      resultBox.style.borderColor = 'rgba(244, 63, 94, 0.4)';
      resultBox.style.color = '#f43f5e';
      resultBox.textContent = `Transformation Error:\n${data.error || 'Server error'}`;
    }
  } catch (err) {
    resultBox.style.display = 'block';
    resultBox.style.borderColor = 'rgba(244, 63, 94, 0.4)';
    resultBox.style.color = '#f43f5e';
    resultBox.textContent = `Network Error:\n${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

