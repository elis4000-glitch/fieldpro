require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fieldpro_secret_2024';
const MONGODB_URI = process.env.MONGODB_URI;

// ── Connect MongoDB ─────────────────────────────────────
mongoose.connect(MONGODB_URI).then(() => console.log('✅ MongoDB connected')).catch(e => console.error('MongoDB error:', e));

// ── Uploads Dir ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════
// SCHEMAS
// ══════════════════════════════════════════════════════════

const AgentSchema = new mongoose.Schema({
  name: String,
  username: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'agent' }, // admin / agent
  active: { type: Boolean, default: true },
  location: { lat: Number, lng: Number, updatedAt: Date },
  discount: { type: Number, default: 0 }, // % default discount for this agent
}, { timestamps: true });

const CustomerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: String,
  email: String,
  address: String,
  city: String,
  category: String,
  discount: { type: Number, default: 0 }, // % fixed discount
  notes: String,
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
}, { timestamps: true });

const ProductSchema = new mongoose.Schema({
  sku: { type: String, required: true, unique: true },
  parentSku: { type: String, default: '' },
  name: String,
  category: String,
  price: { type: Number, default: 0 },
  color: String,
  qty: { type: Number, default: 0 },
  imgUrl: String,
  imgLocal: String,
  allowDiscount: { type: Boolean, default: true }, // false = net price, no discount
  tags: [String],
  barcode: String,
  extraImages: [String],
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  orderNum: { type: String, unique: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
  agentName: String,
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: String,
  customerPhone: String,
  items: [{
    sku: String, name: String, color: String, price: Number,
    qty: Number, discount: Number, total: Number, imgLocal: String
  }],
  subtotal: Number,
  discountAmount: Number,
  total: Number,
  status: { type: String, default: 'pending' }, // pending/confirmed/shipped/cancelled
  notes: String,
  isReturn: { type: Boolean, default: false },
  sentWhatsapp: { type: Boolean, default: false },
  sentEmail: { type: Boolean, default: false },
}, { timestamps: true });

const SettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
});

const Agent = mongoose.model('Agent', AgentSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Auth Middleware ────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'לא מורשה' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'טוקן לא תקין' }); }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'נדרשות הרשאות מנהל' });
  next();
}

// ── Multer ─────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const name = (req.params?.sku || path.parse(file.originalname).name).replace(/[^a-zA-Z0-9\-_#]/g, '_');
    cb(null, name + '_' + Date.now() + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ══════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════

// Create default admin if none exists
async function ensureAdmin() {
  const count = await Agent.countDocuments({ role: 'admin' });
  if (!count) {
    const hash = await bcrypt.hash('admin123', 10);
    await Agent.create({ name: 'מנהל', username: 'admin', password: hash, role: 'admin' });
    console.log('✅ Admin created: admin / admin123');
  }
}
mongoose.connection.once('open', ensureAdmin);

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const agent = await Agent.findOne({ username, active: true });
  if (!agent) return res.status(401).json({ error: 'שם משתמש לא נמצא' });
  const ok = await bcrypt.compare(password, agent.password);
  if (!ok) return res.status(401).json({ error: 'סיסמה שגויה' });
  const token = jwt.sign({ id: agent._id, role: agent.role, name: agent.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: agent._id, name: agent.name, role: agent.role } });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const agent = await Agent.findById(req.user.id).select('-password');
  res.json(agent);
});

// ══════════════════════════════════════════════════════════
// AGENTS (Admin only)
// ══════════════════════════════════════════════════════════
app.get('/api/agents', auth, adminOnly, async (req, res) => {
  res.json(await Agent.find().select('-password').sort('name'));
});

app.post('/api/agents', auth, adminOnly, async (req, res) => {
  const { name, username, password, role, discount } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const agent = await Agent.create({ name, username, password: hash, role: role || 'agent', discount: discount || 0 });
    res.json({ success: true, id: agent._id });
  } catch (e) { res.status(400).json({ error: 'שם משתמש כבר קיים' }); }
});

app.put('/api/agents/:id', auth, adminOnly, async (req, res) => {
  const update = { ...req.body };
  if (update.password) { update.password = await bcrypt.hash(update.password, 10); }
  else delete update.password;
  await Agent.findByIdAndUpdate(req.params.id, update);
  res.json({ success: true });
});

app.delete('/api/agents/:id', auth, adminOnly, async (req, res) => {
  await Agent.findByIdAndUpdate(req.params.id, { active: false });
  res.json({ success: true });
});

// Update location
app.post('/api/agents/location', auth, async (req, res) => {
  const { lat, lng } = req.body;
  await Agent.findByIdAndUpdate(req.user.id, { location: { lat, lng, updatedAt: new Date() } });
  res.json({ success: true });
});

// Get all agent locations (admin)
app.get('/api/agents/locations', auth, adminOnly, async (req, res) => {
  const agents = await Agent.find({ active: true, 'location.lat': { $exists: true } }).select('name location');
  res.json(agents);
});

// ══════════════════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════════════════
app.get('/api/products', auth, async (req, res) => {
  const { cat, search, parent } = req.query;
  const filter = {};
  if (cat && cat !== 'all') filter.category = cat;
  if (search) filter.$or = [{ name: /search/i }, { sku: new RegExp(search, 'i') }, { color: new RegExp(search, 'i') }];
  if (parent !== undefined) filter.parentSku = parent;
  res.json(await Product.find(filter).sort('category name sku'));
});

app.get('/api/products/categories', auth, async (req, res) => {
  const cats = await Product.distinct('category', { category: { $ne: '' } });
  res.json(cats.sort());
});

app.get('/api/products/:sku', auth, async (req, res) => {
  const product = await Product.findOne({ sku: req.params.sku });
  if (!product) return res.status(404).json({ error: 'לא נמצא' });
  const children = await Product.find({ parentSku: req.params.sku });
  res.json({ ...product.toObject(), children });
});

app.post('/api/products', auth, adminOnly, async (req, res) => {
  try {
    await Product.findOneAndUpdate({ sku: req.body.sku }, req.body, { upsert: true, new: true });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/products/:sku', auth, adminOnly, async (req, res) => {
  await Product.findOneAndUpdate({ sku: req.params.sku }, req.body);
  res.json({ success: true });
});

app.delete('/api/products/:sku', auth, adminOnly, async (req, res) => {
  await Product.deleteMany({ $or: [{ sku: req.params.sku }, { parentSku: req.params.sku }] });
  res.json({ success: true });
});

// Upload image for product
app.post('/api/products/:sku/image', auth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'אין קובץ' });
  const imgLocal = '/uploads/' + req.file.filename;
  await Product.findOneAndUpdate({ sku: req.params.sku }, { imgLocal });
  res.json({ success: true, imgLocal });
});

// Bulk image upload
app.post('/api/images/bulk', auth, upload.array('images', 500), async (req, res) => {
  const matched = [], unmatched = [];
  for (const file of req.files) {
    const skuName = path.parse(file.originalname).name;
    const imgLocal = '/uploads/' + file.filename;
    let p = await Product.findOne({ sku: skuName });
    if (!p) p = await Product.findOne({ sku: skuName.replace(/-V\d+$/, '') });
    if (p) { await Product.findByIdAndUpdate(p._id, { imgLocal }); matched.push(skuName); }
    else unmatched.push(file.originalname);
  }
  res.json({ matched, unmatched });
});

// Barcode search
app.get('/api/products/barcode/:code', auth, async (req, res) => {
  const product = await Product.findOne({ $or: [{ barcode: req.params.code }, { sku: req.params.code }] });
  if (!product) return res.status(404).json({ error: 'מוצר לא נמצא' });
  const children = await Product.find({ parentSku: product.sku });
  res.json({ ...product.toObject(), children });
});

// ══════════════════════════════════════════════════════════
// EXCEL IMPORT
// ══════════════════════════════════════════════════════════
app.post('/api/import/excel', auth, adminOnly, uploadMem.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'אין קובץ' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const headers = rows[0].map(h => String(h || '').toLowerCase().trim());
    const gc = name => headers.findIndex(h => h.includes(name));
    const colName = gc('product name') !== -1 ? gc('product name') : gc('name');
    const colSku = gc('sku'), colParent = gc('parent'), colPrice = gc('price');
    const colColor = gc('color') !== -1 ? gc('color') : gc('colours');
    const colQty = gc('quantity') !== -1 ? gc('quantity') : gc('available');
    const colCat = gc('tag') !== -1 ? gc('tag') : gc('category');
    const colImg = gc('picture') !== -1 ? gc('picture') : gc('image');
    const colDiscount = gc('discount') !== -1 ? gc('discount') : gc('allow');
    const colBarcode = gc('barcode') !== -1 ? gc('barcode') : -1;
    let added = 0, updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; if (!row?.[colSku]) continue;
      const sku = String(row[colSku]).trim(); if (!sku) continue;
      const rawName = colName >= 0 ? String(row[colName] || '') : '';
      const allowDiscountRaw = colDiscount >= 0 ? row[colDiscount] : 1;
      const product = {
        sku, parentSku: colParent >= 0 ? String(row[colParent] || '') : '',
        name: rawName.replace(/\s*-\s*[\w#\-]+$/, '').trim() || rawName,
        category: colCat >= 0 ? String(row[colCat] || '') : '',
        price: colPrice >= 0 ? (parseFloat(row[colPrice]) || 0) : 0,
        color: colColor >= 0 ? String(row[colColor] || '') : '',
        qty: colQty >= 0 ? (parseInt(row[colQty]) || 0) : 0,
        imgUrl: colImg >= 0 ? String(row[colImg] || '') : '',
        allowDiscount: allowDiscountRaw !== 0 && allowDiscountRaw !== '0',
        barcode: colBarcode >= 0 ? String(row[colBarcode] || '') : '',
      };
      const exists = await Product.findOne({ sku });
      if (exists) { await Product.findOneAndUpdate({ sku }, product); updated++; }
      else { await Product.create(product); added++; }
    }
    res.json({ success: true, added, updated, total: added + updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
// CUSTOMERS
// ══════════════════════════════════════════════════════════
app.get('/api/customers', auth, async (req, res) => {
  const filter = req.user.role === 'admin' ? {} : { agentId: req.user.id };
  const search = req.query.search;
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { phone: new RegExp(search, 'i') }];
  res.json(await Customer.find(filter).sort('name'));
});

app.post('/api/customers', auth, async (req, res) => {
  const customer = await Customer.create({ ...req.body, agentId: req.user.id });
  res.json({ success: true, id: customer._id });
});

app.put('/api/customers/:id', auth, async (req, res) => {
  await Customer.findByIdAndUpdate(req.params.id, req.body);
  res.json({ success: true });
});

app.delete('/api/customers/:id', auth, adminOnly, async (req, res) => {
  await Customer.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// ORDERS
// ══════════════════════════════════════════════════════════
app.get('/api/orders', auth, async (req, res) => {
  const filter = req.user.role === 'admin' ? {} : { agentId: req.user.id };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.isReturn) filter.isReturn = req.query.isReturn === 'true';
  const orders = await Order.find(filter).sort('-createdAt').limit(200);
  res.json(orders);
});

app.post('/api/orders', auth, async (req, res) => {
  const orderNum = 'ORD-' + Date.now();
  const order = await Order.create({
    ...req.body, orderNum,
    agentId: req.user.id, agentName: req.user.name,
  });
  // Update stock
  for (const item of req.body.items || []) {
    await Product.findOneAndUpdate({ sku: item.sku }, { $inc: { qty: req.body.isReturn ? item.qty : -item.qty } });
  }
  res.json({ success: true, orderNum, id: order._id });
});

app.put('/api/orders/:id/status', auth, async (req, res) => {
  await Order.findByIdAndUpdate(req.params.id, { status: req.body.status });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// QUICKSELL — Public catalog link
// ══════════════════════════════════════════════════════════
app.get('/api/quicksell/:token', async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);
    const filter = { parentSku: '' };
    if (data.categories?.length) filter.category = { $in: data.categories };
    const products = await Product.find(filter).sort('category name');
    const result = await Promise.all(products.map(async p => ({
      ...p.toObject(),
      children: await Product.find({ parentSku: p.sku })
    })));
    res.json({ products: result, agentName: data.agentName, customerName: data.customerName });
  } catch { res.status(400).json({ error: 'קישור לא תקין' }); }
});

// Create quicksell link
app.post('/api/quicksell/create', auth, async (req, res) => {
  const { customerId, categories } = req.body;
  const customer = customerId ? await Customer.findById(customerId) : null;
  const token = jwt.sign({
    agentId: req.user.id, agentName: req.user.name,
    customerId, customerName: customer?.name || '',
    categories: categories || [], // empty = all
  }, JWT_SECRET, { expiresIn: '7d' });
  const link = `${req.protocol}://${req.get('host')}/catalog/${token}`;
  res.json({ link, token });
});

// Customer submits order via quicksell
app.post('/api/quicksell/:token/order', async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);
    const orderNum = 'QS-' + Date.now();
    await Order.create({
      ...req.body, orderNum,
      agentId: data.agentId, agentName: data.agentName,
      customerId: data.customerId, customerName: data.customerName || req.body.customerName,
      status: 'new',
    });
    res.json({ success: true, orderNum });
  } catch { res.status(400).json({ error: 'קישור לא תקין' }); }
});

// ══════════════════════════════════════════════════════════
// STATS / REPORTS (Admin)
// ══════════════════════════════════════════════════════════
app.get('/api/stats/overview', auth, adminOnly, async (req, res) => {
  const [products, customers, orders, agents] = await Promise.all([
    Product.countDocuments({ parentSku: '' }),
    Customer.countDocuments(),
    Order.countDocuments({ isReturn: false }),
    Agent.countDocuments({ role: 'agent', active: true }),
  ]);
  const revenue = await Order.aggregate([
    { $match: { isReturn: false, status: { $ne: 'cancelled' } } },
    { $group: { _id: null, total: { $sum: '$total' } } }
  ]);
  res.json({ products, customers, orders, agents, revenue: revenue[0]?.total || 0 });
});

app.get('/api/stats/bestsellers', auth, adminOnly, async (req, res) => {
  const result = await Order.aggregate([
    { $match: { isReturn: false } },
    { $unwind: '$items' },
    { $group: { _id: { sku: '$items.sku', name: '$items.name', color: '$items.color' }, totalQty: { $sum: '$items.qty' }, totalRevenue: { $sum: '$items.total' } } },
    { $sort: { totalQty: -1 } },
    { $limit: 50 }
  ]);
  res.json(result);
});

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
app.get('/api/settings', auth, async (req, res) => {
  const rows = await Settings.find();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  res.json(s);
});

app.post('/api/settings', auth, adminOnly, async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    await Settings.findOneAndUpdate({ key }, { key, value }, { upsert: true });
  }
  res.json({ success: true });
});

// ── Serve frontend ─────────────────────────────────────────
app.get('/catalog/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'catalog.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ FieldPro v2 running on port ${PORT}`));
