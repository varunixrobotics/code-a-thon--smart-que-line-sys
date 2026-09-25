import { mountThemeSwitcher, getTheme } from '../core/theme.js';
import { api, post } from '../core/api.js';
import { initTilt, initMagnetic, initHover3D } from '../core/motion.js';
import { initParticleDrift } from '../core/particle-drift.js';
import { $, $$, setBusy, toast } from '../core/ui.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const params = new URLSearchParams(location.search);

/** Only allow same-origin relative redirects (prevents open-redirects). */
function safeNext() {
  const next = params.get('next');
  if (!next) return null;
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//') || url.pathname.includes('\\')) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

function finish(user) {
  const staff = user && (user.role === 'admin' || user.role === 'staff');
  location.href = safeNext() || (staff ? '/admin.html' : '/app.html');
}

function showStep(step) {
  $$('[data-step]').forEach((el) => {
    el.hidden = el.dataset.step !== step;
  });
  const input = $(`[data-step="${step}"] input:not([type=hidden]):not(.hp-field)`);
  setTimeout(() => input?.focus(), 60);
}

function showError(form, message) {
  const el = $('[data-error]', form);
  el.textContent = message || '';
  el.hidden = !message;
}

async function handleNext(result) {
  if (result.next === 'done') return finish(result.user);
  if (result.next === 'otp' || result.next === 'totp') {
    showStep('totp');
    if (result.email) {
      const desc = $('[data-otp-desc]');
      if (desc) desc.textContent = `Enter the 6-digit verification code sent to ${result.email}.`;
    }
    if (result.otp) {
      toast(`Verification code: ${result.otp}`, { type: 'info', timeout: 15000 });
      const banner = $('[data-otp-banner]');
      if (banner) {
        banner.innerHTML = `<span class="pill accent">Code sent</span> <b>${result.otp}</b> <small class="muted">(check console or use above)</small>`;
        banner.hidden = false;
      }
    }
    return;
  }
  if (result.next === 'totp_setup') {
    showStep('totp_setup');
    await loadEnrolment();
  }
}

/* ---------- Tabs ---------- */
function setTab(tab) {
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('[data-form="login"]').hidden = tab !== 'login';
  $('[data-form="register"]').hidden = tab !== 'register';
  $('[data-title]').textContent = tab === 'login' ? 'Welcome back' : 'Create your account';
  $('[data-subtitle]').textContent = tab === 'login'
    ? 'Sign in to get and track your tokens.'
    : 'Takes a minute. You will link an authenticator app next.';
}

/* ---------- Password strength ---------- */
function strength(pw) {
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw) || /\s/.test(pw)) score++;
  return pw.length < 10 ? Math.min(score, 1) : score;
}
const STRENGTH_LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];

/* ---------- Forms ---------- */
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function bindCredentialForms() {
  const login = $('[data-form="login"]');
  login.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { email, password, website } = formData(login);
    if (!email || !password) return showError(login, 'Enter your email and password.');
    const btn = $('button[type=submit]', login);
    setBusy(btn, true, 'Signing in…');
    showError(login, '');
    try {
      if (window.supabaseClient) {
        try {
          const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
          if (!error && data?.session?.access_token) {
            await handleNext(await post('/api/auth/supabase', { accessToken: data.session.access_token }, { human: true }));
            return;
          }
        } catch {
          // If Supabase sign in fails, fall back to backend local login
        }
      }
      await handleNext(await post('/api/auth/login', { email, password, website }, { human: true }));
    } catch (err) {
      showError(login, err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  const register = $('[data-form="register"]');
  const pass = $('#re-pass');
  pass.addEventListener('input', () => {
    const s = strength(pass.value);
    $('[data-strength]').dataset.level = String(s);
    $('[data-strength-label]').textContent = pass.value ? STRENGTH_LABELS[s] : 'At least 10 characters. A short phrase works well.';
  });
  register.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { name, email, password, website } = formData(register);
    if (!name || name.trim().length < 2) return showError(register, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return showError(register, 'Enter a valid email address.');
    if ((password || '').length < 10) return showError(register, 'Password must be at least 10 characters.');
    const btn = $('button[type=submit]', register);
    setBusy(btn, true, 'Creating…');
    showError(register, '');
    try {
      // First try backend registration with email OTP
      try {
        await handleNext(await post('/api/auth/register', { name: name.trim(), email, password, website }, { human: true }));
        return;
      } catch (backendErr) {
        if (window.supabaseClient && (backendErr.code === 'BAD_REQUEST' || backendErr.status === 400)) {
          const { data, error } = await window.supabaseClient.auth.signUp({ email, password, options: { data: { full_name: name.trim() } } });
          if (error) throw new Error(error.message);
          toast('Account created! Check your email to confirm, then sign in.', { type: 'success', timeout: 10000 });
          setTab('login');
          return;
        }
        throw backendErr;
      }
    } catch (err) {
      showError(register, err.message);
    } finally {
      setBusy(btn, false);
    }
  });
}

function bindCodeForm(step) {
  const form = $(`[data-form="${step}"]`);
  const input = $('input', form);
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(input.value)) return showError(form, 'Enter the 6-digit verification code.');
    const btn = $('button[type=submit]', form);
    if (btn.disabled) return;
    setBusy(btn, true, 'Verifying…');
    showError(form, '');
    try {
      const endpoint = step === 'totp' ? '/api/auth/otp/verify' : '/api/auth/totp/verify';
      const res = await post(endpoint, { code: input.value });
      toast('Signed in successfully', { type: 'success' });
      finish(res.user);
    } catch (err) {
      showError(form, err.message);
      input.select();
    } finally {
      setBusy(btn, false);
    }
  });

  const resendBtn = $('[data-resend]');
  if (resendBtn && !resendBtn.dataset.bound) {
    resendBtn.dataset.bound = 'true';
    resendBtn.addEventListener('click', async () => {
      setBusy(resendBtn, true, 'Sending…');
      try {
        const res = await post('/api/auth/otp/resend');
        toast(res.message || 'New code sent!', { type: 'info' });
        if (res.otp) {
          toast(`Verification code: ${res.otp}`, { type: 'info', timeout: 15000 });
          const banner = $('[data-otp-banner]');
          if (banner) {
            banner.innerHTML = `<span class="pill accent">New code</span> <b>${res.otp}</b> <small class="muted">(check console or use above)</small>`;
            banner.hidden = false;
          }
        }
      } catch (err) {
        toast(err.message, { type: 'danger' });
      } finally {
        setBusy(resendBtn, false);
      }
    });
  }
}

async function loadEnrolment() {
  const box = $('[data-qr]');
  try {
    const { qr, secret } = await post('/api/auth/totp/setup');
    const img = new Image();
    img.src = qr;
    img.alt = 'QR code for your authenticator app';
    img.width = 220;
    img.height = 220;
    box.replaceChildren(img);
    $('[data-secret]').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
    $('[data-copy]').onclick = async () => {
      try {
        await navigator.clipboard.writeText(secret);
        toast('Key copied', { type: 'success', timeout: 2000 });
      } catch {
        toast('Copy failed — select the key and copy it manually', { type: 'warning' });
      }
    };
  } catch (err) {
    if (err.code === 'CONFLICT') return showStep('totp');
    box.textContent = err.message;
  }
}

/* ---------- Google Identity Services ---------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.append(s);
  });
}

async function initGoogle(clientId) {
  const slot = $('[data-google]');
  slot.replaceChildren();

  // If Supabase is available, create stylish Google & GitHub OAuth buttons
  if (window.supabaseClient) {
    const wrap = document.createElement('div');
    wrap.className = 'oauth-btn-group';
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 8px; width: 100%;';

    // 1. Google OAuth Button
    const googleBtn = document.createElement('button');
    googleBtn.type = 'button';
    googleBtn.className = 'btn btn-ghost';
    googleBtn.style.cssText = 'width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px 16px; border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: var(--radius-md, 8px); font-weight: 600; font-size: 14px;';
    googleBtn.innerHTML = `
      <svg style="width: 18px; height: 18px; flex-shrink: 0;" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
      </svg>
      <span>Continue with Google</span>
    `;
    googleBtn.onclick = async () => {
      setBusy(googleBtn, true, 'Connecting to Google…');
      try {
        const { error } = await window.supabaseClient.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.origin + '/login.html',
            queryParams: { access_type: 'offline', prompt: 'select_account' },
          },
        });
        if (error) throw error;
      } catch (err) {
        setBusy(googleBtn, false);
        const msg = err.message || '';
        if (msg.includes('provider is not enabled') || msg.includes('validation_failed')) {
          toast('Google provider is not enabled in your Supabase project dashboard (Authentication > Providers > Google).', { type: 'danger', timeout: 12000 });
        } else {
          toast('Google sign-in error: ' + msg, { type: 'danger' });
        }
      }
    };
    wrap.appendChild(googleBtn);

    // 2. GitHub OAuth Button
    const githubBtn = document.createElement('button');
    githubBtn.type = 'button';
    githubBtn.className = 'btn btn-ghost';
    githubBtn.style.cssText = 'width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px 16px; border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: var(--radius-md, 8px); font-weight: 600; font-size: 14px;';
    githubBtn.innerHTML = `
      <svg style="width: 18px; height: 18px; flex-shrink: 0;" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.379.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z"/>
      </svg>
      <span>Continue with GitHub</span>
    `;
    githubBtn.onclick = async () => {
      setBusy(githubBtn, true, 'Connecting to GitHub…');
      try {
        const { error } = await window.supabaseClient.auth.signInWithOAuth({
          provider: 'github',
          options: { redirectTo: window.location.origin + '/login.html' },
        });
        if (error) throw error;
      } catch (err) {
        setBusy(githubBtn, false);
        const msg = err.message || '';
        if (msg.includes('provider is not enabled') || msg.includes('validation_failed')) {
          toast('GitHub provider is not enabled in your Supabase project dashboard (Authentication > Providers > GitHub).', { type: 'danger', timeout: 12000 });
        } else {
          toast('GitHub sign-in error: ' + msg, { type: 'danger' });
        }
      }
    };
    wrap.appendChild(githubBtn);

    slot.appendChild(wrap);
    return;
  }

  // If no Supabase, fall back to Google Identity Services
  if (!clientId) {
    slot.innerHTML = '<p class="google-off">Use your email address below to sign in or register.</p>';
    $('[data-or]').hidden = true;
    return;
  }
  try {
    await loadScript(GSI_SRC);
  } catch (err) {
    slot.textContent = err.message;
    return;
  }
  const g = window.google.accounts.id;
  g.initialize({
    client_id: clientId,
    ux_mode: 'popup',
    auto_select: false,
    itp_support: true,
    callback: async ({ credential }) => {
      try {
        await handleNext(await post('/api/auth/google', { credential }, { human: true }));
      } catch (err) {
        toast('Google sign-in failed', { body: err.message, type: 'danger' });
      }
    },
  });
  const render = () => {
    slot.replaceChildren();
    g.renderButton(slot, {
      theme: getTheme() === 'dark' ? 'filled_black' : 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: Math.min(400, slot.clientWidth || 360),
    });
  };
  render();
  document.addEventListener('themechange', render);
}

/* ---------- Boot ---------- */
async function boot() {
  mountThemeSwitcher($('[data-theme-switch]'));
  initTilt($('[data-auth-stack]'), { max: 10 });
  initMagnetic();
  initHover3D();
  initParticleDrift();
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  if (params.get('tab') === 'register') setTab('register');
  bindCredentialForms();
  bindCodeForm('totp');
  bindCodeForm('totp_setup');
  $('[data-switch]').addEventListener('click', async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      showStep('credentials');
    }
  });

  try {
    const me = await api('/api/auth/me');
    if (me.user?.verified) return finish(me.user);
    if (me.pending) await handleNext({ next: me.pending });
  } catch {
    // not signed in — stay on credentials
  }

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const oauthError = searchParams.get('error_description')
    || searchParams.get('error')
    || hashParams.get('error_description')
    || hashParams.get('error');

  if (oauthError) {
    console.error('[oauth error in url]', oauthError);
    toast('Authentication error', { body: decodeURIComponent(oauthError.replace(/\+/g, ' ')), type: 'danger', timeout: 10000 });
  }

  let config = null;
  try {
    config = await api('/api/config');
  } catch (err) {
    console.warn('[config load fallback]', err);
    config = {
      supabaseUrl: 'https://muoqwywbnklxquwnseao.supabase.co',
      supabaseAnonKey: 'sb_publishable_q714PtFe6DYJ2qy64g5X1Q_ndbnsQPZ',
      googleClientId: null,
    };
  }

  const supabaseUrl = config?.supabaseUrl || 'https://muoqwywbnklxquwnseao.supabase.co';
  const supabaseAnonKey = config?.supabaseAnonKey || 'sb_publishable_q714PtFe6DYJ2qy64g5X1Q_ndbnsQPZ';

  if (supabaseUrl && supabaseAnonKey && window.supabase) {
    try {
      window.supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          flowType: 'pkce',
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      });

      let syncing = false;
      async function syncSupabaseUser(session) {
        if (!session?.access_token || syncing) return;
        syncing = true;
        try {
          toast('Finalizing sign-in…', { type: 'info', timeout: 3000 });
          const res = await post('/api/auth/supabase', { accessToken: session.access_token }, { human: true });
          if (window.history?.replaceState) {
            window.history.replaceState(null, '', window.location.pathname);
          }
          await handleNext(res);
        } catch (err) {
          console.warn('[supabase sync error]', err);
          toast('Supabase sign-in sync error', { body: err.message, type: 'danger' });
        } finally {
          syncing = false;
        }
      }

      // 1. If returning from OAuth with a PKCE authorization code in query params:
      const authCode = searchParams.get('code');
      if (authCode) {
        toast('Completing Google sign-in…', { type: 'info', timeout: 5000 });
        try {
          const { data, error } = await window.supabaseClient.auth.exchangeCodeForSession(authCode);
          if (error) {
            console.warn('[exchangeCodeForSession error]', error);
            toast('Google sign-in error', { body: error.message, type: 'danger' });
          } else if (data?.session?.access_token) {
            await syncSupabaseUser(data.session);
            return;
          }
        } catch (err) {
          console.error('[exchangeCodeForSession exception]', err);
        }
      }

      // 2. If returning from OAuth with access token in URL hash:
      const hashToken = hashParams.get('access_token');
      if (hashToken) {
        await syncSupabaseUser({ access_token: hashToken });
        return;
      }

      // 3. Listen for auth state changes
      window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && session?.access_token) {
          await syncSupabaseUser(session);
        }
      });

      // 4. Check for existing active session
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (session?.access_token) {
        await syncSupabaseUser(session);
        return;
      }
    } catch (err) {
      console.error('[supabase init error]', err);
    }
  }

  await initGoogle(config?.googleClientId);
}

boot();
