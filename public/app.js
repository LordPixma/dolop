/* Dolop dashboard — dependency-free SPA over the /api endpoints. */
'use strict';

// ---------------------------------------------------------------------------
// API client

const TOKEN_KEY = 'dolop_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

async function api(method, path, body, opts = {}) {
  const headers = {};
  if (getToken()) headers.authorization = `Bearer ${getToken()}`; // optional API-token mode
  let payload;
  if (body !== undefined) {
    if (opts.raw) {
      payload = body;
      headers['content-type'] = opts.contentType || 'text/plain';
    } else {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401 && !opts.noRedirect) {
    renderLogin();
    throw new Error('unauthorized');
  }
  if (opts.blob) {
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    return res.blob();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (HTTP ${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Tiny UI helpers

const $app = document.getElementById('app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = message;
  root.appendChild(div);
  setTimeout(() => div.remove(), 6000);
}

function modal(html, { wide } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  return root.querySelector('.modal');
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function pill(status) { return `<span class="pill ${esc(status)}">${esc(String(status).replace(/_/g, ' '))}</span>`; }

function sumUserStats(stats) {
  const t = { discovered: 0, migrated: 0, skipped: 0, failed: 0, bytes: 0, expected: 0, expectedBytes: 0 };
  for (const [k, s] of Object.entries(stats || {})) {
    if (k.startsWith('assessment')) continue;
    t.discovered += s.discovered || 0; t.migrated += s.migrated || 0;
    t.skipped += s.skipped || 0; t.failed += s.failed || 0; t.bytes += s.bytes || 0;
    t.expected += s.expected || 0; t.expectedBytes += s.expectedBytes || 0;
  }
  return t;
}

const WORKLOADS = ['mail', 'calendar', 'contacts', 'tasks', 'drive', 'rules'];
const WORKLOAD_LABELS = {
  mail: 'Mail', calendar: 'Calendar', contacts: 'Contacts',
  tasks: 'Tasks (To Do)', drive: 'OneDrive', rules: 'Rules & settings',
  assessment: 'Assessment',
};

const PHASE_LABELS = {
  init: 'starting', starting: 'starting',
  folders: 'mapping folders', items: 'copying items',
  calendars: 'mapping calendars', lists: 'mapping lists',
  walk: 'copying files',
  categories: 'copying categories', rules: 'copying inbox rules', settings: 'applying mailbox settings',
  mail: 'counting mailbox', drive: 'checking OneDrive', dest: 'checking destination',
};

function activityLabel(activity) {
  if (!activity) return '';
  const wl = WORKLOAD_LABELS[activity.workload] || activity.workload;
  return `${wl} — ${PHASE_LABELS[activity.phase] || activity.phase}`;
}

/**
 * Fraction complete for one workload. Uses the upfront totals captured by the
 * engines (mailbox folder counts, OneDrive quota bytes) as the denominator;
 * workloads without a known total are capped at 90% until they finish, so the
 * bar can't sit at 100% while work remains.
 */
function workloadFraction(s) {
  if (!s) return 0;
  const done = (s.migrated || 0) + (s.skipped || 0) + (s.failed || 0);
  if (s.expected > 0) return Math.min(1, done / s.expected);
  if (s.expectedBytes > 0) return Math.min(1, (s.bytes || 0) / s.expectedBytes);
  if (s.discovered > 0) return Math.min(0.9, done / s.discovered);
  return 0;
}

/** Staged overall progress: finished workloads count fully, the active one partially. */
function userProgress(user) {
  if (user.status === 'completed' || user.status === 'completed_with_errors') return 1;
  if (user.status === 'pending' || user.status === 'queued' || user.status === 'stopped') return 0;
  if (user.passType === 'assessment') return user.status === 'running' ? 0.5 : 0;
  const selected = user.passConfig?.workloads?.length
    ? WORKLOADS.filter((w) => user.passConfig.workloads.includes(w))
    : WORKLOADS.filter((w) => user.stats && user.stats[w]);
  if (!selected.length) return 0;
  const activeIdx = user.activity ? selected.indexOf(user.activity.workload) : -1;
  let sum = 0;
  selected.forEach((w, i) => {
    if (activeIdx >= 0 && i < activeIdx) sum += 1;
    else if (activeIdx >= 0 && i > activeIdx) sum += 0;
    else sum += workloadFraction(user.stats ? user.stats[w] : null);
  });
  return sum / selected.length;
}

function bar(fraction, done) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return `<div class="progress ${done ? 'done' : ''}" title="${pct}%"><div style="width:${pct}%"></div></div>`;
}

function progressBar(user) {
  const isDone = user.status === 'completed' || user.status === 'completed_with_errors';
  return bar(userProgress(user), isDone);
}

// ---------------------------------------------------------------------------
// Sign-in (username/password sessions; API token as fallback/recovery)

async function renderLogin() {
  stopPolling();
  let status = { setupRequired: false };
  try { status = await fetch('/api/auth/status').then((r) => r.json()); } catch { /* show login anyway */ }

  if (status.setupRequired) {
    $app.innerHTML = `
      <div class="card" style="max-width:460px;margin:8vh auto">
        <h1>Welcome to dolop</h1>
        <p class="sub">No operator accounts exist yet. Create the first administrator account for this deployment.</p>
        <label>Username</label><input id="su-user" autocomplete="username" autofocus />
        <label>Display name</label><input id="su-name" autocomplete="name" />
        <label>Password <span class="muted">(min 10 characters)</span></label>
        <input type="password" id="su-pass" autocomplete="new-password" />
        <label>Confirm password</label><input type="password" id="su-pass2" autocomplete="new-password" />
        <div class="btnrow" style="margin-top:1rem"><button class="primary" id="su-go">Create account</button></div>
      </div>`;
    document.getElementById('su-go').addEventListener('click', async () => {
      const password = document.getElementById('su-pass').value;
      if (password !== document.getElementById('su-pass2').value) return toast('Passwords do not match', 'error');
      try {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('su-user').value.trim(),
            displayName: document.getElementById('su-name').value.trim() || undefined,
            password,
          }),
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'setup failed', 'error');
        toast('Account created — welcome!', 'ok');
        route();
      } catch (e) { toast(e.message, 'error'); }
    });
    return;
  }

  $app.innerHTML = `
    <div class="card" style="max-width:420px;margin:8vh auto">
      <h1>Sign in to dolop</h1>
      <label>Username</label><input id="li-user" autocomplete="username" autofocus />
      <label>Password</label><input type="password" id="li-pass" autocomplete="current-password" />
      <div class="btnrow" style="margin-top:1rem"><button class="primary" id="li-go">Sign in</button></div>
      <p class="sub" style="margin-top:1rem"><a href="#" id="li-token-toggle">Use an API token instead</a></p>
      <div id="li-token-pane" style="display:none">
        <label>API token <span class="muted">(also resets forgotten passwords via Account → Team)</span></label>
        <input type="password" id="li-token" />
        <div class="btnrow" style="margin-top:.7rem"><button id="li-token-go">Continue with token</button></div>
      </div>
    </div>`;
  const login = async () => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('li-user').value.trim(),
          password: document.getElementById('li-pass').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) return toast(data.error || 'sign-in failed', 'error');
      localStorage.removeItem(TOKEN_KEY);
      route();
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('li-go').addEventListener('click', login);
  document.getElementById('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  document.getElementById('li-token-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    const pane = document.getElementById('li-token-pane');
    pane.style.display = pane.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('li-token-go').addEventListener('click', async () => {
    localStorage.setItem(TOKEN_KEY, document.getElementById('li-token').value.trim());
    try {
      await api('GET', '/api/projects', undefined, { noRedirect: true });
      route();
    } catch { toast('Token rejected', 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Account & team page

async function viewAccount() {
  const status = await fetch('/api/auth/status').then((r) => r.json());
  const { accounts } = await api('GET', '/api/auth/accounts');
  const me = status.account;
  const rows = accounts.map((a) => `
    <tr>
      <td><strong>${esc(a.username)}</strong>${me && me.id === a.id ? ' <span class="muted">(you)</span>' : ''}
        <div class="muted" style="font-size:.76rem">${esc(a.displayName || '')}</div></td>
      <td class="muted" style="font-size:.8rem">${a.lastLoginAt ? fmtDate(a.lastLoginAt) : 'never signed in'}</td>
      <td class="right">
        <button class="small" data-reset="${a.id}" data-username="${esc(a.username)}">Reset password</button>
        ${me && me.id === a.id ? '' : `<button class="small danger" data-del="${a.id}" data-username="${esc(a.username)}">Delete</button>`}
      </td>
    </tr>`).join('');
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>Account</h1>
      <div class="sub">${me ? `Signed in as <strong>${esc(me.username)}</strong>` : 'Authenticated with the API token'}</div></div>
    </div>
    ${me ? `
    <div class="card" style="max-width:480px">
      <h3>Change password</h3>
      <label>Current password</label><input type="password" id="cp-cur" autocomplete="current-password" />
      <label>New password <span class="muted">(min 10 characters)</span></label>
      <input type="password" id="cp-new" autocomplete="new-password" />
      <div class="btnrow" style="margin-top:.9rem"><button class="primary" id="cp-go">Update password</button></div>
    </div>` : ''}
    <div class="card">
      <div class="page-head" style="margin-bottom:.6rem">
        <h3 style="margin:0">Team</h3>
        <button class="primary" id="ac-add">Add operator</button>
      </div>
      <table><thead><tr><th>Username</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  const cp = document.getElementById('cp-go');
  if (cp) cp.addEventListener('click', async () => {
    try {
      await api('POST', '/api/auth/change-password', {
        currentPassword: document.getElementById('cp-cur').value,
        newPassword: document.getElementById('cp-new').value,
      });
      toast('Password updated', 'ok');
      viewAccount();
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('ac-add').addEventListener('click', () => {
    const m = modal(`
      <h2>Add operator account</h2>
      <label>Username</label><input id="na-user" />
      <label>Display name</label><input id="na-name" />
      <label>Password <span class="muted">(min 10 characters — share securely; they can change it after signing in)</span></label>
      <input id="na-pass" type="password" />
      <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Create</button></div>`);
    m.querySelector('#m-cancel').addEventListener('click', closeModal);
    m.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await api('POST', '/api/auth/accounts', {
          username: m.querySelector('#na-user').value.trim(),
          displayName: m.querySelector('#na-name').value.trim() || undefined,
          password: m.querySelector('#na-pass').value,
        });
        closeModal(); toast('Operator account created', 'ok'); viewAccount();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  $app.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    const m = modal(`
      <h2>Reset password for ${esc(b.dataset.username)}</h2>
      <label>New password <span class="muted">(min 10 characters)</span></label>
      <input id="rp-pass" type="password" />
      <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Reset</button></div>`);
    m.querySelector('#m-cancel').addEventListener('click', closeModal);
    m.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await api('POST', `/api/auth/accounts/${b.dataset.reset}/reset-password`, {
          newPassword: m.querySelector('#rp-pass').value,
        });
        closeModal(); toast('Password reset', 'ok');
      } catch (e) { toast(e.message, 'error'); }
    });
  }));
  $app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete operator account "${b.dataset.username}"?`)) return;
    try { await api('DELETE', `/api/auth/accounts/${b.dataset.del}`); viewAccount(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

// ---------------------------------------------------------------------------
// Projects list

async function viewProjects() {
  const { projects } = await api('GET', '/api/projects');
  const cards = projects.map((p) => {
    const s = p.userSummary || {};
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    const parts = Object.entries(s).map(([k, v]) => `${pill(k)} ${v}`).join(' &nbsp; ');
    return `
      <div class="card">
        <h3><a href="#/projects/${p.id}">${esc(p.name)}</a></h3>
        <div class="meta">${esc(p.description || '')}</div>
        <div class="meta" style="margin-top:.5rem">${total} user(s)</div>
        <div style="margin-top:.5rem;font-size:.82rem">${parts || '<span class="muted">no users scoped yet</span>'}</div>
      </div>`;
  }).join('');
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>Migration projects</h1>
      <div class="sub">Each project migrates users from one tenant to another.</div></div>
      <button class="primary" id="new-project">New project</button>
    </div>
    ${projects.length ? `<div class="grid">${cards}</div>` : '<div class="empty">No projects yet — create one to begin.</div>'}`;
  document.getElementById('new-project').addEventListener('click', newProjectModal);
}

async function newProjectModal() {
  const { connectors } = await api('GET', '/api/connectors');
  const options = (sel) => ['<option value="">— select —</option>']
    .concat(connectors.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.tenantId)})</option>`)).join('');
  const m = modal(`
    <h2>New project</h2>
    ${connectors.length < 2 ? `<div class="warn-box">You need two connectors (source + destination tenants). <a href="#/connectors" onclick="document.getElementById('modal-root').innerHTML=''">Create them first →</a></div>` : ''}
    <label>Project name</label><input id="p-name" placeholder="Contoso → Fabrikam" />
    <label>Description</label><input id="p-desc" placeholder="M&A wave 1" />
    <div class="formgrid">
      <div><label>Source tenant connector</label><select id="p-src">${options()}</select></div>
      <div><label>Destination tenant connector</label><select id="p-dst">${options()}</select></div>
    </div>
    <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Create</button></div>`);
  m.querySelector('#m-cancel').addEventListener('click', closeModal);
  m.querySelector('#m-save').addEventListener('click', async () => {
    try {
      const body = {
        name: m.querySelector('#p-name').value.trim(),
        description: m.querySelector('#p-desc').value.trim() || undefined,
        sourceConnectorId: m.querySelector('#p-src').value || undefined,
        destConnectorId: m.querySelector('#p-dst').value || undefined,
      };
      const { id } = await api('POST', '/api/projects', body);
      closeModal();
      location.hash = `#/projects/${id}`;
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Connectors

async function viewConnectors() {
  const { connectors } = await api('GET', '/api/connectors');
  const rows = connectors.map((c) => `
    <tr>
      <td><strong>${esc(c.name)}</strong><div style="margin-top:.15rem"><span class="pill mode">${c.authMode === 'consent' ? 'admin consent' : 'app credentials'}</span></div></td>
      <td class="mono">${esc(c.tenantId || '—')}</td>
      <td class="mono">${esc(c.clientId)}</td>
      <td>${pill(c.verifyStatus)}<div class="muted" style="font-size:.76rem">${esc(c.verifyDetail || '')}</div></td>
      <td class="right">
        ${c.authMode === 'consent' ? `<button class="small" data-relink="${c.id}">Consent link</button>` : ''}
        <button class="small" data-verify="${c.id}">Verify</button>
        ${c.authMode === 'secret' ? `<button class="small" data-rotate="${c.id}">Rotate secret</button>` : ''}
        <button class="small danger" data-del="${c.id}">Delete</button>
      </td>
    </tr>`).join('');
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>Tenant connectors</h1>
      <div class="sub">One Entra ID app registration per tenant, with application permissions and admin consent. See the setup guide in the repo docs.</div></div>
      <button class="primary" id="new-connector">Add connector</button>
    </div>
    <div class="card">
      ${connectors.length ? `<table><thead><tr><th>Name</th><th>Tenant ID</th><th>Client ID</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No connectors yet.</div>'}
    </div>`;
  document.getElementById('new-connector').addEventListener('click', newConnectorModal);
  $app.querySelectorAll('[data-relink]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/connectors/${b.dataset.relink}/consent-link`);
      showConsentLink(r.consentUrl, r.redirectUri);
    } catch (e) { toast(e.message, 'error'); }
  }));
  $app.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api('POST', `/api/connectors/${b.dataset.verify}/verify`);
      toast(`Verified: ${r.detail}`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
    viewConnectors();
  }));
  $app.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', () => {
    const m = modal(`
      <h2>Rotate client secret</h2>
      <label>New client secret</label><input id="r-secret" type="password" />
      <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Save</button></div>`);
    m.querySelector('#m-cancel').addEventListener('click', closeModal);
    m.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await api('PATCH', `/api/connectors/${b.dataset.rotate}`, { clientSecret: m.querySelector('#r-secret').value });
        closeModal(); toast('Secret updated — run Verify', 'ok'); viewConnectors();
      } catch (e) { toast(e.message, 'error'); }
    });
  }));
  $app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this connector?')) return;
    try { await api('DELETE', `/api/connectors/${b.dataset.del}`); viewConnectors(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

function showConsentLink(consentUrl, redirectUri) {
  const m = modal(`
    <h2>Admin consent link</h2>
    <p class="sub">Send this link to a <strong>Global Administrator of the target tenant</strong>. When they approve, the tenant connects automatically — no app registration or secret needed on their side. The link is valid for 7 days.</p>
    <div class="linkbox"><input id="cl-url" class="mono" readonly value="${esc(consentUrl)}" /><button class="small" id="cl-copy">Copy</button></div>
    <p class="sub" style="margin-top:.8rem">Ensure <code class="mono">${esc(redirectUri)}</code> is registered as a redirect URI on your multi-tenant app.</p>
    <div class="actions">
      <a class="btn" href="${esc(consentUrl)}" target="_blank" rel="noopener">Open link</a>
      <button class="primary" id="cl-done">Done</button>
    </div>`, { wide: true });
  m.querySelector('#cl-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(consentUrl).then(() => toast('Link copied', 'ok'));
  });
  m.querySelector('#cl-done').addEventListener('click', () => { closeModal(); viewConnectors(); });
}

function newConnectorModal() {
  const m = modal(`
    <h2>Add tenant connector</h2>
    <div class="mode-switch">
      <button id="mode-consent" class="active">Admin consent link (recommended)</button>
      <button id="mode-secret">Manual app credentials</button>
    </div>
    <div id="pane-consent">
      <p class="sub">Uses this deployment's multi-tenant app (<code>MT_CLIENT_ID</code>/<code>MT_CLIENT_SECRET</code> secrets). Generate a link, send it to the tenant's Global Admin, and the connector binds itself when they approve — like BitTitan/ShareGate onboarding.</p>
      <label>Name</label><input id="cc-name" placeholder="Contoso (source)" />
    </div>
    <div id="pane-secret" style="display:none">
      <p class="sub">Register an app in the tenant's Entra ID with the Graph <em>application</em> permissions listed in <code>docs/setup.md</code>, grant admin consent, then paste its details. The secret is encrypted with AES-256-GCM before storage.</p>
      <label>Name</label><input id="c-name" placeholder="Contoso (source)" />
      <label>Directory (tenant) ID</label><input id="c-tenant" placeholder="00000000-0000-0000-0000-000000000000" />
      <label>Application (client) ID</label><input id="c-client" />
      <label>Client secret</label><input id="c-secret" type="password" />
    </div>
    <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Add</button></div>`);
  let mode = 'consent';
  const setMode = (next) => {
    mode = next;
    m.querySelector('#mode-consent').classList.toggle('active', next === 'consent');
    m.querySelector('#mode-secret').classList.toggle('active', next === 'secret');
    m.querySelector('#pane-consent').style.display = next === 'consent' ? 'block' : 'none';
    m.querySelector('#pane-secret').style.display = next === 'secret' ? 'block' : 'none';
  };
  m.querySelector('#mode-consent').addEventListener('click', () => setMode('consent'));
  m.querySelector('#mode-secret').addEventListener('click', () => setMode('secret'));
  m.querySelector('#m-cancel').addEventListener('click', closeModal);
  m.querySelector('#m-save').addEventListener('click', async () => {
    try {
      if (mode === 'consent') {
        const name = m.querySelector('#cc-name').value.trim();
        if (!name) return toast('Enter a connector name', 'error');
        const r = await api('POST', '/api/connectors/consent-link', { name });
        showConsentLink(r.consentUrl, r.redirectUri);
        return;
      }
      await api('POST', '/api/connectors', {
        name: m.querySelector('#c-name').value.trim(),
        tenantId: m.querySelector('#c-tenant').value.trim(),
        clientId: m.querySelector('#c-client').value.trim(),
        clientSecret: m.querySelector('#c-secret').value,
      });
      closeModal(); toast('Connector added — run Verify', 'ok'); viewConnectors();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Project view

let pollTimer = null;
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

let renderingProject = false;

/**
 * Fetch all data first, build the new view in a detached node, then swap the
 * DOM in one synchronous step — background refreshes never show "Loading…"
 * or drop checkbox/scroll state.
 */
async function renderProject(projectId, tab) {
  if (renderingProject) return;
  renderingProject = true;
  try {
    const data = await api('GET', `/api/projects/${projectId}`);
    const { project, userSummary, sourceConnector, destConnector } = data;
    const s = userSummary || {};
    const total = Object.values(s).reduce((a, b) => a + b, 0);

    const content = document.createElement('div');
    content.id = 'tab-content';
    if (tab === 'users') await tabUsers(content, project);
    else if (tab === 'migrate') await tabMigrate(content, project);
    else if (tab === 'errors') await tabErrors(content, project);
    else if (tab === 'events') await tabEvents(content, project);
    else await tabSettings(content, project, data);

    // Preserve volatile UI state across background refreshes.
    const prevSel = new Set([...document.querySelectorAll('[data-sel]:checked')].map((x) => x.dataset.sel));
    const prevSelAll = document.getElementById('sel-all')?.checked ?? false;
    const scrollY = window.scrollY;

    const tabs = ['users', 'migrate', 'errors', 'events', 'settings'];
    $app.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${esc(project.name)}</h1>
          <div class="sub">
            ${sourceConnector ? esc(sourceConnector.name) : '<em>no source</em>'} →
            ${destConnector ? esc(destConnector.name) : '<em>no destination</em>'}
          </div>
        </div>
        <div class="statrow">
          <div class="stat"><div class="n">${total}</div><div class="l">users</div></div>
          <div class="stat"><div class="n">${s.running || 0}</div><div class="l">running</div></div>
          <div class="stat"><div class="n">${(s.completed || 0) + (s.completed_with_errors || 0)}</div><div class="l">done</div></div>
          <div class="stat"><div class="n" style="color:${(s.failed || 0) ? 'var(--red)' : 'inherit'}">${s.failed || 0}</div><div class="l">failed</div></div>
        </div>
      </div>
      <div class="tabs">
        ${tabs.map((t) => `<a href="#/projects/${project.id}/${t}" class="${t === tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</a>`).join('')}
      </div>
      <div id="tab-content"></div>`;
    document.getElementById('tab-content').replaceWith(content);

    if (prevSel.size) {
      content.querySelectorAll('[data-sel]').forEach((x) => { if (prevSel.has(x.dataset.sel)) x.checked = true; });
    }
    if (prevSelAll) {
      const sa = content.querySelector('#sel-all');
      if (sa) sa.checked = true;
    }
    window.scrollTo(0, scrollY);
  } finally {
    renderingProject = false;
  }
}

async function viewProject(projectId, tab = 'users') {
  stopPolling();
  try {
    await renderProject(projectId, tab);
  } catch (e) {
    if (e.message !== 'unauthorized') $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (tab === 'users' || tab === 'migrate') {
    pollTimer = setInterval(async () => {
      if (document.getElementById('modal-root').innerHTML !== '') return; // don't refresh under a modal
      if (!location.hash.startsWith(`#/projects/${projectId}`)) { stopPolling(); return; }
      try { await renderProject(projectId, tab); } catch { /* transient — keep current view */ }
    }, 6000);
  }
}

// -- Users tab ---------------------------------------------------------------

async function tabUsers(c, project) {
  const offset = parseInt(sessionStorage.getItem(`off:${project.id}`) || '0', 10);
  const { users, total } = await api('GET', `/api/projects/${project.id}/users?limit=100&offset=${offset}`);
  const rows = users.map((u) => {
    const t = sumUserStats(u.stats);
    const denom = t.expected > t.discovered ? t.expected : t.discovered;
    const act = u.status === 'running' ? activityLabel(u.activity) : '';
    return `
      <tr class="clickable" data-user="${u.id}">
        <td class="checkbox-col" data-stop><input type="checkbox" data-sel="${u.id}" /></td>
        <td><strong>${esc(u.sourceUpn)}</strong><div class="muted" style="font-size:.76rem">${esc(u.displayName || '')}</div></td>
        <td class="mono">${esc(u.destUpn)}</td>
        <td>${pill(u.status)}</td>
        <td>${progressBar(u)}${act ? `<div class="muted" style="font-size:.72rem;margin-top:.2rem">${esc(act)}</div>` : ''}</td>
        <td class="right mono">${t.migrated}/${denom}${t.failed ? ` <span style="color:var(--red)">(${t.failed}✗)</span>` : ''}</td>
        <td class="right mono">${fmtBytes(t.bytes)}</td>
      </tr>`;
  }).join('');
  c.innerHTML = `
    <div class="btnrow" style="margin-bottom:.9rem">
      <button class="primary" id="u-discover">Discover &amp; add users</button>
      <button id="u-import">Import CSV</button>
      <button id="u-provision">Provision selected</button>
      <button id="u-start-sel">Start selected</button>
      <button class="danger" id="u-remove">Remove selected</button>
    </div>
    <div class="card">
      ${users.length ? `<table><thead><tr><th class="checkbox-col"><input type="checkbox" id="sel-all" /></th><th>Source</th><th>Destination</th><th>Status</th><th>Progress</th><th class="right">Items</th><th class="right">Data</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No users in scope. Use “Discover &amp; add users” or import a CSV mapping.</div>'}
      ${total > 100 ? `<div class="pager">
        <button class="small" id="pg-prev" ${offset === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span>${offset + 1}–${Math.min(offset + 100, total)} of ${total}</span>
        <button class="small" id="pg-next" ${offset + 100 >= total ? 'disabled' : ''}>Next ›</button>
      </div>` : ''}
    </div>`;

  const selected = () => [...c.querySelectorAll('[data-sel]:checked')].map((x) => x.dataset.sel);
  const selAll = c.querySelector('#sel-all');
  if (selAll) selAll.addEventListener('change', () => {
    c.querySelectorAll('[data-sel]').forEach((x) => { x.checked = selAll.checked; });
  });
  c.querySelectorAll('tr[data-user]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    userDetailModal(project, tr.dataset.user);
  }));
  c.querySelector('#u-discover').addEventListener('click', () => discoverModal(project));
  c.querySelector('#u-import').addEventListener('click', () => importCsvModal(project));
  c.querySelector('#u-provision').addEventListener('click', () => {
    const ids = selected();
    if (!ids.length) return toast('Select users first', 'error');
    provisionModal(project, ids);
  });
  c.querySelector('#u-start-sel').addEventListener('click', () => {
    const ids = selected();
    if (!ids.length) return toast('Select users first', 'error');
    startPassModal(project, ids);
  });
  c.querySelector('#u-remove').addEventListener('click', async () => {
    const ids = selected();
    if (!ids.length) return toast('Select users first', 'error');
    if (!confirm(`Remove ${ids.length} user(s) from scope? (No tenant data is touched.)`)) return;
    for (const id of ids) {
      try { await api('DELETE', `/api/projects/${project.id}/users/${id}`); }
      catch (e) { toast(e.message, 'error'); }
    }
    viewProject(project.id, 'users');
  });
  const prev = c.querySelector('#pg-prev'); const next = c.querySelector('#pg-next');
  if (prev) prev.addEventListener('click', () => { sessionStorage.setItem(`off:${project.id}`, String(Math.max(0, offset - 100))); viewProject(project.id, 'users'); });
  if (next) next.addEventListener('click', () => { sessionStorage.setItem(`off:${project.id}`, String(offset + 100)); viewProject(project.id, 'users'); });
}

async function userDetailModal(project, userId) {
  const { user, recentErrors } = await api('GET', `/api/projects/${project.id}/users/${userId}`);
  const canEdit = user.status !== 'running' && user.status !== 'queued';
  const orderedKeys = [
    ...WORKLOADS.filter((w) => user.stats && user.stats[w]),
    ...Object.keys(user.stats || {}).filter((k) => !WORKLOADS.includes(k)),
  ];
  const activeWl = user.status === 'running' ? user.activity?.workload : null;
  const selected = user.passConfig?.workloads || [];
  const activeIdx = activeWl ? selected.indexOf(activeWl) : -1;
  const wlRows = orderedKeys.map((w) => {
    const st = user.stats[w];
    const idx = selected.indexOf(w);
    const finished =
      user.status === 'completed' || user.status === 'completed_with_errors' ||
      (activeIdx >= 0 && idx >= 0 && idx < activeIdx);
    const frac = finished ? 1 : workloadFraction(st);
    const denom = (st.expected || 0) > (st.discovered || 0) ? st.expected : st.discovered || 0;
    return `
    <tr><td>${esc(WORKLOAD_LABELS[w] || w)}${w === activeWl ? ' <span class="pill running">active</span>' : ''}</td>
    <td style="width:120px">${bar(frac, finished)}</td>
    <td class="right mono">${st.migrated || 0}/${denom}</td>
    <td class="right mono">${st.skipped || 0}</td><td class="right mono" style="color:${st.failed ? 'var(--red)' : 'inherit'}">${st.failed || 0}</td>
    <td class="right mono">${fmtBytes(st.bytes || 0)}${st.expectedBytes ? `<span class="muted"> / ${fmtBytes(st.expectedBytes)}</span>` : ''}</td></tr>`;
  }).join('');
  const elapsed = user.startedAt && user.status === 'running'
    ? `${Math.max(1, Math.round((Date.now() - Date.parse(user.startedAt)) / 60000))} min`
    : null;
  const errRows = recentErrors.map((e) => `
    <tr><td>${esc(e.workload)}</td><td>${esc(e.itemType || '')}</td>
    <td>${esc(e.itemName || e.itemId || '')}</td><td class="mono" style="font-size:.76rem">${esc(e.code || '')}: ${esc((e.message || '').slice(0, 160))}</td></tr>`).join('');
  const m = modal(`
    <h2>${esc(user.sourceUpn)} ${pill(user.status)}</h2>
    <dl class="kv">
      <dt>Destination</dt><dd class="mono" id="ud-dest-row">${esc(user.destUpn)}${canEdit ? ' <button class="small" id="ud-edit-dest">Edit</button>' : ''}</dd>
      <dt>Last pass</dt><dd>${esc(user.passType || '—')}</dd>
      <dt>Started</dt><dd>${fmtDate(user.startedAt)}${elapsed ? ` <span class="muted">(${elapsed} elapsed)</span>` : ''}</dd>
      <dt>Completed</dt><dd>${fmtDate(user.completedAt)}</dd>
      <dt>Heartbeat</dt><dd>${fmtDate(user.heartbeatAt)}</dd>
      ${user.status === 'running' && user.activity ? `<dt>Activity</dt><dd>${esc(activityLabel(user.activity))}</dd>` : ''}
      ${user.error ? `<dt>Error</dt><dd style="color:var(--red)">${esc(user.error)}</dd>` : ''}
    </dl>
    <div style="margin:.8rem 0">${progressBar(user)}</div>
    <h2>Workloads</h2>
    ${wlRows ? `<table class="wl-table"><thead><tr><th>Workload</th><th>Progress</th><th class="right">Migrated</th><th class="right">Skipped</th><th class="right">Failed</th><th class="right">Data</th></tr></thead><tbody>${wlRows}</tbody></table>` : '<div class="muted">No stats yet.</div>'}
    ${errRows ? `<h2>Recent item errors</h2><table class="wl-table"><tbody>${errRows}</tbody></table>` : ''}
    <div class="actions">
      ${user.status === 'running' || user.status === 'queued'
        ? `<button class="danger" id="ud-stop">Stop</button>`
        : `<button id="ud-start">Start a pass…</button>`}
      <button id="ud-close">Close</button>
    </div>`, { wide: true });
  m.querySelector('#ud-close').addEventListener('click', closeModal);
  const editBtn = m.querySelector('#ud-edit-dest');
  if (editBtn) editBtn.addEventListener('click', () => {
    const row = m.querySelector('#ud-dest-row');
    row.innerHTML = `
      <input id="ud-dest-input" class="mono" value="${esc(user.destUpn)}" style="max-width:300px;display:inline-block;width:auto" />
      <button class="small primary" id="ud-dest-save">Save</button>
      <button class="small" id="ud-dest-cancel">Cancel</button>`;
    const input = row.querySelector('#ud-dest-input');
    input.focus();
    row.querySelector('#ud-dest-cancel').addEventListener('click', () => {
      closeModal(); userDetailModal(project, userId);
    });
    const save = async () => {
      const destUpn = input.value.trim().toLowerCase();
      if (!destUpn.includes('@')) return toast('Enter a full UPN (user@domain)', 'error');
      if (destUpn === user.destUpn) { closeModal(); userDetailModal(project, userId); return; }
      const hasHistory = user.startedAt || Object.keys(user.stats || {}).length > 0;
      if (hasHistory && !confirm(
        'Changing the destination resets this user\'s migration state (id map and delta cursors). ' +
        'Items already copied to the old mailbox stay there, and the next pass re-copies everything ' +
        'to the new destination. Continue?')) return;
      try {
        await api('PATCH', `/api/projects/${project.id}/users/${userId}`, { destUpn });
        toast(`Destination changed to ${destUpn}`, 'ok');
        closeModal(); userDetailModal(project, userId);
      } catch (e) { toast(e.message, 'error'); }
    };
    row.querySelector('#ud-dest-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  });
  const stopBtn = m.querySelector('#ud-stop');
  if (stopBtn) stopBtn.addEventListener('click', async () => {
    try { await api('POST', `/api/projects/${project.id}/stop`, { userIds: [userId] }); closeModal(); toast('Stop requested', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  });
  const startBtn = m.querySelector('#ud-start');
  if (startBtn) startBtn.addEventListener('click', () => { closeModal(); startPassModal(project, [userId]); });
}

async function discoverModal(project) {
  const m = modal(`
    <h2>Discover source users</h2>
    <div class="searchrow">
      <input id="d-filter" placeholder="optional OData $filter, e.g. startswith(userPrincipalName,'a')" />
      <button class="primary" id="d-run">Discover</button>
    </div>
    <div id="d-results" class="muted">Query the source tenant to list users.</div>
    <label>Destination domain (auto-map UPNs)</label>
    <input id="d-domain" placeholder="newcorp.com" />
    <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="d-add" disabled>Add selected</button></div>`, { wide: true });
  m.querySelector('#m-cancel').addEventListener('click', closeModal);
  let discovered = [];
  m.querySelector('#d-run').addEventListener('click', async () => {
    const btn = m.querySelector('#d-run');
    btn.disabled = true; btn.textContent = 'Discovering…';
    try {
      const filter = m.querySelector('#d-filter').value.trim() || undefined;
      const res = await api('POST', `/api/projects/${project.id}/discover`, { filter });
      discovered = res.users;
      m.querySelector('#d-results').innerHTML = `
        ${res.truncated ? '<div class="warn-box">Result truncated — refine with a filter.</div>' : ''}
        <div style="max-height:320px;overflow-y:auto">
        <table><thead><tr><th class="checkbox-col"><input type="checkbox" id="d-all" checked /></th><th>UPN</th><th>Name</th><th>Licensed</th></tr></thead>
        <tbody>${discovered.map((u, i) => `
          <tr><td><input type="checkbox" data-di="${i}" ${u.accountEnabled !== false ? 'checked' : ''} /></td>
          <td class="mono">${esc(u.userPrincipalName)}</td><td>${esc(u.displayName || '')}</td>
          <td>${u.licensed ? '✓' : '<span class="muted">—</span>'}</td></tr>`).join('')}
        </tbody></table></div>`;
      m.querySelector('#d-add').disabled = false;
      m.querySelector('#d-all').addEventListener('change', (e) => {
        m.querySelectorAll('[data-di]').forEach((x) => { x.checked = e.target.checked; });
      });
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false; btn.textContent = 'Discover';
  });
  m.querySelector('#d-add').addEventListener('click', async () => {
    const domain = m.querySelector('#d-domain').value.trim();
    if (!domain) return toast('Enter the destination domain', 'error');
    const picked = [...m.querySelectorAll('[data-di]:checked')].map((x) => discovered[+x.dataset.di]);
    if (!picked.length) return toast('Select at least one user', 'error');
    try {
      const res = await api('POST', `/api/projects/${project.id}/users`, {
        autoMap: {
          targetDomain: domain,
          users: picked.map((u) => ({ sourceUpn: u.userPrincipalName, displayName: u.displayName, sourceId: u.id })),
        },
      });
      closeModal();
      toast(`Added ${res.added}, updated ${res.updated}${res.remapped ? `, remapped ${res.remapped}` : ''}${res.conflicts?.length ? ` — ${res.conflicts.length} skipped (active migration)` : ''}`, 'ok');
      viewProject(project.id, 'users');
    } catch (e) { toast(e.message, 'error'); }
  });
}

function importCsvModal(project) {
  const m = modal(`
    <h2>Import user mapping CSV</h2>
    <p class="sub">One mapping per line: <code>source.upn@old.com,dest.upn@new.com</code> (header optional).</p>
    <textarea id="csv" rows="10" placeholder="sourceUpn,destUpn&#10;ada@contoso.com,ada@fabrikam.com"></textarea>
    <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Import</button></div>`);
  m.querySelector('#m-cancel').addEventListener('click', closeModal);
  m.querySelector('#m-save').addEventListener('click', async () => {
    try {
      const res = await api('POST', `/api/projects/${project.id}/users/import`, m.querySelector('#csv').value, { raw: true, contentType: 'text/csv' });
      closeModal();
      toast(`Imported: ${res.added} added, ${res.updated} updated${res.remapped ? `, ${res.remapped} remapped` : ''}${res.conflicts?.length ? `, ${res.conflicts.length} skipped (active migration)` : ''}${res.parseErrors?.length ? `, ${res.parseErrors.length} line(s) invalid` : ''}`, 'ok');
      viewProject(project.id, 'users');
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function provisionModal(project, userIds) {
  let skus = [];
  try { skus = (await api('GET', `/api/projects/${project.id}/skus`)).skus; }
  catch (e) { toast(`Could not load SKUs: ${e.message}`, 'error'); }
  const m = modal(`
    <h2>Provision ${userIds.length} destination account(s)</h2>
    <p class="sub">Creates missing users in the destination tenant with a one-time password (shown once, never stored). Existing users are left untouched.</p>
    <label>Usage location (required for licensing)</label>
    <input id="pv-loc" placeholder="GB" maxlength="2" style="max-width:90px" />
    <label>Licenses to assign</label>
    ${skus.length ? skus.map((s) => `
      <label class="inline"><input type="checkbox" data-sku="${s.skuId}" />
      ${esc(s.skuPartNumber)} <span class="muted">(${s.consumedUnits}/${s.enabledUnits} used)</span></label>`).join('')
      : '<div class="muted">No SKUs visible (or destination connector cannot read them).</div>'}
    <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Provision</button></div>`);
  m.querySelector('#m-cancel').addEventListener('click', closeModal);
  m.querySelector('#m-save').addEventListener('click', async () => {
    const btn = m.querySelector('#m-save');
    btn.disabled = true; btn.textContent = 'Provisioning…';
    try {
      const res = await api('POST', `/api/projects/${project.id}/provision`, {
        userIds,
        usageLocation: m.querySelector('#pv-loc').value.trim().toUpperCase() || undefined,
        skuIds: [...m.querySelectorAll('[data-sku]:checked')].map((x) => x.dataset.sku),
      });
      const created = res.results.filter((r) => r.status === 'created');
      const failed = res.results.filter((r) => r.status === 'failed');
      modal(`
        <h2>Provisioning result</h2>
        ${created.length ? `<div class="warn-box"><strong>Save these one-time passwords now</strong> — they will not be shown again.</div>
        <table><thead><tr><th>User</th><th>Temporary password</th></tr></thead><tbody>
        ${created.map((r) => `<tr><td class="mono">${esc(r.destUpn)}</td><td class="mono">${esc(r.password)}</td></tr>`).join('')}
        </tbody></table>` : ''}
        <p class="sub">${res.results.filter((r) => r.status === 'exists').length} already existed, ${failed.length} failed.</p>
        ${failed.length ? `<table><tbody>${failed.map((r) => `<tr><td class="mono">${esc(r.destUpn)}</td><td style="color:var(--red);font-size:.8rem">${esc(r.error)}</td></tr>`).join('')}</tbody></table>` : ''}
        <div class="actions"><button id="m-close" class="primary">Done</button></div>`, { wide: true })
        .querySelector('#m-close').addEventListener('click', () => { closeModal(); viewProject(project.id, 'users'); });
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Provision'; }
  });
}

// -- Migrate tab --------------------------------------------------------------

// Previous progress snapshots per project, for client-side throughput rates.
const rateState = new Map();

function throughput(projectId, totals) {
  const now = Date.now();
  const prev = rateState.get(projectId);
  rateState.set(projectId, { ts: now, migrated: totals.migrated, bytes: totals.bytes });
  if (!prev || now - prev.ts < 2000 || now - prev.ts > 120000) return null;
  const mins = (now - prev.ts) / 60000;
  return {
    itemsPerMin: Math.max(0, Math.round((totals.migrated - prev.migrated) / mins)),
    bytesPerMin: Math.max(0, (totals.bytes - prev.bytes) / mins),
  };
}

async function tabMigrate(c, project) {
  let queue = { queued: 0, running: [], maxConcurrent: project.settings.maxConcurrentUsers };
  let progress = { totals: {}, byWorkload: {}, statusCounts: {}, active: [] };
  try { queue = await api('GET', `/api/projects/${project.id}/queue`); } catch { /* coordinator not yet created */ }
  try { progress = await api('GET', `/api/projects/${project.id}/progress`); } catch { /* no data yet */ }
  const t = { discovered: 0, migrated: 0, skipped: 0, failed: 0, bytes: 0, expected: 0, expectedBytes: 0, ...progress.totals };
  const denom = Math.max(t.expected, t.discovered);
  const rate = throughput(project.id, t);

  const wlRows = WORKLOADS.filter((w) => progress.byWorkload[w]).map((w) => {
    const s = progress.byWorkload[w];
    const wDenom = Math.max(s.expected || 0, s.discovered || 0);
    const done = (s.migrated || 0) + (s.skipped || 0) + (s.failed || 0);
    const frac = s.expectedBytes > 0 && w === 'drive'
      ? Math.min(1, (s.bytes || 0) / s.expectedBytes)
      : wDenom > 0 ? Math.min(1, done / wDenom) : 0;
    return `
      <tr><td>${WORKLOAD_LABELS[w]}</td>
      <td style="width:160px">${bar(frac, false)}</td>
      <td class="right mono">${s.migrated || 0}/${wDenom}</td>
      <td class="right mono">${s.skipped || 0}</td>
      <td class="right mono" style="color:${s.failed ? 'var(--red)' : 'inherit'}">${s.failed || 0}</td>
      <td class="right mono">${fmtBytes(s.bytes || 0)}${s.expectedBytes ? `<span class="muted"> / ${fmtBytes(s.expectedBytes)}</span>` : ''}</td></tr>`;
  }).join('');

  const activeRows = (progress.active || []).map((u) => `
    <tr class="clickable" data-user="${u.id}">
      <td><strong>${esc(u.sourceUpn)}</strong></td>
      <td style="width:160px">${bar(userProgress({ ...u, status: 'running' }), false)}</td>
      <td class="muted" style="font-size:.78rem">${esc(activityLabel(u.activity)) || 'starting'}</td>
      <td class="muted right" style="font-size:.78rem;white-space:nowrap">${u.startedAt ? `${Math.max(1, Math.round((Date.now() - Date.parse(u.startedAt)) / 60000))} min` : ''}</td>
    </tr>`).join('');

  c.innerHTML = `
    <div class="card">
      <div class="page-head" style="margin-bottom:.4rem">
        <h3 style="margin:0">Live progress</h3>
        <div class="btnrow">
          <button class="primary" id="mg-start">Start a pass…</button>
          <button class="danger" id="mg-stop">Stop all</button>
        </div>
      </div>
      <div class="statrow">
        <div class="stat"><div class="n">${t.migrated.toLocaleString()}<span class="muted" style="font-size:.85rem"> / ${denom.toLocaleString()}</span></div><div class="l">items migrated</div></div>
        <div class="stat"><div class="n">${fmtBytes(t.bytes)}${t.expectedBytes ? `<span class="muted" style="font-size:.85rem"> / ${fmtBytes(t.expectedBytes)}</span>` : ''}</div><div class="l">data moved</div></div>
        <div class="stat"><div class="n" style="color:${t.failed ? 'var(--red)' : 'inherit'}">${t.failed.toLocaleString()}</div><div class="l">item failures</div></div>
        <div class="stat"><div class="n">${(queue.running || []).length}<span class="muted" style="font-size:.85rem"> +${queue.queued || 0} waiting</span></div><div class="l">running (max ${queue.maxConcurrent || project.settings.maxConcurrentUsers})</div></div>
        <div class="stat"><div class="n">${rate ? rate.itemsPerMin.toLocaleString() : '—'}</div><div class="l">items / min</div></div>
        <div class="stat"><div class="n">${rate ? fmtBytes(rate.bytesPerMin) : '—'}</div><div class="l">data / min</div></div>
      </div>
      <div style="margin-top:.8rem">${bar(denom > 0 ? Math.min(1, (t.migrated + t.skipped + t.failed) / denom) : 0, false)}</div>
      ${wlRows ? `
      <h2 style="margin-top:1.2rem">By workload</h2>
      <table class="wl-table"><thead><tr><th>Workload</th><th>Progress</th><th class="right">Migrated</th><th class="right">Skipped</th><th class="right">Failed</th><th class="right">Data</th></tr></thead><tbody>${wlRows}</tbody></table>` : ''}
      ${activeRows ? `
      <h2 style="margin-top:1.2rem">Active mailboxes</h2>
      <table class="wl-table"><tbody>${activeRows}</tbody></table>` : ''}
      <div class="muted" style="font-size:.8rem;margin-top:.8rem">
        Recommended cutover sequence: <strong>assessment → provision → pre-stage → delta passes → MX/domain cutover → final delta</strong>.
        Totals come from mailbox folder counts and OneDrive quota captured at pass start; Graph throttling is handled automatically.
      </div>
    </div>
    <div class="card">
      <h3>Reports</h3>
      <div class="btnrow">
        <button id="rp-users">Download user report (CSV)</button>
        <button id="rp-errors">Download error report (CSV)</button>
      </div>
      <div class="muted" style="font-size:.8rem;margin-top:.5rem">Reports are also archived to the R2 bucket.</div>
    </div>`;

  c.querySelectorAll('tr[data-user]').forEach((tr) => tr.addEventListener('click', () => {
    userDetailModal(project, tr.dataset.user);
  }));
  c.querySelector('#mg-start').addEventListener('click', () => startPassModal(project, null));
  c.querySelector('#mg-stop').addEventListener('click', async () => {
    if (!confirm('Stop all queued and running migrations in this project?')) return;
    try { const r = await api('POST', `/api/projects/${project.id}/stop`, {}); toast(`Stopped: ${r.dequeued.length} dequeued, ${r.signaled.length} running signaled`, 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  });
  const download = async (type) => {
    try {
      const blob = await api('GET', `/api/projects/${project.id}/report?type=${type}`, undefined, { blob: true });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `dolop-${type}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message, 'error'); }
  };
  c.querySelector('#rp-users').addEventListener('click', () => download('users'));
  c.querySelector('#rp-errors').addEventListener('click', () => download('errors'));
}

function startPassModal(project, userIds) {
  const defaults = project.settings.defaultWorkloads || WORKLOADS;
  const m = modal(`
    <h2>Start a migration pass ${userIds ? `(${userIds.length} selected user(s))` : '(all eligible users)'}</h2>
    <label>Pass type</label>
    <select id="sp-type">
      <option value="assessment">Assessment — size mailboxes/OneDrive, verify destination (writes nothing)</option>
      <option value="prestage">Pre-stage — bulk-copy older mail ahead of cutover</option>
      <option value="full" selected>Full — migrate everything (incremental & idempotent)</option>
      <option value="delta">Delta — only changes since the previous pass</option>
    </select>
    <div id="sp-prestage" style="display:none">
      <label>Only migrate mail received before</label>
      <input id="sp-cutoff" type="date" />
    </div>
    <label>Workloads</label>
    ${WORKLOADS.map((w) => `<label class="inline"><input type="checkbox" data-wl="${w}" ${defaults.includes(w) ? 'checked' : ''} /> ${WORKLOAD_LABELS[w]}</label>`).join('')}
    <label>Options</label>
    <label class="inline"><input type="checkbox" id="sp-deleted" /> Include Deleted Items</label>
    <label class="inline"><input type="checkbox" id="sp-junk" /> Include Junk Email</label>
    <label class="inline"><input type="checkbox" id="sp-attendees" /> Preserve event attendees <span class="muted">(may send meeting invitations!)</span></label>
    <div class="actions"><button id="m-cancel">Cancel</button><button class="primary" id="m-save">Start</button></div>`);
  const typeSel = m.querySelector('#sp-type');
  typeSel.addEventListener('change', () => {
    m.querySelector('#sp-prestage').style.display = typeSel.value === 'prestage' ? 'block' : 'none';
  });
  m.querySelector('#m-cancel').addEventListener('click', closeModal);
  m.querySelector('#m-save').addEventListener('click', async () => {
    try {
      const passType = typeSel.value;
      const filters = {
        excludeDeletedItems: !m.querySelector('#sp-deleted').checked,
        excludeJunk: !m.querySelector('#sp-junk').checked,
        calendarAttendees: m.querySelector('#sp-attendees').checked ? 'preserve' : 'strip',
      };
      if (passType === 'prestage') {
        const cutoff = m.querySelector('#sp-cutoff').value;
        if (!cutoff) return toast('Pick the pre-stage cutoff date', 'error');
        filters.mailReceivedBefore = `${cutoff}T00:00:00Z`;
      }
      const body = {
        passType,
        workloads: [...m.querySelectorAll('[data-wl]:checked')].map((x) => x.dataset.wl),
        filters,
      };
      if (userIds) body.userIds = userIds;
      const res = await api('POST', `/api/projects/${project.id}/start`, body);
      closeModal(); toast(`${res.queued} user(s) queued for ${passType} pass`, 'ok');
      viewProject(project.id, 'users');
    } catch (e) { toast(e.message, 'error'); }
  });
}

// -- Errors / Events tabs ------------------------------------------------------

async function tabErrors(c, project) {
  const { errors, total } = await api('GET', `/api/projects/${project.id}/errors?limit=200`);
  const { users } = await api('GET', `/api/projects/${project.id}/users?limit=500`);
  const upn = new Map(users.map((u) => [u.id, u.sourceUpn]));
  c.innerHTML = `
    <div class="card">
      <div class="sub" style="margin-bottom:.6rem">${total} item error(s). Item errors do not stop a migration — re-run a delta pass after fixing root causes.</div>
      ${errors.length ? `<table><thead><tr><th>User</th><th>Workload</th><th>Type</th><th>Item</th><th>Error</th><th>When</th></tr></thead><tbody>
      ${errors.map((e) => `<tr>
        <td class="mono" style="font-size:.78rem">${esc(upn.get(e.userId) || e.userId)}</td>
        <td>${esc(e.workload)}</td><td>${esc(e.itemType || '')}</td>
        <td>${esc((e.itemName || e.itemId || '').slice(0, 60))}</td>
        <td class="mono" style="font-size:.76rem">${esc(e.code || '')}: ${esc((e.message || '').slice(0, 180))}</td>
        <td class="muted" style="font-size:.78rem;white-space:nowrap">${fmtDate(e.createdAt)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No item errors recorded. 🎉</div>'}
    </div>`;
}

async function tabEvents(c, project) {
  const { events } = await api('GET', `/api/projects/${project.id}/events`);
  c.innerHTML = `
    <div class="card">
      ${events.length ? `<table><tbody>
      ${events.map((e) => `<tr>
        <td class="muted" style="white-space:nowrap;font-size:.78rem">${fmtDate(e.created_at)}</td>
        <td>${e.level === 'error' ? '🔴' : e.level === 'warn' ? '🟡' : '🔵'}</td>
        <td>${esc(e.message)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No events yet.</div>'}
    </div>`;
}

// -- Settings tab ----------------------------------------------------------------

async function tabSettings(c, project, data) {
  const { connectors } = await api('GET', '/api/connectors');
  const st = project.settings;
  const conOptions = (current) => ['<option value="">— none —</option>']
    .concat(connectors.map((x) => `<option value="${x.id}" ${x.id === current ? 'selected' : ''}>${esc(x.name)}</option>`)).join('');
  c.innerHTML = `
    <div class="card" style="max-width:620px">
      <h3>Project settings</h3>
      <div class="formgrid">
        <div><label>Source connector</label><select id="st-src">${conOptions(project.sourceConnectorId)}</select></div>
        <div><label>Destination connector</label><select id="st-dst">${conOptions(project.destConnectorId)}</select></div>
      </div>
      <label>Concurrent user migrations</label>
      <input id="st-conc" type="number" min="1" max="100" value="${st.maxConcurrentUsers}" style="max-width:110px" />
      <label>Default workloads</label>
      ${WORKLOADS.map((w) => `<label class="inline"><input type="checkbox" data-stwl="${w}" ${st.defaultWorkloads.includes(w) ? 'checked' : ''} /> ${WORKLOAD_LABELS[w]}</label>`).join('')}
      <label class="inline" style="margin-top:.9rem"><input type="checkbox" id="st-autodelta" ${st.autoDeltaEnabled ? 'checked' : ''} /> Automatic delta sync</label>
      <label>Delta interval (minutes)</label>
      <input id="st-interval" type="number" min="30" value="${st.autoDeltaIntervalMinutes || 240}" style="max-width:110px" />
      <div class="btnrow" style="margin-top:1.1rem">
        <button class="primary" id="st-save">Save</button>
        <button class="danger" id="st-delete">Delete project</button>
      </div>
    </div>`;
  c.querySelector('#st-save').addEventListener('click', async () => {
    try {
      await api('PATCH', `/api/projects/${project.id}`, {
        sourceConnectorId: c.querySelector('#st-src').value || undefined,
        destConnectorId: c.querySelector('#st-dst').value || undefined,
        settings: {
          maxConcurrentUsers: Math.max(1, parseInt(c.querySelector('#st-conc').value, 10) || 10),
          defaultWorkloads: [...c.querySelectorAll('[data-stwl]:checked')].map((x) => x.dataset.stwl),
          autoDeltaEnabled: c.querySelector('#st-autodelta').checked,
          autoDeltaIntervalMinutes: Math.max(30, parseInt(c.querySelector('#st-interval').value, 10) || 240),
        },
      });
      toast('Settings saved', 'ok');
      viewProject(project.id, 'settings');
    } catch (e) { toast(e.message, 'error'); }
  });
  c.querySelector('#st-delete').addEventListener('click', async () => {
    if (!confirm(`Delete project "${project.name}" and all its migration records? Tenant data is not affected.`)) return;
    try { await api('DELETE', `/api/projects/${project.id}`); location.hash = '#/'; }
    catch (e) { toast(e.message, 'error'); }
  });
  void data;
}

// ---------------------------------------------------------------------------
// Router

async function route() {
  stopPolling();
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  try {
    if (parts.length === 0) await viewProjects();
    else if (parts[0] === 'connectors') await viewConnectors();
    else if (parts[0] === 'account') await viewAccount();
    else if (parts[0] === 'projects' && parts[1]) await viewProject(parts[1], parts[2] || 'users');
    else await viewProjects();
  } catch (e) {
    if (e.message !== 'unauthorized') {
      $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }
}

window.addEventListener('hashchange', route);
document.getElementById('signout').addEventListener('click', async (e) => {
  e.preventDefault();
  localStorage.removeItem(TOKEN_KEY);
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
  renderLogin();
});
route();
