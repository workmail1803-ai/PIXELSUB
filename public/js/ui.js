// Shared UI helpers: toasts, modal, formatting, small DOM utilities.
const UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  const currencySymbols = { USD: '$', EUR: '€', GBP: '£', RUB: '₽', INR: '₹', UAH: '₴' };
  function money(n, cur = 'USD') {
    const sym = currencySymbols[cur] || '';
    const v = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym ? `${sym}${v}` : `${v} ${cur}`;
  }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }

  function timeAgo(dateStr) {
    const d = new Date(dateStr); const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  function dateTime(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Toasts
  function toast(message, kind = 'good') {
    const icon = kind === 'good' ? '✅' : kind === 'bad' ? '⛔' : 'ℹ️';
    const t = el('div', { class: `toast ${kind}` }, [el('span', { class: 'tc', text: icon }), el('div', { text: message })]);
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 300); }, 3200);
  }

  // Modal
  function modal({ title, subtitle, body, footer, wide }) {
    const root = $('#modal-root');
    const m = $('#modal');
    m.className = 'modal' + (wide ? ' wide' : '');
    m.innerHTML = '';
    const head = el('div', { class: 'modal-head' }, [
      el('div', {}, [el('h2', { text: title }), subtitle ? el('p', { text: subtitle }) : null]),
      el('button', { class: 'icon-btn', text: '✕', onclick: closeModal }),
    ]);
    m.appendChild(head);
    if (typeof body === 'string') m.appendChild(el('div', { html: body }));
    else if (body) m.appendChild(body);
    if (footer) m.appendChild(el('div', { class: 'modal-foot' }, footer));
    root.classList.remove('hidden');
    return m;
  }
  function closeModal() { $('#modal-root').classList.add('hidden'); $('#modal').innerHTML = ''; }

  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const foot = [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => { closeModal(); resolve(false); } }),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmText, onclick: () => { closeModal(); resolve(true); } }),
      ];
      modal({ title, body: el('p', { class: 'hint', text: message, style: 'font-size:14px;color:var(--muted)' }), footer: foot });
    });
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard')).catch(() => {});
  }

  function spinner() { return el('div', { class: 'loading' }, [el('div', { class: 'spinner' })]); }

  // init modal backdrop close
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  return { $, $$, el, esc, money, num, timeAgo, dateTime, toast, modal, closeModal, confirmDialog, copy, spinner };
})();
