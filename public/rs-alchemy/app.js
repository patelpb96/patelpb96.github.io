/* RuneScape alchemy dashboard: static tables over the JSON bundle in ./data/.
   No dependencies, no build step -- Vite copies public/ through verbatim. */

const DATA = 'data/';
const NATURE_RUNE_ID = 561;

const COLUMN_META = {
  item_id: { label: 'ID', kind: 'id' },
  name: { label: 'Item', kind: 'text' },
  timestamp: { label: 'Date', kind: 'date' },
  price: { label: 'Price', kind: 'gp' },
  volume: { label: 'Volume', kind: 'int' },
  highalch: { label: 'High alch', kind: 'gp' },
  lowalch: { label: 'Low alch', kind: 'gp' },
  limit: { label: 'Buy limit', kind: 'int' },
  members: { label: 'Members', kind: 'bool' },
  nature_price: { label: 'Nature rune', kind: 'gp' },
  alch_profit: { label: 'Profit / cast', kind: 'gp', signed: true },
  alch_roi: { label: 'ROI', kind: 'pct', signed: true },
  profit_per_limit: { label: 'Profit / limit', kind: 'gp', signed: true },
  n_days: { label: 'Days', kind: 'int' },
  price_first: { label: 'Price first', kind: 'gp' },
  price_last: { label: 'Price last', kind: 'gp' },
  price_min: { label: 'Price min', kind: 'gp' },
  price_max: { label: 'Price max', kind: 'gp' },
  price_mean: { label: 'Price mean', kind: 'gp' },
  price_change: { label: 'Price change', kind: 'gp', signed: true },
  price_change_frac: { label: 'Price change %', kind: 'pct', signed: true },
  volume_mean: { label: 'Volume / day', kind: 'int' },
  volume_total: { label: 'Volume total', kind: 'int' },
  profit_last: { label: 'Profit (last)', kind: 'gp', signed: true },
  profit_mean: { label: 'Profit (mean)', kind: 'gp', signed: true },
  profit_max: { label: 'Profit (max)', kind: 'gp', signed: true },
  roi_mean: { label: 'ROI (mean)', kind: 'pct', signed: true },
  days_profitable: { label: 'Days profitable', kind: 'int' },
};

const WINDOW_LABELS = {
  latest: 'Latest snapshot',
  all: 'All history',
  last_1y: '1 year',
  last_6m: '6 months',
  last_3m: '3 months',
  last_1m: '1 month',
  last_1w: '1 week',
  last_1d: '1 day',
};

const meta = (col) => COLUMN_META[col] || { label: col, kind: 'gp' };
const isNumeric = (col) => meta(col).kind !== 'text' && meta(col).kind !== 'date';

const fmt = {
  id: (v) => String(Math.round(v)),
  // guards against a "-0" axis tick from floating-point tick generation
  int: (v) => (Math.abs(v) < 1e-9 ? 0 : v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
  gp: (v) => (Math.abs(v) < 1e-9 ? 0 : v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
  pct: (v) => (v * 100).toFixed(1) + '%',
  bool: (v) => (v ? 'yes' : 'no'),
};

function formatCell(col, value) {
  if (value === null || value === undefined || value === '') return '—';
  const kind = meta(col).kind;
  if (kind === 'text' || kind === 'date') return String(value);
  if (kind === 'bool') return fmt.bool(value);
  if (typeof value !== 'number') return String(value);
  return (fmt[kind] || fmt.gp)(value);
}

/* ------------------------------------------------------------------ state */

const state = {
  tab: null,
  sorts: [],
  filters: [],
  search: '',
  members: 'any',
  profitableOnly: false,
  page: 0,
  pageSize: 100,
  selected: null,
};

let manifest = null;
const datasets = new Map(); // tab -> {columns, rows, idx}
let natureSeries = null;
let view = []; // current filtered+sorted rows

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------- load */

async function getJSON(path) {
  const response = await fetch(DATA + path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${path}`);
  return response.json();
}

function profitColumn(dataset) {
  if (dataset.idx.alch_profit !== undefined) return 'alch_profit';
  if (dataset.idx.profit_last !== undefined) return 'profit_last';
  return null;
}

async function loadTab(tab) {
  if (datasets.has(tab)) return datasets.get(tab);
  const file = tab === 'latest' ? manifest.files.latest : manifest.files.summaries[tab];
  const raw = await getJSON(file);
  const idx = {};
  raw.columns.forEach((c, i) => (idx[c] = i));
  const dataset = { columns: raw.columns, rows: raw.rows, idx };
  datasets.set(tab, dataset);
  return dataset;
}

/* ---------------------------------------------------------------- filtering */

function passes(row, dataset) {
  const idx = dataset.idx;

  if (state.search) {
    const name = String(row[idx.name] ?? '').toLowerCase();
    if (!name.includes(state.search.toLowerCase())) return false;
  }

  if (state.members !== 'any' && idx.members !== undefined) {
    const isMembers = !!row[idx.members];
    if (state.members === 'members' && !isMembers) return false;
    if (state.members === 'f2p' && isMembers) return false;
  }

  if (state.profitableOnly) {
    const col = profitColumn(dataset);
    if (col && !(row[idx[col]] > 0)) return false;
  }

  for (const f of state.filters) {
    const value = row[idx[f.col]];
    if (value === null || value === undefined) return false;
    if (f.min !== null && value < f.min) return false;
    if (f.max !== null && value > f.max) return false;
  }
  return true;
}

function compare(a, b, dataset) {
  for (const sort of state.sorts) {
    const i = dataset.idx[sort.col];
    if (i === undefined) continue;
    let x = a[i];
    let y = b[i];
    if (x === y) continue;
    // nulls always sink, whichever direction the column is sorted
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === 'string' || typeof y === 'string') {
      const c = String(x).localeCompare(String(y));
      if (c) return sort.dir === 'asc' ? c : -c;
      continue;
    }
    return sort.dir === 'asc' ? x - y : y - x;
  }
  return 0;
}

function recompute() {
  const dataset = datasets.get(state.tab);
  if (!dataset) return;
  view = dataset.rows.filter((row) => passes(row, dataset));
  if (state.sorts.length) view.sort((a, b) => compare(a, b, dataset));
  const maxPage = Math.max(0, Math.ceil(view.length / state.pageSize) - 1);
  state.page = Math.min(state.page, maxPage);
  renderChips();
  renderTable();
  writeHash();
}

/* ----------------------------------------------------------------- sorting */

function toggleSort(col, additive) {
  const existing = state.sorts.findIndex((s) => s.col === col);
  if (!additive) {
    if (existing === 0 && state.sorts.length === 1) {
      state.sorts = [{ col, dir: state.sorts[0].dir === 'desc' ? 'asc' : 'desc' }];
    } else {
      state.sorts = [{ col, dir: defaultDir(col) }];
    }
  } else if (existing >= 0) {
    state.sorts[existing].dir = state.sorts[existing].dir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sorts.push({ col, dir: defaultDir(col) });
  }
  state.page = 0;
  recompute();
}

// text reads best A->Z, numbers best biggest-first
const defaultDir = (col) => (meta(col).kind === 'text' ? 'asc' : 'desc');

function moveSort(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.sorts.length) return;
  const [item] = state.sorts.splice(i, 1);
  state.sorts.splice(j, 0, item);
  recompute();
}

/* --------------------------------------------------------------- rendering */

function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = '';
  const tabs = ['latest', ...manifest.windows];
  for (const tab of tabs) {
    if (tab === 'latest' && !manifest.files.latest) continue;
    const button = document.createElement('button');
    button.textContent = WINDOW_LABELS[tab] || tab;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab === state.tab));
    button.onclick = () => selectTab(tab);
    nav.appendChild(button);
  }
  const note = document.createElement('span');
  note.className = 'tab-note';
  note.textContent =
    state.tab === 'latest'
      ? 'one row per item, newest datapoint'
      : 'per-item stats over the selected window';
  nav.appendChild(note);
}

function renderChips() {
  const dataset = datasets.get(state.tab);
  const sortBox = $('#sort-chips');
  sortBox.innerHTML = '';
  if (!state.sorts.length) {
    sortBox.innerHTML = '<span class="hint">No sort — click a column header.</span>';
  }
  state.sorts.forEach((sort, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML =
      `<span class="rank">${i + 1}.</span>` +
      `<span>${meta(sort.col).label} ${sort.dir === 'desc' ? '↓' : '↑'}</span>`;
    chip.append(
      iconButton('⇅', 'Flip direction', () => {
        sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
        recompute();
      }),
      iconButton('◀', 'Higher priority', () => moveSort(i, -1)),
      iconButton('▶', 'Lower priority', () => moveSort(i, 1)),
      iconButton('✕', 'Remove', () => {
        state.sorts.splice(i, 1);
        recompute();
      })
    );
    sortBox.appendChild(chip);
  });

  const filterBox = $('#filter-chips');
  filterBox.innerHTML = '';
  state.filters.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const bits = [];
    if (f.min !== null) bits.push(`≥ ${fmt.gp(f.min)}`);
    if (f.max !== null) bits.push(`≤ ${fmt.gp(f.max)}`);
    chip.innerHTML = `<span>${meta(f.col).label} ${bits.join(' and ') || 'any'}</span>`;
    chip.append(
      iconButton('✕', 'Remove', () => {
        state.filters.splice(i, 1);
        state.page = 0;
        recompute();
      })
    );
    filterBox.appendChild(chip);
  });

  // keep the "add filter" column list in sync with the active tab
  const select = $('#filter-col');
  if (dataset && select.dataset.tab !== state.tab) {
    select.innerHTML = '';
    dataset.columns.filter(isNumeric).forEach((col) => {
      const option = document.createElement('option');
      option.value = col;
      option.textContent = meta(col).label;
      select.appendChild(option);
    });
    select.dataset.tab = state.tab;
  }
}

function iconButton(glyph, title, onClick) {
  const button = document.createElement('button');
  button.textContent = glyph;
  button.title = title;
  button.onclick = (event) => {
    event.stopPropagation();
    onClick();
  };
  return button;
}

function renderTable() {
  const dataset = datasets.get(state.tab);
  const table = $('#table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');

  dataset.columns.forEach((col) => {
    const th = document.createElement('th');
    const sortIndex = state.sorts.findIndex((s) => s.col === col);
    th.className = isNumeric(col) ? '' : 'text';
    th.textContent = meta(col).label;
    th.title = `${col} — click to sort, shift-click to add as a tie-breaker`;
    if (sortIndex >= 0) {
      const tag = document.createElement('span');
      tag.className = 'dir';
      tag.textContent =
        (state.sorts[sortIndex].dir === 'desc' ? '↓' : '↑') +
        (state.sorts.length > 1 ? sortIndex + 1 : '');
      th.appendChild(tag);
    }
    th.onclick = (event) => toggleSort(col, event.shiftKey);
    headRow.appendChild(th);
  });
  head.appendChild(headRow);

  const body = document.createElement('tbody');
  const start = state.page * state.pageSize;
  const rows = view.slice(start, start + state.pageSize);

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (state.selected === row[dataset.idx.item_id]) tr.className = 'selected';
    dataset.columns.forEach((col) => {
      const td = document.createElement('td');
      const value = row[dataset.idx[col]];
      td.textContent = formatCell(col, value);
      if (col === 'name') td.className = 'text name';
      else if (meta(col).kind === 'text' || meta(col).kind === 'date') td.className = 'text';
      if (meta(col).signed && typeof value === 'number') {
        td.className = (td.className + ' ' + (value > 0 ? 'pos' : value < 0 ? 'neg' : '')).trim();
      }
      tr.appendChild(td);
    });
    tr.onclick = () => openItem(row[dataset.idx.item_id]);
    body.appendChild(tr);
  }

  table.innerHTML = '';
  table.append(head, body);

  const total = datasets.get(state.tab).rows.length;
  $('#count').textContent =
    `${view.length.toLocaleString()} of ${total.toLocaleString()} items` +
    (view.length ? ` · showing ${start + 1}–${Math.min(start + state.pageSize, view.length)}` : '');
  $('#page-label').textContent = `page ${state.page + 1} / ${Math.max(
    1,
    Math.ceil(view.length / state.pageSize)
  )}`;
}

/* -------------------------------------------------------------------- charts */

function niceTicks(min, max, count) {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return ticks;
}

const dayToDate = (day) => new Date(day * 86400000);
const shortDate = (day) =>
  dayToDate(day).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

/** Single-series line chart. One y-axis, always — never a second scale. */
function lineChart(container, points, { caption, sub, zeroLine = false, format = fmt.gp }) {
  const W = 520;
  const H = 170;
  const pad = { top: 10, right: 12, bottom: 22, left: 56 };

  const figure = document.createElement('figure');
  figure.className = 'chart';
  figure.innerHTML =
    `<figcaption>${caption}</figcaption>` +
    (sub ? `<div class="caption-sub">${sub}</div>` : '');

  if (!points.length) {
    figure.innerHTML += '<div class="hint">No series data for this item.</div>';
    container.appendChild(figure);
    return;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (zeroLine) {
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY;
  yMax += padY;

  const sx = (x) =>
    pad.left + ((x - xMin) / (xMax - xMin || 1)) * (W - pad.left - pad.right);
  const sy = (y) => H - pad.bottom - ((y - yMin) / (yMax - yMin)) * (H - pad.top - pad.bottom);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${caption}: ${format(ys[0])} to ${format(ys[ys.length - 1])}`);

  const add = (tag, attrs, text) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  for (const t of niceTicks(yMin, yMax, 4)) {
    add('line', { class: 'grid-line', x1: pad.left, x2: W - pad.right, y1: sy(t), y2: sy(t) });
    add('text', { class: 'tick', x: pad.left - 6, y: sy(t) + 3, 'text-anchor': 'end' }, format(t));
  }
  if (zeroLine && yMin < 0 && yMax > 0) {
    add('line', { class: 'axis-line', x1: pad.left, x2: W - pad.right, y1: sy(0), y2: sy(0) });
  }
  for (const t of [xMin, (xMin + xMax) / 2, xMax]) {
    add(
      'text',
      { class: 'tick', x: sx(t), y: H - 6, 'text-anchor': 'middle' },
      shortDate(Math.round(t))
    );
  }

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`);
  add('path', { class: 'series', d: d.join(' ') });

  const crosshair = add('line', {
    class: 'crosshair',
    y1: pad.top,
    y2: H - pad.bottom,
    x1: 0,
    x2: 0,
    opacity: 0,
  });
  const dot = add('circle', { class: 'dot', r: 4, cx: 0, cy: 0, opacity: 0 });

  const tooltip = $('#tooltip');
  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W; // css px -> svg units
    const target = xMin + ((px - pad.left) / (W - pad.left - pad.right)) * (xMax - xMin);
    let best = points[0];
    for (const p of points) if (Math.abs(p.x - target) < Math.abs(best.x - target)) best = p;
    crosshair.setAttribute('x1', sx(best.x));
    crosshair.setAttribute('x2', sx(best.x));
    crosshair.setAttribute('opacity', 1);
    dot.setAttribute('cx', sx(best.x));
    dot.setAttribute('cy', sy(best.y));
    dot.setAttribute('opacity', 1);
    tooltip.innerHTML =
      `<strong>${format(best.y)}</strong><br>` +
      dayToDate(best.x).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    tooltip.classList.add('on');
    tooltip.style.left = Math.min(event.clientX + 14, window.innerWidth - 140) + 'px';
    tooltip.style.top = event.clientY - 10 + 'px';
  });
  svg.addEventListener('pointerleave', () => {
    crosshair.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
    tooltip.classList.remove('on');
  });

  figure.appendChild(svg);
  container.appendChild(figure);
}

/* ------------------------------------------------------------------- drawer */

async function seriesFor(itemId) {
  if (!manifest.files.series) return null;
  try {
    return await getJSON(`series/${itemId}.json`);
  } catch {
    return null;
  }
}

async function openItem(itemId) {
  if (itemId === null || itemId === undefined) return;
  state.selected = itemId;
  renderTable();
  writeHash();

  const dataset = datasets.get(state.tab);
  const row = dataset.rows.find((r) => r[dataset.idx.item_id] === itemId);
  const get = (col) => (dataset.idx[col] !== undefined ? row[dataset.idx[col]] : null);

  $('#drawer').classList.add('open');
  $('#backdrop').classList.add('on');
  $('#drawer-title').textContent = get('name') || `Item ${itemId}`;
  $('#drawer-sub').textContent = `item ${itemId} · ${WINDOW_LABELS[state.tab] || state.tab}`;

  const stats = $('#drawer-stats');
  stats.innerHTML = '';
  const statCols = dataset.columns.filter(
    (c) => c !== 'name' && c !== 'item_id' && isNumeric(c)
  );
  for (const col of statCols.slice(0, 8)) {
    const div = document.createElement('div');
    div.className = 'stat';
    div.innerHTML =
      `<div class="k">${meta(col).label}</div>` +
      `<div class="v">${formatCell(col, get(col))}</div>`;
    stats.appendChild(div);
  }

  const charts = $('#drawer-charts');
  charts.innerHTML = '<div class="hint">Loading series …</div>';

  const series = await seriesFor(itemId);
  charts.innerHTML = '';
  if (!series) {
    charts.innerHTML =
      '<div class="hint">No per-item series exported. Re-run the scraper without --no-series.</div>';
    return;
  }

  const pricePoints = series.t
    .map((t, i) => ({ x: t, y: series.p[i] }))
    .filter((p) => p.y !== null);
  lineChart(charts, pricePoints, {
    caption: 'Grand Exchange price',
    sub: 'gp per item, daily',
  });

  const volumePoints = series.t
    .map((t, i) => ({ x: t, y: series.v[i] }))
    .filter((p) => p.y !== null);
  if (volumePoints.length) {
    lineChart(charts, volumePoints, { caption: 'Daily volume', sub: 'items traded' });
  }

  // Profit is derived client-side: high alch value minus price minus the
  // nature rune price on that same day.
  const highalch = get('highalch');
  if (highalch && natureSeries) {
    const runeByDay = new Map(natureSeries.t.map((t, i) => [t, natureSeries.p[i]]));
    let lastRune = natureSeries.p[0];
    const profitPoints = [];
    for (const point of pricePoints) {
      if (runeByDay.has(point.x)) lastRune = runeByDay.get(point.x);
      profitPoints.push({ x: point.x, y: highalch - point.y - lastRune });
    }
    lineChart(charts, profitPoints, {
      caption: 'High alchemy profit per cast',
      sub: 'high alch value − price − nature rune',
      zeroLine: true,
    });
  }
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#backdrop').classList.remove('on');
  state.selected = null;
  renderTable();
  writeHash();
}

/* ---------------------------------------------------------------------- csv */

function downloadCSV() {
  const dataset = datasets.get(state.tab);
  const escape = (v) =>
    v === null || v === undefined
      ? ''
      : /[",\n]/.test(String(v))
        ? `"${String(v).replace(/"/g, '""')}"`
        : String(v);
  const lines = [dataset.columns.join(',')];
  for (const row of view) lines.push(row.map(escape).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `rs_alchemy_${state.tab}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* --------------------------------------------------------------- hash state */

function writeHash() {
  const parts = [`tab=${state.tab}`];
  if (state.sorts.length)
    parts.push('sort=' + state.sorts.map((s) => `${s.col}:${s.dir}`).join(','));
  if (state.filters.length)
    parts.push(
      'filter=' + state.filters.map((f) => `${f.col}:${f.min ?? ''}:${f.max ?? ''}`).join(',')
    );
  if (state.search) parts.push('q=' + encodeURIComponent(state.search));
  if (state.members !== 'any') parts.push('members=' + state.members);
  if (state.profitableOnly) parts.push('profitable=1');
  if (state.page) parts.push('page=' + (state.page + 1));
  if (state.selected !== null) parts.push('item=' + state.selected);
  history.replaceState(null, '', '#' + parts.join('&'));
}

function readHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return {};
  const out = {};
  for (const part of hash.split('&')) {
    const [key, value] = part.split('=');
    out[key] = decodeURIComponent(value ?? '');
  }
  return out;
}

/* --------------------------------------------------------------------- init */

async function selectTab(tab) {
  state.tab = tab;
  await loadTab(tab);
  const dataset = datasets.get(tab);
  // drop sorts/filters naming columns this tab does not have
  state.sorts = state.sorts.filter((s) => dataset.idx[s.col] !== undefined);
  state.filters = state.filters.filter((f) => dataset.idx[f.col] !== undefined);
  if (!state.sorts.length) {
    const col = profitColumn(dataset);
    if (col) state.sorts = [{ col, dir: 'desc' }];
  }
  state.page = 0;
  renderTabs();
  recompute();
}

function wireControls() {
  $('#search').oninput = (event) => {
    state.search = event.target.value.trim();
    state.page = 0;
    recompute();
  };
  $('#members').onchange = (event) => {
    state.members = event.target.value;
    state.page = 0;
    recompute();
  };
  $('#profitable').onchange = (event) => {
    state.profitableOnly = event.target.checked;
    state.page = 0;
    recompute();
  };
  $('#add-filter').onclick = () => {
    const col = $('#filter-col').value;
    const min = $('#filter-min').value === '' ? null : Number($('#filter-min').value);
    const max = $('#filter-max').value === '' ? null : Number($('#filter-max').value);
    if (min === null && max === null) return;
    state.filters.push({ col, min, max });
    $('#filter-min').value = '';
    $('#filter-max').value = '';
    state.page = 0;
    recompute();
  };
  $('#clear').onclick = () => {
    state.filters = [];
    state.search = '';
    state.members = 'any';
    state.profitableOnly = false;
    $('#search').value = '';
    $('#members').value = 'any';
    $('#profitable').checked = false;
    state.page = 0;
    recompute();
  };
  $('#page-size').onchange = (event) => {
    state.pageSize = Number(event.target.value);
    state.page = 0;
    recompute();
  };
  $('#prev').onclick = () => {
    state.page = Math.max(0, state.page - 1);
    recompute();
  };
  $('#next').onclick = () => {
    const maxPage = Math.max(0, Math.ceil(view.length / state.pageSize) - 1);
    state.page = Math.min(maxPage, state.page + 1);
    recompute();
  };
  $('#csv').onclick = downloadCSV;
  $('#close-drawer').onclick = closeDrawer;
  $('#backdrop').onclick = closeDrawer;
  $('#theme').onclick = () => {
    const root = document.documentElement;
    const dark =
      root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'light' : 'dark';
  };
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });
}

async function init() {
  wireControls();
  try {
    manifest = await getJSON('manifest.json');
  } catch (error) {
    $('#status').innerHTML =
      '<div class="banner error">No data found in <code>data/</code>. ' +
      'Run <code>python -m rs_alchemy --export-dir …</code> and commit the output. ' +
      `<br><span class="hint">${error.message}</span></div>`;
    return;
  }

  if (manifest.sample) {
    $('#status').innerHTML =
      '<div class="banner"><strong>SAMPLE DATA</strong> — these are synthetic numbers ' +
      'generated to exercise the page, not real Grand Exchange prices. Replace ' +
      '<code>data/</code> with a real scraper export.</div>';
  }

  $('#meta').textContent =
    `${(manifest.n_items || 0).toLocaleString()} items · ` +
    `${manifest.first_timestamp || '?'} → ${manifest.last_timestamp || '?'} · ` +
    `generated ${(manifest.generated_utc || '').slice(0, 10)}`;

  if (manifest.files.series && manifest.series_ids?.includes(NATURE_RUNE_ID)) {
    natureSeries = await seriesFor(NATURE_RUNE_ID);
  }

  const hash = readHash();
  if (hash.sort)
    state.sorts = hash.sort.split(',').map((part) => {
      const [col, dir] = part.split(':');
      return { col, dir: dir === 'asc' ? 'asc' : 'desc' };
    });
  if (hash.filter)
    state.filters = hash.filter.split(',').map((part) => {
      const [col, min, max] = part.split(':');
      return { col, min: min === '' ? null : Number(min), max: max === '' ? null : Number(max) };
    });
  if (hash.q) {
    state.search = hash.q;
    $('#search').value = hash.q;
  }
  if (hash.members) {
    state.members = hash.members;
    $('#members').value = hash.members;
  }
  if (hash.profitable) {
    state.profitableOnly = true;
    $('#profitable').checked = true;
  }

  const first = manifest.files.latest ? 'latest' : manifest.windows[0];
  await selectTab(hash.tab && (hash.tab === 'latest' || manifest.windows.includes(hash.tab))
    ? hash.tab
    : first);

  if (hash.page) {
    state.page = Math.max(0, Number(hash.page) - 1);
    recompute();
  }
  if (hash.item) openItem(Number(hash.item));
}

init();
