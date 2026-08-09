// Tiny fetch wrapper for the admin API.
const API = (() => {
  async function req(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),

    // auth
    login: (username, password) => req('POST', '/auth/login', { username, password }),
    logout: () => req('POST', '/auth/logout'),
    me: () => req('GET', '/auth/me'),

    // domain
    dashboard: () => req('GET', '/dashboard'),
    products: () => req('GET', '/products'),
    categories: () => req('GET', '/products/meta/categories'),
    stock: (pid, unsold) => req('GET', `/stock/product/${pid}${unsold ? '?unsold=1' : ''}`),
    orders: (q) => req('GET', `/orders?${new URLSearchParams(q)}`),
    order: (id) => req('GET', `/orders/${id}`),
    users: (q) => req('GET', `/users?${new URLSearchParams(q)}`),
    user: (id) => req('GET', `/users/${id}`),
    settings: () => req('GET', '/settings'),
  };
})();
