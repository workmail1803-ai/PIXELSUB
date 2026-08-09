// App bootstrap: auth gate, routing, sidebar.
(() => {
  const { $, $$, toast } = UI;

  const ROUTES = {
    dashboard: { title: 'Dashboard', render: Views.dashboard },
    products: { title: 'Products', render: Views.products },
    orders: { title: 'Orders', render: Views.orders },
    users: { title: 'Customers', render: Views.users },
    broadcast: { title: 'Broadcast', render: Views.broadcast },
    settings: { title: 'Settings', render: Views.settings },
  };

  let current = 'dashboard';

  function go(route) {
    if (!ROUTES[route]) route = 'dashboard';
    current = route;
    location.hash = route;
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
    $('#page-title').textContent = ROUTES[route].title;
    $('#sidebar').classList.remove('open');
    ROUTES[route].render();
  }

  function showApp(admin) {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#admin-avatar').textContent = (admin?.username || 'A')[0].toUpperCase();
    const initial = (location.hash || '').replace('#', '') || 'dashboard';
    go(initial);
    loadHealthChip();
  }

  function showLogin() {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    setTimeout(() => $('#login-username')?.focus(), 100);
  }

  async function loadHealthChip() {
    try {
      const { runtime } = await API.settings();
      const chip = $('#health-chip');
      chip.innerHTML = '';
      const mk = (label, ok) => { const p = document.createElement('span'); p.className = 'pill ' + (ok ? 'ok' : 'off'); p.textContent = (ok ? '● ' : '○ ') + label; return p; };
      chip.appendChild(mk('Bot', runtime.botConfigured));
      chip.appendChild(mk('Crypto', runtime.cryptomusConfigured));
      const nameEl = $('#brand-name');
      const s = await API.settings();
      if (s.settings?.shop_name) nameEl.textContent = s.settings.shop_name;
    } catch { /* not logged in */ }
  }

  // ---- Login form ----
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const err = $('#login-error');
    err.textContent = '';
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Signing in…';
    try {
      const u = $('#login-username').value.trim();
      const p = $('#login-password').value;
      const res = await API.login(u, p);
      showApp(res.admin);
    } catch (ex) {
      err.textContent = ex.message || 'Login failed';
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Enter Dashboard';
    }
  });

  // ---- Nav ----
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => go(n.dataset.route)));
  $('#logout-btn').addEventListener('click', async () => { try { await API.logout(); } catch {} toast('Signed out'); showLogin(); });
  $('#refresh-btn').addEventListener('click', () => { ROUTES[current].render(); loadHealthChip(); });
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  window.addEventListener('hashchange', () => { const r = location.hash.replace('#', ''); if (r && r !== current && ROUTES[r]) go(r); });

  // ---- Boot: check session ----
  (async () => {
    try {
      const me = await API.me();
      showApp(me.admin);
    } catch {
      showLogin();
    }
  })();
})();
