const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Folders ──────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'fieldpro.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    parent_sku TEXT DEFAULT '',
    name TEXT,
    category TEXT,
    price REAL DEFAULT 0,
    color TEXT,
    qty INTEGER DEFAULT 0,
    img_url TEXT DEFAULT '',
    img_local TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_num TEXT UNIQUE,
    customer TEXT,
    agent TEXT,
    status TEXT DEFAULT 'pending',
    total REAL DEFAULT 0,
    items TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    category TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Multer for images ──────────────────────────────────────
const imgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // Use SKU from request or original filename
    const sku = req.body?.sku || req.params?.sku || path.parse(file.originalname).name;
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, sku.replace(/[^a-zA-Z0-9\-_#]/g, '_') + ext);
  }
});
const upload = multer({ storage: imgStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Multer for Excel
const xlsxStorage = multer.memoryStorage();
const uploadXlsx = multer({ storage: xlsxStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// ══════════════════════════════════════════════════════════
// PRODUCTS API
// ══════════════════════════════════════════════════════════

// GET all products (with children)
app.get('/api/products', (req, res) => {
  const { cat, search, parent } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (cat && cat !== 'all') { sql += ' AND category = ?'; params.push(cat); }
  if (search) { sql += ' AND (name LIKE ? OR sku LIKE ? OR color LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (parent !== undefined) { sql += ' AND parent_sku = ?'; params.push(parent); }
  sql += ' ORDER BY category, name, sku';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET single product with children
app.get('/api/products/:sku', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(req.params.sku);
  if (!product) return res.status(404).json({ error: 'Not found' });
  const children = db.prepare('SELECT * FROM products WHERE parent_sku = ? ORDER BY sku').all(req.params.sku);
  res.json({ ...product, children });
});

// POST create product
app.post('/api/products', (req, res) => {
  const { sku, parent_sku, name, category, price, color, qty, img_url } = req.body;
  try {
    db.prepare(`INSERT OR REPLACE INTO products (sku, parent_sku, name, category, price, color, qty, img_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(sku, parent_sku || '', name, category, price || 0, color || '', qty || 0, img_url || '');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT update product
app.put('/api/products/:sku', (req, res) => {
  const fields = ['name', 'category', 'price', 'color', 'qty', 'img_url', 'img_local'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.json({ success: true });
  const sql = `UPDATE products SET ${updates.map(f => f + '=?').join(',')}, updated_at=CURRENT_TIMESTAMP WHERE sku=?`;
  db.prepare(sql).run(...updates.map(f => req.body[f]), req.params.sku);
  res.json({ success: true });
});

// DELETE product
app.delete('/api/products/:sku', (req, res) => {
  db.prepare('DELETE FROM products WHERE sku = ? OR parent_sku = ?').run(req.params.sku, req.params.sku);
  res.json({ success: true });
});

// ── Image upload for a product ─────────────────────────────
app.post('/api/products/:sku/image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const imgLocal = '/uploads/' + req.file.filename;
  db.prepare('UPDATE products SET img_local=?, updated_at=CURRENT_TIMESTAMP WHERE sku=?')
    .run(imgLocal, req.params.sku);
  res.json({ success: true, img_local: imgLocal, url: `${req.protocol}://${req.get('host')}${imgLocal}` });
});

// ── Bulk image upload (auto-match by filename = SKU) ────────
app.post('/api/images/bulk', upload.array('images', 500), (req, res) => {
  const results = { matched: [], unmatched: [] };
  for (const file of req.files) {
    const skuName = path.parse(file.originalname).name;
    // Try exact match first, then strip variant suffix
    let product = db.prepare('SELECT sku FROM products WHERE sku = ?').get(skuName);
    if (!product) {
      const parentSku = skuName.replace(/-V\d+$/, '').replace(/-\d+$/, '');
      product = db.prepare('SELECT sku FROM products WHERE sku = ?').get(parentSku);
    }
    const imgLocal = '/uploads/' + file.filename;
    if (product) {
      db.prepare('UPDATE products SET img_local=?, updated_at=CURRENT_TIMESTAMP WHERE sku=?')
        .run(imgLocal, product.sku);
      results.matched.push({ sku: product.sku, file: file.originalname });
    } else {
      results.unmatched.push(file.originalname);
    }
  }
  res.json(results);
});

// ══════════════════════════════════════════════════════════
// EXCEL IMPORT
// ══════════════════════════════════════════════════════════
app.post('/api/import/excel', uploadXlsx.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const headers = rows[0].map(h => String(h || '').toLowerCase().trim());
    const getCol = name => headers.findIndex(h => h.includes(name));

    // Auto-detect columns
    const colName = getCol('product name') !== -1 ? getCol('product name') : getCol('name');
    const colSku = getCol('sku');
    const colParent = getCol('parent');
    const colPrice = getCol('price');
    const colColor = getCol('color') !== -1 ? getCol('color') : getCol('colours');
    const colQty = getCol('quantity') !== -1 ? getCol('quantity') : getCol('qty') !== -1 ? getCol('qty') : getCol('available');
    const colCat = getCol('tag') !== -1 ? getCol('tag') : getCol('category') !== -1 ? getCol('category') : getCol('cat');
    const colImg = getCol('picture') !== -1 ? getCol('picture') : getCol('image') !== -1 ? getCol('image') : getCol('img');

    let added = 0, updated = 0, errors = 0;
    const insertStmt = db.prepare(`INSERT OR REPLACE INTO products 
      (sku, parent_sku, name, category, price, color, qty, img_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);

    const importAll = db.transaction(() => {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[colSku]) continue;
        const sku = String(row[colSku] || '').trim();
        if (!sku) continue;
        // Extract clean name (remove " - SKU" suffix common in Pepperi)
        let rawName = colName >= 0 ? String(row[colName] || '') : '';
        const cleanName = rawName.replace(/\s*-\s*[\w#\-]+$/, '').trim() || rawName;
        const existing = db.prepare('SELECT id FROM products WHERE sku=?').get(sku);
        try {
          insertStmt.run(
            sku,
            colParent >= 0 ? String(row[colParent] || '') : '',
            cleanName,
            colCat >= 0 ? String(row[colCat] || '') : '',
            colPrice >= 0 ? (parseFloat(row[colPrice]) || 0) : 0,
            colColor >= 0 ? String(row[colColor] || '') : '',
            colQty >= 0 ? (parseInt(row[colQty]) || 0) : 0,
            colImg >= 0 ? String(row[colImg] || '') : ''
          );
          existing ? updated++ : added++;
        } catch (e) { errors++; }
      }
    });
    importAll();
    res.json({ success: true, added, updated, errors, total: added + updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// ORDERS API
// ══════════════════════════════════════════════════════════
app.get('/api/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  res.json(orders.map(o => ({ ...o, items: JSON.parse(o.items || '[]') })));
});

app.post('/api/orders', (req, res) => {
  const { customer, agent, items, total } = req.body;
  const orderNum = 'ORD-' + Date.now();
  db.prepare('INSERT INTO orders (order_num, customer, agent, items, total) VALUES (?,?,?,?,?)')
    .run(orderNum, customer || '', agent || '', JSON.stringify(items || []), total || 0);
  res.json({ success: true, order_num: orderNum });
});

app.put('/api/orders/:id/status', (req, res) => {
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// CUSTOMERS API
// ══════════════════════════════════════════════════════════
app.get('/api/customers', (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY name').all());
});

app.post('/api/customers', (req, res) => {
  const { name, phone, address, category, notes } = req.body;
  const r = db.prepare('INSERT INTO customers (name,phone,address,category,notes) VALUES (?,?,?,?,?)')
    .run(name, phone || '', address || '', category || '', notes || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

// ══════════════════════════════════════════════════════════
// QUICKSELL - Public order link
// ══════════════════════════════════════════════════════════
app.get('/api/quicksell/:token', (req, res) => {
  // Return catalog for customer ordering
  const products = db.prepare("SELECT * FROM products WHERE parent_sku = '' ORDER BY category, name").all();
  const result = products.map(p => ({
    ...p,
    children: db.prepare('SELECT * FROM products WHERE parent_sku=?').all(p.sku)
  }));
  res.json(result);
});

app.post('/api/quicksell/:token/order', (req, res) => {
  const { items, customer_name, total } = req.body;
  const orderNum = 'QS-' + Date.now();
  db.prepare('INSERT INTO orders (order_num, customer, agent, items, total, status) VALUES (?,?,?,?,?,?)')
    .run(orderNum, customer_name || 'לקוח אונליין', 'quicksell', JSON.stringify(items || []), total || 0, 'new');
  res.json({ success: true, order_num: orderNum });
});

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const s = {};
  rows.forEach(r => { try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; } });
  res.json(s);
});

app.post('/api/settings', (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  Object.entries(req.body).forEach(([k, v]) => stmt.run(k, JSON.stringify(v)));
  res.json({ success: true });
});

// ── Serve frontend ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ FieldPro רץ על פורט ${PORT}`));
