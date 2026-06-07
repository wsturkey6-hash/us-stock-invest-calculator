// watchlist item shape: { symbol, name, price, checked, percent, shares, investAmount }
let watchlist = [];
let dragSrcIndex = null;

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
        if (key) fetchAndUpdatePrice(s.symbol);
      });
    } catch {
      watchlist = [];
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

  // Refresh prices now that we have a key
  if (watchlist.length > 0) refreshAllPrices();
}

// ── Finnhub API ───────────────────────────────────────────────────────────────

const FINNHUB = 'https://finnhub.io/api/v1';

async function fetchStockData(symbol) {
  const key = getApiKey();
  if (!key) throw new Error('請先設定 Finnhub API Key');

  const opts = { signal: AbortSignal.timeout(10000) };

  // search 端點對股票與 ETF 都有 description，profile2 對 ETF 通常是空的
  const [quoteResp, searchResp] = await Promise.all([
    fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${key}`, opts),
    fetch(`${FINNHUB}/search?q=${symbol}&token=${key}`, opts),
  ]);

  if (!quoteResp.ok) throw new Error(`HTTP ${quoteResp.status}`);

  const quote = await quoteResp.json();
  const search = await searchResp.json().catch(() => ({ result: [] }));

  // quote.c === 0 means symbol not found on Finnhub
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
  const symbol = input.value.trim().toUpperCase();

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
    watchlist.push({ symbol, name: result.name, price: result.price, checked: false, percent: 0 });
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

// ── Check / percent change ────────────────────────────────────────────────────

function onCheckChange(symbol, checked) {
  const stock = watchlist.find(s => s.symbol === symbol);
  if (!stock) return;
  stock.checked = checked;
  saveToLocalStorage();
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

// ── Validation ────────────────────────────────────────────────────────────────

function validateAllocation() {
  const total = watchlist
    .filter(s => s.checked)
    .reduce((sum, s) => sum + s.percent, 0);

  const warning = document.getElementById('allocation-warning');
  const exceeded = total > 100.001;
  warning.classList.toggle('hidden', !exceeded);
  return !exceeded;
}

function updateCalculateButton() {
  const hasChecked = watchlist.some(s => s.checked && s.percent > 0 && s.price > 0);
  const budget = parseFloat(document.getElementById('total-budget').value) || 0;
  const valid = validateAllocation();
  document.getElementById('calculate-btn').disabled = !(hasChecked && budget > 0 && valid);
}

// ── Calculate ─────────────────────────────────────────────────────────────────

function calculate() {
  const budget = parseFloat(document.getElementById('total-budget').value);
  const selected = watchlist.filter(s => s.checked && s.percent > 0 && s.price > 0);

  watchlist.forEach(s => { if (!s.checked) { delete s.shares; delete s.investAmount; } });

  let summaryHTML = `<div class="table-wrapper"><table>
    <thead><tr>
      <th>股票代號</th><th>公司名稱</th><th>投入金額</th>
      <th>股價</th><th>可購買股數</th><th>實際花費</th><th>剩餘現金</th>
    </tr></thead><tbody>`;

  selected.forEach(stock => {
    const investAmount = budget * (stock.percent / 100);
    const shares = parseFloat((investAmount / stock.price).toFixed(2));
    const actualCost = shares * stock.price;
    const remainder = investAmount - actualCost;

    stock.shares = shares;
    stock.investAmount = investAmount;

    summaryHTML += `<tr>
      <td><strong>${stock.symbol}</strong></td>
      <td>${stock.name}</td>
      <td>$${investAmount.toFixed(2)}</td>
      <td>$${stock.price.toFixed(2)}</td>
      <td><strong style="color:var(--success);font-size:1.1em">${shares.toFixed(2)} 股</strong></td>
      <td>$${actualCost.toFixed(2)}</td>
      <td style="color:var(--text-muted)">$${remainder.toFixed(2)}</td>
    </tr>`;
  });

  const totalInvested = selected.reduce((sum, s) => sum + s.investAmount, 0);
  const totalCost = selected.reduce((sum, s) => sum + (s.shares * s.price), 0);

  summaryHTML += `</tbody>
    <tfoot><tr>
      <td colspan="2" style="color:var(--text-muted);font-size:0.85em">合計</td>
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

function renderTable() {
  const tbody = document.getElementById('watchlist-body');
  const emptyMsg = document.getElementById('empty-msg');

  if (watchlist.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  tbody.innerHTML = watchlist.map((stock, idx) => `
    <tr class="${stock.checked ? 'selected-row' : ''}"
        draggable="true"
        ondragstart="onDragStart(event, ${idx})"
        ondragover="onDragOver(event, ${idx})"
        ondragenter="onDragEnter(event, ${idx})"
        ondrop="onDrop(event, ${idx})"
        ondragend="onDragEnd()">
      <td class="drag-handle" title="拖曳排序">⠿</td>
      <td><input type="checkbox" ${stock.checked ? 'checked' : ''}
          onchange="onCheckChange('${stock.symbol}', this.checked)"></td>
      <td><strong>${stock.symbol}</strong></td>
      <td>${stock.name || '—'}</td>
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
  `).join('');
}

// ── Drag and drop reorder ─────────────────────────────────────────────────────

function onDragStart(e, index) {
  dragSrcIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', index); // required for Firefox
  // Defer so the row isn't invisible during the drag ghost render
  setTimeout(() => {
    const rows = document.querySelectorAll('#watchlist-body tr');
    rows[index]?.classList.add('dragging');
  }, 0);
}

function onDragOver(e, index) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onDragEnter(e, index) {
  if (index === dragSrcIndex) return;
  document.querySelectorAll('#watchlist-body tr').forEach((r, i) => {
    r.classList.toggle('drag-over', i === index);
  });
}

function onDrop(e, index) {
  e.preventDefault();
  if (dragSrcIndex === null || dragSrcIndex === index) return;
  const [moved] = watchlist.splice(dragSrcIndex, 1);
  watchlist.splice(index, 0, moved);
  dragSrcIndex = null;
  saveToLocalStorage();
  renderTable();
}

function onDragEnd() {
  dragSrcIndex = null;
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

// auto-refresh every 60 seconds
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
  const toSave = watchlist.map(({ symbol, name, price, checked, percent }) =>
    ({ symbol, name, price, checked, percent })
  );
  localStorage.setItem('watchlist', JSON.stringify(toSave));
}
