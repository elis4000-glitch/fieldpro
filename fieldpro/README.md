# FieldPro — אפליקציית סוכני שטח 🚀

## הפעלה מקומית (מחשב)

```bash
# 1. התקן תלויות
npm install

# 2. הפעל את השרת
npm start

# 3. פתח בדפדפן
http://localhost:3000
```

## העלאה לאינטרנט (חינמי) — Render.com

### שלב 1 — העלה ל-GitHub
```bash
git init
git add .
git commit -m "FieldPro v1.0"
git remote add origin https://github.com/YOUR_USERNAME/fieldpro.git
git push -u origin main
```

### שלב 2 — חבר ל-Render
1. היכנס ל-https://render.com (חשבון חינמי)
2. לחץ **New → Web Service**
3. בחר את ה-GitHub repository שלך
4. הגדרות:
   - **Name:** fieldpro
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. לחץ **Create Web Service**
6. תוך 2-3 דקות האפליקציה תהיה חיה!

### שלב 3 — כתובת האפליקציה
```
https://fieldpro.onrender.com
```

---

## העלאה חלופית — Railway.app

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## מבנה הפרויקט

```
fieldpro/
├── server/
│   └── index.js          ← Backend (Express + SQLite)
├── public/
│   ├── index.html         ← Frontend PWA
│   ├── manifest.json      ← PWA manifest
│   ├── sw.js              ← Service Worker (offline)
│   └── icons/             ← אייקונים לאפליקציה
├── data/                  ← נוצר אוטומטית
│   ├── fieldpro.db        ← SQLite database
│   └── uploads/           ← תמונות מוצרים
└── package.json
```

## API Endpoints

| Method | Path | תיאור |
|--------|------|--------|
| GET | /api/products | כל המוצרים |
| POST | /api/products | הוספת מוצר |
| PUT | /api/products/:sku | עדכון מוצר |
| DELETE | /api/products/:sku | מחיקת מוצר |
| POST | /api/products/:sku/image | העלאת תמונה לפריט |
| POST | /api/images/bulk | העלאת תמונות מרובות |
| POST | /api/import/excel | ייבוא Excel |
| GET | /api/orders | כל ההזמנות |
| POST | /api/orders | הזמנה חדשה |
| GET | /api/customers | לקוחות |
| POST | /api/customers | לקוח חדש |
| GET | /api/settings | הגדרות |
| POST | /api/settings | שמירת הגדרות |

## PWA — התקנה על iPad/iPhone

1. פתח את כתובת האפליקציה ב-Safari
2. לחץ על כפתור השיתוף ↑
3. בחר **"הוסף למסך הבית"**
4. האפליקציה תיפתח כאפליקציה מלאה ללא דפדפן!

## Offline

האפליקציה עובדת ללא אינטרנט:
- הקטלוג נשמר מקומית
- הזמנות נשמרות ונשלחות אוטומטית בחיבור
