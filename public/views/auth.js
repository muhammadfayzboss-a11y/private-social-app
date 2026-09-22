import { request, setCsrf } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, toast } from '../ui.js';

export function renderAuth(host, { needsSetup, onAuthenticated }) {
  let mode = needsSetup ? 'setup' : 'login';

  const draw = () => {
    const copy = {
      setup: { title: 'Create your circle', subtitle: 'You are the first member. This becomes the admin account that invites everyone else.', submit: 'Create admin account' },
      login: { title: 'Welcome back', subtitle: 'Sign in to your private circle.', submit: 'Sign in' },
      register: { title: 'Join the circle', subtitle: 'Enter the invite code you received from the group admin.', submit: 'Join the circle' }
    }[mode];

    host.innerHTML = `
      <div class="auth-page">
        <section class="auth-card">
          <div class="auth-brand">
            <span class="auth-logo">${icon('lock', 24)}</span>
            <div><h1>Circle</h1><p>Private. Just us.</p></div>
          </div>
          <h2>${escapeHtml(copy.title)}</h2>
          <p class="subtitle">${escapeHtml(copy.subtitle)}</p>
          <form data-auth-form novalidate>
            ${mode === 'setup' ? `<div class="field">
              <label for="setupCode">Setup code</label>
              <input id="setupCode" name="setupCode" type="password" autocomplete="off" required>
              <span class="field-hint">The SETUP_CODE value from your server environment.</span>
            </div>` : ''}
            ${mode === 'register' ? `<div class="field">
              <label for="inviteCode">Invite code</label>
              <input id="inviteCode" name="inviteCode" autocomplete="off" required>
            </div>` : ''}
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" autocomplete="username" inputmode="text" spellcheck="false" required>
              ${mode === 'login' ? '' : '<span class="field-hint">3–24 lowercase letters, numbers, or underscores.</span>'}
            </div>
            ${mode === 'login' ? '' : `<div class="field">
              <label for="displayName">Display name</label>
              <input id="displayName" name="displayName" autocomplete="name" required>
            </div>`}
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required>
              ${mode === 'login' ? '' : '<span class="field-hint">At least 10 characters.</span>'}
            </div>
            <button class="button button-primary button-block" type="submit">${escapeHtml(copy.submit)}</button>
          </form>
          ${needsSetup ? '' : `<p class="auth-switch">
            ${mode === 'login' ? 'Have an invite code?' : 'Already a member?'}
            <button class="text-button" data-switch>${mode === 'login' ? 'Join with invite' : 'Sign in'}</button>
          </p>`}
        </section>
      </div>`;

    host.querySelector('[data-switch]')?.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; draw(); });

    host.querySelector('[data-auth-form]').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const submit = form.querySelector('button[type="submit"]');
      const payload = Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value).trim()]));
      submit.disabled = true;
      submit.textContent = 'Please wait…';
      try {
        const endpoint = mode === 'setup' ? '/api/auth/bootstrap' : mode === 'register' ? '/api/auth/register' : '/api/auth/login';
        const data = await request(endpoint, { method: 'POST', body: payload });
        setCsrf(data.csrfToken);
        toast(mode === 'login' ? `Welcome back, ${data.user.displayName}` : `Welcome to Circle, ${data.user.displayName}`);
        onAuthenticated(data.user);
      } catch (error) {
        toast(error.message, 'error');
        submit.disabled = false;
        submit.textContent = copy.submit;
      }
    });
  };

  draw();
  return () => {};
}
