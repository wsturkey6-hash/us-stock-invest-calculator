// watchlist item shape: { symbol, name, price, category, checked, percent, shares, investAmount }
// categories shape: { [key]: { checked, percent } }
const CATEGORY_DEFS = [
  { key: 'index',    label: '指數型ETF' },
  { key: 'momentum', label: '動能ETF' },
  { key: 'stock',    label: '個股' },
];
const CATEGORY_KEYS = CATEGORY_DEFS.map(c => c.key);
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_DEFS.map(c => [c.key, c.label]));

let watchlist = [];
let categories = defaultCategories();
let dragSrcSymbol = null;

function defaultCategories() {
  return CATEGORY_KEYS.reduce((acc, k) => {
    acc[k] = { checked: false, percent: 0 };
    return acc;
  }, {});
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  const key = getApiKey();
  if (key) {
    document.getElementById('api-key-input').value = key;
    document.getElementById('no-key-banner').classList.add('hidden');
  } else {
    document.getElementById('no-key-banner').classList.remove('hidden');
  }

  const saved = localStorage.getItem('watchlist');
  if (saved) {
    try {
      watchlist = JSON.parse(saved);
      watchlist.forEach(s => {
        delete s.shares;
        delete s.investAmount;
        if (!CATEGORY_KEYS.includes(s.category)) s.category = 'stock';
        if (key) fetchAndUpdatePrice(s.symbol);
      });
    } catch {
      watchlist = [];
    }
  }

  const savedCats = localStorage.getItem('categories');
  if (savedCats) {
    try {
      const parsed = JSON.parse(savedCats);
      CATEGORY_KEYS.forEach(k => {
        if (parsed[k]) {
          categories[k] = {
            checked: !!parsed[k].checked,
            percent: Math.max(0, Math.min(100, parseFloat(parsed[k].percent) || 0)),
          };
        }
      });
    } catch {
      categories = defaultCategories();
    }
  }

  renderTable();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);

// ── API Key ───────────────────────────────────────────────────────────────────

function getApiKey() {
  return localStorage.getItem('finnhubKey') || '';
}

function saveApiKey() {
  const key = document.getElementById('api-key-input').value.trim();
  const msgEl = document.getElementById('key-msg');
  if (!key) {
    msgEl.textContent = '請輸入 API Key';
    msgEl.style.color = 'var(--danger)';
    return;
  }
  localStorage.setItem('finnhubKey', key);
  msgEl.textContent = '✅ Key 已儲存';
  msgEl.style.color = 'var(--success)';
  document.getElementById('no-key-banner').classList.add('hidden');
  setTimeout(() => { msgEl.textContent = ''; }, 2500);

  if (watchlist.length > 0) refreshAllPrices();
}

// ── Finnhub API ───────────────────────────────────────────────────────────────

const FINNHUB = 'https://finnhub.io/api/v1';

async function fetchStockData(symbol) {
  const key = getApiKey();
  if (!key) throw new Error('請先設定 Finnhub API Key');

  const opts = { signal: AbortSignal.timeout(10000) };

  const [quoteResp, searchResp] = await Promise.all([
    fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${key}`, opts),
    fetch(`${FINNHUB}/search?q=${symbol}&token=${key}`, opts),
  ]);

  if (!quoteResp.ok) throw new Error(`HTTP ${quoteResp.status}`);

  const quote = await quoteResp.json();
  const search = await searchResp.json().catch(() => ({ result: [] }));

  if (!quote.c || quote.c === 0) throw new Error('查無此股票代號');

  const match = search.result?.find(r => r.symbol === symbol || r.displaySymbol === symbol);
  const name = match?.description || symbol;

  return { price: quote.c, name };
}

async function fetchPriceOnly(symbol) {
  const key = getApiKey();
  if (!key) return null;
  try {
    const resp = await fetch(
      `${FINNHUB}/quote?symbol=${symbol}&token=${key}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const quote = await resp.json();
    return quote.c || null;
  } catch {
    return null;
  }
}

// ── Add stock ─────────────────────────────────────────────────────────────────

async function addStock() {
  const input = document.getElementById('stock-input');
  const errorEl = document.getElementById('add-error');
  const addBtn = document.getElementById('add-btn');
  const categorySelect = document.getElementById('category-select');
  const symbol = input.value.trim().toUpperCase();
  const category = CATEGORY_KEYS.includes(categorySelect.value) ? categorySelect.value : 'stock';

  if (!symbol) { errorEl.textContent = '請輸入股票代號'; return; }

  if (!getApiKey()) {
    errorEl.textContent = '請先設定 API Key';
    document.getElementById('settings-section').scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (watchlist.find(s => s.symbol === symbol)) {
    errorEl.textContent = `${symbol} 已在追蹤清單中`;
    return;
  }

  errorEl.textContent = '載入中...';
  addBtn.disabled = true;

  try {
    const result = await fetchStockData(symbol);
    watchlist.push({ symbol, name: result.name, price: result.price, category, checked: false, percent: 0 });
    saveToLocalStorage();
    renderTable();
    errorEl.textContent = '';
    input.value = '';
    updateLastUpdated();
  } catch (e) {
    errorEl.textContent = `❌ ${e.message || '無法找到股票代號：' + symbol}`;
  } finally {
    addBtn.disabled = false;
  }
}

// ── Remove stock ──────────────────────────────────────────────────────────────

function removeStock(symbol) {
  watchlist = watchlist.filter(s => s.symbol !== symbol);
  saveToLocalStorage();
  renderTable();
  updateCalculateButton();
}

// ── Item check / percent / category change ────────────────────────────────────

function onCheckChange(symbol, checked) {
  const stock = watchlist.find(s => s.symbol === symbol);
  if (!stock) return;
  stock.checked = checked;
  // 取消勾選時，清除原本填寫的投入比例
  if (!checked) stock.percent = 0;
  saveToLocalStorage();
  renderTable();
  validateAllocation();
  updateCalculateButton();
}

function onPercentChange(symbol, value) {
  const stock = watchlist.find(s => s.symbol === symbol);
  if (!stock) return;
  stock.percent = Math.max(0, Math.min(100, parseFloat(value) || 0));
  saveToLocalStorage();
  validateAllocation();
  updateCalculateButton();
}

function onCategoryChange(symbol, newCategory) {
  const stock = watchlist.find(s => s.symbol === symbol);
  if (!stock || !CATEGORY_KEYS.includes(newCategory)) return;
  stock.category = newCategory;
  saveToLocalStorage();
  renderTable();
  validateAllocation();
  updateCalculateButton();
}

// ── Category check / percent ──────────────────────────────────────────────────

function onCategoryCheckChange(key, checked) {
  if (!categories[key]) return;
  categories[key].checked = checked;
  // 取消勾選時，清除原本填寫的投入比例
  if (!checked) categories[key].percent = 0;
  saveToLocalStorage();
  renderTable();
  validateAllocation();
  updateCalculateButton();
}

function onCategoryPercentChange(key, value) {
  if (!categories[key]) return;
  categories[key].percent = Math.max(0, Math.min(100, parseFloat(value) || 0));
  saveToLocalStorage();
  validateAllocation();
  updateCalculateButton();
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateAllocation() {
  const warning = document.getElementById('allocation-warning');
  const messages = [];

  const catTotal = CATEGORY_KEYS
    .filter(k => categories[k].checked)
    .reduce((sum, k) => sum + categories[k].percent, 0);
  if (catTotal > 100.001) {
    messages.push('⚠️ 類別投入比例總和超過 100%，請重新調整');
  }

  CATEGORY_KEYS.forEach(k => {
    if (!categories[k].checked) return;
    const itemsTotal = watchlist
      .filter(s => s.category === k && s.checked)
      .reduce((sum, s) => sum + s.percent, 0);
    if (itemsTotal > 100.001) {
      messages.push(`⚠️ 「${CATEGORY_LABEL[k]}」項目比例總和超過 100%，請重新調整`);
    }
  });

  if (messages.length === 0) {
    warning.classList.add('hidden');
    warning.textContent = '';
    return true;
  }

  warning.innerHTML = messages.join('<br>');
  warning.classList.remove('hidden');
  return false;
}

function updateCalculateButton() {
  const budget = parseFloat(document.getElementById('total-budget').value) || 0;
  const valid = validateAllocation();
  const hasValidPick = CATEGORY_KEYS.some(k => {
    if (!categories[k].checked || categories[k].percent <= 0) return false;
    return watchlist.some(s =>
      s.category === k && s.checked && s.percent > 0 && s.price > 0
    );
  });
  document.getElementById('calculate-btn').disabled = !(hasValidPick && budget > 0 && valid);
}

// ── Calculate ─────────────────────────────────────────────────────────────────

function calculate() {
  const budget = parseFloat(document.getElementById('total-budget').value);
  const selected = watchlist.filter(s =>
    s.checked && s.percent > 0 && s.price > 0
    && categories[s.category]?.checked && categories[s.category].percent > 0
  );

  watchlist.forEach(s => { if (!s.checked) { delete s.shares; delete s.investAmount; } });

  let summaryHTML = `<div class="table-wrapper"><table>
    <thead><tr>
      <th>類別</th><th>股票代號</th><th>公司名稱</th><th>投入金額</th>
      <th>股價</th><th>可購買股數</th><th>實際花費</th><th>剩餘現金</th>
    </tr></thead><tbody>`;

  // 依類別順序輸出
  CATEGORY_KEYS.forEach(catKey => {
    selected.filter(s => s.category === catKey).forEach(stock => {
      const investAmount = budget * (categories[catKey].percent / 100) * (stock.percent / 100);
      const shares = parseFloat((investAmount / stock.price).toFixed(2));
      const actualCost = shares * stock.price;
      const remainder = investAmount - actualCost;

      stock.shares = shares;
      stock.investAmount = investAmount;

      summaryHTML += `<tr>
        <td>${CATEGORY_LABEL[catKey]}</td>
        <td><strong>${stock.symbol}</strong></td>
        <td>${stock.name}</td>
        <td>$${investAmount.toFixed(2)}</td>
        <td>$${stock.price.toFixed(2)}</td>
        <td><strong style="color:var(--success);font-size:1.1em">${shares.toFixed(2)} 股</strong></td>
        <td>$${actualCost.toFixed(2)}</td>
        <td style="color:var(--text-muted)">$${remainder.toFixed(2)}</td>
      </tr>`;
    });
  });

  const totalInvested = selected.reduce((sum, s) => sum + s.investAmount, 0);
  const totalCost = selected.reduce((sum, s) => sum + (s.shares * s.price), 0);

  summaryHTML += `</tbody>
    <tfoot><tr>
      <td colspan="3" style="color:var(--text-muted);font-size:0.85em">合計</td>
      <td>$${totalInvested.toFixed(2)}</td>
      <td>—</td>
      <td>—</td>
      <td><strong>$${totalCost.toFixed(2)}</strong></td>
      <td style="color:var(--text-muted)">$${(totalInvested - totalCost).toFixed(2)}</td>
    </tr></tfoot>
  </table></div>`;

  document.getElementById('summary-content').innerHTML = summaryHTML;
  document.getElementById('summary-section').classList.remove('hidden');
  document.getElementById('summary-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

  renderTable();
}

// ── Render ────────────────────────────────────────────────────────────────────

const TOTAL_COLS = 10;

function renderTable() {
  const tbody = document.getElementById('watchlist-body');
  const emptyMsg = document.getElementById('empty-msg');

  if (watchlist.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  let html = '';
  CATEGORY_KEYS.forEach(catKey => {
    const cat = categories[catKey];
    const label = CATEGORY_LABEL[catKey];
    html += `
      <tr class="category-row">
        <td></td>
        <td><input type="checkbox" ${cat.checked ? 'checked' : ''}
            onchange="onCategoryCheckChange('${catKey}', this.checked)"></td>
        <td colspan="4"><strong>${label}</strong></td>
        <td>
          <input type="number" value="${cat.percent || ''}" min="0" max="100" step="1"
              placeholder="0" onchange="onCategoryPercentChange('${catKey}', this.value)"> %
        </td>
        <td colspan="3" class="category-meta"></td>
      </tr>
    `;

    const items = watchlist.filter(s => s.category === catKey);
    if (items.length === 0) {
      html += `
        <tr class="category-empty">
          <td colspan="${TOTAL_COLS}">此類別尚無追蹤標的</td>
        </tr>
      `;
      return;
    }
    items.forEach(stock => {
      html += `
        <tr class="${stock.checked ? 'selected-row' : ''}"
            draggable="true"
            ondragstart="onDragStart(event, '${stock.symbol}')"
            ondragover="onDragOver(event)"
            ondragenter="onDragEnter(event, '${stock.symbol}')"
            ondrop="onDrop(event, '${stock.symbol}')"
            ondragend="onDragEnd()">
          <td class="drag-handle" title="拖曳排序">⠿</td>
          <td><input type="checkbox" ${stock.checked ? 'checked' : ''}
              onchange="onCheckChange('${stock.symbol}', this.checked)"></td>
          <td><strong>${stock.symbol}</strong></td>
          <td>${stock.name || '—'}</td>
          <td>
            <select class="category-select" onchange="onCategoryChange('${stock.symbol}', this.value)">
              ${CATEGORY_DEFS.map(c =>
                `<option value="${c.key}" ${c.key === stock.category ? 'selected' : ''}>${c.label}</option>`
              ).join('')}
            </select>
          </td>
          <td class="price-cell">${
            stock.price
              ? '$' + stock.price.toFixed(2)
              : '<span class="loading">載入中…</span>'
          }</td>
          <td>
            <input type="number" value="${stock.percent || ''}" min="0" max="100" step="1"
                placeholder="0" onchange="onPercentChange('${stock.symbol}', this.value)"> %
          </td>
          <td>${stock.investAmount != null ? '$' + stock.investAmount.toFixed(2) : '—'}</td>
          <td>${stock.shares != null ? '<strong>' + stock.shares.toFixed(2) + '</strong> 股' : '—'}</td>
          <td><button onclick="removeStock('${stock.symbol}')" class="delete-btn">✕</button></td>
        </tr>
      `;
    });
  });

  tbody.innerHTML = html;
}

// ── Drag and drop reorder (within same category) ──────────────────────────────

function onDragStart(e, symbol) {
  dragSrcSymbol = symbol;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', symbol);
  const row = e.currentTarget;
  setTimeout(() => row?.classList?.add('dragging'), 0);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onDragEnter(e, symbol) {
  if (symbol === dragSrcSymbol) return;
  document.querySelectorAll('#watchlist-body tr').forEach(r => {
    r.classList.remove('drag-over');
  });
  e.currentTarget?.classList?.add('drag-over');
}

function onDrop(e, symbol) {
  e.preventDefault();
  if (!dragSrcSymbol || dragSrcSymbol === symbol) return;
  const srcIdx = watchlist.findIndex(s => s.symbol === dragSrcSymbol);
  const dstIdx = watchlist.findIndex(s => s.symbol === symbol);
  if (srcIdx < 0 || dstIdx < 0) return;
  // 僅允許同類別內排序
  if (watchlist[srcIdx].category !== watchlist[dstIdx].category) {
    dragSrcSymbol = null;
    return;
  }
  const [moved] = watchlist.splice(srcIdx, 1);
  const newDstIdx = watchlist.findIndex(s => s.symbol === symbol);
  watchlist.splice(newDstIdx, 0, moved);
  dragSrcSymbol = null;
  saveToLocalStorage();
  renderTable();
}

function onDragEnd() {
  dragSrcSymbol = null;
  document.querySelectorAll('#watchlist-body tr').forEach(r => {
    r.classList.remove('dragging', 'drag-over');
  });
}

// ── Price refresh ─────────────────────────────────────────────────────────────

async function fetchAndUpdatePrice(symbol) {
  const price = await fetchPriceOnly(symbol);
  if (price === null) return;
  const stock = watchlist.find(s => s.symbol === symbol);
  if (stock) {
    stock.price = price;
    saveToLocalStorage();
    renderTable();
  }
}

async function refreshAllPrices() {
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled = true;
  refreshBtn.textContent = '刷新中…';

  await Promise.all(watchlist.map(s => fetchAndUpdatePrice(s.symbol)));

  refreshBtn.disabled = false;
  refreshBtn.textContent = '🔄 刷新股價';
  updateLastUpdated();
  updateCalculateButton();
}

function updateLastUpdated() {
  document.getElementById('last-updated').textContent =
    `最後更新：${new Date().toLocaleTimeString('zh-TW')}`;
}

setInterval(() => { if (getApiKey() && watchlist.length > 0) refreshAllPrices(); }, 60000);

// ── Events ────────────────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('save-key-btn').addEventListener('click', saveApiKey);
  document.getElementById('api-key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveApiKey();
  });
  document.getElementById('add-btn').addEventListener('click', addStock);
  document.getElementById('stock-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addStock();
  });
  document.getElementById('calculate-btn').addEventListener('click', calculate);
  document.getElementById('refresh-btn').addEventListener('click', refreshAllPrices);
  document.getElementById('total-budget').addEventListener('input', updateCalculateButton);
}

// ── Storage ───────────────────────────────────────────────────────────────────

function saveToLocalStorage() {
  const toSave = watchlist.map(({ symbol, name, price, category, checked, percent }) =>
    ({ symbol, name, price, category, checked, percent })
  );
  localStorage.setItem('watchlist', JSON.stringify(toSave));
  localStorage.setItem('categories', JSON.stringify(categories));
}
