# 🛒 Free POS Web App (Firebase + Web Based)

A free, simple but powerful **Point of Sale (POS)** web app designed for **small stores, sari-sari shops, market stalls, and home businesses**.

Runs in the **browser (mobile + desktop)**  
Uses **Firebase (free tier)**  
No subscriptions • No licenses • You control the data

---

## 🚀 What this project does

✔️ Product selection by category  
✔️ Add to cart / remove / change quantity  
✔️ Supports **Kg and pcs** (including partial Kg)  
✔️ Discount per checkout  
✔️ Automatic total and change  
✔️ Receipt history  
✔️ Stock management  
✔️ Shift system  
✔️ Finance tracking (income, profit, remit, expenses)  
✔️ Lending / credit (utang) feature  
✔️ Admin & cashier accounts  
✔️ Sound effects & modern UI  

---

# 🧰 Requirements

To install this system you need:

- A Google account
- Internet connection
- A computer or phone
- Basic copy-paste ability 😊

You **do NOT** need:
✖️ programming experience  
✖️ a paid hosting plan  
✖️ your own server  

---

# 🔥 Step 1 — Create Firebase project

1. Go to https://console.firebase.google.com
2. Click **Add project**
3. Enter any project name
4. Disable Google Analytics (optional)
5. Click **Create project**

---

# 📦 Step 2 — Enable Firestore Database

1. In Firebase console sidebar choose **Firestore Database**
2. Click **Create database**
3. Choose:
   - Start in **production mode**
4. Select your region
5. Create

---

# 🔐 Step 3 — Enable Authentication

1. Go to **Authentication**
2. Click **Get Started**
3. Choose **Email / Password**
4. Enable and save

---

# 👥 Step 4 — Create first admin account

1. Authentication → **Users**
2. Click **Add user**
3. Enter:
   - email (any)
   - password
4. Save

Later inside the app, you will define:
- role = admin
- cashier accounts

---

# 🗂 Step 5 — Create Firestore collections
Create the following collections:

products

sales

shifts

employees

lending

expenses

categories

You don’t need to add fields yet — the system will create them when you use it.

---

# 💾 Step 6 — Download / Clone this repository

Option A: ZIP download

- click **Code → Download ZIP**
- extract on your computer

Option B: Git

git clone <your-repository-link>


---

# ⚙️ Step 7 — Insert your Firebase config

1. Go to Firebase console → Project settings
2. Scroll to **Your apps**
3. Click **</> Web**
4. Register app → continue
5. Copy the config code:

const firebaseConfig = {
apiKey: "...",
authDomain: "...",
projectId: "...",
storageBucket: "...",
messagingSenderId: "...",
appId: "..."
};

6. Open `app.js` (or your config file)
7. Replace the existing config with your own

---

# 🌍 Step 8 — Deploy (make it live)

Install Firebase CLI (only once):
npm install -g firebase-tools

Login:
firebase login

Initialize project inside folder:
firebase init

Choose:

- Hosting
- Use existing project → select your Firebase project
- Public folder: `public`  (or folder where `index.html` is)
- Configure as single page app: **yes**
- Overwrite index.html → **no**

Deploy:
firebase deploy


Your POS is now live 🎉  
Firebase will give you a URL like:


---

# 🧪 Step 9 — First run

Login using the account you created earlier

Then:

1. Add employees (admin page)
2. Add products (stocks page)
3. Start a shift
4. Make a test sale
5. View receipt and finance records

---

# 📚 Features explained

### 👩‍💼 Roles
- Admin → full control
- Cashier → POS, shift, receipts only

### 🛍 Products & Stocks
- add/edit/delete products
- auto stock deduction
- category grouping
- search
- low stock warnings

### 🧾 Receipts
- view all transactions
- filter by cashier & date
- delete (admin only)
- export CSV

### 💸 Finance
- income
- profit
- remit
- expenses
- daily / weekly / monthly / yearly view

### 🤝 Lending / Utang
- lend items to a customer
- full or partial payment
- debt tracking
- updates stock & sales correctly

---

# 🛡 Security notes

- each business should deploy **their own Firebase**
- do not share credentials
- admins should keep passwords private

---

# ❤️ Credits

This project was built for a real small shop first — now shared for anyone who needs it.

Feel free to:

- fork
- modify
- improve
- share with friends

---

# ❓ Need help?

Open an **Issue** here on GitHub  
or message me and I’ll gladly assist.



