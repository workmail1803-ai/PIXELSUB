// Page renderers for the admin SPA.
const Views = (() => {
  const { $, el, esc, money, num, timeAgo, dateTime, toast, modal, closeModal, confirmDialog, copy, spinner } = UI;
  let chart = null;

  function mount(node) {
    const view = $('#view');
    view.innerHTML = '';
    view.appendChild(node);
  }
  function loading() { mount(spinner()); }

  function statTile({ icon, label, value, delta, tint }) {
    return el('div', { class: 'stat', style: tint ? `--tint:${tint}` : '' }, [
      el('div', { class: 'stat-ico', text: icon }),
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-value', text: value }),
      delta ? el('div', { class: 'stat-delta up', html: delta }) : null,
    ]);
  }

  function badge(status) { return el('span', { class: `badge ${status}`, text: status }); }

  // ============================ DASHBOARD ============================
  async function dashboard() {
    loading();
    let d;
    try { d = await API.dashboard(); } catch (e) { return mount(errorBox(e)); }
    const s = d.stats;

    const wrap = el('div');
    const stats = el('div', { class: 'grid cols-4' }, [
      statTile({ icon: '💰', label: 'Total Revenue', value: money(s.revenue), delta: `+${money(s.revenueToday)} today`, tint: 'linear-gradient(135deg,#6c5cff,#a855f7)' }),
      statTile({ icon: '🧾', label: 'Orders', value: num(s.totalOrders), delta: `${s.deliveredOrders} delivered`, tint: 'linear-gradient(135deg,#22d3ee,#6c5cff)' }),
      statTile({ icon: '⏳', label: 'Pending Payments', value: num(s.pendingOrders), delta: 'auto-detected', tint: 'linear-gradient(135deg,#ffb020,#ff5c7a)' }),
      statTile({ icon: '👥', label: 'Customers', value: num(s.totalUsers), delta: `+${num(s.newUsersToday)} today`, tint: 'linear-gradient(135deg,#37d399,#22d3ee)' }),
    ]);
    wrap.appendChild(stats);

    const row = el('div', { class: 'grid cols-2', style: 'margin-top:18px' });
    // Revenue chart card
    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('div', {}, [el('h3', { text: 'Revenue · last 14 days' }), el('div', { class: 'sub', text: 'Paid & delivered orders' })])]),
      el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'revChart' })]),
    ]);
    row.appendChild(chartCard);

    // Top products card
    const topBody = d.topProducts.length
      ? el('div', {}, d.topProducts.map((t) => el('div', { class: 'row-flex', style: 'padding:9px 0;border-bottom:1px solid var(--stroke)' }, [
          el('span', { style: 'font-size:20px', text: t.emoji }),
          el('div', { class: 't-strong', text: t.name }),
          el('div', { class: 'right t-muted', text: `${t.qty} sold` }),
          el('div', { style: 'width:90px;text-align:right;font-weight:700', text: money(t.revenue) }),
        ])))
      : emptyState('📦', 'No sales yet');
    const topCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🔥 Top Products' })]),
      topBody,
    ]);
    row.appendChild(topCard);
    wrap.appendChild(row);

    // Low stock + recent orders
    const row2 = el('div', { class: 'grid cols-2', style: 'margin-top:18px' });
    const lowBody = d.lowStock.length
      ? el('div', {}, d.lowStock.map((p) => el('div', { class: 'row-flex', style: 'padding:9px 0;border-bottom:1px solid var(--stroke)' }, [
          el('span', { style: 'font-size:18px', text: p.emoji }),
          el('div', { class: 't-strong', text: p.name }),
          el('div', { class: `right stock-chip ${p.stock === 0 ? 'zero' : 'low'}`, text: p.stock === 0 ? 'OUT' : `${p.stock} left` }),
        ])))
      : emptyState('✅', 'All products well stocked');
    row2.appendChild(el('div', { class: 'card' }, [el('div', { class: 'card-head' }, [el('h3', { text: '⚠️ Low Stock' })]), lowBody]));

    const recentBody = d.recentOrders.length
      ? el('div', { class: 'table-wrap' }, [ordersTable(d.recentOrders, true)])
      : emptyState('🧾', 'No orders yet');
    row2.appendChild(el('div', { class: 'card', style: 'grid-column:auto' }, [el('div', { class: 'card-head' }, [el('h3', { text: '🕑 Recent Orders' })]), recentBody]));
    wrap.appendChild(row2);

    mount(wrap);

    // draw chart
    const ctx = document.getElementById('revChart');
    if (chart) { chart.destroy(); chart = null; }
    const grad = ctx.getContext('2d').createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, 'rgba(108,92,255,.5)');
    grad.addColorStop(1, 'rgba(108,92,255,0)');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: d.series.map((p) => p.date.slice(5)),
        datasets: [{
          label: 'Revenue', data: d.series.map((p) => p.revenue),
          borderColor: '#8b7bff', backgroundColor: grad, fill: true, tension: .38,
          borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#22d3ee',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#6b739a', maxTicksLimit: 8 } },
          y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#6b739a', callback: (v) => money(v) }, beginAtZero: true },
        },
      },
    });
  }

  function ordersTable(orders, compact) {
    const table = el('table');
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Order' }), el('th', { text: 'Customer' }), el('th', { text: 'Items' }),
      el('th', { text: 'Amount' }), el('th', { text: 'Status' }), el('th', { text: compact ? 'When' : 'Created' }),
    ])]));
    const tb = el('tbody');
    for (const o of orders) {
      tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => orderDetail(o.id) }, [
        el('td', { class: 'mono t-strong', text: o.publicId }),
        el('td', {}, [customerCell(o.user)]),
        el('td', { class: 't-muted', text: truncate(o.summary, 40) }),
        el('td', { class: 't-strong', text: money(o.amount, o.currency) }),
        el('td', {}, [badge(o.status)]),
        el('td', { class: 't-muted', text: compact ? timeAgo(o.createdAt) : dateTime(o.createdAt) }),
      ]));
    }
    table.appendChild(tb);
    return table;
  }

  function customerCell(u) {
    if (!u) return el('span', { class: 't-muted', text: '—' });
    const name = u.username ? '@' + u.username : (u.firstName || 'User');
    return el('div', {}, [el('div', { class: 't-strong', text: name }), el('div', { class: 't-muted mono', style: 'font-size:11px', text: u.telegramId })]);
  }

  // ============================ PRODUCTS ============================
  async function products() {
    loading();
    let data;
    try { data = await API.products(); } catch (e) { return mount(errorBox(e)); }
    const list = data.products;

    const head = el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [el('h2', { class: 'topbar-title', text: `${list.length} Products`, style: 'font-size:16px' })]),
      el('button', { class: 'btn btn-primary', html: '＋ New Product', onclick: () => productModal(null) }),
    ]);

    const grid = el('div', { class: 'prod-grid' });
    if (!list.length) grid.appendChild(emptyState('🏷️', 'No products yet — create your first one'));
    for (const p of list) grid.appendChild(productCard(p));

    mount(el('div', {}, [head, grid]));
  }

  function productCard(p) {
    const stockChip = p.usesStock
      ? el('span', { class: `stock-chip ${p.stock === 0 ? 'zero' : p.stock <= 3 ? 'low' : ''}`, text: p.stock === 0 ? 'Out of stock' : `${p.stock} in stock` })
      : el('span', { class: 'stock-chip', text: '♾️ Unlimited' });
    const activeChip = p.isActive ? null : el('span', { class: 'badge EXPIRED', text: 'Hidden' });
    return el('div', { class: 'card prod-card' + (p.isActive ? '' : ' dim') }, [
      el('div', { class: 'prod-top' }, [
        el('div', { class: 'prod-emoji', text: p.emoji }),
        el('div', {}, [el('div', { class: 'prod-name', text: p.name }), el('div', { class: 'prod-price', text: money(p.price) })]),
      ]),
      el('div', { class: 'prod-meta' }, [stockChip, activeChip]),
      el('div', { class: 'prod-actions' }, [
        p.usesStock ? el('button', { class: 'btn btn-sm btn-good', html: '📦 Stock', onclick: () => stockModal(p) }) : null,
        el('button', { class: 'btn btn-sm', html: '✎ Edit', onclick: () => productModal(p) }),
        el('button', { class: 'btn btn-sm btn-danger', html: '🗑', onclick: () => deleteProduct(p) }),
      ]),
    ]);
  }

  function productModal(p) {
    const isNew = !p;
    const f = (id) => document.getElementById(id);
    const body = el('div', { class: 'form-grid' }, [
      field('Emoji', `<input id="p-emoji" value="${esc(p?.emoji || '🛍️')}" maxlength="8" />`),
      field('Price (USD)', `<input id="p-price" type="number" step="0.01" min="0" value="${p?.price ?? ''}" />`),
      field('Name', `<input id="p-name" value="${esc(p?.name || '')}" />`, true),
      field('Description', `<textarea id="p-desc" placeholder="Shown on the product page">${esc(p?.description || '')}</textarea>`, true),
      field('Uses stock inventory', `<label class="switch"><input type="checkbox" id="p-stock" ${p?.usesStock !== false ? 'checked' : ''}/><span class="track"></span></label><span class="hint">Off = unlimited, delivers fixed content</span>`, true),
      field('Fixed delivery content (when stock is off)', `<textarea id="p-fixed" placeholder="Delivered to buyer. Supports {order_id}">${esc(p?.fixedContent || '')}</textarea>`, true),
      field('Active (visible in shop)', `<label class="switch"><input type="checkbox" id="p-active" ${p?.isActive !== false ? 'checked' : ''}/><span class="track"></span></label>`, true),
    ]);
    const save = el('button', { class: 'btn btn-primary', text: isNew ? 'Create Product' : 'Save Changes' });
    save.onclick = async () => {
      const payload = {
        name: f('p-name').value.trim(), emoji: f('p-emoji').value.trim() || '🛍️',
        description: f('p-desc').value, price: parseFloat(f('p-price').value),
        usesStock: f('p-stock').checked, fixedContent: f('p-fixed').value,
        isActive: f('p-active').checked,
      };
      if (!payload.name || !(payload.price >= 0)) return toast('Name and a valid price are required', 'bad');
      save.disabled = true;
      try {
        if (isNew) await API.post('/products', payload);
        else await API.put(`/products/${p.id}`, payload);
        toast(isNew ? 'Product created' : 'Product updated');
        closeModal(); products();
      } catch (e) { toast(e.message, 'bad'); save.disabled = false; }
    };
    modal({ title: isNew ? 'New Product' : 'Edit Product', body, footer: [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }), save], wide: true });
  }

  async function deleteProduct(p) {
    if (!(await confirmDialog({ title: 'Delete product?', message: `“${p.name}” will be removed. If it has order history it will be hidden instead.`, confirmText: 'Delete', danger: true }))) return;
    try { const r = await API.del(`/products/${p.id}`); toast(r.softDeleted ? 'Product hidden (has history)' : 'Product deleted'); products(); }
    catch (e) { toast(e.message, 'bad'); }
  }

  async function stockModal(p) {
    const m = modal({
      title: `📦 Stock · ${p.emoji} ${p.name}`,
      subtitle: 'Paste one item (code/account) per line. Each line becomes one deliverable unit.',
      body: el('div', {}, [spinner()]),
      wide: true,
    });
    let data;
    try { data = await API.stock(p.id); } catch (e) { return toast(e.message, 'bad'); }

    const textarea = el('textarea', { id: 'stock-input', placeholder: 'ACCOUNT-1:pass\nACCOUNT-2:pass\nCODE-XXXX-YYYY', style: 'min-height:150px' });
    const info = el('div', { class: 'row-flex', style: 'margin:12px 0' }, [
      el('span', { class: 'stock-chip', text: `${data.available} available` }),
      el('span', { class: 'badge EXPIRED', text: `${data.sold} sold` }),
      el('button', { class: 'btn btn-sm btn-danger right', html: '🧹 Clear unsold', onclick: async () => {
        if (!(await confirmDialog({ title: 'Clear unsold stock?', message: 'Deletes all unsold items for this product.', confirmText: 'Clear', danger: true }))) return;
        try { await API.del(`/stock/product/${p.id}/clear`); toast('Unsold stock cleared'); stockModal(p); } catch (e) { toast(e.message, 'bad'); }
      } }),
    ]);

    const listWrap = el('div', { class: 'table-wrap', style: 'max-height:220px;overflow-y:auto' });
    const t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Content' }), el('th', { text: 'Status' }), el('th', { text: '' })])]));
    const tb = el('tbody');
    for (const it of data.items) {
      tb.appendChild(el('tr', {}, [
        el('td', { class: 'mono', text: truncate(it.content, 46) }),
        el('td', {}, [el('span', { class: `badge ${it.isSold ? 'DELIVERED' : 'PAID'}`, text: it.isSold ? 'sold' : 'available' })]),
        el('td', {}, [it.isSold ? el('span', { class: 't-muted', text: dateTime(it.soldAt) }) : el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => { try { await API.del(`/stock/${it.id}`); toast('Removed'); stockModal(p); } catch (e) { toast(e.message, 'bad'); } } })]),
      ]));
    }
    t.appendChild(tb); listWrap.appendChild(data.items.length ? t : emptyState('📭', 'No stock items yet'));

    const addBtn = el('button', { class: 'btn btn-primary', html: '＋ Add stock' });
    addBtn.onclick = async () => {
      const content = textarea.value.trim();
      if (!content) return toast('Paste at least one line', 'bad');
      addBtn.disabled = true;
      try { const r = await API.post(`/stock/product/${p.id}`, { content }); toast(`Added ${r.added} item(s)`); textarea.value = ''; stockModal(p); }
      catch (e) { toast(e.message, 'bad'); addBtn.disabled = false; }
    };

    m.querySelector('.modal-head').insertAdjacentElement('afterend',
      el('div', {}, [
        el('div', { class: 'field' }, [el('span', { text: 'Add new stock' }), textarea]),
        el('div', { class: 'modal-foot', style: 'margin-top:12px' }, [addBtn]),
        info, listWrap,
        el('div', { class: 'modal-foot' }, [el('button', { class: 'btn btn-ghost', text: 'Done', onclick: () => { closeModal(); products(); } })]),
      ])
    );
    // remove the spinner we injected as body
    const spin = m.querySelector('.loading'); if (spin) spin.remove();
  }

  // ============================ ORDERS ============================
  const orderState = { status: 'ALL', search: '', page: 1 };
  async function orders() {
    const wrap = el('div');
    const statuses = ['ALL', 'PENDING', 'PAID', 'DELIVERED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'FAILED'];
    const seg = el('div', { class: 'seg' }, statuses.map((s) =>
      el('button', { class: orderState.status === s ? 'active' : '', text: s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase(), onclick: () => { orderState.status = s; orderState.page = 1; orders(); } })));
    const search = el('div', { class: 'search grow' }, [el('input', { placeholder: 'Search order id, username, telegram id…', value: orderState.search, onkeydown: (e) => { if (e.key === 'Enter') { orderState.search = e.target.value.trim(); orderState.page = 1; orders(); } } })]);
    wrap.appendChild(el('div', { class: 'toolbar' }, [seg, search]));

    const container = el('div', {}, [spinner()]);
    wrap.appendChild(container);
    mount(wrap);

    let data;
    try { data = await API.orders({ status: orderState.status, search: orderState.search, page: orderState.page, pageSize: 25 }); }
    catch (e) { container.innerHTML = ''; container.appendChild(errorBox(e)); return; }

    container.innerHTML = '';
    if (!data.orders.length) { container.appendChild(el('div', { class: 'card' }, [emptyState('🧾', 'No orders match')])); return; }
    container.appendChild(el('div', { class: 'table-wrap' }, [ordersTable(data.orders)]));
    container.appendChild(pager(data, (pg) => { orderState.page = pg; orders(); }));
  }

  async function orderDetail(id) {
    modal({ title: 'Order', body: el('div', {}, [spinner()]), wide: true });
    let data;
    try { data = (await API.order(id)).order; } catch (e) { return toast(e.message, 'bad'); }

    const o = data;
    const actions = el('div', { class: 'modal-foot', style: 'flex-wrap:wrap' }, []);
    const act = (label, cls, fn) => { const b = el('button', { class: `btn btn-sm ${cls}`, html: label }); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'bad'); b.disabled = false; } }; return b; };
    if (o.status === 'PENDING') actions.appendChild(act('🔄 Re-check payment', 'btn-good', async () => { const r = await API.post(`/orders/${o.id}/recheck`); toast(`Status: ${r.status}`); closeModal(); orderDetail(o.id); }));
    if (['PAID', 'DELIVERED'].includes(o.status)) actions.appendChild(act('📤 Re-deliver', 'btn-good', async () => { await API.post(`/orders/${o.id}/redeliver`); toast('Delivery re-sent'); }));
    if (['PAID', 'DELIVERED'].includes(o.status)) actions.appendChild(act('↩️ Mark refunded', '', async () => { await API.post(`/orders/${o.id}/refund`); toast('Marked refunded'); closeModal(); orderDetail(o.id); }));
    if (o.status === 'PENDING') actions.appendChild(act('✕ Cancel', 'btn-danger', async () => { await API.post(`/orders/${o.id}/cancel`); toast('Cancelled'); closeModal(); orderDetail(o.id); }));

    const itemsList = el('div', {}, o.items.map((i) => el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--stroke)' }, [
      el('div', { class: 'row-flex' }, [el('span', { text: i.emoji }), el('span', { class: 't-strong', text: `${i.productName} ×${i.quantity}` }), el('span', { class: 'right t-strong', text: money(i.lineTotal, o.currency) })]),
      i.delivered && i.delivered.length ? el('div', { class: 'deliver-box copyable', title: 'Click to copy', text: i.delivered.join('\n'), onclick: () => copy(i.delivered.join('\n')) }) : null,
    ])));

    const kv = el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Order ID' }), el('div', { class: 'v mono', text: o.publicId }),
      el('div', { class: 'k', text: 'Status' }), el('div', { class: 'v' }, [badge(o.status)]),
      el('div', { class: 'k', text: 'Customer' }), el('div', { class: 'v', text: (o.user?.username ? '@' + o.user.username : o.user?.firstName || '—') }),
      el('div', { class: 'k', text: 'Telegram ID' }), el('div', { class: 'v mono', text: o.user?.telegramId || '—' }),
      el('div', { class: 'k', text: 'Amount' }), el('div', { class: 'v', text: money(o.amount, o.currency) }),
      el('div', { class: 'k', text: 'Paid in' }), el('div', { class: 'v', text: o.payAmount ? `${o.payAmount} ${o.payCurrency || ''} ${o.network ? '(' + o.network + ')' : ''}` : '—' }),
      el('div', { class: 'k', text: 'Created' }), el('div', { class: 'v', text: dateTime(o.createdAt) }),
      el('div', { class: 'k', text: 'Paid at' }), el('div', { class: 'v', text: dateTime(o.paidAt) }),
      el('div', { class: 'k', text: 'Delivered' }), el('div', { class: 'v', text: dateTime(o.deliveredAt) }),
    ]);

    const timeline = el('div', { class: 'timeline' }, (o.events || []).map((ev) => el('div', { class: 'tl-item' }, [
      el('div', { class: 'tl-dot' }),
      el('div', { class: 'tl-body' }, [el('div', { class: 'tl-type', text: ev.type.replace(/_/g, ' ') }), ev.message ? el('div', { class: 't-muted', text: ev.message }) : null, el('div', { class: 'tl-time', text: dateTime(ev.createdAt) })]),
    ])));

    const body = el('div', {}, [
      el('div', { class: 'grid cols-2' }, [
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Details' }), kv]),
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Timeline' }), o.events?.length ? timeline : el('div', { class: 'hint', text: 'No events' })]),
      ]),
      el('h3', { style: 'font-family:var(--font-head);margin:18px 0 6px', text: 'Items' }), itemsList,
    ]);

    const m = $('#modal');
    m.innerHTML = '';
    modal({ title: `Order ${o.publicId}`, subtitle: o.payUrl ? 'Hosted invoice active' : '', body, footer: null, wide: true });
    $('#modal').appendChild(actions);
    $('#modal').appendChild(el('div', { class: 'modal-foot' }, [el('button', { class: 'btn btn-ghost', text: 'Close', onclick: closeModal })]));
  }

  // ============================ USERS ============================
  const userState = { search: '', page: 1 };
  async function users() {
    const wrap = el('div');
    const search = el('div', { class: 'search grow' }, [el('input', { placeholder: 'Search username, name, telegram id…', value: userState.search, onkeydown: (e) => { if (e.key === 'Enter') { userState.search = e.target.value.trim(); userState.page = 1; users(); } } })]);
    wrap.appendChild(el('div', { class: 'toolbar' }, [search]));
    const container = el('div', {}, [spinner()]);
    wrap.appendChild(container); mount(wrap);

    let data;
    try { data = await API.users({ search: userState.search, page: userState.page, pageSize: 25 }); }
    catch (e) { container.innerHTML = ''; container.appendChild(errorBox(e)); return; }

    container.innerHTML = '';
    if (!data.users.length) { container.appendChild(el('div', { class: 'card' }, [emptyState('👥', 'No users found')])); return; }

    const table = el('table');
    table.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Customer' }), el('th', { text: 'Orders' }), el('th', { text: 'Spent' }), el('th', { text: 'Balance' }), el('th', { text: 'Joined' }), el('th', { text: '' })])]));
    const tb = el('tbody');
    for (const u of data.users) {
      tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => userDetail(u.id) }, [
        el('td', {}, [customerCell(u), u.isBanned ? el('span', { class: 'badge FAILED', text: 'banned', style: 'margin-top:4px' }) : null]),
        el('td', { class: 't-strong', text: num(u.orders) }),
        el('td', { text: money(u.totalSpent) }),
        el('td', { text: money(u.balance) }),
        el('td', { class: 't-muted', text: timeAgo(u.createdAt) }),
        el('td', {}, [el('span', { class: 'hint', text: '›' })]),
      ]));
    }
    table.appendChild(tb);
    container.appendChild(el('div', { class: 'table-wrap' }, [table]));
    container.appendChild(pager(data, (pg) => { userState.page = pg; users(); }));
  }

  async function userDetail(id) {
    modal({ title: 'Customer', body: el('div', {}, [spinner()]), wide: true });
    let res;
    try { res = await API.user(id); } catch (e) { return toast(e.message, 'bad'); }
    const u = res.user;

    const kv = el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Name' }), el('div', { class: 'v', text: [u.firstName, u.lastName].filter(Boolean).join(' ') || '—' }),
      el('div', { class: 'k', text: 'Username' }), el('div', { class: 'v', text: u.username ? '@' + u.username : '—' }),
      el('div', { class: 'k', text: 'Telegram ID' }), el('div', { class: 'v mono', text: u.telegramId }),
      el('div', { class: 'k', text: 'Balance' }), el('div', { class: 'v', text: money(u.balance) }),
      el('div', { class: 'k', text: 'Total spent' }), el('div', { class: 'v', text: money(u.totalSpent) }),
      el('div', { class: 'k', text: 'Joined' }), el('div', { class: 'v', text: dateTime(u.createdAt) }),
    ]);

    const msgArea = el('textarea', { placeholder: 'Send a direct message to this customer…', style: 'min-height:70px' });
    const balInput = el('input', { type: 'number', step: '0.01', placeholder: 'e.g. 5 or -5', style: 'max-width:140px' });

    const actions = el('div', { class: 'row-flex', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' }, [
      el('button', { class: `btn btn-sm ${u.isBanned ? 'btn-good' : 'btn-danger'}`, html: u.isBanned ? '✓ Unban' : '⛔ Ban', onclick: async () => { try { const r = await API.post(`/users/${u.id}/ban`, { banned: !u.isBanned }); toast(r.isBanned ? 'User banned' : 'User unbanned'); closeModal(); userDetail(u.id); } catch (e) { toast(e.message, 'bad'); } } }),
      balInput,
      el('button', { class: 'btn btn-sm', html: '💰 Adjust balance', onclick: async () => { const delta = parseFloat(balInput.value); if (!isFinite(delta)) return toast('Enter an amount', 'bad'); try { const r = await API.post(`/users/${u.id}/balance`, { delta }); toast(`Balance: ${money(r.balance)}`); closeModal(); userDetail(u.id); } catch (e) { toast(e.message, 'bad'); } } }),
    ]);

    const sendBtn = el('button', { class: 'btn btn-primary btn-sm', html: '📨 Send message', onclick: async () => { const text = msgArea.value.trim(); if (!text) return toast('Type a message', 'bad'); try { const r = await API.post(`/users/${u.id}/message`, { text }); toast(r.ok ? 'Message sent' : (r.error || 'Failed'), r.ok ? 'good' : 'bad'); msgArea.value = ''; } catch (e) { toast(e.message, 'bad'); } } });

    const ordersList = res.orders.length
      ? el('div', { class: 'table-wrap', style: 'margin-top:8px' }, [(() => {
          const t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Order' }), el('th', { text: 'Items' }), el('th', { text: 'Amount' }), el('th', { text: 'Status' })])]));
          const tb = el('tbody');
          for (const o of res.orders) tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => orderDetail(o.id) }, [el('td', { class: 'mono', text: o.publicId }), el('td', { class: 't-muted', text: truncate(o.summary, 32) }), el('td', { text: money(o.amount, o.currency) }), el('td', {}, [badge(o.status)])]));
          t.appendChild(tb); return t;
        })()])
      : el('div', { class: 'hint', style: 'margin-top:8px', text: 'No orders yet' });

    const body = el('div', {}, [
      el('div', { class: 'grid cols-2' }, [
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Profile' }), kv, actions]),
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Message' }), msgArea, el('div', { style: 'margin-top:8px' }, [sendBtn])]),
      ]),
      el('h3', { style: 'font-family:var(--font-head);margin:18px 0 4px', text: 'Recent Orders' }), ordersList,
    ]);
    modal({ title: (u.username ? '@' + u.username : u.firstName || 'Customer'), body, footer: [el('button', { class: 'btn btn-ghost', text: 'Close', onclick: closeModal })], wide: true });
  }

  // ============================ BROADCAST ============================
  async function broadcast() {
    const textarea = el('textarea', { id: 'bc-text', placeholder: 'Write an announcement… HTML supported: <b>bold</b>, <i>italic</i>, <a href="...">link</a>', style: 'min-height:140px' });
    const sendBtn = el('button', { class: 'btn btn-primary', html: '🚀 Send to all users' });
    const progress = el('div', { class: 'hint', style: 'margin-top:10px' });

    sendBtn.onclick = async () => {
      const text = textarea.value.trim();
      if (!text) return toast('Write a message first', 'bad');
      if (!(await confirmDialog({ title: 'Send broadcast?', message: 'This message will be delivered to every non-banned user.', confirmText: 'Send now' }))) return;
      sendBtn.disabled = true;
      try {
        const r = await API.post('/broadcast', { text });
        toast(`Broadcasting to ${r.recipients} users…`);
        pollBroadcast(progress, sendBtn);
      } catch (e) { toast(e.message, 'bad'); sendBtn.disabled = false; }
    };

    const composer = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '📣 New Broadcast' })]),
      textarea,
      el('div', { class: 'modal-foot', style: 'margin-top:14px' }, [sendBtn]),
      progress,
    ]);

    const histCard = el('div', { class: 'card', style: 'margin-top:18px' }, [el('div', { class: 'card-head' }, [el('h3', { text: 'History' })]), el('div', { id: 'bc-history' }, [spinner()])]);
    mount(el('div', {}, [composer, histCard]));

    try {
      const h = await API.get('/broadcast/history');
      const box = document.getElementById('bc-history'); box.innerHTML = '';
      if (!h.items.length) box.appendChild(emptyState('📭', 'No broadcasts sent yet'));
      else for (const b of h.items) box.appendChild(el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--stroke)' }, [
        el('div', { class: 't-strong', text: truncate(b.text.replace(/<[^>]+>/g, ''), 80) }),
        el('div', { class: 'hint' }, [el('span', { text: `✅ ${b.sentCount} sent · ⛔ ${b.failCount} failed · ${dateTime(b.createdAt)}` })]),
      ]));
    } catch { /* ignore */ }
  }

  async function pollBroadcast(progressEl, btn) {
    const iv = setInterval(async () => {
      try {
        const s = await API.get('/broadcast/status');
        if (s.lastResult) progressEl.innerHTML = `Sending… <b>${s.lastResult.sent}</b>/${s.lastResult.total} · failed ${s.lastResult.failed}`;
        if (!s.inProgress) { clearInterval(iv); btn.disabled = false; if (s.lastResult) { toast(`Broadcast done · ${s.lastResult.sent} delivered`); broadcast(); } }
      } catch { clearInterval(iv); btn.disabled = false; }
    }, 1200);
  }

  // ============================ SETTINGS ============================
  async function settings() {
    loading();
    let data;
    try { data = await API.settings(); } catch (e) { return mount(errorBox(e)); }
    const s = data.settings; const rt = data.runtime;

    const health = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🩺 System Health' })]),
      el('div', { class: 'kv' }, [
        el('div', { class: 'k', text: 'Bot' }), el('div', { class: 'v' }, [healthPill(rt.botConfigured)]),
        el('div', { class: 'k', text: 'Cryptomus' }), el('div', { class: 'v' }, [healthPill(rt.cryptomusConfigured)]),
        el('div', { class: 'k', text: 'Environment' }), el('div', { class: 'v', text: rt.env }),
        el('div', { class: 'k', text: 'Currency' }), el('div', { class: 'v', text: rt.currency }),
        el('div', { class: 'k', text: 'Poll interval' }), el('div', { class: 'v', text: rt.pollIntervalSec + 's' }),
        el('div', { class: 'k', text: 'Order expiry' }), el('div', { class: 'v', text: rt.orderExpiryMin + ' min' }),
        el('div', { class: 'k', text: 'Admin IDs' }), el('div', { class: 'v mono', text: (rt.adminTelegramIds || []).join(', ') || '—' }),
      ]),
      rt.missing?.length ? el('div', { class: 'toast bad', style: 'margin-top:12px' }, [el('span', { class: 'tc', text: '⚠️' }), el('div', { text: 'Missing env: ' + rt.missing.join(', ') })]) : null,
      el('div', { class: 'field', style: 'margin-top:14px' }, [el('span', { text: 'Cryptomus webhook URL (set in Cryptomus dashboard)' }),
        el('div', { class: 'row-flex' }, [el('input', { value: rt.webhookUrl, readonly: true, class: 'mono' }), el('button', { class: 'btn btn-sm', text: 'Copy', onclick: () => copy(rt.webhookUrl) })])]),
    ]);

    const f = (key, label, multi) => field(label, multi
      ? `<textarea id="s-${key}">${esc(s[key] || '')}</textarea>`
      : `<input id="s-${key}" value="${esc(s[key] || '')}" />`, true);

    const maint = s.maintenance_mode === 'true';
    const content = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '✏️ Bot Content & Messages' }), el('div', { class: 'sub', text: 'Use {shop_name} as a placeholder' })]),
      el('div', { class: 'form-grid' }, [
        field('Shop name', `<input id="s-shop_name" value="${esc(s.shop_name || '')}" />`),
        field('Maintenance mode', `<label class="switch"><input type="checkbox" id="s-maintenance_mode" ${maint ? 'checked' : ''}/><span class="track"></span></label>`),
        f('welcome_message', 'Welcome message', true),
        f('shop_intro', 'Shop intro', true),
        f('order_paid_message', 'Payment confirmed message', true),
        f('support_text', 'Support text', true),
        f('faq_text', 'FAQ text', true),
        f('maintenance_text', 'Maintenance message', true),
      ]),
    ]);

    const saveBtn = el('button', { class: 'btn btn-primary', html: '💾 Save settings' });
    saveBtn.onclick = async () => {
      const keys = ['shop_name', 'welcome_message', 'shop_intro', 'order_paid_message', 'support_text', 'faq_text', 'maintenance_text'];
      const payload = {};
      for (const k of keys) { const elx = document.getElementById(`s-${k}`); if (elx) payload[k] = elx.value; }
      payload.maintenance_mode = document.getElementById('s-maintenance_mode').checked ? 'true' : 'false';
      saveBtn.disabled = true;
      try { await API.put('/settings', { settings: payload }); toast('Settings saved'); document.getElementById('brand-name').textContent = payload.shop_name || 'Shop Control'; }
      catch (e) { toast(e.message, 'bad'); }
      saveBtn.disabled = false;
    };

    mount(el('div', {}, [el('div', { class: 'grid cols-2' }, [content, health]), el('div', { class: 'modal-foot', style: 'margin-top:18px' }, [saveBtn])]));
  }

  function healthPill(ok) { return el('span', { class: `badge ${ok ? 'DELIVERED' : 'FAILED'}`, text: ok ? 'connected' : 'not configured' }); }

  // ============================ shared bits ============================
  function field(label, innerHTML, full) {
    const wrap = el('label', { class: 'field' + (full ? ' full' : '') });
    wrap.appendChild(el('span', { text: label }));
    wrap.insertAdjacentHTML('beforeend', innerHTML);
    return wrap;
  }
  function emptyState(emoji, text) { return el('div', { class: 'empty' }, [el('span', { class: 'em', text: emoji }), el('div', { text })]); }
  function errorBox(e) { return el('div', { class: 'card' }, [emptyState('😕', e.message || 'Something went wrong')]); }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function pager(data, go) {
    if (data.pages <= 1) return el('div');
    return el('div', { class: 'pager' }, [
      el('button', { class: 'btn btn-sm', text: '‹ Prev', disabled: data.page <= 1, onclick: () => go(data.page - 1) }),
      el('span', { text: `Page ${data.page} of ${data.pages} · ${num(data.total)} total` }),
      el('button', { class: 'btn btn-sm', text: 'Next ›', disabled: data.page >= data.pages, onclick: () => go(data.page + 1) }),
    ]);
  }

  return { dashboard, products, orders, users, broadcast, settings };
})();
