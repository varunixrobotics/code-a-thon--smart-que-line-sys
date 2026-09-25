/* Glass navigation: theme switcher, scroll state, mobile menu, auth-aware actions. */
import { mountThemeSwitcher } from './theme.js';
import { api, post } from './api.js';
import { $, esc, icon, toast } from './ui.js';
import { initMagnetic } from './motion.js';
import { supabase } from '/src/supabaseclient.js';

const initials = (name) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function renderAuthSlot(slot, me) {
  if (!slot) return;
  if (!me) {
    slot.innerHTML = `
      <a class="btn btn-ghost btn-sm hide-sm" href="/login.html">Sign in</a>
      <a class="btn btn-primary btn-sm" data-magnetic href="/app.html">Get a token</a>`;
    return;
  }
  const staff = me.role === 'admin' || me.role === 'staff';
  slot.innerHTML = `
    ${staff ? `<a class="btn btn-ghost btn-sm hide-sm" href="/admin.html">${icon('chart')}<span>Dashboard</span></a>` : ''}
    <a class="btn btn-sm hide-sm" href="/app.html">${icon('ticket')}<span>My tokens</span></a>
    <span class="avatar" title="${esc(me.name)} · ${esc(me.email)}">${esc(initials(me.name))}</span>
    <button type="button" class="btn btn-ghost btn-icon" data-logout aria-label="Sign out" title="Sign out">${icon('logout')}</button>`;
  $('[data-logout]', slot).addEventListener('click', async () => {
    try {
      await Promise.allSettled([
        post('/api/auth/logout'),
        supabase.auth.signOut(),
      ]);
    } catch (err) {
      toast('Sign-out failed', { body: err.message, type: 'danger' });
      return;
    }
    location.href = '/';
  });
}

/**
 * Ensures user has an active Supabase session; if not, redirects to /login.
 * @returns {Promise<object|null>} the session or null
 */
export async function requireAuthSession() {
  try {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      window.location.href = '/login';
      return null;
    }
    return data.session;
  } catch {
    window.location.href = '/login';
    return null;
  }
}

/**
 * @param {{requireAuth?: boolean}} [opts]
 * @returns {Promise<object|null>} the verified user, or null
 */
export async function initNav({ requireAuth = false } = {}) {
  const nav = $('.nav');
  mountThemeSwitcher($('[data-theme-switch]'));

  const onScroll = () => nav?.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggle = $('.nav-toggle');
  toggle?.addEventListener('click', () => {
    const open = !nav.classList.contains('menu-open');
    nav.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  if (requireAuth) {
    try {
      const { data } = await supabase.auth.getSession();
      if (!data?.session) {
        window.location.href = '/login';
        return new Promise(() => {});
      }
      if (data.session.access_token) {
        try {
          await post('/api/auth/supabase', { accessToken: data.session.access_token }, { human: true });
        } catch (syncErr) {
          console.warn('[nav supabase backend sync]', syncErr);
        }
      }
    } catch (err) {
      console.warn('[nav getSession error]', err);
      window.location.href = '/login';
      return new Promise(() => {});
    }
  }

  let me = null;
  try {
    const res = await api('/api/auth/me');
    me = res.user?.verified ? res.user : null;
    if (requireAuth && res.user && !res.user.verified) {
      window.location.href = '/login';
      return new Promise(() => {});
    }
  } catch {
    me = null;
  }
  if (requireAuth && !me) {
    window.location.href = '/login';
    return new Promise(() => {});
  }
  renderAuthSlot($('[data-auth-slot]'), me);
  initMagnetic(nav);
  return me;
}
