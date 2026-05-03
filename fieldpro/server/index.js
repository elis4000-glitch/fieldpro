const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const DB_FILE = path.join(DATA_DIR, 'db.json');
function readDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  return { products: [], orders: [], customers: [], settings: {} };
}
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function getDB() { return readDB(); }

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const imgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const sku = req.params?.sku || path.parse(file.originalname).name;
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, sku.replace(/[^a-zA-Z0-9\-_#]/g, '_') + ext);
  }
});
const upload = multer({ storage: imgStorage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadXlsx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.get('/api/products', (req, res) => {
  let products = getDB().products || [];
  const { cat, search } = req.query;
  if (cat && cat !== 'all') products = products.filter(p => p.category === cat);
  if (search) { const q = search.toLowerCase(); products = products.filter(p => p.name?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)); }
  res.json(products);
});
app.get('/api/products/:sku', (req, res) => {
  const db = getDB();
  const product = db.products.find(p => p.sku === req.params.sku);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json({ ...product, children: db.products.filter(p => p.parent_sku === req.params.sku) });
});
app.post('/api/products', (req, res) => {
  const db = getDB();
  const { sku, parent_sku, name, category, price, color, qty, img_url } = req.body;
  const product = { sku, parent_sku: parent_sku||'', name, category, price: price||0, color: color||'', qty: qty||0, img_url: img_url||'', img_local: '', updated_at: new Date().toISOString() };
  const idx = db.products.findIndex(p => p.sku === sku);
  if (idx >= 0) db.products[idx] = { ...db.products[idx], ...product }; else db.products.push(product);
  writeDB(db); res.json({ success: true });
});
app.put('/api/products/:sku', (req, res) => {
  const db = getDB(); const idx = db.products.findIndex(p => p.sku === req.params.sku);
  if (idx >= 0) { db.products[idx] = { ...db.products[idx], ...req.body, updated_at: new Date().toISOString() }; writeDB(db); }
  res.json({ success: true });
});
app.delete('/api/products/:sku', (req, res) => {
  const db = getDB(); db.products = db.products.filter(p => p.sku !== req.params.sku && p.parent_sku !== req.params.sku);
  writeDB(db); res.json({ success: true });
});
app.post('/api/products/:sku/image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const imgLocal = '/uploads/' + req.file.filename;
  const db = getDB(); const idx = db.products.findIndex(p => p.sku === req.params.sku);
  if (idx >= 0) { db.products[idx].img_local = imgLocal; writeDB(db); }
  res.json({ success: true, img_local: imgLocal });
});
app.post('/api/images/bulk', upload.array('images', 500), (req, res) => {
  const db = getDB(); const results = { matched: [], unmatched: [] };
  for (const file of req.files) {
    const skuName = path.parse(file.originalname).name;
    const imgLocal = '/uploads/' + file.filename;
    let idx = db.products.findIndex(p => p.sku === skuName);
    if (idx < 0) idx = db.products.findIndex(p => p.sku === skuName.replace(/-V\d+$/, ''));
    if (idx >= 0) { db.products[idx].img_local = imgLocal; results.matched.push(skuName); } else results.unmatched.push(file.originalname);
  }
  writeDB(db); res.json(results);
});
app.post('/api/import/excel', uploadXlsx.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const headers = rows[0].map(h => String(h||'').toLowerCase().trim());
    const gc = name => headers.findIndex(h => h.includes(name));
    const colName = gc('product name') !== -1 ? gc('product name') : gc('name');
    const colSku = gc('sku'), colParent = gc('parent'), colPrice = gc('price');
    const colColor = gc('color') !== -1 ? gc('color') : gc('colours');
    const colQty = gc('quantity') !== -1 ? gc('quantity') : gc('available');
    const colCat = gc('tag') !== -1 ? gc('tag') : gc('category');
    const colImg = gc('picture') !== -1 ? gc('picture') : gc('image');
    const db = getDB(); let added = 0, updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; if (!row || !row[colSku]) continue;
      const sku = String(row[colSku]||'').trim(); if (!sku) continue;
      const rawName = colName >= 0 ? String(row[colName]||'') : '';
      const product = { sku, parent_sku: colParent>=0?String(row[colParent]||''):'', name: rawName.replace(/\s*-\s*[\w#\-]+$/, '').trim()||rawName,
        category: colCat>=0?String(row[colCat]||''):'', price: colPrice>=0?(parseFloat(row[colPrice])||0):0,
        color: colColor>=0?String(row[colColor]||''):'', qty: colQty>=0?(parseInt(row[colQty])||0):0,
        img_url: colImg>=0?String(row[colImg]||''):'', img_local: '', updated_at: new Date().toISOString() };
      const idx = db.products.findIndex(p => p.sku === sku);
      if (idx >= 0) { db.products[idx] = { ...db.products[idx], ...product }; updated++; } else { db.products.push(product); added++; }
    }
    writeDB(db); res.json({ success: true, added, updated, total: added+updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/orders', (req, res) => { res.json((getDB().orders||[]).slice(-100).reverse()); });
app.post('/api/orders', (req, res) => {
  const db = getDB(); const order = { id: Date.now(), order_num: 'ORD-'+Date.now(), ...req.body, status: 'pending', created_at: new Date().toISOString() };
  if (!db.orders) db.orders = []; db.orders.push(order); writeDB(db); res.json({ success: true, order_num: order.order_num });
});
app.get('/api/customers', (req, res) => { res.json(getDB().customers||[]); });
app.post('/api/customers', (req, res) => {
  const db = getDB(); const customer = { id: Date.now(), ...req.body, created_at: new Date().toISOString() };
  if (!db.customers) db.customers = []; db.customers.push(customer); writeDB(db); res.json({ success: true, id: customer.id });
});
app.get('/api/settings', (req, res) => { res.json(getDB().settings||{}); });
app.post('/api/settings', (req, res) => {
  const db = getDB(); db.settings = { ...(db.settings||{}), ...req.body }; writeDB(db); res.json({ success: true });
});
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'index.html')); });
app.listen(PORT, () => console.log(`FieldPro running on port ${PORT}`));
