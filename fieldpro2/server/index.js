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

mongoose.connect(MONGODB_URI).then(() => console.log('MongoDB connected')).catch(e => console.error('MongoDB error:', e));

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const LAST_EXCEL_PATH = path.join(UPLOADS_DIR, 'last_import.xlsx');

// ===== SCHEMAS =====
const AgentSchema = new mongoose.Schema({
  name: String,
  username: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'agent' },
  active: { type: Boolean, default: true },
  location: { lat: Number, lng: Number, updatedAt: Date },
  discount: { type: Number, default: 0 }
}, { timestamps: true });

const CustomerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: String,
  email: String,
  address: String,
  city: String,
  category: String,
  discount: { type: Number, default: 0 },
  notes: String,
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' }
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
  allowDiscount: { type: Boolean, default: true },
  tags: [String],
  barcode: String,
  extraImages: [String],
  active: { type: Boolean, default: true },
  removedAt: { type: Date, default: null }
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  orderNum: { type: String, unique: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
  agentName: String,
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: String,
  customerPhone: String,
  items: [{ sku: String, name: String, color: String, price: Number, qty: Number, discount: Number, total: Number, imgLocal: String }],
  subtotal: Number,
  discountAmount: Number,
  total: Number,
  status: { type: String, default: 'pending' },
  notes: String,
  isReturn: { type: Boolean, default: false },
  sentWhatsapp: { type: Boolean, default: false },
  sentEmail: { type: Boolean, default: false }
}, { timestamps: true });

const SettingsSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });

const Agent = mongoose.model('Agent', AgentSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'אסימון לא תקין' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'מנהל בלבד' });
  next();
}

// ===== FILE UPLOAD =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const name = (req.params?.sku || path.parse(file.originalname).name).replace(/[^\w\-_#]/g, '_');
    cb(null, name + '_' + Date.now() + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function deleteLocalImage(imgLocal) {
  if (!imgLocal) return;
  try {
    const fp = path.join(__dirname, '..', imgLocal.replace(/^\//, ''));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (e) {
    console.error('שגיאה במחיקת תמונה:', e.message);
  }
}

async function cleanupOldRemovedImages() {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const old = await Product.find({ active: false, qty: 0, removedAt: { $lt: oneYearAgo }, imgLocal: { $exists: true, $ne: '' } });
  let deleted = 0;
  for (const p of old) {
    deleteLocalImage(p.imgLocal);
    await Product.findByIdAndUpdate(p._id, { imgLocal: '' });
    deleted++;
  }
  if (deleted > 0) console.log(`ניקוי ${deleted} תמונות ישנות`);
}

async function ensureAdmin() {
  const count = await Agent.countDocuments({ role: 'admin' });
  if (!count) {
    const hash = await bcrypt.hash('admin123', 10);
    await Agent.create({ name: 'מנהל', username: 'admin', password: hash, role: 'admin' });
    console.log('מנהל נוצר: admin / admin123');
  }
}

mongoose.connection.once('open', () => {
  ensureAdmin();
  cleanupOldRemovedImages();
});

// ===== AUTH ROUTES =====
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const agent = await Agent.findOne({ username, active: true });
  if (!agent) return res.status(401).json({ error: 'המשתמש לא נמצא' });
  const ok = await bcrypt.compare(password, agent.password);
  if (!ok) return res.status(401).json({ error: 'סיסמה שגויה' });
  const token = jwt.sign({ id: agent._id, role: agent.role, name: agent.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: agent._id, name: agent.name, role: agent.role } });
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json(await Agent.findById(req.user.id).select('-password'));
});

// ===== AGENTS =====
app.get('/api/agents', auth, adminOnly, async (req, res) => {
  res.json(await Agent.find().select('-password').sort('name'));
});

app.post('/api/agents', auth, adminOnly, async (req, res) => {
  const { name, username, password, role, discount } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const agent = await Agent.create({ name, username, password: hash, role: role || 'agent', discount: discount || 0 });
    res.json({ success: true, id: agent._id });
  } catch (e) {
    res.status(400).json({ error: 'שם המשתמש קיים' });
  }
});

app.put('/api/agents/:id', auth, adminOnly, async (req, res) => {
  const update = { ...req.body };
  if (update.password) update.password = await bcrypt.hash(update.password, 10);
  else delete update.password;
  await Agent.findByIdAndUpdate(req.params.id, update);
  res.json({ success: true });
});

app.delete('/api/agents/:id', auth, adminOnly, async (req, res) => {
  await Agent.findByIdAndUpdate(req.params.id, { active: false });
  res.json({ success: true });
});

app.post('/api/agents/location', auth, async (req, res) => {
  const { lat, lng } = req.body;
  await Agent.findByIdAndUpdate(req.user.id, { location: { lat, lng, updatedAt: new Date() } });
  res.json({ success: true });
});

app.get('/api/agents/locations', auth, adminOnly, async (req, res) => {
  res.json(await Agent.find({ active: true, 'location.lat': { $exists: true } }).select('name location'));
});

// ===== PRODUCTS =====
app.get('/api/products', auth, async (req, res) => {
  const { cat, search, parent } = req.query;
  const filter = { active: true };
  if (cat && cat !== 'all') filter.category = cat;
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { sku: new RegExp(search, 'i') }, { color: new RegExp(search, 'i') }];
  if (parent !== undefined) filter.parentSku = parent;
  res.json(await Product.find(filter).sort('category name sku'));
});

app.get('/api/products/categories', auth, async (req, res) => {
  res.json((await Product.distinct('category', { category: { $ne: '' }, active: true })).sort());
});

app.get('/api/products/barcode/:code', auth, async (req, res) => {
  const product = await Product.findOne({ $or: [{ barcode: req.params.code }, { sku: req.params.code }], active: true });
  if (!product) return res.status(404).json({ error: 'not found' });
  const children = await Product.find({ parentSku: product.sku, active: true });
  res.json({ ...product.toObject(), children });
});

app.get('/api/products/:sku', auth, async (req, res) => {
  const product = await Product.findOne({ sku: req.params.sku });
  if (!product) return res.status(404).json({ error: 'not found' });
  const children = await Product.find({ parentSku: req.params.sku, active: true });
  res.json({ ...product.toObject(), children });
});

app.post('/api/products', auth, adminOnly, async (req, res) => {
  try {
    await Product.findOneAndUpdate({ sku: req.body.sku }, req.body, { upsert: true, new: true });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/products/:sku', auth, adminOnly, async (req, res) => {
  await Product.findOneAndUpdate({ sku: req.params.sku }, req.body);
  res.json({ success: true });
});

app.delete('/api/products/:sku', auth, adminOnly, async (req, res) => {
  const products = await Product.find({ $or: [{ sku: req.params.sku }, { parentSku: req.params.sku }] });
  for (const p of products) deleteLocalImage(p.imgLocal);
  await Product.deleteMany({ $or: [{ sku: req.params.sku }, { parentSku: req.params.sku }] });
  res.json({ success: true });
});

app.post('/api/products/:sku/image', auth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const imgLocal = '/uploads/' + req.file.filename;
  const old = await Product.findOne({ sku: req.params.sku });
  if (old?.imgLocal) deleteLocalImage(old.imgLocal);
  await Product.findOneAndUpdate({ sku: req.params.sku }, { imgLocal });
  res.json({ success: true, imgLocal });
});

app.post('/api/images/bulk', auth, upload.array('images', 500), async (req, res) => {
  const matched = [], unmatched = [];
  for (const file of req.files) {
    const skuName = path.parse(file.originalname).name;
    const imgLocal = '/uploads/' + file.filename;
    let p = await Product.findOne({ sku: skuName });
    if (!p) p = await Product.findOne({ sku: skuName.replace(/-V\d+$/, '') });
    if (p) {
      if (p.imgLocal) deleteLocalImage(p.imgLocal);
      await Product.findByIdAndUpdate(p._id, { imgLocal });
      matched.push(skuName);
    } else unmatched.push(file.originalname);
  }
  res.json({ matched, unmatched });
});

// ===== IMPORT EXCEL (Pepperi + Standard) =====
app.post('/api/import/excel', auth, adminOnly, uploadMem.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    // שמור את הקובץ האחרון
    fs.writeFileSync(LAST_EXCEL_PATH, req.file.buffer);

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const headers = rows[0].map(h => String(h || '').trim());
    const headersLower = headers.map(h => h.toLowerCase());

    // זיהוי פורמט Pepperi לפי כותרות
    const isPepperi = headers.some(h => h === 'Main Category') || headers.some(h => h.includes('קטלוג') || h.includes('מחיר'));

    // פונקציות עזר לחיפוש עמודות
    const gcExact = name => headers.findIndex(h => h === name);
    const gc = name => headersLower.findIndex(h => h.includes(name.toLowerCase()));

    let colSku, colParent, colName, colPrice, colColor, colQty, colCat, colImg, colDiscount;

    if (isPepperi) {
      // פורמט Pepperi - חיפוש מדויק כולל טיפול ברווחים
      colSku = headers.findIndex(h => h.trim() === 'קוד פריט');
      colParent = headers.findIndex(h => h.trim() === 'קוד כשף');
      colName = headers.findIndex(h => h.trim() === 'פנת');
      colPrice = headers.findIndex(h => h.trim() === 'מחיר סיטונאי');
      colColor = headers.findIndex(h => h.trim() === 'צבע פנ');
      colQty = headers.findIndex(h => h.trim() === 'פרחח');
      colCat = gcExact('Main Category');
      colImg = gcExact('Product picture URL');
      // חיפוש עמודת הנחה עם trim לכל כותרת
      colDiscount = headers.findIndex(h => h.trim().includes('הנחה'));
    } else {
      // פורמט סטנדרטי
      colName = gc('product name') !== -1 ? gc('product name') : gc('name');
      colSku = gc('sku');
      colParent = gc('parent');
      colPrice = gc('price');
      colColor = gc('color') !== -1 ? gc('color') : gc('colour');
      colQty = gc('quantity') !== -1 ? gc('quantity') : gc('available');
      colCat = gc('tag') !== -1 ? gc('tag') : gc('category');
      colImg = gc('picture') !== -1 ? gc('picture') : gc('image');
      colDiscount = gc('discount') !== -1 ? gc('discount') : gc('allow');
    }

    // איסוף כל ה-SKU החדשים
    const newSkus = new Set();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row[colSku] == null) continue;
      const sku = String(row[colSku]).trim();
      if (sku) newSkus.add(sku);
    }

    // עדכון מוצרים לא פעילים
    const existingProducts = await Product.find({}).select('sku imgLocal active removedAt');
    const existingMap = {};
    for (const p of existingProducts) existingMap[p.sku] = p;
    const now = new Date();

    for (const p of existingProducts) {
      if (newSkus.has(p.sku)) {
        if (!p.active) await Product.findOneAndUpdate({ sku: p.sku }, { active: true, removedAt: null });
      } else {
        if (p.active) await Product.findOneAndUpdate({ sku: p.sku }, { active: false, removedAt: now });
      }
    }

    // ייבוא שורות
    let added = 0, updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row[colSku] == null) continue;
      const sku = String(row[colSku]).trim();
      if (!sku) continue;

      const rawName = colName >= 0 ? String(row[colName] || '') : '';
      const category = colCat >= 0 ? String(row[colCat] || '') : '';
      const allowRaw = colDiscount >= 0 ? row[colDiscount] : 1;
      const imgUrl = colImg >= 0 ? String(row[colImg] || '') : '';
      const productName = (rawName && rawName !== 'False') ? rawName : category;

      const productData = {
        sku,
        parentSku: colParent >= 0 ? String(row[colParent] || '') : '',
        name: productName || sku,
        category,
        price: colPrice >= 0 ? (parseFloat(row[colPrice]) || 0) : 0,
        color: colColor >= 0 ? String(row[colColor] || '') : '',
        qty: colQty >= 0 ? (parseInt(row[colQty]) || 0) : 0,
        imgUrl,
        allowDiscount: !(allowRaw === 0 || allowRaw === '0'),
        active: true,
        removedAt: null
      };

      if (existingMap[sku]) {
        await Product.findOneAndUpdate({ sku }, productData);
        updated++;
      } else {
        await Product.create(productData);
        added++;
      }
    }

    await cleanupOldRemovedImages();
    res.json({ success: true, added, updated, total: added + updated, format: isPepperi ? 'pepperi' : 'standard' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== הורד אקסל אחרון =====
app.get('/api/import/excel/last', auth, adminOnly, (req, res) => {
  if (!fs.existsSync(LAST_EXCEL_PATH)) return res.status(404).json({ error: 'לא נמצא קובץ קודם' });
  res.download(LAST_EXCEL_PATH, 'last_import.xlsx');
});

// ===== CUSTOMERS =====
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

// ===== ORDERS =====
app.get('/api/orders', auth, async (req, res) => {
  const filter = req.user.role === 'admin' ? {} : { agentId: req.user.id };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.isReturn) filter.isReturn = req.query.isReturn === 'true';
  res.json(await Order.find(filter).sort('-createdAt').limit(200));
});

app.post('/api/orders', auth, async (req, res) => {
  const orderNum = 'ORD-' + Date.now();
  await Order.create({ ...req.body, orderNum, agentId: req.user.id, agentName: req.user.name });
  for (const item of req.body.items || []) {
    await Product.findOneAndUpdate({ sku: item.sku }, { $inc: { qty: req.body.isReturn ? item.qty : -item.qty } });
  }
  res.json({ success: true, orderNum });
});

app.put('/api/orders/:id/status', auth, async (req, res) => {
  await Order.findByIdAndUpdate(req.params.id, { status: req.body.status });
  res.json({ success: true });
});

// ===== QUICKSELL =====
app.get('/api/quicksell/:token', async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);
    const filter = { parentSku: '', active: true };
    if (data.categories?.length) filter.category = { $in: data.categories };
    const products = await Product.find(filter).sort('category name');
    const result = await Promise.all(products.map(async p => ({
      ...p.toObject(),
      children: await Product.find({ parentSku: p.sku, active: true })
    })));
    res.json({ products: result, agentName: data.agentName, customerName: data.customerName });
  } catch {
    res.status(400).json({ error: 'invalid link' });
  }
});

app.post('/api/quicksell/create', auth, async (req, res) => {
  const { customerId, categories } = req.body;
  const customer = customerId ? await Customer.findById(customerId) : null;
  const token = jwt.sign({ agentId: req.user.id, agentName: req.user.name, customerId, customerName: customer?.name || '', categories: categories || [] }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ link: `${req.protocol}://${req.get('host')}/catalog/${token}`, token });
});

app.post('/api/quicksell/:token/order', async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);
    await Order.create({ ...req.body, orderNum: 'QS-' + Date.now(), agentId: data.agentId, agentName: data.agentName, customerId: data.customerId, customerName: data.customerName || req.body.customerName, status: 'new' });
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'invalid link' });
  }
});

// ===== STATS =====
app.get('/api/stats/overview', auth, adminOnly, async (req, res) => {
  const [products, customers, orders, agents] = await Promise.all([
    Product.countDocuments({ parentSku: '', active: true }),
    Customer.countDocuments(),
    Order.countDocuments({ isReturn: false }),
    Agent.countDocuments({ role: 'agent', active: true })
  ]);
  const revenue = await Order.aggregate([{ $match: { isReturn: false, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]);
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

// ===== SETTINGS =====
app.get('/api/settings', auth, async (req, res) => {
  const rows = await Settings.find();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  res.json(s);
});

app.post('/api/settings', auth, adminOnly, async (req, res) => {
  for (const [key, value] of Object.entries(req.body))
    await Settings.findOneAndUpdate({ key }, { key, value }, { upsert: true });
  res.json({ success: true });
});

// ===== STATIC =====
app.get('/catalog/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'catalog.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => console.log(`FieldPro v2 פועל על פורט ${PORT}`));
