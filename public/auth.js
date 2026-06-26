'use strict';

/**
 * auth.js — Frontend multi-tenant authentication controller
 *
 * - Authenticates requests via secure HttpOnly cookies set by backend session
 * - Exposes apiFetch() as a wrapper that automatically bubbles up 401s to lock the console
 * - Handles dual-tabbed Sign In / Sign Up form views
 * - Supports session check on load and page logout
 */

(function () {
  const SESSION_KEY = 'whe_api_key';
  let _apiKey = sessionStorage.getItem(SESSION_KEY) || '';
  let generatedKey = '';

  function updateAdminUI(email) {
    const billingSim = document.getElementById('billing-simulator-panel');
    if (billingSim) {
      if (email === 'admin@localhost') {
        billingSim.style.display = 'block';
      } else {
        billingSim.style.display = 'none';
      }
    }
  }

  // ── Public apiFetch wrapper ─────────────────────────────────────────────────
  window.apiFetch = async function (url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (_apiKey) headers['X-API-Key'] = _apiKey;

    const res = await fetch(url, { ...options, headers });

    if (res.status === 401) {
      window._authToken = null;
      // Session cookie or API key rejected — force re-auth
      _apiKey = '';
      sessionStorage.removeItem(SESSION_KEY);
      
      const logoutBtn = document.getElementById('btn-logout');
      if (logoutBtn) logoutBtn.style.display = 'none';
      
      const modal = document.getElementById('modal-auth');
      const isModalActive = modal && modal.classList.contains('active');
      if (!isModalActive) {
        showAuthModal('Your session has expired. Please sign in again.');
      }
      throw new Error('Unauthorized — session expired');
    }

    return res;
  };

  // ── Auth Modal ──────────────────────────────────────────────────────────────
  function showAuthModal(errorMsg = '') {
    const modal = document.getElementById('modal-auth');
    if (!modal) return;

    const errEl = document.getElementById('auth-error-msg');
    if (errEl) errEl.textContent = errorMsg;

    modal.classList.add('active');

    // Reset onboarding view states
    generatedKey = '';
    const display = document.getElementById('auth-creds-display');
    if (display) display.style.display = 'none';
    const onboardBtn = document.getElementById('auth-onboard-btn');
    if (onboardBtn) {
      onboardBtn.innerHTML = '<i data-lucide="user-plus" style="width:1rem;height:1rem;margin-right:6px;"></i> Create Free Account';
      onboardBtn.disabled = false;
    }
    const emailSignup = document.getElementById('auth-email-signup');
    const passwordSignup = document.getElementById('auth-password-signup');
    if (emailSignup) emailSignup.value = '';
    if (passwordSignup) passwordSignup.value = '';

    // Focus login email
    setTimeout(() => {
      const emailLogin = document.getElementById('auth-email-login');
      if (emailLogin) emailLogin.focus();
    }, 120);
  }

  function hideAuthModal() {
    const modal = document.getElementById('modal-auth');
    if (modal) modal.classList.remove('active');
  }

  // ── Submit handler: Log In ──────────────────────────────────────────────────
  async function handleAuthSubmit() {
    const emailInput = document.getElementById('auth-email-login');
    const passwordInput = document.getElementById('auth-password-login');
    const btn   = document.getElementById('auth-submit-btn');
    const errEl = document.getElementById('auth-error-msg');
    
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!email || !password) {
      if (errEl) errEl.textContent = 'Please enter your email and password.';
      shakeModal();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Signing In...'; }
    if (errEl) errEl.textContent = '';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        window._sandboxMode = false;
        sessionStorage.removeItem('webhookengine_sandbox');
        window._authToken = data.apiKey || 'session_active';
        hideAuthModal();
        const logoutBtn = document.getElementById('btn-logout');
        if (logoutBtn) logoutBtn.style.display = 'flex';
        
        updateAdminUI(data.email);

        // Trigger dashboard reload
        if (typeof fetchEndpoints === 'function') fetchEndpoints();
        if (typeof pollDashboard  === 'function') pollDashboard();
        if (typeof loadSecurityPanel === 'function') loadSecurityPanel();
        if (typeof loadAlertSettings === 'function') loadAlertSettings();
      } else {
        if (errEl) errEl.textContent = data.error || 'Invalid email or password.';
        shakeModal();
      }
    } catch (e) {
      if (errEl) errEl.textContent = 'Network error. Is the server running?';
      shakeModal();
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="unlock" style="width:1rem;height:1rem;margin-right:6px;"></i> Sign In'; }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  // ── Submit handler: Onboard / Sign Up ────────────────────────────────────────
  async function handleOnboardSubmit() {
    const emailInput = document.getElementById('auth-email-signup');
    const passwordInput = document.getElementById('auth-password-signup');
    const btn = document.getElementById('auth-onboard-btn');
    const errEl = document.getElementById('onboard-error-msg');

    if (generatedKey) {
      // Key was already generated, user clicked "Continue to Dashboard"
      window._sandboxMode = false;
      sessionStorage.removeItem('webhookengine_sandbox');
      window._authToken = generatedKey || 'session_active';
      hideAuthModal();
      const logoutBtn = document.getElementById('btn-logout');
      if (logoutBtn) logoutBtn.style.display = 'flex';
      
      const emailInput = document.getElementById('auth-email-signup');
      const email = emailInput ? emailInput.value.trim() : '';
      updateAdminUI(email);
      
      if (typeof fetchEndpoints === 'function') fetchEndpoints();
      if (typeof pollDashboard  === 'function') pollDashboard();
      if (typeof loadSecurityPanel === 'function') loadSecurityPanel();
      if (typeof loadAlertSettings === 'function') loadAlertSettings();
      return;
    }

    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!email || !email.includes('@')) {
      if (errEl) errEl.textContent = 'Please enter a valid email address.';
      shakeModal();
      return;
    }
    if (!password || password.length < 6) {
      if (errEl) errEl.textContent = 'Password must be at least 6 characters.';
      shakeModal();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Creating Account...'; }
    if (errEl) errEl.textContent = '';

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        generatedKey = data.apiKey;
        
        // Show credentials display
        const display = document.getElementById('auth-creds-display');
        const keyVal = document.getElementById('auth-new-key-val');
        if (display) display.style.display = 'block';
        if (keyVal) keyVal.textContent = data.apiKey;
        
        // Update button to proceed
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i data-lucide="arrow-right" style="width:1rem;height:1rem;margin-right:6px;"></i> Continue to Dashboard';
        }
      } else {
        if (errEl) errEl.textContent = data.error || 'Registration failed. Try again.';
        shakeModal();
      }
    } catch (e) {
      if (errEl) errEl.textContent = 'Network error. Is the server running?';
      shakeModal();
    } finally {
      if (!generatedKey && btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="user-plus" style="width:1rem;height:1rem;margin-right:6px;"></i> Create Free Account'; }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  function shakeModal() {
    const box = document.getElementById('auth-modal-box');
    if (!box) return;
    box.classList.remove('shake');
    void box.offsetWidth; // reflow
    box.classList.add('shake');
  }

  // ── Check session state on load ──────────────────────────────────────────────
  async function checkAuthOnLoad() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok && res.status === 200) {
        const data = await res.json();
        window._authToken = data.apiKey || 'session_active';
        // Automatically bypass lock modal if session is active
        hideAuthModal();
        const logoutBtn = document.getElementById('btn-logout');
        if (logoutBtn) logoutBtn.style.display = 'flex';
        
        updateAdminUI(data.email);
        
        if (typeof fetchEndpoints === 'function') fetchEndpoints();
        if (typeof pollDashboard  === 'function') pollDashboard();
        if (typeof loadSecurityPanel === 'function') loadSecurityPanel();
        if (typeof loadAlertSettings === 'function') loadAlertSettings();
        return;
      }
    } catch (err) {
      // not logged in or network issue
    }

    window._authToken = null;
    showAuthModal();
  }

  // ── Wire up listeners on DOM ready ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const submitBtn = document.getElementById('auth-submit-btn');
    const emailLogin = document.getElementById('auth-email-login');
    const passwordLogin = document.getElementById('auth-password-login');
    
    const onboardBtn = document.getElementById('auth-onboard-btn');
    const emailSignup = document.getElementById('auth-email-signup');
    const passwordSignup = document.getElementById('auth-password-signup');
    
    const tabLogin   = document.getElementById('tab-login');
    const tabOnboard = document.getElementById('tab-onboard');
    const paneLogin  = document.getElementById('pane-login');
    const paneOnboard = document.getElementById('pane-onboard');
    const copyBtn    = document.getElementById('btn-copy-new-key');
    const logoutBtn  = document.getElementById('btn-logout');

    if (submitBtn) submitBtn.addEventListener('click', handleAuthSubmit);
    
    const triggerLoginOnEnter = (e) => { if (e.key === 'Enter') handleAuthSubmit(); };
    if (emailLogin) emailLogin.addEventListener('keydown', triggerLoginOnEnter);
    if (passwordLogin) passwordLogin.addEventListener('keydown', triggerLoginOnEnter);

    if (onboardBtn) onboardBtn.addEventListener('click', handleOnboardSubmit);
    
    const triggerSignupOnEnter = (e) => { if (e.key === 'Enter') handleOnboardSubmit(); };
    if (emailSignup) emailSignup.addEventListener('keydown', triggerSignupOnEnter);
    if (passwordSignup) passwordSignup.addEventListener('keydown', triggerSignupOnEnter);

    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        window._authToken = null;
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } catch (err) {}
        window.location.reload();
      });
    }

    if (tabLogin && tabOnboard) {
      tabLogin.addEventListener('click', () => {
        tabLogin.classList.add('active');
        tabLogin.style.borderBottom = '2px solid #0070f3';
        tabLogin.style.color = '#fff';
        
        tabOnboard.classList.remove('active');
        tabOnboard.style.borderBottom = 'none';
        tabOnboard.style.color = 'rgba(255,255,255,0.6)';
        
        if (paneLogin) paneLogin.style.display = 'block';
        if (paneOnboard) paneOnboard.style.display = 'none';
        
        // Focus login email
        if (emailLogin) emailLogin.focus();
      });

      tabOnboard.addEventListener('click', () => {
        tabOnboard.classList.add('active');
        tabOnboard.style.borderBottom = '2px solid #0070f3';
        tabOnboard.style.color = '#fff';
        
        tabLogin.classList.remove('active');
        tabLogin.style.borderBottom = 'none';
        tabLogin.style.color = 'rgba(255,255,255,0.6)';
        
        if (paneOnboard) paneOnboard.style.display = 'block';
        if (paneLogin) paneLogin.style.display = 'none';
        
        // Focus signup email
        if (emailSignup) emailSignup.focus();
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const keyVal = document.getElementById('auth-new-key-val');
        if (keyVal && keyVal.textContent) {
          navigator.clipboard.writeText(keyVal.textContent).then(() => {
            copyBtn.innerHTML = '<i data-lucide="check" style="width: 0.9rem; height: 0.9rem; color: #10b981;"></i>';
            setTimeout(() => {
              copyBtn.innerHTML = '<i data-lucide="copy" style="width: 0.9rem; height: 0.9rem;"></i>';
              if (typeof lucide !== 'undefined') lucide.createIcons();
            }, 1500);
            if (typeof lucide !== 'undefined') lucide.createIcons();
          });
        }
      });
    }

    checkAuthOnLoad();
  });
})();
