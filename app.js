// app.js - Point of Sale Application
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, getDoc, updateDoc, doc, deleteDoc, query, orderBy, where, limit, serverTimestamp, runTransaction, writeBatch } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const firebaseConfig = {
apiKey: "...",
authDomain: "...",
projectId: "...",
storageBucket: "...",
messagingSenderId: "...",
appId: "..."
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------- OFFLINE MANAGER (IndexedDB Sync Queue) ----------
class OfflineManager {
  constructor() {
    this.dbName = 'pos_offline_db';
    this.storeName = 'sync_queue';
    this.db = null;
    this.initDB();
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
        this.sync();
      };
      request.onerror = (e) => reject(e);
    });
  }

  async addToQueue(type, collectionName, payload, docId = null) {
    if (!this.db) await this.initDB();
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const entry = {
      type, // 'add', 'update', 'delete'
      collection: collectionName,
      payload,
      docId,
      timestamp: Date.now()
    };
    return new Promise((resolve, reject) => {
      const request = store.add(entry);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  async sync() {
    if (!navigator.onLine || !this.db) return;
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.getAll();

    request.onsuccess = async () => {
      const items = request.result;
      if (items.length === 0) return;

      console.log(`[OfflineManager] Syncing ${items.length} items...`);
      for (const item of items) {
        try {
          if (item.type === 'add') {
            await addDoc(collection(db, item.collection), item.payload);
          } else if (item.type === 'update') {
            await updateDoc(doc(db, item.collection, item.docId), item.payload);
          } else if (item.type === 'delete') {
            await deleteDoc(doc(db, item.collection, item.docId));
          }
          // Remove from local queue after success
          const delTrans = this.db.transaction([this.storeName], 'readwrite');
          delTrans.objectStore(this.storeName).delete(item.id);
        } catch (err) {
          console.error('[OfflineManager] Sync failed for item', item, err);
          // If it's a permanent error (e.g. permission), we might want to skip it
          // For now, we'll try again next time if it fails
        }
      }
      console.log('[OfflineManager] Sync completed.');
    };
  }
}

const offlineManager = new OfflineManager();
window.syncData = () => offlineManager.sync();

// Helper to wrap Firestore writes
async function safeWrite(action, collectionName, payload, docId = null) {
  if (navigator.onLine) {
    try {
      if (action === 'add') return await addDoc(collection(db, collectionName), payload);
      if (action === 'update') return await updateDoc(doc(db, collectionName, docId), payload);
      if (action === 'delete') return await deleteDoc(doc(db, collectionName, docId));
    } catch (err) {
      console.warn('Online write failed, queuing...', err);
      await offlineManager.addToQueue(action, collectionName, payload, docId);
    }
  } else {
    console.log('Offline: Queuing write...');
    await offlineManager.addToQueue(action, collectionName, payload, docId);
  }
}

// ---------- SOUND EFFECTS ----------
const sfx = {
  click: new Audio('sounds/click.mp3'),
  add: new Audio('sounds/add.mp3'),
  delete: new Audio('sounds/delete.mp3'),
  success: new Audio('sounds/success.mp3'),
  chaching: new Audio('sounds/chaching.mp3'),
};

Object.values(sfx).forEach(a => {
  a.preload = 'auto';
  a.volume = 0.8;
});

// ----------PLAYSSAFE ----------
function playSfx(sound) {
  try {
    sfx[sound].currentTime = 0;
    sfx[sound].play();
  } catch (e) {
    console.warn("Audio blocked until user action");
  }
}


// ---------- PRODUCTS (FROM DATABASE) ----------

let products = [];
let cart = [];
let currentCategory = "All";
let currentShift = null; // { id, startTime, status, totalIncome, cashierName }
let currentSubtotal = 0;

// Lending variables
let lendingCart = [];
let currentLendingCategory = "All";

// Dynamic Categories & Search State
let categories = []; // [{id, name, color, ...}]
let isColorMode = false;
const availableColors = ['#f6f7fb', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#4b0082', '#9b59b6']; // Red, Orange, Yellow, Green, Blue, Indigo, Violet + Default
const searchState = {
  sales: "",
  lending: "",
  stocks: ""
};

const historyFilters = { startDate: null, endDate: null, cashier: 'all' };

// Current logged-in user state
let currentUserRole = null; // 'admin' | 'cashier'
let currentUsername = null; // username string
let currentEmployeeName = null; // real name for shifts / display

// Helper to normalize strings for search
const cleanStr = (s) => String(s || '').toLowerCase().trim();

// Load Categories from Firestore
async function loadCategories() {
  try {
    const q = query(collection(db, 'categories'), orderBy('name'));
    const snap = await getDocs(q);
    categories = [];
    snap.forEach(d => categories.push({ id: d.id, ...d.data() }));

    // Fallback if empty (first run)
    if (categories.length === 0) {
      const defaults = ['Vegetables', 'Frozen Foods', 'Groceries'];
      for (const cat of defaults) {
        await safeWrite('add', 'categories', { name: cat });
      }
      // reload
      const q2 = query(collection(db, 'categories'), orderBy('name'));
      const snap2 = await getDocs(q2);
      snap2.forEach(d => categories.push({ id: d.id, ...d.data() }));
    }

    renderCategoriesUI();
    renderLendingCategoriesUI();
    renderCategoriesManagement(); // Stocks page admin
    updateAddProductCategorySelect();
    renderProducts(); // Refresh products to apply colors
    renderLendingProducts();
    if (document.getElementById('productsPage')?.style.display !== 'none') renderProductsEditor();
  } catch (err) {
    console.error('Failed to load categories', err);
  }
}

async function setCategoryColor(catId, color) {
  try {
    await safeWrite('update', 'categories', { color }, catId);
    await loadCategories();
  } catch (err) {
    console.error('Failed to update category color', err);
  }
}

function cycleCategoryColor(catId) {
  const cat = categories.find(c => c.id === catId);
  if (!cat) return;
  const currentIndex = availableColors.indexOf(cat.color || '#f6f7fb');
  const nextIndex = (currentIndex + 1) % availableColors.length;
  setCategoryColor(catId, availableColors[nextIndex]);
}

async function addCategory(name) {
  const n = (name || '').trim();
  if (!n) return alert('Category name required');
  // check duplicate
  if (categories.some(c => c.name.toLowerCase() === n.toLowerCase())) {
    return alert('Category already exists');
  }
  try {
    await safeWrite('add', 'categories', { name: n });
    await loadCategories();
    alert('Category added');
  } catch (err) {
    console.error('Failed to add category', err);
    alert('Failed to add category');
  }
}

async function deleteCategory(id) {
  if (!confirm('Delete this category? Products in this category will remain but be uncategorized (or mapped incorrectly).')) return;
  try {
    await safeWrite('delete', 'categories', null, id);
    await loadCategories();
  } catch (err) {
    console.error('Failed to delete category', err);
  }
}

window.deleteCategory = deleteCategory;

// Render dynamic category buttons for Sales Page
function renderCategoriesUI() {
  const div = document.getElementById('categories');
  if (!div) return;
  div.innerHTML = '';

  // "All" button
  const allBtn = document.createElement('button');
  allBtn.className = 'category-btn'; // new style
  allBtn.innerText = 'All';
  allBtn.onclick = () => setCategory('All');
  if (currentCategory === 'All') allBtn.classList.add('active');
  div.appendChild(allBtn);

  categories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerText = c.name;
    if (c.color) {
      btn.style.background = c.color;
      btn.style.borderColor = c.color;
      // adjust text color based on background? For simplicity just use c.color if exists
      // or standard colors provided in prompt
    }
    btn.onclick = () => setCategory(c.name);
    if (currentCategory === c.name) btn.classList.add('active');
    div.appendChild(btn);
  });
}

// Render dynamic category buttons for Lending Page
function renderLendingCategoriesUI() {
  const div = document.getElementById('lending-categories');
  if (!div) return;
  div.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'category-btn';
  allBtn.innerText = 'All';
  allBtn.onclick = () => setLendingCategory('All');
  if (currentLendingCategory === 'All') allBtn.classList.add('active');
  div.appendChild(allBtn);

  categories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerText = c.name;
    if (c.color) {
      btn.style.background = c.color;
      btn.style.borderColor = c.color;
    }
    btn.onclick = () => setLendingCategory(c.name);
    if (currentLendingCategory === c.name) btn.classList.add('active');
    div.appendChild(btn);
  });
}

// Render Management List (Stocks Page)
function renderCategoriesManagement() {
  const div = document.getElementById('categories-management-list');
  if (!div) return;
  div.innerHTML = '';

  categories.forEach(c => {
    const chip = document.createElement('span');
    chip.className = 'category-btn'; // reuse style
    if (c.color) {
      chip.style.background = c.color;
      chip.style.borderColor = c.color;
    }
    chip.style.cursor = isColorMode ? 'pointer' : 'default';
    chip.innerHTML = `${c.name} <button class="delete-cat" onclick="deleteCategory('${c.id}')">✕</button>`;
    if (isColorMode) {
      chip.onclick = (e) => {
        if (e.target.classList.contains('delete-cat')) return;
        cycleCategoryColor(c.id);
      };
    }
    div.appendChild(chip);
  });
}

const toggleColorModeBtn = document.getElementById('toggle-color-mode');
if (toggleColorModeBtn) {
  toggleColorModeBtn.onclick = () => {
    isColorMode = !isColorMode;
    document.getElementById('color-mode-status').style.display = isColorMode ? 'inline' : 'none';
    toggleColorModeBtn.classList.toggle('active', isColorMode);
    renderCategoriesManagement();
  };
}

function updateAddProductCategorySelect() {
  const sel = document.getElementById('new-product-category');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">Select Category</option>';
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.innerText = c.name;
    sel.appendChild(opt);
  });
  if (currentVal) sel.value = currentVal;
}

// Sound management
let soundEnabled = true;
const soundFiles = {};

// Sound management functions
function loadSounds() {
  const sounds = ['click.mp3', 'add.mp3', 'delete.mp3', 'success.mp3', 'chaching.mp3'];
  sounds.forEach(sound => {
    const audio = new Audio(`sounds/${sound}`);
    audio.preload = 'auto';
    soundFiles[sound.replace('.mp3', '')] = audio;
  });
}

function playSound(soundName) {
  if (!soundEnabled || !soundFiles[soundName]) return;
  try {
    soundFiles[soundName].currentTime = 0;
    soundFiles[soundName].play();
  } catch (error) {
    console.warn('Failed to play sound:', soundName, error);
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  saveSoundSettings();
  updateSoundToggleUI();
}

function saveSoundSettings() {
  localStorage.setItem('soundEnabled', soundEnabled);
}

function loadSoundSettings() {
  const saved = localStorage.getItem('soundEnabled');
  if (saved !== null) {
    soundEnabled = saved === 'true';
  }
  updateSoundToggleUI();
}

function updateSoundToggleUI() {
  const toggleBtn = document.getElementById('sound-toggle');
  if (toggleBtn) {
    toggleBtn.innerHTML = soundEnabled ? '<span class="btn-icon">🔊</span><span class="btn-text">Sound ON</span>' : '<span class="btn-icon">🔇</span><span class="btn-text">Sound OFF</span>';
  }
}

// Currency formatting helper (Peso formatting for display)
function formatCurrency(amount) {
  return '₱' + Number(amount || 0).toFixed(2);
}

async function initShift() {
  // find currently open shift (most recent) without requiring a composite index
  try {
    const q = query(collection(db, 'shifts'), where('status', '==', 'open'));
    const qSnap = await getDocs(q);
    if (!qSnap.empty) {
      let latest = null;
      qSnap.forEach(snap => {
        const d = snap.data() || {};
        const ts = d.startTime && d.startTime.toDate ? d.startTime.toDate() : (d.startTime || new Date(0));
        if (!latest || ts > latest.startTime) {
          latest = { id: snap.id, startTime: ts, status: d.status, totalIncome: Number(d.totalIncome || d.totalSales || 0), cashierName: d.cashierName || d.openedBy || '' };
        }
      });
      currentShift = latest || null;
    } else {
      currentShift = null;
    }
  } catch (err) {
    console.error('Failed to init shift', err);
    currentShift = null;
  }
  updateShiftUI();
  // ensure sales summary reflects current shift on load
  loadSalesSummary();
}

async function endCurrentShift() {
  // find open shift and close it by summarizing sales
  if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
    return alert('No open shift to end.');
  }

  if (!confirm('Are you sure you want to end the current shift?')) return;

  try {
    // sum sales total for this shift
    const q = query(collection(db, 'sales'), where('shiftId', '==', currentShift.id));
    const qSnap = await getDocs(q);
    let sum = 0;
    qSnap.forEach(snap => { const s = snap.data() || {}; sum += Number(s.total || 0); });

    // update shift doc with totals and mark closed
    await safeWrite('update', 'shifts', { totalIncome: Number(sum.toFixed(2)), endTime: new Date(), status: 'closed' }, currentShift.id);

    // update local currentShift and UI
    currentShift.status = 'closed';
    currentShift.endTime = new Date();
    currentShift.totalIncome = Number(sum.toFixed(2));
    updateShiftUI();
    // refresh sales summary to reflect closure
    loadSalesSummary();
    // refresh admin lists
    loadCashiersList();
    loadCashiersDropdown();

    alert('Shift ended. Total income: ' + formatCurrency(sum));
  } catch (err) {
    console.error('Failed to close shift', err);
    alert('Failed to close shift. Check console for details.');
  }
}

function updateShiftUI() {
  const ids = ['cashier-shift-info', 'admin-shift-info', 'current-shift-info'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (currentShift && currentShift.status === 'open') {
      const ts = currentShift.startTime && currentShift.startTime.toDate ? currentShift.startTime.toDate() : (currentShift.startTime || new Date());
      el.innerText = `Shift OPEN — started ${new Date(ts).toLocaleString()} — Cashier: ${currentShift.cashierName || currentShift.openedBy || 'Unknown'} — Sales: ${formatCurrency(Number(currentShift.totalIncome || currentShift.totalSales || 0))}`;
    } else {
      el.innerText = 'No open shift';
    }
  });

  // ensure both start buttons have consistent label and toggle end button visibility
  ['start-shift-btn-cashier', 'start-shift-btn-admin'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.innerText = 'Start New Shift';
    if (b) b.disabled = !!(currentShift && currentShift.status === 'open');
  });

  ['end-shift-btn-cashier', 'end-shift-btn-admin'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = (currentShift && currentShift.status === 'open') ? '' : 'none';
  });

  // Update checkout button availability based on whether the logged-in user has an active shift
  updateCheckoutButtonState();

  // If cashier page is visible, refresh their personal shift history
  const cashierPageEl = document.getElementById('cashierPage');
  if (cashierPageEl && cashierPageEl.style.display !== 'none' && currentUserRole === 'cashier') {
    try { if (typeof loadMyShifts === 'function') loadMyShifts(); } catch (err) { console.error('loadMyShifts failed', err); }
  }
}

async function startNewShift() {
  // UI Protection: Disable buttons immediately
  const startBtns = ['start-shift-btn-cashier', 'start-shift-btn-admin'];
  startBtns.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = true;
  });

  const reEnableButtons = () => {
    startBtns.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        // Only re-enable if there is no current open shift
        if (!currentShift || currentShift.status !== 'open') {
          btn.disabled = false;
        }
      }
    });
  };

  // 1. Quick local check
  if (currentShift && currentShift.id && currentShift.status === 'open') {
    alert('A shift is already open locally. Please end the current shift before starting a new one.');
    reEnableButtons();
    return;
  }

  // 2. Determine cashier name
  let cashierName = null;
  if (currentUserRole === 'cashier') {
    cashierName = currentEmployeeName || currentUsername || prompt('Enter cashier name for this shift (required)');
  } else {
    cashierName = prompt('Enter cashier name for this shift (required)');
  }

  if (!cashierName || !cashierName.trim()) {
    alert('Shift start cancelled: cashier name is required');
    reEnableButtons();
    return;
  }
  cashierName = cashierName.trim();

  // 3. Database check + Create with Transaction
  try {
    if (!navigator.onLine) {
      throw new Error('Internet connection is required to start a shift to prevent duplicates.');
    }

    await runTransaction(db, async (transaction) => {
      // Query for ANY open shift for this cashier
      // Since we can't do collection queries directly in transactions in the same way, 
      // we'll use a regular query first to find the ID, then read the doc in transaction to lock it?
      // Actually, Firestore transactions allow reading a specific document.
      // But we don't know the doc ID.

      // Let's do a query first (limited to online)
      const q = query(collection(db, 'shifts'),
        where('cashierName', '==', cashierName),
        where('status', '==', 'open'),
        limit(1));

      const qSnap = await getDocs(q);

      if (!qSnap.empty) {
        throw new Error('ALREADY_ACTIVE');
      }

      // No active shift found, create one
      const newShiftRef = doc(collection(db, 'shifts'));
      const shiftData = {
        startTime: new Date(),
        status: 'open',
        endTime: null,
        cashierName: cashierName,
        totalIncome: 0
      };

      transaction.set(newShiftRef, shiftData);

      // Update local state after transaction success
      currentShift = { id: newShiftRef.id, ...shiftData };
    });

    playSfx('success');
    updateShiftUI();
    // clear items sold summary and refresh sales summary
    document.getElementById('items-sold-tbody').innerHTML = '';
    loadSalesSummary();
    // refresh admin lists
    loadCashiersList();
    loadCashiersDropdown();
    alert('Shift started');

  } catch (err) {
    if (err.message === 'ALREADY_ACTIVE') {
      alert(`You already have an active shift as "${cashierName}". Please end it before starting a new one.`);
    } else {
      console.error('Failed to start shift', err);
      alert('Failed to start shift: ' + err.message);
    }
    reEnableButtons();
  }
}

async function loadProducts() {
  products = [];
  const querySnapshot = await getDocs(collection(db, "products"));
  querySnapshot.forEach((doc) => {
    const data = doc.data() || {};
    products.push({
      id: doc.id,
      name: data.name,
      price: Number(data.price),
      capital: Number(data.capital || 0),
      profit: Number(data.profit || 0),
      category: (data.category || "").trim(),
      unit: data.unit,
      stock: Number(data.stock || 0)
    });
  });
  renderProducts();
  checkLowStock();
}

function checkLowStock() {
  const threshold = 5;
  const lowStockProducts = products.filter(p => p.stock <= threshold);
  const notificationsEl = document.getElementById('stock-notifications-list');
  const panelEl = document.getElementById('stock-notifications');

  if (lowStockProducts.length > 0) {
    notificationsEl.innerHTML = '';
    lowStockProducts.forEach(p => {
      const div = document.createElement('div');
      div.className = 'notification-item';
      div.innerHTML = `
        <div class="notification-icon">⚠️</div>
        <div class="notification-content">
          <strong>${p.name}</strong>: Only <strong>${Number(p.stock).toFixed(2)}</strong> ${p.unit} left!
        </div>
      `;
      notificationsEl.appendChild(div);
    });
    panelEl.style.display = 'block';
  } else {
    panelEl.style.display = 'none';
  }
}

function setCategory(cat) {
  currentCategory = cat;
  // update active visual on category buttons
  document.querySelectorAll('#categories button').forEach(b => b.classList.toggle('active', b.innerText.trim() === cat));
  renderProducts();
}

window.setCategory = setCategory;

function setLendingCategory(cat) {
  currentLendingCategory = cat;
  // update active visual on lending category buttons
  document.querySelectorAll('#lending-categories button').forEach(b => b.classList.toggle('active', b.innerText.trim() === cat));
  renderLendingProducts();
}

window.setLendingCategory = setLendingCategory;

function renderLendingProducts() {
  const div = document.getElementById("lending-products");
  div.innerHTML = "";

  // ensure category active state
  renderLendingCategoriesUI();

  let filtered = products;

  // Search Filter
  const q = cleanStr(searchState.lending);
  if (q) {
    // If searching, prioritize matches but usually showing all matches is best
    // We filter by name match regardless of category if searching? 
    // Usually standard behavior: If standard category selected, filter within that category.
    // Spec said: "When search box is cleared: product list returns to normal category view order"
    // So let's filter the CURRENT selection by search term.
    filtered = filtered.filter(p => cleanStr(p.name).includes(q));
  }

  // Category Filter
  if (currentLendingCategory !== "All") {
    filtered = filtered.filter(p => p.category === currentLendingCategory);
  }

  if (filtered.length === 0) {
    div.innerHTML = '<div style="color:var(--muted);width:100%">No items found</div>';
    return;
  }

  filtered.forEach((p) => {
    let btn = document.createElement("button");
    btn.innerHTML = `<span class="btn-text">${p.name} (${p.unit}) - ${formatCurrency(p.price)}</span>`;
    // pass the product object directly to avoid index/reference issues
    btn.onclick = () => {
      playSfx('click');
      addToLendingCart(p);
    };

    // Add category-based class for styling
    const cat = (p.category || '').toLowerCase().trim();
    if (cat === 'vegetables') btn.classList.add('category-vegetables');
    else if (cat === 'frozen foods') btn.classList.add('category-frozen-foods');
    else if (cat === 'groceries') btn.classList.add('category-groceries');

    div.appendChild(btn);
  });
}

function addToLendingCart(product) {
  if (!product) return;

  // If product sold by Kg, open modal to enter weight or amount
  if (product.unit && product.unit.toLowerCase() === 'kg') {
    openLendingWeightModal(product);
    return;
  }

  // pcs behavior (integer quantity)
  let existing = lendingCart.find(item => item.name === product.name && item.unit === product.unit);

  if (existing) {
    existing.qty += 1; // increase quantity
    existing.total = Number((existing.qty * existing.price).toFixed(2));
  } else {
    lendingCart.push({
      name: product.name,
      price: Number(product.price),
      unit: product.unit,
      qty: 1,
      total: Number((1 * Number(product.price)).toFixed(2))
    });
  }

  playSfx('add');
  renderLendingCart();
}

function renderLendingCart() {
  const list = document.getElementById("lending-cart");
  const totalSpan = document.getElementById("lending-total");

  list.innerHTML = "";
  let total = 0;

  lendingCart.forEach((item, idx) => {
    let lineTotalNumber = 0;
    let lineText = '';

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      lineTotalNumber = Number(item.total);
      const displayWeight = Number(item.weight).toFixed(2);
      lineText = `${item.name} (${item.unit}) ${displayWeight}kg = ${formatCurrency(lineTotalNumber)}`;
    } else {
      lineTotalNumber = Number(item.price * item.qty);
      lineText = `${item.name} (${item.unit}) x${Number(item.qty).toFixed(2)} = ${formatCurrency(lineTotalNumber)}`;
    }

    total += lineTotalNumber;

    let li = document.createElement("li");

    const text = document.createElement('span');
    text.className = 'cart-item-text';
    text.innerText = lineText;

    // actions container
    const actions = document.createElement('div');

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      const editBtn = document.createElement('button');
      editBtn.className = 'remove-btn';
      editBtn.innerHTML = `<span class=\"btn-icon\">✏️</span><span class=\"btn-text\">Edit</span>`;
      editBtn.onclick = () => openLendingWeightModal({ name: item.name, price: item.price, unit: item.unit }, idx, item.weight);
      actions.appendChild(editBtn);
    } else {
      const minus = document.createElement('button');
      minus.className = 'remove-btn';
      minus.innerHTML = `<span class=\"btn-icon\">➖</span>`;
      minus.onclick = () => changeLendingQty(idx, -1);

      const plus = document.createElement('button');
      plus.className = 'checkout-btn';
      plus.style.marginLeft = '8px';
      plus.innerHTML = `<span class=\"btn-icon\">➕</span>`;
      plus.onclick = () => changeLendingQty(idx, 1);

      actions.appendChild(minus);
      actions.appendChild(plus);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.style.marginLeft = '8px';
    removeBtn.innerHTML = `<span class=\"btn-icon\">🗑️</span><span class=\"btn-text\">Remove</span>`;
    removeBtn.onclick = () => removeFromLendingCart(idx);

    actions.appendChild(removeBtn);

    li.appendChild(text);
    li.appendChild(actions);
    list.appendChild(li);
  });

  // store subtotal and update formatted displays
  currentSubtotal = Number(total);
  totalSpan.innerText = formatCurrency(total);
}

function removeFromLendingCart(index) {
  if (index < 0 || index >= lendingCart.length) return;
  playSfx('delete');
  lendingCart.splice(index, 1);
  renderLendingCart();
}

function changeLendingQty(index, delta) {
  const item = lendingCart[index];
  if (!item) return;
  if (item.unit && item.unit.toLowerCase() === 'kg') return; // qty buttons only for pcs

  item.qty = Math.max(1, item.qty + delta);
  item.total = Number((item.qty * item.price).toFixed(2));
  renderLendingCart();
}

function clearLendingCart() {
  lendingCart = [];
  renderLendingCart();
}

// Weight modal for lending
function openLendingWeightModal(product, editIndex = null, existingWeight = null) {
  modalProduct = product;
  modalEditIndex = (typeof editIndex === 'number') ? editIndex : null;
  isLendingModal = true;
  document.getElementById('lending-modal-product-name').innerText = product.name;
  document.getElementById('lending-modal-price').innerText = Number(product.price).toFixed(2);

  const w = document.getElementById('lending-modal-weight');
  const a = document.getElementById('lending-modal-amount');

  if (existingWeight != null) {
    w.value = Number(existingWeight).toFixed(2);
    a.value = Number((existingWeight * product.price).toFixed(2));
  } else {
    w.value = '';
    a.value = '';
  }

  document.getElementById('lending-weight-modal').classList.remove('hidden');
  document.getElementById('lending-weight-modal').setAttribute('aria-hidden', 'false');
}

// wire clear lending cart button
const clearLendingBtn = document.getElementById('clear-lending-cart');
if (clearLendingBtn) clearLendingBtn.onclick = clearLendingCart;

// wire lend button
const lendBtn = document.getElementById('lend');
if (lendBtn) lendBtn.onclick = () => {
  if (lendingCart.length === 0) {
    alert('Lending cart is empty');
    return;
  }
  document.getElementById('borrower-name').value = '';
  document.getElementById('borrower-modal').classList.remove('hidden');
  document.getElementById('borrower-modal').setAttribute('aria-hidden', 'false');
};

// wire borrower modal buttons
const borrowerCancel = document.getElementById('borrower-cancel');
if (borrowerCancel) borrowerCancel.onclick = () => {
  document.getElementById('borrower-modal').classList.add('hidden');
  document.getElementById('borrower-modal').setAttribute('aria-hidden', 'true');
};

const borrowerConfirm = document.getElementById('borrower-confirm');
if (borrowerConfirm) borrowerConfirm.onclick = async () => {
  const borrowerName = document.getElementById('borrower-name').value.trim();
  if (!borrowerName) {
    alert('Please enter borrower name');
    return;
  }
  await saveLending(borrowerName);
};

async function saveLending(borrowerName) {
  const lendingDoc = {
    borrowerName: borrowerName,
    items: lendingCart.map(i => {
      const it = {
        name: i.name,
        unit: i.unit,
        price: i.price,
        total: i.total
      };
      if (i.unit && i.unit.toLowerCase() === 'kg') {
        it.weight = Number(i.weight);
      } else {
        it.qty = i.qty;
      }
      return it;
    }),
    total: lendingCart.reduce((s, i) => s + i.total, 0),
    timestamp: serverTimestamp(),
    returned: false
  };

  try {
    const lendingForSave = { ...lendingDoc, timestamp: new Date() };
    await safeWrite('add', 'lendings', lendingForSave);
    playSfx('success');
    lendingCart = [];
    renderLendingCart();
    document.getElementById('borrower-modal').classList.add('hidden');
    document.getElementById('borrower-modal').setAttribute('aria-hidden', 'true');
    alert('Lending recorded successfully!');
  } catch (err) {
    console.error('Failed to save lending', err);
    alert('Failed to save lending. Check console for details.');
  }
}

function renderProducts() {
  const div = document.getElementById("products");
  div.innerHTML = "";

  // ensure category active state
  renderCategoriesUI();

  let filtered = products;

  // Search Filter
  const q = cleanStr(searchState.sales);
  if (q) {
    filtered = filtered.filter(p => cleanStr(p.name).includes(q));
  }

  // Category Filter
  if (currentCategory !== "All") {
    filtered = filtered.filter(p => p.category === currentCategory);
  }

  if (filtered.length === 0) {
    div.innerHTML = '<div style="color:var(--muted);width:100%">No products found</div>';
    return;
  }

  filtered.forEach((p) => {
    let btn = document.createElement("button");
    btn.innerHTML = `<span class="btn-text">${p.name} (${p.unit}) - ${formatCurrency(p.price)}</span>`;
    // pass the product object directly to avoid index/reference issues
    btn.onclick = () => {
      playSfx('click');
      addToCart(p);
    };

    // Add category-based coloring
    const categoryInfo = categories.find(c => c.name === p.category);
    if (categoryInfo && categoryInfo.color) {
      btn.style.background = categoryInfo.color;
    } else {
      // Fallback category-based class
      const cat = (p.category || '').toLowerCase().trim();
      if (cat === 'vegetables') btn.classList.add('category-vegetables');
      else if (cat === 'frozen foods') btn.classList.add('category-frozen-foods');
      else if (cat === 'groceries') btn.classList.add('category-groceries');
    }

    div.appendChild(btn);
  });
}

function addToCartByName(name) {
  const product = products.find(p => p.name === name);
  if (product) addToCart(product);
}

function addToCart(product) {
  if (!product) return;

  // If product sold by Kg, open modal to enter weight or amount
  if (product.unit && product.unit.toLowerCase() === 'kg') {
    openWeightModal(product);
    return;
  }

  // pcs behavior (integer quantity)
  let existing = cart.find(item => item.name === product.name && item.unit === product.unit);

  if (existing) {
    existing.qty += 1; // increase quantity
    existing.total = Number((existing.qty * existing.price).toFixed(2));
  } else {
    cart.push({
      name: product.name,
      price: Number(product.price),
      unit: product.unit,
      qty: 1,
      total: Number((1 * Number(product.price)).toFixed(2))
    });
  }

  playSfx('add');
  renderCart();
}


function renderCart() {
  const list = document.getElementById("cart");
  const totalSpan = document.getElementById("total");
  const cashInput = document.getElementById("cash");
  const changeSpan = document.getElementById("change");

  list.innerHTML = "";
  let total = 0;

  cart.forEach((item, idx) => {
    let lineTotalNumber = 0;
    let lineText = '';

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      lineTotalNumber = Number(item.total);
      const displayWeight = Number(item.weight).toFixed(2);
      lineText = `${item.name} (${item.unit}) ${displayWeight}kg = ${formatCurrency(lineTotalNumber)}`;
    } else {
      lineTotalNumber = Number(item.price * item.qty);
      lineText = `${item.name} (${item.unit}) x${Number(item.qty).toFixed(2)} = ${formatCurrency(lineTotalNumber)}`;
    }

    total += lineTotalNumber;

    let li = document.createElement("li");

    const text = document.createElement('span');
    text.className = 'cart-item-text';
    text.innerText = lineText;

    // actions container
    const actions = document.createElement('div');

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      const editBtn = document.createElement('button');
      editBtn.className = 'remove-btn';
      editBtn.innerHTML = `<span class=\"btn-icon\">✏️</span><span class=\"btn-text\">Edit</span>`;
      editBtn.onclick = () => openWeightModal({ name: item.name, price: item.price, unit: item.unit }, idx, item.weight);
      actions.appendChild(editBtn);
    } else {
      const minus = document.createElement('button');
      minus.className = 'remove-btn';
      minus.innerHTML = `<span class=\"btn-icon\">➖</span>`;
      minus.onclick = () => changeQty(idx, -1);

      const plus = document.createElement('button');
      plus.className = 'checkout-btn';
      plus.style.marginLeft = '8px';
      plus.innerHTML = `<span class=\"btn-icon\">➕</span>`;
      plus.onclick = () => changeQty(idx, 1);

      actions.appendChild(minus);
      actions.appendChild(plus);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.style.marginLeft = '8px';
    removeBtn.innerHTML = `<span class=\"btn-icon\">🗑️</span><span class=\"btn-text\">Remove</span>`;
    removeBtn.onclick = () => removeFromCart(idx);

    actions.appendChild(removeBtn);

    li.appendChild(text);
    li.appendChild(actions);
    list.appendChild(li);
  });

  // store subtotal and update formatted displays
  currentSubtotal = Number(total);
  totalSpan.innerText = formatCurrency(total);

  // wire cash input to update totals
  if (cashInput) cashInput.oninput = () => updateTotals();

  // ensure discount input updates totals as well
  const discountInput = document.getElementById('discount');
  if (discountInput) discountInput.oninput = () => updateTotals();

  // run totals update
  updateTotals();
}

function updateTotals() {
  const subtotal = Number(currentSubtotal || 0);
  const discount = Number(document.getElementById('discount')?.value) || 0;
  const total = Number(Math.max(0, (subtotal - discount)).toFixed(2));
  const cash = Number(document.getElementById('cash')?.value) || 0;

  const subtotalEl = document.getElementById('subtotal');
  const totalEl = document.getElementById('total');
  const changeEl = document.getElementById('change');
  const receiptDiscountEl = document.getElementById('receipt-discount');

  if (subtotalEl) subtotalEl.innerText = formatCurrency(subtotal);
  if (totalEl) totalEl.innerText = formatCurrency(total);
  if (changeEl) changeEl.innerText = formatCurrency(cash - total);
  if (receiptDiscountEl) receiptDiscountEl.innerText = formatCurrency(discount);
}

function removeFromCart(index) {
  if (index < 0 || index >= cart.length) return;
  playSfx('delete');
  cart.splice(index, 1);
  renderCart();
  updateTotals();
}

function clearCart() {
  playSfx('delete');
  cart = [];
  renderCart();
}

function changeQty(index, delta) {
  const item = cart[index];
  if (!item) return;
  if (item.unit && item.unit.toLowerCase() === 'kg') return; // qty buttons only for pcs

  item.qty = Math.max(1, item.qty + delta);
  item.total = Number((item.qty * item.price).toFixed(2));
  renderCart();
}

// Open receipt preview on checkout (do not save immediately)
const checkoutBtnEl = document.getElementById("checkout");
if (checkoutBtnEl) checkoutBtnEl.onclick = () => {
  // If user is a cashier, ensure they have an active shift assigned to them
  if (!canCheckout()) {
    alert('You must start a shift before checkout.');
    return;
  }

  // ensure totals up-to-date then open
  updateTotals();
  const discount = Number(document.getElementById('discount')?.value) || 0;
  const total = Number(Math.max(0, (Number(currentSubtotal || 0) - discount)).toFixed(2));
  const cash = Number(document.getElementById('cash').value) || 0;
  if (cash < total) {
    showErrorModal("Cannot proceed to checkout. Cash Payment isn't enough");
    return;
  }
  openReceiptModal();
}

// Error modal helper
function showErrorModal(msg) {
  const modal = document.getElementById('error-modal');
  const msgEl = document.getElementById('error-modal-message');
  if (msgEl) msgEl.innerText = msg;
  if (modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); }
}

function closeErrorModal() {
  const modal = document.getElementById('error-modal');
  if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
}

// wire error modal OK button
const errorOkBtn = document.getElementById('error-ok');
if (errorOkBtn) errorOkBtn.onclick = () => {
  closeErrorModal();
  const cashInput = document.getElementById('cash');
  if (cashInput) cashInput.focus();
};

// SPA navigation
function isPageAllowedForRole(id) {
  if (!currentUserRole) return false;
  // Admins can access all pages
  if (currentUserRole === 'admin') return true;
  // Cashiers can access Sales, Receipts, and Cashier page
  if (currentUserRole === 'cashier') return id === 'salesPage' || id === 'receiptsPage' || id === 'cashierPage';
  // Finance, Remits, and Profits are admin-only
  if (id === 'financePage' || id === 'remitsPage' || id === 'profitsPage') return currentUserRole === 'admin';
  return false;
}

function showPage(id) {
  // enforce access
  if (!isPageAllowedForRole(id)) {
    alert('You are not authorized to view this page');
    id = 'salesPage';
  }

  // Use animation classes for page transitions
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('page-active');
    p.classList.add('page-hidden');
    p.style.display = 'none'; // Hide inactive pages to prevent layout issues
  });
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('page-hidden');
    el.classList.add('page-active');
    el.style.display = 'block'; // Ensure display is block for active page
  }

  // update active nav
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = Array.from(document.querySelectorAll('.nav-btn')).find(b => b.innerText.trim().toLowerCase() === id.replace('Page', '').toLowerCase());
  if (navBtn) navBtn.classList.add('active');

  // close mobile nav
  document.getElementById('nav-links').classList.remove('open');

  // show/hide page title based on page
  const pageTitle = document.getElementById('page-title');
  if (pageTitle) {
    pageTitle.style.display = (id === 'salesPage') ? 'block' : 'none';
  }

  // call page-specific loaders
  if (id === 'salesPage') loadSalesSummary();
  if (id === 'receiptsPage') loadSalesHistory(); // Note: receiptsPage corresponds to historyPage in JS
  if (id === 'productsPage') renderProductsEditor();
  if (id === 'cashierPage') {
    try { if (typeof loadMyShifts === 'function') loadMyShifts(); } catch (err) { console.error('loadMyShifts failed', err); }
  }
  if (id === 'adminPage') {
    try { if (typeof loadShiftsDropdown === 'function') loadShiftsDropdown(); } catch (err) { console.error('loadShiftsDropdown failed', err); }
    try { if (typeof loadCashiersList === 'function') loadCashiersList(); } catch (err) { console.error('loadCashiersList failed', err); }
    try { if (typeof loadEmployees === 'function') loadEmployees(); } catch (err) { console.error('loadEmployees failed', err); }
  }
  if (id === 'remitsPage') loadRemits();
  if (id === 'profitsPage') loadProfits();
  if (id === 'financePage') loadFinancePage();
  if (id === 'receiptsPage') {
    loadCashiersDropdown();
    loadSalesHistory();
  }
  if (id === 'lendingPage') {
    setLendingCategory('All');
    loadBorrowersList();
  }
}

// Global modal close helpers
window.closeAddProductModal = () => {
  document.getElementById('add-product-modal').classList.add('hidden');
  document.getElementById('add-product-modal').setAttribute('aria-hidden', 'true');
};
window.closeAddEmployeeModal = () => {
  document.getElementById('add-employee-modal').classList.add('hidden');
  document.getElementById('add-employee-modal').setAttribute('aria-hidden', 'true');
};
window.closeLendingDetailsModal = () => {
  document.getElementById('lending-details-modal').classList.add('hidden');
  document.getElementById('lending-details-modal').setAttribute('aria-hidden', 'true');
};

const addProductClose = document.getElementById('add-product-close');
if (addProductClose) addProductClose.onclick = window.closeAddProductModal;
const addEmployeeClose = document.getElementById('add-employee-close');
if (addEmployeeClose) addEmployeeClose.onclick = window.closeAddEmployeeModal;
const receiptClose = document.getElementById('receipt-close');
if (receiptClose) receiptClose.onclick = closeReceiptModal;
const lendingDetailsClose = document.getElementById('lending-details-close');
if (lendingDetailsClose) lendingDetailsClose.onclick = window.closeLendingDetailsModal;

// Keyboard ESC
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeReceiptModal();
    window.closeAddProductModal();
    window.closeAddEmployeeModal();
    window.closeLendingDetailsModal();
    closeErrorModal();
  }
});

window.showPage = showPage;

// hamburger toggle
const hamburger = document.getElementById('hamburger');
if (hamburger) hamburger.onclick = () => document.getElementById('nav-links').classList.toggle('open');

// Receipt modal handlers
function openReceiptModal(saleObj = null) {
  // if saleObj provided, open read-only preview, otherwise preview for current cart
  const modal = document.getElementById('receipt-modal');
  const itemsList = document.getElementById('receipt-items');
  const datetime = document.getElementById('receipt-datetime');
  const cashierEl = document.getElementById('receipt-cashier');
  const subtotalEl = document.getElementById('receipt-subtotal');
  const discountEl = document.getElementById('receipt-discount');
  const totalEl = document.getElementById('receipt-total');
  const cashInput = document.getElementById('receipt-cash');
  const changeEl = document.getElementById('receipt-change');
  const receiptSaveBtn = document.getElementById('receipt-save');

  itemsList.innerHTML = '';
  let subtotal = 0;

  const itemsSource = saleObj ? saleObj.items : cart;

  itemsSource.forEach(item => {
    let lineTotal = 0;
    let li = document.createElement('li');
    li.style.padding = '6px 0';

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      const weight = item.weight || 0;
      lineTotal = Number(item.lineTotal ?? item.total ?? 0);
      li.innerText = `${item.name} (${item.unit}) ${Number(weight).toFixed(2)}kg @ ${formatCurrency(item.price)} = ${formatCurrency(lineTotal)}`;
    } else {
      const qty = item.qty || 0;
      lineTotal = Number(item.lineTotal ?? (item.price * qty) ?? 0);
      li.innerText = `${item.name} (${item.unit}) x${Number(Number(qty).toFixed(2))} @ ${formatCurrency(item.price)} = ${formatCurrency(lineTotal)}`;
    }

    subtotal += lineTotal;
    itemsList.appendChild(li);
  });

  const discountVal = saleObj ? Number(saleObj.discount || 0) : Number(document.getElementById('discount')?.value || 0);
  const totalAfter = Number((subtotal - discountVal).toFixed(2));

  subtotalEl.innerText = formatCurrency(subtotal);
  if (discountEl) discountEl.innerText = formatCurrency(discountVal);
  totalEl.innerText = formatCurrency(totalAfter);

  const now = saleObj && saleObj.timestamp ? (saleObj.timestamp.toDate ? saleObj.timestamp.toDate() : new Date(saleObj.timestamp)) : new Date();
  datetime.innerText = now.toLocaleString();

  if (saleObj) {
    // readonly view
    const cash = Number(saleObj.cash) || 0;
    const change = Number(saleObj.change) || (cash - totalAfter);
    cashInput.value = cash ? cash.toFixed(2) : '';
    cashInput.disabled = true;
    changeEl.innerText = formatCurrency(change);
    if (receiptSaveBtn) receiptSaveBtn.style.display = 'none';
    if (cashierEl) cashierEl.innerText = saleObj.cashier || 'Unknown';
  } else {
    // allow save flow
    const mainCash = Number(document.getElementById('cash').value) || 0;
    cashInput.value = mainCash ? mainCash.toFixed(2) : '';
    cashInput.disabled = false;
    if (receiptSaveBtn) receiptSaveBtn.style.display = '';

    // update change on input
    cashInput.oninput = () => {
      const cash = Number(cashInput.value) || 0;
      const change = cash - totalAfter;
      changeEl.innerText = formatCurrency(change);
    };

    const initialCash = Number(cashInput.value) || 0;
    changeEl.innerText = formatCurrency(initialCash - totalAfter);
    if (cashierEl) cashierEl.innerText = currentEmployeeName || currentUsername || 'Unknown';
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeReceiptModal() {
  const modal = document.getElementById('receipt-modal');
  // reset receipt UI to default
  const cashInput = document.getElementById('receipt-cash');
  const receiptSaveBtn = document.getElementById('receipt-save');
  if (cashInput) { cashInput.disabled = false; cashInput.value = ''; }
  if (receiptSaveBtn) receiptSaveBtn.style.display = '';

  // reset receipt discount display
  const receiptDiscount = document.getElementById('receipt-discount');
  if (receiptDiscount) receiptDiscount.innerText = formatCurrency(0);

  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// wire receipt buttons
// removed receiptCancel footer button wire as it is replaced by X


const receiptSave = document.getElementById('receipt-save');
if (receiptSave) receiptSave.onclick = async () => {
  // gather data and save to Firestore
  const cash = Number(document.getElementById('receipt-cash').value) || 0;

  const itemsForSave = cart.map(i => {
    const it = {
      name: i.name,
      unit: i.unit,
      price: Number(i.price)
    };

    if (i.unit && i.unit.toLowerCase() === 'kg') {
      it.weight = Number(i.weight);
      it.lineTotal = Number(i.total);
    } else {
      it.qty = i.qty;
      it.lineTotal = Number((i.price * i.qty).toFixed(2));
    }

    return it;
  });

  // compute subtotal from items
  let subtotal = itemsForSave.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0);
  subtotal = Number(subtotal.toFixed(2));

  // read discount and validate
  const discountVal = Number(document.getElementById('discount')?.value || 0);
  if (discountVal < 0) {
    showErrorModal('Invalid discount amount');
    return;
  }
  if (discountVal > subtotal) {
    showErrorModal('Discount cannot exceed subtotal');
    return;
  }

  const total = Number((subtotal - discountVal).toFixed(2));
  const change = Number((cash - total).toFixed(2));

  // require an open shift for cashiers (must match current employee name); admins may proceed if a shift exists
  if (currentUserRole === 'cashier') {
    if (!currentShift || !currentShift.id || currentShift.status !== 'open' || (String(currentShift.cashierName || '').trim() !== String(currentEmployeeName || '').trim())) {
      console.warn('Receipt save blocked - no active shift for current cashier', { currentShift, currentEmployeeName });
      return alert('You must start a shift before checkout.');
    }
  } else {
    if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
      console.warn('Receipt save blocked - no active shift found for non-cashier user', { currentShift });
      return alert('No open shift. Please start a shift before saving sales.');
    }
  }

  // validate receipt cash (in case user modified in modal)
  const receiptCash = Number(document.getElementById('receipt-cash').value) || 0;
  if (receiptCash < total) {
    showErrorModal("Cannot proceed to checkout. Cash Payment isn't enough");
    return;
  }

  const saleDoc = {
    timestamp: new Date(),
    shiftId: currentShift.id,
    items: itemsForSave,
    subtotal: Number(subtotal.toFixed(2)),
    discount: Number(discountVal.toFixed(2)),
    total: Number(total.toFixed(2)),
    cash: Number(cash.toFixed(2)),
    change: Number(change.toFixed(2)),
    cashier: currentEmployeeName || currentUsername || 'Unknown'
  };

  try {
    await safeWrite('add', 'sales', saleDoc);
    // update shift totalIncome
    try {
      const newTotal = Number(((Number(currentShift.totalIncome || currentShift.totalSales || 0) + saleDoc.total)).toFixed(2));
      await safeWrite('update', 'shifts', { totalIncome: newTotal }, currentShift.id);
      currentShift.totalIncome = newTotal;
    } catch (e) { console.error('Failed to update shift total', e); }

    // Deduct stock for sold items
    for (const item of cart) {
      const product = products.find(p => p.name === item.name && p.unit === item.unit);
      if (product) {
        let deduct = 0;
        if (item.unit && item.unit.toLowerCase() === 'kg') {
          deduct = Number(item.weight || 0);
        } else {
          deduct = Number(item.qty || 0);
        }
        const newStock = Math.max(0, Number(product.stock || 0) - deduct);
        try {
          await safeWrite('update', 'products', { stock: newStock }, product.id);
          product.stock = newStock; // update local
        } catch (e) {
          console.error('Failed to update stock for', product.name, e);
        }
      }
    }

    // success
    playSfx('chaching');
    cart = [];
    renderCart();
    closeReceiptModal();
    // reset checkout inputs
    const discountInput = document.getElementById('discount'); if (discountInput) discountInput.value = '';
    const cashInput = document.getElementById('cash'); if (cashInput) cashInput.value = '';
    alert('Sale recorded successfully!');
    // refresh summary and history
    loadSalesSummary();
    loadSalesHistory();
    updateShiftUI();
    // refresh products to reflect stock changes
    loadProducts();
  } catch (err) {
    console.error('Save failed', err);
    alert('Failed to save sale. Check console for details.');
  }
};

// Modal state
let modalProduct = null;
let modalEditIndex = null;
let isLendingModal = false;

// sync inputs for lending modal
const lendingModalWeightInput = document.getElementById('lending-modal-weight');
const lendingModalAmountInput = document.getElementById('lending-modal-amount');

if (lendingModalWeightInput && lendingModalAmountInput) {
  lendingModalWeightInput.oninput = () => {
    const w = Number(lendingModalWeightInput.value);
    if (!modalProduct) return;
    if (!isNaN(w) && w > 0) {
      lendingModalAmountInput.value = Number((w * modalProduct.price).toFixed(2));
    } else {
      lendingModalAmountInput.value = '';
    }
  };

  lendingModalAmountInput.oninput = () => {
    const a = Number(lendingModalAmountInput.value);
    if (!modalProduct) return;
    if (!isNaN(a) && a > 0) {
      lendingModalWeightInput.value = Number((a / modalProduct.price).toFixed(2));
    } else {
      lendingModalWeightInput.value = '';
    }
  };
}

// SALES summary & history functions
async function loadSalesSummary() {
  const itemsSummary = {};
  let totalIncome = 0;

  // if there's no open shift, or the current shift is not open, show empty summary
  if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
    document.getElementById('items-sold-tbody').innerHTML = '';
    document.getElementById('total-income').innerText = formatCurrency(0);
    return;
  }

  const q = query(collection(db, 'sales'), where('shiftId', '==', currentShift.id));
  const qSnap = await getDocs(q);
  qSnap.forEach(docSnap => {
    const s = docSnap.data();
    totalIncome += Number(s.total || 0);
    (s.items || []).forEach(it => {
      const key = `${it.name}||${it.unit}`;
      if (!itemsSummary[key]) itemsSummary[key] = { name: it.name, unit: it.unit, weight: 0, qty: 0 };
      if (it.unit && it.unit.toLowerCase() === 'kg') {
        itemsSummary[key].weight += Number(it.weight || 0);
      } else {
        itemsSummary[key].qty += Number(it.qty || 0);
      }
    });
  });

  // update local shift total if it differs
  if (currentShift && Number(currentShift.totalIncome || 0) !== Number(totalIncome.toFixed(2))) {
    currentShift.totalIncome = Number(totalIncome.toFixed(2));
  }

  const tbody = document.getElementById('items-sold-tbody');
  tbody.innerHTML = '';
  Object.values(itemsSummary).forEach(entry => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const unitTd = document.createElement('td');
    const soldTd = document.createElement('td');

    nameTd.innerText = entry.name;
    unitTd.innerText = entry.unit;
    if (entry.unit && entry.unit.toLowerCase() === 'kg') {
      soldTd.innerText = `${Number(entry.weight).toFixed(2)} Kg`;
    } else {
      soldTd.innerText = `${Number(Number(entry.qty).toFixed(2))} pcs`;
    }

    tr.appendChild(nameTd);
    tr.appendChild(unitTd);
    tr.appendChild(soldTd);
    tbody.appendChild(tr);
  });

  document.getElementById('total-income').innerText = formatCurrency(totalIncome);
}


async function loadCashiersDropdown() {
  const sel = document.getElementById('cashier-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All Cashiers</option>';

  try {
    const q = query(collection(db, 'shifts'), orderBy('cashierName'));
    const qSnap = await getDocs(q);
    const names = new Set();
    qSnap.forEach(snap => {
      const d = snap.data();
      if (d.cashierName) names.add(d.cashierName);
    });

    names.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.innerText = name;
      sel.appendChild(opt);
    });

    if (historyFilters.cashier) sel.value = historyFilters.cashier;
  } catch (err) {
    console.error('Failed to load cashiers dropdown', err);
  }
}

async function loadShiftsDropdown() {
  const sel = document.getElementById('shift-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All Shifts</option>';

  try {
    // latest 50 shifts
    const q = query(collection(db, 'shifts'), orderBy('startTime', 'desc'), limit(50));
    const qSnap = await getDocs(q);
    qSnap.forEach(snap => {
      const d = snap.data();
      const start = d.startTime && d.startTime.toDate ? d.startTime.toDate().toLocaleString() : (d.startTime || '');
      const opt = document.createElement('option');
      opt.value = snap.id;
      opt.innerText = `${d.cashierName || 'No Name'} - ${start}`;
      sel.appendChild(opt);
    });
    if (historyFilters.shiftId) sel.value = historyFilters.shiftId;
  } catch (err) {
    console.error('Failed to load shifts dropdown', err);
  }
}

async function loadProfits() {
  const container = document.getElementById('profits-list');
  const profitEl = document.getElementById('weekly-profit');
  if (!container || !profitEl) return;
  container.innerHTML = 'Loading profits...';

  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (now.getDay() || 7) + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalProfit = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      let saleProfit = 0;

      (s.items || []).forEach(it => {
        const product = products.find(p => p.name === it.name && p.unit === it.unit);
        if (product && product.profit != null) {
          let quantity = (it.unit && it.unit.toLowerCase() === 'kg') ? Number(it.weight || 0) : Number(it.qty || 0);
          saleProfit += Number(product.profit) * quantity;
        }
      });

      totalProfit += saleProfit;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += saleProfit;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales this week';
    profitEl.innerText = formatCurrency(totalProfit);
  } catch (err) {
    console.error('Failed to load profits', err);
    container.innerText = 'Failed to load profits';
    profitEl.innerText = '₱0.00';
  }
}

const cashierFilterEl = document.getElementById('cashier-filter');
if (cashierFilterEl) {
  cashierFilterEl.onchange = () => {
    historyFilters.cashier = cashierFilterEl.value;
    loadSalesHistory();
  };
}

// Admin helper: list distinct cashier names and wire viewing their shifts
async function loadCashiersList() {
  const container = document.getElementById('admin-cashier-list');
  if (!container) return;
  container.innerHTML = '';
  try {
    const q = query(collection(db, 'shifts'), orderBy('startTime', 'desc'));
    const qSnap = await getDocs(q);
    const seen = new Set();
    if (qSnap.empty) { container.innerText = 'No shifts recorded'; return; }
    qSnap.forEach(snap => {
      const d = snap.data() || {};
      const name = (d.cashierName || d.openedBy || '').trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        const btn = document.createElement('button');
        btn.className = 'checkout-btn';
        btn.innerHTML = `<span class="btn-text">${name}</span>`;
        btn.onclick = () => loadCashierShifts(name);
        container.appendChild(btn);
      }
    });
  } catch (err) { console.error('Failed to load cashiers list', err); container.innerText = 'Failed to load cashiers'; }
}

async function loadCashierShifts(name) {
  const container = document.getElementById('admin-cashier-shifts');
  if (!container) return;
  container.innerHTML = '';
  try {
    if (!name || typeof name !== 'string' || !name.trim()) {
      container.innerText = 'Invalid cashier name';
      console.warn('loadCashierShifts called with invalid name:', name);
      return;
    }
    console.log('loadCashierShifts: filter cashierName==', name);
    // remove server-side orderBy to avoid composite index requirement; we'll sort client-side
    const q = query(collection(db, 'shifts'), where('cashierName', '==', name));
    console.log('Shift query object (no orderBy - sorting client-side):', q);
    let qSnap;
    try {
      qSnap = await getDocs(q);
    } catch (innerErr) {
      console.error('Error fetching shifts for', name, innerErr);
      container.innerText = 'Failed to load shifts: ' + (innerErr && innerErr.message ? innerErr.message : String(innerErr));
      return;
    }
    if (qSnap.empty) { container.innerText = 'No shifts recorded yet'; return; }

    // sort documents client-side by startTime desc
    const docs = qSnap.docs.map(snap => ({ id: snap.id, data: snap.data() || {} }));
    docs.sort((a, b) => {
      const ta = a.data.startTime && a.data.startTime.toDate ? a.data.startTime.toDate() : (a.data.startTime || new Date(0));
      const tb = b.data.startTime && b.data.startTime.toDate ? b.data.startTime.toDate() : (b.data.startTime || new Date(0));
      return tb - ta;
    });

    docs.forEach(item => {
      const d = item.data || {};
      const div = document.createElement('div');
      div.className = 'card';
      const start = d.startTime && d.startTime.toDate ? d.startTime.toDate().toLocaleString() : (d.startTime || '');
      const end = d.endTime && d.endTime.toDate ? d.endTime.toDate().toLocaleString() : (d.endTime ? d.endTime.toString() : '—');
      div.innerHTML = `<div><strong>${name}</strong> — ${d.status || 'unknown'} — Started: ${start} — End: ${end} — Total: ${formatCurrency(Number(d.totalIncome || d.totalSales || 0))}</div>`;
      container.appendChild(div);
    });
  } catch (err) { console.error('Failed to load cashier shifts for', name, err); container.innerText = 'Failed to load shifts: ' + (err && err.message ? err.message : String(err)); }
}

// Cashiers: view only their own shift history here
async function loadMyShifts() {
  const container = document.getElementById('cashier-my-shifts');
  if (!container) return;
  container.innerHTML = '';

  const name = (currentEmployeeName || '').trim();
  if (!name) {
    container.innerText = 'No employee name assigned to your account';
    return;
  }

  try {
    console.log('loadMyShifts: filter cashierName==', name);
    if (!name || typeof name !== 'string' || !name.trim()) {
      container.innerText = 'No employee name assigned to your account';
      console.warn('loadMyShifts: missing employee name for current user', { currentUserRole, currentUsername, currentEmployeeName });
      return;
    }
    // avoid requiring a composite index by omitting orderBy and sorting client-side
    const q = query(collection(db, 'shifts'), where('cashierName', '==', name));
    console.log('My Shift query object (no orderBy - sorting client-side):', q);
    let qSnap;
    try {
      qSnap = await getDocs(q);
    } catch (innerErr) {
      console.error('Error fetching my shifts for', name, innerErr);
      container.innerText = 'Failed to load shifts: ' + (innerErr && innerErr.message ? innerErr.message : String(innerErr));
      return;
    }
    if (qSnap.empty) { container.innerText = 'No shifts recorded yet'; return; }

    // sort client-side by startTime desc
    const docs = qSnap.docs.map(snap => ({ id: snap.id, data: snap.data() || {} }));
    docs.sort((a, b) => {
      const ta = a.data.startTime && a.data.startTime.toDate ? a.data.startTime.toDate() : (a.data.startTime || new Date(0));
      const tb = b.data.startTime && b.data.startTime.toDate ? b.data.startTime.toDate() : (b.data.startTime || new Date(0));
      return tb - ta;
    });

    docs.forEach(item => {
      const d = item.data || {};
      const div = document.createElement('div');
      div.className = 'card';
      const start = d.startTime && d.startTime.toDate ? d.startTime.toDate().toLocaleString() : (d.startTime || '');
      const end = d.endTime && d.endTime.toDate ? d.endTime.toDate().toLocaleString() : (d.endTime ? d.endTime.toString() : '—');
      div.innerHTML = `<div><strong>${name}</strong> — ${d.status || 'unknown'} — Started: ${start} — End: ${end} — Total: ${formatCurrency(Number(d.totalIncome || d.totalSales || 0))}</div>`;
      container.appendChild(div);
    });
  } catch (err) { console.error('Failed to load my shifts for', name, err); container.innerText = 'Failed to load shifts: ' + (err && err.message ? err.message : String(err)); }

}

// Remits: Weekly Capital Summary
async function loadRemits() {
  const container = document.getElementById('remits-list');
  const capitalEl = document.getElementById('weekly-capital');
  if (!container || !capitalEl) return;
  container.innerHTML = 'Loading remits...';

  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (now.getDay() || 7) + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalCapital = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      const amount = Number(s.total || 0);
      totalCapital += amount;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += amount;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales this week';
    capitalEl.innerText = formatCurrency(totalCapital);
  } catch (err) {
    console.error('Failed to load remits', err);
    container.innerText = 'Failed to load remits';
    capitalEl.innerText = '₱0.00';
  }
}

// ========== FINANCE PAGE STATE & FUNCTIONS ==========

let financeRange = { start: null, end: null, preset: 'weekly' };

function updateFinanceRange(preset) {
  const now = new Date();
  let start = new Date(now);
  start.setHours(0, 0, 0, 0);
  let end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (preset === 'daily') {
    // start is already today 00:00
  } else if (preset === 'weekly') {
    start.setDate(now.getDate() - (now.getDay() || 7) + 1);
    end.setDate(start.getDate() + 6);
  } else if (preset === 'monthly') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (preset === 'annual') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  }

  financeRange = { start, end, preset };
  renderFinanceRange();
  loadFinancePage();
}

function renderFinanceRange() {
  const display = document.getElementById('fin-range-display');
  if (!display || !financeRange.start || !financeRange.end) return;
  const s = financeRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const e = financeRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  display.innerText = `${s} – ${e}`;

  // Update date pickers
  const startInput = document.getElementById('fin-start-date');
  const endInput = document.getElementById('fin-end-date');
  if (startInput) startInput.value = financeRange.start.toISOString().split('T')[0];
  if (endInput) endInput.value = financeRange.end.toISOString().split('T')[0];
}

// Function to initialize finance listeners (called once on load or when needed)
function initFinanceListeners() {
  document.querySelectorAll('.fin-preset').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.fin-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateFinanceRange(btn.dataset.preset);
    };
  });

  const finStartInput = document.getElementById('fin-start-date');
  const finEndInput = document.getElementById('fin-end-date');

  const onFinanceDateChange = () => {
    const sStr = finStartInput.value;
    const eStr = finEndInput.value;
    if (!sStr || !eStr) return;

    const start = new Date(sStr + 'T00:00:00');
    const end = new Date(eStr + 'T23:59:59.999');

    const warning = document.getElementById('fin-date-warning');
    if (end < start) {
      if (warning) warning.style.display = 'block';
      return;
    }
    if (warning) warning.style.display = 'none';

    financeRange = { start, end, preset: 'custom' };
    document.querySelectorAll('.fin-preset').forEach(b => b.classList.remove('active'));
    renderFinanceRange();
    loadFinancePage();
  };

  if (finStartInput) finStartInput.onchange = onFinanceDateChange;
  if (finEndInput) finEndInput.onchange = onFinanceDateChange;

  const addExpenseBtn = document.getElementById('add-expense-btn');
  if (addExpenseBtn) addExpenseBtn.onclick = addExpense;

  const resetExpensesBtn = document.getElementById('reset-expenses-btn');
  if (resetExpensesBtn) resetExpensesBtn.onclick = resetExpenses;
}

// Load all Finance page data
async function loadFinancePage() {
  if (financeRange.preset === 'weekly' && !financeRange.start) {
    updateFinanceRange('weekly'); // init
    return;
  }
  try {
    const { start, end } = financeRange;
    const queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];

    await Promise.all([
      loadFinanceIncome(queryRange),
      loadFinanceRemits(queryRange),
      loadFinanceProfits(queryRange),
      loadFinanceExpenses(queryRange)
    ]);
    updateNetIncome();
  } catch (err) {
    console.error('Failed to load finance page', err);
  }
}

// Income Section
async function loadFinanceIncome(queryRange) {
  const totalEl = document.getElementById('fin-total-income');
  if (!totalEl) return;

  try {
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalIncome = 0;
    qSnap.forEach(docSnap => { totalIncome += Number(docSnap.data().total || 0); });
    totalEl.innerText = formatCurrency(totalIncome);
  } catch (err) {
    console.error('Failed to load finance income', err);
    totalEl.innerText = '₱0.00';
  }
}

// Remits Section
async function loadFinanceRemits(queryRange) {
  const container = document.getElementById('finance-remits-list');
  const capitalEl = document.getElementById('finance-total-capital');
  if (!container || !capitalEl) return;
  container.innerHTML = 'Loading remits...';

  try {
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalCapital = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      const amount = Number(s.total || 0);
      totalCapital += amount;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += amount;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales in this range';
    capitalEl.innerText = formatCurrency(totalCapital);
  } catch (err) {
    console.error('Failed to load finance remits', err);
    container.innerText = 'Failed to load remits';
    capitalEl.innerText = '₱0.00';
  }
}

// Profits Section
async function loadFinanceProfits(queryRange) {
  const container = document.getElementById('finance-profits-list');
  const profitEl = document.getElementById('finance-total-profit');
  if (!container || !profitEl) return;
  container.innerHTML = 'Loading profits...';

  try {
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalProfit = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      let saleProfit = 0;

      (s.items || []).forEach(it => {
        const product = products.find(p => p.name === it.name && p.unit === it.unit);
        if (product && product.profit != null) {
          let quantity = (it.unit && it.unit.toLowerCase() === 'kg') ? Number(it.weight || 0) : Number(it.qty || 0);
          saleProfit += Number(product.profit) * quantity;
        }
      });

      totalProfit += saleProfit;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += saleProfit;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales in this range';
    profitEl.innerText = formatCurrency(totalProfit);
  } catch (err) {
    console.error('Failed to load finance profits', err);
    container.innerText = 'Failed to load profits';
    profitEl.innerText = '₱0.00';
  }
}

// Expenses Section
async function loadFinanceExpenses(queryRange) {
  const container = document.getElementById('expenses-list');
  const totalEl = document.getElementById('weekly-expenses');
  if (!container || !totalEl) return;
  container.innerHTML = 'Loading expenses...';

  if (!queryRange) {
    const { start, end } = financeRange;
    if (start && end) {
      queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];
    } else {
      container.innerHTML = 'No date range selected';
      return;
    }
  }

  try {
    const q = query(collection(db, 'expenses'), ...queryRange, orderBy('timestamp', 'desc'));
    const snap = await getDocs(q);
    let total = 0;

    container.innerHTML = '';
    if (snap.empty) {
      container.innerHTML = '<div style="color:var(--muted);font-size:14px">No expenses in this range</div>';
    } else {
      snap.forEach(docSnap => {
        const e = docSnap.data();
        total += Number(e.amount || 0);
        const div = document.createElement('div');
        div.className = 'expense-item';
        div.innerHTML = `<span>${e.reason || 'No description'}</span><span>${formatCurrency(e.amount)}</span><button class="remove-btn" onclick="deleteExpense('${docSnap.id}')">Delete</button>`;
        container.appendChild(div);
      });
    }
    totalEl.innerText = formatCurrency(total);
  } catch (err) {
    console.error('Failed to load finance expenses', err);
    container.innerHTML = '<div style="color:var(--danger)">Failed to load expenses</div>';
    totalEl.innerText = '₱0.00';
  }
}

async function addExpense() {
  const amountInput = document.getElementById('expense-amount');
  const reasonInput = document.getElementById('expense-reason');

  const amount = Number(amountInput.value);
  const reason = reasonInput.value.trim();

  if (!amount || amount <= 0) return alert('Please enter a valid amount');
  if (!reason) return alert('Please enter a reason/description');

  try {
    await safeWrite('add', 'expenses', {
      amount: amount,
      reason: reason,
      timestamp: new Date()
    });
    amountInput.value = '';
    reasonInput.value = '';
    await loadFinanceExpenses(); // Now uses default range if none passed
    updateNetIncome();
    alert('Expense added successfully');
  } catch (err) {
    console.error('Failed to add expense', err);
    alert('Failed to add expense');
  }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  try {
    await deleteDoc(doc(db, 'expenses', id));
    await loadFinanceExpenses();
    updateNetIncome();
  } catch (err) {
    console.error('Failed to delete expense', err);
    alert('Failed to delete expense');
  }
}
window.deleteExpense = deleteExpense;

async function resetExpenses() {
  if (!confirm('Reset all expenses for the selected range? This will delete all expense entries in this span.')) return;
  try {
    const q = query(collection(db, 'expenses'), where('timestamp', '>=', financeRange.start), where('timestamp', '<=', financeRange.end));
    const snap = await getDocs(q);
    const deletePromises = [];
    snap.forEach(docSnap => deletePromises.push(safeWrite('delete', 'expenses', null, docSnap.id)));
    await Promise.all(deletePromises);
    await loadFinanceExpenses();
    updateNetIncome();
    alert('Expenses reset successfully');
  } catch (err) {
    console.error('Failed to reset expenses', err);
    alert('Failed to reset expenses');
  }
}

function updateNetIncome() {
  const incomeEl = document.getElementById('fin-total-income');
  const expensesEl = document.getElementById('weekly-expenses');
  const netIncomeEl = document.getElementById('net-income');
  if (!incomeEl || !expensesEl || !netIncomeEl) return;
  const income = parseFloat(incomeEl.innerText.replace('₱', '').replace(/,/g, '')) || 0;
  const expenses = parseFloat(expensesEl.innerText.replace('₱', '').replace(/,/g, '')) || 0;
  const netIncome = income - expenses;
  netIncomeEl.innerText = formatCurrency(netIncome);
  netIncomeEl.style.color = netIncome >= 0 ? 'var(--accent)' : 'var(--danger)';
}



function parseDateInputToRange(startStr, endStr) {
  if (!startStr && !endStr) return null;
  let start = startStr ? new Date(startStr + 'T00:00:00') : null;
  let end = endStr ? new Date(endStr + 'T23:59:59.999') : null;
  return { start, end };
}

// Return whether current user (esp. cashiers) can proceed to checkout
function canCheckout() {
  // admins may proceed as long as an open shift exists
  if (!currentUserRole) return false;
  if (currentUserRole === 'admin') {
    return !!(currentShift && currentShift.id && currentShift.status === 'open');
  }

  // cashiers must have an open shift assigned to their employee name
  if (currentUserRole === 'cashier') {
    return !!(currentShift && currentShift.id && currentShift.status === 'open' && String(currentShift.cashierName || '').trim() === String(currentEmployeeName || '').trim());
  }

  // default: require an open shift
  return !!(currentShift && currentShift.id && currentShift.status === 'open');
}

function updateCheckoutButtonState() {
  const btn = document.getElementById('checkout');
  if (!btn) return;
  if (!canCheckout()) {
    // Use visual disabled state rather than setting disabled property so click handler still runs and can show message
    btn.classList.add('disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.title = 'You must start a shift before checkout.';
    console.log('Checkout disabled: no active shift for current user', { currentUserRole, currentEmployeeName, currentShift });
  } else {
    btn.classList.remove('disabled');
    btn.removeAttribute('aria-disabled');
    btn.title = 'Proceed to checkout';
    console.log('Checkout enabled');
  }
}

async function loadSalesHistory() {
  const historyEl = document.getElementById('history-list');
  historyEl.innerHTML = '';
  const emptyEl = document.getElementById('history-empty');
  if (emptyEl) emptyEl.style.display = 'none';

  // Build query based on filters
  const clauses = [];
  let qRef = collection(db, 'sales');

  // cashier filter
  if (historyFilters.cashier && historyFilters.cashier !== 'all' && historyFilters.cashier !== 'none') {
    clauses.push(where('cashier', '==', historyFilters.cashier));
  }

  // shift filter
  if (historyFilters.shiftId && historyFilters.shiftId !== 'all' && historyFilters.shiftId !== 'none') {
    clauses.push(where('shiftId', '==', historyFilters.shiftId));
  }

  // Add date range filters if present
  if (historyFilters.startDate) {
    clauses.push(where('timestamp', '>=', new Date(historyFilters.startDate + 'T00:00:00')));
  }
  if (historyFilters.endDate) {
    clauses.push(where('timestamp', '<=', new Date(historyFilters.endDate + 'T23:59:59.999')));
  }

  let q;
  if (clauses.length === 0) {
    q = query(qRef, orderBy('timestamp', 'desc'));
  } else {
    q = query(qRef, ...clauses, orderBy('timestamp', 'desc'));
  }

  const qSnap = await getDocs(q);
  let totalIncome = 0;
  let count = 0;

  qSnap.forEach(docSnap => {
    const s = docSnap.data();
    count += 1;
    totalIncome += Number(s.total || 0);

    const li = document.createElement('li');
    li.style.padding = '8px';
    li.style.borderBottom = '1px solid #eee';
    const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
    const itemCount = (s.items || []).length;

    const leftDiv = document.createElement('div');
    leftDiv.innerHTML = `<strong>${ts.toLocaleString()}</strong><div style="color:#666">${itemCount} items — Cashier: ${s.cashier || 'Unknown'}</div>`;

    const rightDiv = document.createElement('div');
    rightDiv.style.display = 'flex';
    rightDiv.style.alignItems = 'center';
    rightDiv.style.gap = '8px';

    const totalStrong = document.createElement('strong');
    totalStrong.innerText = formatCurrency(s.total);
    rightDiv.appendChild(totalStrong);

    if (currentUserRole === 'admin') {
      const refundBtn = document.createElement('button');
      refundBtn.className = 'remove-btn';
      refundBtn.innerText = 'Refund';
      refundBtn.onclick = (event) => {
        event.stopPropagation();
        handleRefund(docSnap.id);
      };
      rightDiv.appendChild(refundBtn);
    }

    const mainDiv = document.createElement('div');
    mainDiv.style.display = 'flex';
    mainDiv.style.justifyContent = 'space-between';
    mainDiv.style.alignItems = 'center';
    mainDiv.appendChild(leftDiv);
    mainDiv.appendChild(rightDiv);

    li.appendChild(mainDiv);
    li.onclick = () => openSavedReceiptModal(s);
    historyEl.appendChild(li);
  });

  document.getElementById('filtered-count').innerText = count;
  document.getElementById('filtered-income').innerText = formatCurrency(totalIncome);

  if (qSnap.empty) {
    if (emptyEl) emptyEl.style.display = '';
  }
}

function openSavedReceiptModal(sale) {
  openReceiptModal(sale);
}

async function handleRefund(saleId) {
  if (!confirm('Refund this receipt? Items will be returned to stock.')) return;

  try {
    const saleRef = doc(db, 'sales', saleId);
    const saleSnap = await getDoc(saleRef);

    if (!saleSnap.exists()) {
      alert('Sale record not found.');
      return;
    }

    const saleData = saleSnap.data();
    const items = saleData.items || [];

    // Use a batch for atomic updates
    const batch = writeBatch(db);

    // 1. Prepare stock restoration
    // We need to fetch current product data to be sure we have the latest stock, 
    // but the app already maintains a 'products' array. 
    // However, for consistency and safety, we should fetch fresh or use transaction.
    // Given the 'safeWrite' pattern, a batch is better if online.

    for (const item of items) {
      // Find product by name and unit (as done in sale logic)
      const product = products.find(p => p.name === item.name && p.unit === item.unit);
      if (product) {
        let restoreAmount = 0;
        if (item.unit && item.unit.toLowerCase() === 'kg') {
          restoreAmount = Number(item.weight || 0);
        } else {
          restoreAmount = Number(item.qty || 0);
        }

        const productRef = doc(db, 'products', product.id);
        // Note: We use the locally cached product.stock for the base, 
        // but it's safer to use the database value.
        // For simplicity and matching existing patterns:
        const newStock = Number((Number(product.stock || 0) + restoreAmount).toFixed(2));
        batch.update(productRef, { stock: newStock });
        product.stock = newStock; // Update local cache
      }
    }

    // 2. Prepare shift total update if possible
    if (saleData.shiftId) {
      const shiftRef = doc(db, 'shifts', saleData.shiftId);
      const shiftSnap = await getDoc(shiftRef);
      if (shiftSnap.exists()) {
        const shiftData = shiftSnap.data();
        const currentTotal = Number(shiftData.totalIncome || shiftData.totalSales || 0);
        const newShiftTotal = Number((currentTotal - Number(saleData.total || 0)).toFixed(2));
        batch.update(shiftRef, { totalIncome: newShiftTotal });
        if (currentShift && currentShift.id === saleData.shiftId) {
          currentShift.totalIncome = newShiftTotal;
        }
      }
    }

    // 3. Delete the sale record
    batch.delete(saleRef);

    // Commit the batch
    await batch.commit();

    alert('Refund processed successfully. Stocks restored.');

    // Refresh history and summary
    loadSalesHistory();
    loadSalesSummary();
    updateShiftUI();
    loadProducts(); // Fresh fetch of products
  } catch (err) {
    console.error('Refund failed', err);
    alert('Failed to process refund. Check console for details.');
  }
}

// Make handleRefund available globally
window.handleRefund = handleRefund;

// products editor
let productsEditMode = false;

async function renderProductsEditor() {
  const container = document.getElementById('products-edit-list');
  container.innerHTML = '';
  const qSnap = await getDocs(collection(db, 'products'));

  // Filter by search
  let filtered = products; // use local Products array or fetch fresh?
  // Use fresh fetch for editor to be safe, but we can filter the SNAPSHOT data
  const editorProducts = [];
  qSnap.forEach(docSnap => editorProducts.push({ id: docSnap.id, ...docSnap.data() }));

  const qSearch = cleanStr(searchState.stocks);
  if (qSearch) {
    // filter by name or category
    const matches = editorProducts.filter(p =>
      cleanStr(p.name).includes(qSearch) ||
      cleanStr(p.category).includes(qSearch)
    );
    // Reuse rendering logic for filtered items
    renderEditorGroups(container, matches);
  } else {
    renderEditorGroups(container, editorProducts);
  }
}

function renderEditorGroups(container, productList) {
  // group by category
  const byCat = {};
  productList.forEach(p => {
    const cat = (p.category || 'Uncategorized');
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(p);
  });

  // render categories
  // Use known categories order, plus any uncategorized or others found
  const knownNames = categories.map(c => c.name);
  const foundNames = Object.keys(byCat);
  const allNames = Array.from(new Set([...knownNames, ...foundNames])).sort();

  allNames.forEach(cat => {
    if (!byCat[cat] || byCat[cat].length === 0) return;

    const catHeader = document.createElement('div');
    catHeader.className = 'category-header';
    catHeader.innerText = cat;
    container.appendChild(catHeader);

    const list = document.createElement('div');
    list.className = 'category-list'; // Grid layout now

    byCat[cat].forEach(p => {
      const id = p.id;
      const row = document.createElement('div');
      row.className = 'product-edit-card'; // New card class

      // Top: Name + Unit + Delete Checkbox
      const headerDiv = document.createElement('div');
      headerDiv.style.display = 'flex';
      headerDiv.style.justifyContent = 'space-between';
      headerDiv.style.alignItems = 'start';

      const titleDiv = document.createElement('div');
      titleDiv.innerHTML = productsEditMode
        ? `<input type="text" class="edit-name" value="${p.name}" style="font-weight:bold; width:100%; margin-bottom:4px;" />`
        : `<h4>${p.name}</h4>`;
      titleDiv.innerHTML += `<span style="font-size:13px;color:var(--muted)">${p.unit}</span>`;

      headerDiv.appendChild(titleDiv);

      if (productsEditMode) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.id = id;
        cb.style.transform = 'scale(1.2)';
        headerDiv.appendChild(cb);
      }

      row.appendChild(headerDiv);

      if (productsEditMode) {
        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'product-edit-inputs';

        // Build Category Select
        let catOptions = `<option value="">No Category</option>`;
        categories.forEach(c => {
          catOptions += `<option value="${c.name}" ${p.category === c.name ? 'selected' : ''}>${c.name}</option>`;
        });

        inputsDiv.innerHTML = `
          <div style="grid-column: span 2;"><label>Category</label>
            <select class="edit-category" style="width:100%">${catOptions}</select>
          </div>
          <div><label>Price</label><input type="number" class="edit-price" step="0.01" value="${Number(p.price).toFixed(2)}" /></div>
          <div><label>Capital</label><input type="number" class="edit-capital" step="0.01" value="${Number(p.capital || 0).toFixed(2)}" /></div>
          <div><label>Stock</label><input type="number" class="edit-stock" step="0.01" min="0" value="${Number(p.stock || 0).toFixed(2)}" /></div>
        `;

        row.appendChild(inputsDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'product-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'checkout-btn';
        saveBtn.style.padding = '6px 12px';
        saveBtn.style.fontSize = '12px';
        saveBtn.innerHTML = `Save`;
        saveBtn.onclick = async () => {
          const nameIn = row.querySelector('.edit-name');
          const priceIn = row.querySelector('.edit-price');
          const stockIn = row.querySelector('.edit-stock');
          const capitalIn = row.querySelector('.edit-capital');
          const categoryIn = row.querySelector('.edit-category');

          const newName = nameIn.value.trim();
          const newPrice = Number(priceIn.value);
          const newStock = Number(stockIn.value);
          const newCapital = Number(capitalIn.value);
          const newCategory = categoryIn.value;

          if (!newName) return alert('Product Name cannot be empty');
          if (isNaN(newPrice) || newPrice <= 0) return alert('Invalid Price');
          if (isNaN(newStock) || newStock < 0) return alert('Invalid Stock');
          if (isNaN(newCapital) || newCapital < 0) return alert('Invalid Capital');

          const newProfit = Number((newPrice - newCapital).toFixed(2));

          try {
            await updateDoc(doc(db, 'products', id), {
              name: newName,
              price: newPrice,
              stock: newStock,
              capital: newCapital,
              profit: newProfit,
              category: newCategory
            });
            playSfx('success');

            // Visual feedback
            row.style.background = 'rgba(46, 204, 113, 0.2)';
            setTimeout(() => { row.style.background = ''; }, 1000);

            // refresh
            renderProductsEditor();
            loadProducts(); // sync other views
          } catch (err) {
            console.error(err); alert('Update failed');
          }
        };
        actionsDiv.appendChild(saveBtn);
        row.appendChild(actionsDiv);
      } else {
        // View Only
        const infoDiv = document.createElement('div');
        infoDiv.className = 'product-info';
        infoDiv.innerHTML = `
          <div>Category: <strong>${p.category || 'None'}</strong></div>
          <div>Price: <strong>${formatCurrency(p.price)}</strong></div>
          <div>Capital: <strong>${formatCurrency(p.capital || 0)}</strong></div>
          <div>Stock: <strong>${Number(p.stock || 0).toFixed(2)}</strong></div>
        `;
        row.appendChild(infoDiv);
      }

      list.appendChild(row);
    });

    container.appendChild(list);
  });

  // show/hide delete button
  const delBtn = document.getElementById('delete-selected');
  if (delBtn) delBtn.style.display = productsEditMode ? '' : 'none';
}

// Employees management
async function loadEmployees() {
  const container = document.getElementById('admin-employees-list');
  if (!container) return;
  container.innerHTML = '';
  try {
    const qSnap = await getDocs(collection(db, 'employees'));
    if (qSnap.empty) {
      container.innerText = 'No employees yet';
      return;
    }
    qSnap.forEach(docSnap => {
      const d = docSnap.data() || {};
      const row = document.createElement('div');
      row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.marginBottom = '6px';
      const nameEl = document.createElement('strong'); nameEl.innerText = d.name || 'Unnamed';
      const roleEl = document.createElement('span'); roleEl.style.color = 'var(--muted)'; roleEl.style.marginLeft = '8px'; roleEl.innerText = d.role || '';
      const usernameEl = document.createElement('span'); usernameEl.style.color = 'var(--muted)'; usernameEl.style.marginLeft = '8px'; usernameEl.innerText = d.username ? `(${d.username})` : '';
      const removeBtn = document.createElement('button'); removeBtn.className = 'remove-btn'; removeBtn.style.marginLeft = 'auto'; removeBtn.innerHTML = `<span class=\"btn-icon\">🗑️</span><span class=\"btn-text\">Remove</span>`;
      removeBtn.onclick = async () => {
        if (!confirm('Delete employee "' + (d.name || '') + '"?')) return;
        try { await safeWrite('delete', 'employees', null, docSnap.id); loadEmployees(); } catch (err) { console.error('Failed to delete employee', err); alert('Failed to delete. See console.'); }
      };
      row.appendChild(nameEl); row.appendChild(usernameEl); row.appendChild(roleEl); row.appendChild(removeBtn);
      container.appendChild(row);
    });
  } catch (err) { console.error('Failed to load employees', err); container.innerText = 'Failed to load employees'; }
}

async function addEmployeeRecord(name, role) {
  if (!name || !name.trim()) throw new Error('Employee name required');
  const r = (role || 'cashier').trim().toLowerCase();
  if (r !== 'admin' && r !== 'cashier') throw new Error('Role must be admin or cashier');
  // check duplicate
  const q = query(collection(db, 'employees'), where('name', '==', name.trim()));
  const qSnap = await getDocs(q);
  if (!qSnap.empty) throw new Error('duplicate');
  await safeWrite('add', 'employees', { name: name.trim(), role: r, active: true });
}

// Backwards compatible prompt flow
async function addEmployee() {
  try {
    const name = prompt('Enter employee name (required)');
    if (!name || !name.trim()) return alert('Employee name required');
    const roleInput = prompt("Role ('admin' or 'cashier')", 'cashier') || 'cashier';
    await addEmployeeRecord(name, roleInput);
    alert('Employee added');
    loadEmployees();
    if (typeof loadCashiersList === 'function') loadCashiersList();
  } catch (err) {
    if (err.message === 'duplicate') return alert('Employee with that name already exists');
    console.error('Failed to add employee', err); alert('Failed to add employee. See console.');
  }
}

function openEmployeeModal() {
  const modal = document.getElementById('add-employee-modal');
  if (!modal) return;
  document.getElementById('new-employee-fullname').value = '';
  document.getElementById('new-employee-username').value = '';
  document.getElementById('new-employee-password').value = '';
  document.getElementById('new-employee-role').value = 'cashier';
  modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false');
}

function closeEmployeeModal() {
  const modal = document.getElementById('add-employee-modal');
  if (!modal) return;
  modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true');
}

// wire modal buttons
const addEmployeeCancel = document.getElementById('add-employee-cancel');
if (addEmployeeCancel) addEmployeeCancel.onclick = () => closeEmployeeModal();
const addEmployeeSave = document.getElementById('add-employee-save');
if (addEmployeeSave) addEmployeeSave.onclick = async () => {
  const fullname = document.getElementById('new-employee-fullname').value?.trim();
  const username = document.getElementById('new-employee-username').value?.trim();
  const password = document.getElementById('new-employee-password').value || '';
  const role = document.getElementById('new-employee-role').value;

  if (!fullname || !username || !password || !role) return alert('Please fill all fields');

  try {
    // check username uniqueness in users collection
    const userQ = query(collection(db, 'users'), where('username', '==', username));
    const userSnap = await getDocs(userQ);
    if (!userSnap.empty) return alert('Username already exists');

    // create users doc
    await safeWrite('add', 'users', { username: username, password: password, role: role, employeeName: fullname, active: true });

    // upsert employee record (by username)
    const empQ = query(collection(db, 'employees'), where('username', '==', username));
    const empSnap = await getDocs(empQ);
    if (!empSnap.empty) {
      const empId = empSnap.docs[0].id;
      await safeWrite('update', 'employees', { name: fullname, role: role, username: username, active: true }, empId);
    } else {
      await safeWrite('add', 'employees', { name: fullname, role: role, username: username, active: true });
    }

    alert('Employee & user added');
    closeEmployeeModal();
    loadEmployees();
    if (typeof loadCashiersList === 'function') loadCashiersList();
  } catch (err) {
    console.error('Failed to add employee/user', err);
    alert('Failed to add employee/user. See console.');
  }
};

// modal helper functions
function openWeightModal(product, editIndex = null, existingWeight = null) {
  modalProduct = product;
  modalEditIndex = (typeof editIndex === 'number') ? editIndex : null;
  isLendingModal = false;
  document.getElementById('modal-product-name').innerText = product.name;
  document.getElementById('modal-price').innerText = Number(product.price).toFixed(2);

  const w = document.getElementById('modal-weight');
  const a = document.getElementById('modal-amount');

  if (existingWeight != null) {
    w.value = Number(existingWeight).toFixed(2);
    a.value = Number((existingWeight * product.price).toFixed(2));
  } else {
    w.value = '';
    a.value = '';
  }

  document.getElementById('weight-modal').classList.remove('hidden');
  document.getElementById('weight-modal').setAttribute('aria-hidden', 'false');
}

function closeWeightModal() {
  const modal = document.getElementById('weight-modal');
  // Blur any focused element inside the modal to fix accessibility warning
  if (document.activeElement && modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  modalProduct = null;
  modalEditIndex = null;
}

// sync inputs
const modalWeightInput = document.getElementById('modal-weight');
const modalAmountInput = document.getElementById('modal-amount');

if (modalWeightInput && modalAmountInput) {
  modalWeightInput.oninput = () => {
    const w = Number(modalWeightInput.value);
    if (!modalProduct) return;
    if (!isNaN(w) && w > 0) {
      modalAmountInput.value = Number((w * modalProduct.price).toFixed(2));
    } else {
      modalAmountInput.value = '';
    }
  };

  modalAmountInput.oninput = () => {
    const a = Number(modalAmountInput.value);
    if (!modalProduct) return;
    if (!isNaN(a) && a > 0) {
      modalWeightInput.value = Number((a / modalProduct.price).toFixed(2));
    } else {
      modalWeightInput.value = '';
    }
  };
}

// modal buttons
const weightModalClose = document.getElementById('weight-modal-close');
const modalAdd = document.getElementById('modal-add');

if (weightModalClose) weightModalClose.onclick = () => closeWeightModal();

if (modalAdd) modalAdd.onclick = () => {
  if (!modalProduct) return closeWeightModal();

  const wVal = Number(document.getElementById('modal-weight').value);
  const aVal = Number(document.getElementById('modal-amount').value);

  // validation: if both empty do nothing
  if ((!wVal || wVal <= 0) && (!aVal || aVal <= 0)) {
    closeWeightModal();
    return;
  }

  // prefer weight if provided
  let weight = null;
  let total = 0;
  if (wVal && wVal > 0) {
    weight = wVal;
    total = Number((weight * modalProduct.price).toFixed(2));
  } else {
    // compute from amount
    weight = Number((aVal / modalProduct.price).toFixed(3));
    total = Number(aVal.toFixed(2));
  }

  if (isLendingModal) {
    // Handle lending cart
    if (modalEditIndex !== null) {
      // replace existing kg line
      const item = lendingCart[modalEditIndex];
      if (item && item.unit.toLowerCase() === 'kg') {
        item.weight = weight;
        item.total = total;
      }
    } else {
      // add or accumulate
      let existing = lendingCart.find(item => item.name === modalProduct.name && item.unit && item.unit.toLowerCase() === 'kg');
      if (existing) {
        existing.weight = Number((existing.weight + weight).toFixed(3));
        existing.total = Number((existing.weight * existing.price).toFixed(2));
      } else {
        lendingCart.push({
          name: modalProduct.name,
          price: Number(modalProduct.price),
          unit: 'Kg',
          weight: Number(weight.toFixed(3)),
          total: Number(total.toFixed(2))
        });
      }
    }
    playSfx('add');
    renderLendingCart();
  } else {
    // Handle sales cart
    if (modalEditIndex !== null) {
      // replace existing kg line
      const item = cart[modalEditIndex];
      if (item && item.unit.toLowerCase() === 'kg') {
        item.weight = weight;
        item.total = total;
      }
    } else {
      // add or accumulate
      let existing = cart.find(item => item.name === modalProduct.name && item.unit && item.unit.toLowerCase() === 'kg');
      if (existing) {
        existing.weight = Number((existing.weight + weight).toFixed(3));
        existing.total = Number((existing.weight * existing.price).toFixed(2));
      } else {
        cart.push({
          name: modalProduct.name,
          price: Number(modalProduct.price),
          unit: 'Kg',
          weight: Number(weight.toFixed(3)),
          total: Number(total.toFixed(2))
        });
      }
    }
    playSfx('add');
    renderCart();
  }
  closeWeightModal();
};

// ---------- Lending weight modal buttons ----------
const lendingModalAdd = document.getElementById('lending-modal-add');
const lendingWeightModalClose = document.getElementById('lending-weight-modal-close');

if (lendingWeightModalClose) lendingWeightModalClose.onclick = () => {
  document.getElementById('lending-weight-modal').classList.add('hidden');
  document.getElementById('lending-weight-modal').setAttribute('aria-hidden', 'true');
  modalProduct = null;
  modalEditIndex = null;
};

// Add to lending cart from lending modal
if (lendingModalAdd) lendingModalAdd.onclick = () => {

  if (!modalProduct) return;

  const wVal = Number(document.getElementById('lending-modal-weight').value);
  const aVal = Number(document.getElementById('lending-modal-amount').value);

  if ((!wVal || wVal <= 0) && (!aVal || aVal <= 0)) return;

  let weight = null;
  let total = 0;

  // prefer weight entry
  if (wVal && wVal > 0) {
    weight = wVal;
    total = Number((weight * modalProduct.price).toFixed(2));
  } else {
    // derive from amount
    weight = Number((aVal / modalProduct.price).toFixed(3));
    total = Number(aVal.toFixed(2));
  }

  // update existing entry or add new one
  let existing = lendingCart.find(
    i => i.name === modalProduct.name && i.unit.toLowerCase() === 'kg'
  );

  if (existing) {
    existing.weight = Number((existing.weight + weight).toFixed(3));
    existing.total = Number((existing.weight * existing.price).toFixed(2));
  } else {
    lendingCart.push({
      name: modalProduct.name,
      price: Number(modalProduct.price),
      unit: 'Kg',
      weight: Number(weight.toFixed(3)),
      total: Number(total.toFixed(2))
    });
  }

  playSfx('add');
  renderLendingCart();

  // close modal
  document.getElementById('lending-weight-modal').classList.add('hidden');
  document.getElementById('lending-weight-modal').setAttribute('aria-hidden', 'true');
  modalProduct = null;
  modalEditIndex = null;
};

// Clear cart button handler
const clearBtn = document.getElementById('clear-cart');
if (clearBtn) clearBtn.onclick = clearCart;

// Theme toggle
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.classList.add('dark-theme');
  else document.documentElement.classList.remove('dark-theme');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerText = theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) applyTheme(saved);
  else {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }

  const btn = document.getElementById('theme-toggle');
  if (btn) btn.onclick = () => {
    const isDark = document.documentElement.classList.contains('dark-theme');
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
  };
}

initTheme();
loadSoundSettings();

// Wire sound toggle button
const soundBtn = document.getElementById('sound-toggle');
if (soundBtn) soundBtn.onclick = toggleSound;

// admin actions
const exportBtn = document.getElementById('export-sales');
if (exportBtn) exportBtn.onclick = async () => {
  const qSnap = await getDocs(collection(db, 'sales'));
  const rows = [];
  qSnap.forEach(snap => {
    const s = snap.data();
    (s.items || []).forEach(it => {
      rows.push({ timestamp: s.timestamp, date: s.timestamp && s.timestamp.toDate ? s.timestamp.toDate().toLocaleString() : new Date(s.timestamp).toLocaleString(), name: it.name, unit: it.unit, qty: it.qty || '', weight: it.weight || '', lineTotal: it.lineTotal });
    });
  });
  // CSV
  const header = ['Date', 'Name', 'Unit', 'Qty', 'Weight', 'LineTotal'];
  const csv = [header.join(',')].concat(rows.map(r => [r.date, r.name, r.unit, r.qty, r.weight, (r.lineTotal || '').toFixed ? r.lineTotal.toFixed(2) : r.lineTotal].join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sales_export_${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};

const clearSalesBtn = document.getElementById('clear-sales');
if (clearSalesBtn) clearSalesBtn.onclick = async () => {
  const confirmText = prompt("Type DELETE to confirm clearing all sales");
  if (confirmText !== 'DELETE') return alert('Delete cancelled');
  const qSnap = await getDocs(collection(db, 'sales'));
  for (const s of qSnap.docs) {
    await deleteDoc(doc(db, 'sales', s.id));
  }
  alert('All sales cleared');
  loadSalesSummary();
  loadSalesHistory();
};

// Add product modal handlers
const addProductBtn = document.getElementById('add-product-btn');
const addProductModal = document.getElementById('add-product-modal');
const addProductCancel = document.getElementById('add-product-cancel');
const addProductSave = document.getElementById('add-product-save');

if (addProductBtn) addProductBtn.onclick = () => {
  document.getElementById('new-product-name').value = '';
  document.getElementById('new-product-unit').value = 'pcs';
  document.getElementById('new-product-category').value = '';
  document.getElementById('new-product-price').value = '';
  document.getElementById('new-product-capital').value = '';
  document.getElementById('new-product-profit').value = '';
  document.getElementById('new-product-stock').value = '';
  addProductModal.classList.remove('hidden');
  addProductModal.setAttribute('aria-hidden', 'false');
};
if (addProductCancel) addProductCancel.onclick = () => {
  addProductModal.classList.add('hidden');
  addProductModal.setAttribute('aria-hidden', 'true');
};

if (addProductSave) addProductSave.onclick = async () => {
  const name = document.getElementById('new-product-name').value.trim();
  const unit = document.getElementById('new-product-unit').value;
  const category = document.getElementById('new-product-category').value.trim();
  const price = Number(document.getElementById('new-product-price').value);
  const capital = Number(document.getElementById('new-product-capital').value) || 0;
  const profit = Number(document.getElementById('new-product-profit').value) || 0;
  if (!name || isNaN(price) || price <= 0) {
    return alert('Provide valid name and numeric price');
  }
  try {
    await safeWrite('add', 'products', { name, unit, category, price, capital, profit });
    addProductModal.classList.add('hidden');
    addProductModal.setAttribute('aria-hidden', 'true');
    loadProducts();
    renderProductsEditor();
    alert('Product added');
  } catch (err) {
    console.error('Add product failed', err);
    alert('Failed to add product');
  }
};

// toggle edit products
const toggleEditBtn = document.getElementById('toggle-edit-products');
if (toggleEditBtn) toggleEditBtn.onclick = () => {
  productsEditMode = !productsEditMode;
  toggleEditBtn.classList.toggle('active', productsEditMode);
  toggleEditBtn.innerText = productsEditMode ? 'Done Editing' : 'Edit Stocks';
  // Use checkout-btn style for Done state
  if (productsEditMode) {
    toggleEditBtn.classList.remove('remove-btn');
    toggleEditBtn.classList.add('checkout-btn');
  } else {
    toggleEditBtn.classList.add('remove-btn');
    toggleEditBtn.classList.remove('checkout-btn');
  }
  renderProductsEditor();
};

// Wire Search Inputs
document.getElementById('product-search').oninput = (e) => {
  searchState.sales = e.target.value;
  renderProducts();
};

document.getElementById('lending-product-search').oninput = (e) => {
  searchState.lending = e.target.value;
  renderLendingProducts();
};

document.getElementById('stock-search').oninput = (e) => {
  searchState.stocks = e.target.value;
  renderProductsEditor();
};

// Wire Category Management
const addCatBtn = document.getElementById('add-category-btn');
if (addCatBtn) addCatBtn.onclick = () => {
  const inp = document.getElementById('new-category-name');
  if (inp && inp.value.trim()) {
    addCategory(inp.value.trim());
    inp.value = '';
  }
};

// Initialize
loadCategories();



// delete selected
const deleteSelectedBtn = document.getElementById('delete-selected');
if (deleteSelectedBtn) deleteSelectedBtn.onclick = async () => {
  const container = document.getElementById('products-edit-list');
  const checks = container.querySelectorAll('input[type="checkbox"]:checked');
  const ids = Array.from(checks).map(c => c.dataset.id).filter(Boolean);
  if (ids.length === 0) return alert('No products selected');
  const confirmText = prompt('Type DELETE to confirm removing selected products');
  if (confirmText !== 'DELETE') return alert('Delete cancelled');
  for (const id of ids) {
    try { await safeWrite('delete', 'products', null, id); } catch (e) { console.error('Delete failed', e); }
  }
  alert('Selected products removed');
  productsEditMode = false;
  toggleEditBtn.innerHTML = `<span class=\"btn-icon\">✏️</span><span class=\"btn-text\">Edit Products</span>`;
  renderProductsEditor();
  loadProducts();
};

// Ensure login hides UI until session resolved (session restore will run on startup)

// Load products on start
loadProducts();

// initialize shift state
initShift();

// Note: Start/End shift buttons are wired later to avoid duplicate declarations

// ROLE / LOGIN state

function updateNavAccess() {
  // hide or show nav buttons based on role
  document.querySelectorAll('.nav-btn').forEach(b => {
    const txt = b.innerText.trim();
    if (currentUserRole === 'cashier') {
      // Cashiers should NOT see admin-only pages
      if (txt === 'Stocks' || txt === 'Products' || txt === 'Admin' || txt === 'Remits' || txt === 'Profits' || txt === 'Finance' || txt === 'Lending') b.style.display = 'none';
      else b.style.display = 'inline-block';
    } else if (currentUserRole === 'admin') {
      // Admins should NOT see the Cashier nav, and should NOT see old Remits/Profits (use Finance instead)
      if (txt === 'Cashier' || txt === 'Remits' || txt === 'Profits') b.style.display = 'none';
      else b.style.display = 'inline-block';
    } else {
      // other roles see all navs
      b.style.display = 'inline-block';
    }
  });

  // If the Cashier page is visible but the role cannot access it, redirect to Sales
  const cashierPageEl = document.getElementById('cashierPage');
  if (cashierPageEl && cashierPageEl.style.display !== 'none' && !isPageAllowedForRole('cashierPage')) {
    showPage('salesPage');
  }

  // Show/hide employee management depending on role (admin-only)
  const empListEl = document.getElementById('admin-employees-list');
  const empCard = empListEl ? empListEl.parentElement : null;
  if (empCard) {
    empCard.style.display = (currentUserRole === 'admin') ? '' : 'none';
  }
}

function showLogin() {
  const login = document.getElementById('loginPage');
  if (login) { login.classList.remove('hidden'); login.style.display = 'flex'; }
  const container = document.querySelector('.container');
  if (container) container.style.display = 'none';
  const nav = document.getElementById('nav-links');
  if (nav) nav.style.display = 'none';
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.style.display = 'none';

  // disable checkout while on login
  updateCheckoutButtonState();
}

function hideLogin() {
  const login = document.getElementById('loginPage');
  if (login) { login.classList.add('hidden'); login.style.display = 'none'; }
  const container = document.querySelector('.container');
  if (container) container.style.display = 'block';
  const nav = document.getElementById('nav-links');
  if (nav) nav.style.display = 'flex';
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.style.display = 'inline-block';
}

// Session persistence (remember me) - now saves role, username and employeeName
function saveSession() {
  try {
    const data = { role: currentUserRole, username: currentUsername, employeeName: currentEmployeeName, ts: Date.now() };
    localStorage.setItem('pos_session', JSON.stringify(data));
  } catch (e) { console.warn('Failed to save session', e); }
}
function clearSession() { try { localStorage.removeItem('pos_session'); } catch (e) { } }
function tryRestoreSession() {
  try {
    const s = localStorage.getItem('pos_session');
    if (!s) { showLogin(); return false; }
    const obj = JSON.parse(s);
    if (obj && obj.role) {
      currentUserRole = obj.role;
      currentUsername = obj.username || null;
      currentEmployeeName = obj.employeeName || null;
      updateNavAccess();
      hideLogin();
      showPage('salesPage');
      // ensure checkout button correctly reflects restored session
      updateCheckoutButtonState();
      return true;
    }
  } catch (err) { console.warn('Failed to restore session', err); }
  showLogin();
  return false;
}

// clear session on logout
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.onclick = () => { currentUserRole = null; currentUsername = null; currentEmployeeName = null; updateNavAccess(); clearSession(); showLogin(); };

const loginBtn = document.getElementById('login-btn');
if (loginBtn) loginBtn.onclick = async () => {
  const username = document.getElementById('login-username')?.value.trim();
  const pwd = document.getElementById('login-password')?.value.trim();
  if (!username) return alert('Enter username');
  if (!pwd) return alert('Enter password');
  try {
    const q = query(collection(db, 'users'), where('username', '==', username), limit(1));
    const qSnap = await getDocs(q);
    if (!qSnap.empty) {
      const d = qSnap.docs[0];
      const u = d.data() || {};
      if ((u.password || '') !== pwd) {
        return alert('Invalid password');
      }
      currentUserRole = u.role || 'cashier';
      currentUsername = u.username || username;
      currentEmployeeName = u.employeeName || u.username || username;
      updateNavAccess();
      // ensure UI switches to app view
      hideLogin();
      const container = document.querySelector('.container'); if (container) container.style.display = 'block';
      const nav = document.getElementById('nav-links'); if (nav) nav.style.display = 'flex';
      const logoutBtn = document.getElementById('logout-btn'); if (logoutBtn) logoutBtn.style.display = 'inline-block';
      // clear the password input
      const usrEl = document.getElementById('login-username'); if (usrEl) usrEl.value = '';
      const pwdEl = document.getElementById('login-password'); if (pwdEl) pwdEl.value = '';

      showPage('salesPage');

      const remember = document.getElementById('remember-me')?.checked;
      if (remember) saveSession();
    } else {
      alert('Invalid username');
    }
  } catch (err) {
    console.error('Login failed', err);
    alert('Login failed. See console.');
  }
};

// Add Enter key support for login
const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');

if (usernameInput) {
  usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginBtn.click();
    }
  });
}

if (passwordInput) {
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginBtn.click();
    }
  });
}

/* logout handler moved earlier to include session clear */

// try restore any remembered session, otherwise show login
tryRestoreSession();

// --- History filters wiring ---
const startDateInput = document.getElementById('filter-start-date');
const endDateInput = document.getElementById('filter-end-date');
const quickToday = document.getElementById('quick-today');
const quickWeek = document.getElementById('quick-week');
const quickMonth = document.getElementById('quick-month');
const shiftFilter = document.getElementById('shift-filter');
const exportHistoryBtn = document.getElementById('export-history-csv');

if (startDateInput) startDateInput.onchange = () => { historyFilters.startDate = startDateInput.value || null; loadSalesHistory(); };
if (endDateInput) endDateInput.onchange = () => { historyFilters.endDate = endDateInput.value || null; loadSalesHistory(); };

if (quickToday) quickToday.onclick = () => {
  const today = new Date();
  const d = today.toISOString().slice(0, 10);
  if (startDateInput) startDateInput.value = d;
  if (endDateInput) endDateInput.value = d;
  historyFilters.startDate = d; historyFilters.endDate = d; loadSalesHistory();
};
if (quickWeek) quickWeek.onclick = () => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - (now.getDay() || 7) + 1); // Monday as start
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  if (startDateInput) startDateInput.value = s; if (endDateInput) endDateInput.value = e;
  historyFilters.startDate = s; historyFilters.endDate = e; loadSalesHistory();
};
if (quickMonth) quickMonth.onclick = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  if (startDateInput) startDateInput.value = s; if (endDateInput) endDateInput.value = e;
  historyFilters.startDate = s; historyFilters.endDate = e; loadSalesHistory();
};

if (shiftFilter) shiftFilter.onchange = () => { historyFilters.shiftId = shiftFilter.value; loadSalesHistory(); };

if (exportHistoryBtn) exportHistoryBtn.onclick = async () => {
  // fetch the same filtered sales as loadSalesHistory but export per line item
  const range = parseDateInputToRange(historyFilters.startDate, historyFilters.endDate);
  const clauses = [];
  if (historyFilters.shiftId && historyFilters.shiftId !== 'all' && historyFilters.shiftId !== 'none') clauses.push(where('shiftId', '==', historyFilters.shiftId));
  if (range && range.start) clauses.push(where('timestamp', '>=', range.start));
  if (range && range.end) clauses.push(where('timestamp', '<=', range.end));
  if (currentUserRole === 'cashier' && (!historyFilters.shiftId || historyFilters.shiftId === 'all')) {
    if (currentShift && currentShift.id) clauses.push(where('shiftId', '==', currentShift.id));
  }
  let qRef = collection(db, 'sales');
  const q = clauses.length === 0 ? query(qRef, orderBy('timestamp', 'desc')) : query(qRef, ...clauses, orderBy('timestamp', 'desc'));
  const qSnap = await getDocs(q);
  const rows = [];
  qSnap.forEach(snap => {
    const s = snap.data() || {};
    const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate().toISOString() : (s.timestamp || new Date()).toString();
    (s.items || []).forEach(it => {
      const qtyOrWeight = (it.unit && it.unit.toLowerCase() === 'kg') ? (it.weight || '') : (it.qty || '');
      rows.push({ timestamp: ts, shiftId: s.shiftId || '', saleTotal: Number(s.total || 0).toFixed(2), saleDiscount: Number(s.discount || 0).toFixed(2), itemName: it.name || '', unit: it.unit || '', quantityOrWeight: qtyOrWeight, pricePerUnit: (it.price || '').toFixed ? (it.price || '').toFixed(2) : it.price, lineTotal: (it.lineTotal || '').toFixed ? (it.lineTotal || '').toFixed(2) : it.lineTotal });
    });
  });

  // build CSV
  const header = ['timestamp', 'shiftId', 'saleTotal', 'saleDiscount', 'itemName', 'unit', 'quantityOrWeight', 'pricePerUnit', 'lineTotal'];
  const csvRows = [header.join(',')].concat(rows.map(r => [r.timestamp, r.shiftId, r.saleTotal, r.itemName, r.unit, r.quantityOrWeight, r.pricePerUnit, r.lineTotal].map(v => typeof v === 'string' ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')));
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `history_export_${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};

// ensure shifts dropdown is loaded after initShift (initShift calls loadSalesSummary)
loadShiftsDropdown();
// wire start/end buttons
const startShiftBtnCashier = document.getElementById('start-shift-btn-cashier');
const startShiftBtnAdmin = document.getElementById('start-shift-btn-admin');
const endShiftBtnCashier = document.getElementById('end-shift-btn-cashier');
const endShiftBtnAdmin = document.getElementById('end-shift-btn-admin');

if (startShiftBtnCashier) startShiftBtnCashier.onclick = () => startNewShift();
if (startShiftBtnAdmin) startShiftBtnAdmin.onclick = () => startNewShift();
if (endShiftBtnCashier) endShiftBtnCashier.onclick = () => endCurrentShift();
if (endShiftBtnAdmin) endShiftBtnAdmin.onclick = () => endCurrentShift();

const adminAddEmployeeBtn = document.getElementById('admin-add-employee');
if (adminAddEmployeeBtn) adminAddEmployeeBtn.onclick = () => openEmployeeModal();

// and populate history on load
loadSalesHistory();

// Lending page specific loaders
function loadBorrowersList() {
  const container = document.getElementById('borrowers-list');
  if (!container) return;
  container.innerHTML = 'Loading borrowers...';

  // Query all lendings where returned == false
  const q = query(collection(db, 'lendings'), where('returned', '==', false));
  getDocs(q).then(qSnap => {
    const borrowers = {};
    qSnap.forEach(docSnap => {
      const l = docSnap.data();
      const name = l.borrowerName;
      if (!borrowers[name]) borrowers[name] = { total: 0, paid: 0, lendings: [] };
      borrowers[name].lendings.push({ id: docSnap.id, ...l });
      borrowers[name].total += Number(l.total || 0);
      // Calculate paid amount from payments array if exists
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      borrowers[name].paid += paid;
    });

    container.innerHTML = '';
    Object.keys(borrowers).forEach(name => {
      const b = borrowers[name];
      const unpaid = b.total - b.paid;
      if (unpaid > 0) {
        const div = document.createElement('div');
        div.className = 'borrower-item card';
        div.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${name}</strong>
            <div>
              <span style="color:var(--danger)">Unpaid: ${formatCurrency(unpaid)}</span>
              <button class="checkout-btn" onclick="showBorrowerDetails('${name}')">View Details</button>
            </div>
          </div>
        `;
        container.appendChild(div);
      }
    });

    if (container.innerHTML === '') {
      container.innerText = 'No borrowers with outstanding balance';
    }
  }).catch(err => {
    console.error('Failed to load borrowers', err);
    container.innerText = 'Failed to load borrowers';
  });
}

function showBorrowerDetails(borrowerName) {
  const modal = document.getElementById('lending-details-modal');
  const borrowerNameEl = document.getElementById('lending-details-name');
  const itemsEl = document.getElementById('lending-details-entries-container');
  const totalEl = document.getElementById('lending-details-balance');

  borrowerNameEl.innerText = borrowerName;
  itemsEl.innerHTML = 'Loading...';

  const q = query(collection(db, 'lendings'), where('borrowerName', '==', borrowerName), where('returned', '==', false));
  getDocs(q).then(qSnap => {
    let totalUnpaid = 0;
    itemsEl.innerHTML = '';

    qSnap.forEach(docSnap => {
      const l = docSnap.data();
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const unpaid = Number(l.total || 0) - paid;
      if (unpaid > 0) {
        totalUnpaid += unpaid;
        const lendingDiv = document.createElement('div');
        lendingDiv.innerHTML = `<h4>Lending on ${new Date(l.timestamp.toDate()).toLocaleString()}</h4>`;
        const itemsList = document.createElement('ul');
        (l.items || []).forEach(item => {
          if (!item.paid) {
            const li = document.createElement('li');
            const qtyStr = item.unit && item.unit.toLowerCase() === 'kg' ? `${Number(item.weight).toFixed(2)}kg` : `x${item.qty}`;
            li.innerText = `${item.name} ${qtyStr} = ${formatCurrency(item.total)}`;
            itemsList.appendChild(li);
          }
        });
        lendingDiv.appendChild(itemsList);
        lendingDiv.innerHTML += `<p>Total Unpaid: ${formatCurrency(unpaid)}</p>`;
        itemsEl.appendChild(lendingDiv);
      }
    });

    totalEl.innerText = formatCurrency(totalUnpaid);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }).catch(err => {
    console.error('Failed to load borrower details', err);
    alert('Failed to load details');
  });
}

function closeLendingDetailsModal() {
  const modal = document.getElementById('lending-details-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// Wire lending details modal buttons
const lendingDetailsCloseBtn = document.getElementById('lending-details-close');
if (lendingDetailsCloseBtn) lendingDetailsCloseBtn.onclick = () => closeLendingDetailsModal();

const lendingDetailsCancelBtn = document.getElementById('lending-details-cancel');
if (lendingDetailsCancelBtn) lendingDetailsCancelBtn.onclick = () => closeLendingDetailsModal();

const lendingFullBtn = document.getElementById('lending-details-full-payment');
if (lendingFullBtn) lendingFullBtn.onclick = () => {
  const name = document.getElementById('lending-details-name').innerText;
  fullPayment(name);
};

const lendingPartialBtn = document.getElementById('lending-details-partial-payment');
if (lendingPartialBtn) lendingPartialBtn.onclick = () => {
  const name = document.getElementById('lending-details-name').innerText;
  partialPayment(name);
};

// Make showBorrowerDetails globally accessible for HTML onclick
window.showBorrowerDetails = showBorrowerDetails;

function openPaymentModal(borrowerName) {
  const modal = document.getElementById('payment-modal');
  const borrowerNameEl = document.getElementById('payment-borrower-name');
  const itemsEl = document.getElementById('payment-items');
  const unpaidTotalEl = document.getElementById('payment-unpaid-total');
  const amountInput = document.getElementById('payment-amount');

  borrowerNameEl.innerText = borrowerName;
  itemsEl.innerHTML = 'Loading...';
  amountInput.value = '';

  // Query lendings for this borrower
  const q = query(collection(db, 'lendings'), where('borrowerName', '==', borrowerName), where('returned', '==', false));
  getDocs(q).then(qSnap => {
    let allItems = [];
    let totalUnpaid = 0;

    qSnap.forEach(docSnap => {
      const l = docSnap.data();
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const unpaid = Number(l.total || 0) - paid;
      if (unpaid > 0) {
        (l.items || []).forEach((item, idx) => {
          if (!item.paid) {
            allItems.push({
              lendingId: docSnap.id,
              itemIndex: idx,
              item: item,
              lendingTotal: unpaid
            });
            totalUnpaid += Number(item.total || 0);
          }
        });
      }
    });

    itemsEl.innerHTML = '';
    allItems.forEach((entry, globalIdx) => {
      const item = entry.item;
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.gap = '8px';
      div.style.marginBottom = '4px';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.lendingId = entry.lendingId;
      checkbox.dataset.itemIndex = entry.itemIndex;
      checkbox.dataset.amount = item.total;

      const label = document.createElement('label');
      const qtyStr = item.unit && item.unit.toLowerCase() === 'kg' ? `${Number(item.weight).toFixed(2)}kg` : `x${item.qty}`;
      label.innerText = `${item.name} ${qtyStr} = ${formatCurrency(item.total)}`;

      div.appendChild(checkbox);
      div.appendChild(label);
      itemsEl.appendChild(div);
    });

    unpaidTotalEl.innerText = formatCurrency(totalUnpaid);

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }).catch(err => {
    console.error('Failed to load payment items', err);
    alert('Failed to load payment details');
  });
}

function closePaymentModal() {
  const modal = document.getElementById('payment-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function fullPayment(borrowerName) {
  const unpaid = Number(document.getElementById('lending-details-balance').innerText.replace('₱', '').replace(',', ''));
  if (!confirm(`Pay full amount of ${formatCurrency(unpaid)}?`)) return;
  processPayment(borrowerName, unpaid, true);
}

function partialPayment(borrowerName) {
  const unpaid = Number(document.getElementById('lending-details-balance').innerText.replace('₱', '').replace(',', ''));
  const payAmount = Number(prompt('Enter partial payment amount', ''));
  if (isNaN(payAmount) || payAmount <= 0) {
    alert('Invalid amount');
    return;
  }
  if (payAmount > unpaid) {
    alert('Payment amount cannot exceed unpaid balance');
    return;
  }
  if (!confirm(`Pay ${formatCurrency(payAmount)}?`)) return;
  processPayment(borrowerName, payAmount, false);
}

async function processPayment(borrowerName, amount, isFull, selectedItems = []) {
  if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
    alert('No open shift. Please start a shift before processing payments.');
    return;
  }

  try {
    // Query lendings for this borrower
    const q = query(collection(db, 'lendings'), where('borrowerName', '==', borrowerName), where('returned', '==', false));
    const qSnap = await getDocs(q);

    let totalPaid = 0;
    const updates = [];

    for (const docSnap of qSnap.docs) {
      const l = docSnap.data();
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const unpaid = Number(l.total || 0) - paid;

      if (unpaid > 0) {
        const paymentRecord = {
          amount: isFull ? unpaid : amount, // For partial, distribute or something, but for simplicity, record the total
          timestamp: new Date(),
          shiftId: currentShift.id,
          cashier: currentEmployeeName || currentUsername || 'Unknown'
        };

        if (isFull) {
          // Mark all unpaid items as paid
          const updatedItems = (l.items || []).map(item => ({ ...item, paid: true }));
          updates.push({
            docId: docSnap.id,
            data: {
              payments: [...(l.payments || []), paymentRecord],
              returned: true,
              items: updatedItems
            }
          });
          totalPaid += unpaid;
        } else {
          // For partial, mark selected items as paid
          const updatedItems = (l.items || []).map((item, idx) => {
            const isSelected = selectedItems.some(s => s.lendingId === docSnap.id && s.itemIndex == idx);
            return isSelected ? { ...item, paid: true } : item;
          });
          updates.push({
            docId: docSnap.id,
            data: {
              payments: [...(l.payments || []), paymentRecord],
              items: updatedItems
            }
          });
          totalPaid += amount;
        }

        if (totalPaid >= amount) break; // For partial, might need to distribute, but keep simple
      }
    }

    // Update documents
    for (const update of updates) {
      await safeWrite('update', 'lendings', update.data, update.docId);
    }

    // Record as sales income? For lending payments, perhaps add to sales
    // To increase sales, create a sale record for the payment
    const saleDoc = {
      timestamp: new Date(),
      shiftId: currentShift.id,
      items: [{ name: `Lending Payment - ${borrowerName}`, unit: 'pcs', price: amount, qty: 1, lineTotal: amount }],
      subtotal: amount,
      discount: 0,
      total: amount,
      cash: amount,
      change: 0,
      cashier: currentEmployeeName || currentUsername || 'Unknown'
    };
    await safeWrite('add', 'sales', saleDoc);

    // Update shift total
    const newTotal = Number(((Number(currentShift.totalIncome || currentShift.totalSales || 0) + amount)).toFixed(2));
    await safeWrite('update', 'shifts', { totalIncome: newTotal }, currentShift.id);
    currentShift.totalIncome = newTotal;

    alert('Payment recorded successfully!');
    closePaymentModal();
    loadBorrowersList();
    loadSalesSummary();
    updateShiftUI();
  } catch (err) {
    console.error('Failed to process payment', err);
    alert('Failed to process payment. Check console.');
  }
}

// Wire payment modal buttons
const paymentCancel = document.getElementById('payment-cancel');
if (paymentCancel) paymentCancel.onclick = () => closePaymentModal();

const paymentFull = document.getElementById('payment-full');
if (paymentFull) paymentFull.onclick = () => {
  const borrowerName = document.getElementById('payment-borrower-name').innerText;
  fullPayment(borrowerName);
};

const paymentPartial = document.getElementById('payment-partial');
if (paymentPartial) paymentPartial.onclick = () => {
  const borrowerName = document.getElementById('payment-borrower-name').innerText;
  partialPayment(borrowerName);
};



// Apply icons to static buttons (if present)
function applyButtonIcons() {
  const map = {
    'checkout': '<span class="btn-icon">💳</span><span class="btn-text">Checkout</span>',
    'add-product-btn': '<span class="btn-icon">➕</span><span class="btn-text">Add New Product</span>',
    'toggle-edit-products': '<span class="btn-icon">✏️</span><span class="btn-text">Edit Products</span>',
    'delete-selected': '<span class="btn-icon">🗑️</span><span class="btn-text">Delete Selected</span>',
    'start-shift-btn-cashier': '<span class="btn-icon">▶️</span><span class="btn-text">Start New Shift</span>',
    'start-shift-btn-admin': '<span class="btn-icon">▶️</span><span class="btn-text">Start New Shift</span>',
    'end-shift-btn-cashier': '<span class="btn-icon">⏹️</span><span class="btn-text">End Shift</span>',
    'end-shift-btn-admin': '<span class="btn-icon">⏹️</span><span class="btn-text">End Shift</span>',
    'export-sales': '<span class="btn-icon">📤</span><span class="btn-text">Export Sales (CSV)</span>',
    'clear-sales': '<span class="btn-icon">🗑️</span><span class="btn-text">Clear All Sales</span>',
    'admin-add-employee': '<span class="btn-icon">➕</span><span class="btn-text">Add Employee</span>',
    'receipt-save': '<span class="btn-icon">✅</span><span class="btn-text">Add to Sales</span>',
    'receipt-cancel': '<span class="btn-icon">✖️</span><span class="btn-text">Cancel</span>',
    'weight-modal-close': '<span class="btn-icon">✖️</span>',
    'lending-weight-modal-close': '<span class="btn-icon">✖️</span>',
    'modal-add': '<span class="btn-icon">➕</span><span class="btn-text">Add</span>',
    'add-product-save': '<span class="btn-icon">✅</span><span class="btn-text">Save</span>',
    'add-product-cancel': '<span class="btn-icon">✖️</span><span class="btn-text">Cancel</span>',
    'clear-cart': '<span class="btn-icon">🧹</span><span class="btn-text">Clear Cart</span>'
  };
  Object.keys(map).forEach(id => {
    try {
      const el = document.getElementById(id);
      if (el) {
        // Some controls (e.g., <input>) don't have innerHTML; handle safely
        if (el.tagName && el.tagName.toUpperCase() === 'INPUT') {
          // strip HTML tags and set as value
          el.value = String(map[id]).replace(/<[^>]*>/g, '').trim();
        } else {
          el.innerHTML = map[id];
        }
      }
    } catch (err) {
      console.error('applyButtonIcons failed for id', id, 'content:', map[id], err);
    }
  });
}
try { applyButtonIcons(); } catch (err) { console.error('applyButtonIcons failed at runtime', err); }
try { initFinanceListeners(); } catch (err) { console.error('initFinanceListeners failed at runtime', err); }
