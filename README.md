# টাকা ইনকাম (Taka Income) — Backend Starter

এটি Node.js + Express + PostgreSQL ভিত্তিক **প্রাথমিক backend**। এটি নিজে থেকে কোনো বাস্তব আয় তৈরি করে না এবং এখনো bKash/Nagad/Rocket/USDT-এর কোনো provider API-তে সংযুক্ত নয়।

## নিরাপত্তায় যোগ করা হয়েছে
- Password hashing (bcrypt), server-side PostgreSQL sessions, rate limits ও Helmet
- Admin login-এ TOTP 2FA gate
- Production-এ `DATABASE_URL`, `SESSION_SECRET`, `APP_ORIGIN` ও payout encryption key না থাকলে সার্ভার শুরু হবে না
- নতুন withdrawal-এর payout তথ্য AES-256-GCM দিয়ে encrypt করে database-এ রাখা হয়
- Withdrawal-এর minimum $3; ব্যালেন্স শুধু ledger-এর verified entry থেকে আসে
- ক্লিক করলেই আয় যোগ হয় না; verified ad-network server callback ছাড়া earning entry বানাবেন না
- Admin-এর `paid` status কেবল রেকর্ড; provider receipt ছাড়া এটি টাকা পাঠায় না

## লোকাল টেস্ট
1. Node.js 20+ ও PostgreSQL ইনস্টল করুন।
2. `.env.example` কপি করে `.env` নাম দিন; নিজের local database values বসান।
3. `npm install`
4. PostgreSQL-এ `taka_income` database তৈরি করুন।
5. `npm run db:init`
6. `npm start`
7. `GET /api/health` দিয়ে health check করুন।

## Render + PostgreSQL সেটআপ
1. Render-এ একটি PostgreSQL database তৈরি করুন।
2. Render dashboard থেকে database-এর **Internal Database URL** কপি করুন; API service একই Render workspace/region-এ থাকলে সেটি `DATABASE_URL` হিসেবে ব্যবহার করুন। URL গোপন রাখুন।
3. GitHub repository-তে এই folder-এর ফাইলগুলো upload করুন; `.env` বা real secret কখনো commit করবেন না।
4. Render-এ **New + → Web Service** দিয়ে repository connect করুন। Runtime Node, Build Command `npm install`, Start Command `npm start` দিন।
5. Web Service → Environment-এ নিচের variable যোগ করুন:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = Render PostgreSQL-এর Internal Database URL
   - `SESSION_SECRET` = অন্তত 32 অক্ষরের অনন্য random secret
   - `APP_ORIGIN` = আপনার frontend-এর সম্পূর্ণ HTTPS origin (যেমন `https://your-frontend.example`); frontend না থাকলে production চালু করার আগে frontend URL নির্ধারণ করুন
   - `PAYOUT_ENCRYPTION_KEY` = `openssl rand -base64 32` দিয়ে তৈরি key
6. Deploy-এর আগে database schema initialize করতে Render Shell-এ `npm run db:init` চালান। Shell সুবিধা না থাকলে Render-এর one-off job/নিরাপদ migration workflow ব্যবহার করুন।
7. HTTPS, logs, backups, monitoring এবং test deployment যাচাই করুন।

**সতর্কতা:** `PAYOUT_ENCRYPTION_KEY` হারালে encrypted payout details আর পড়া যাবে না। এটি database থেকে আলাদা password manager/secret manager-এ নিরাপদে রাখুন। Key পরিবর্তনের আগে পুরোনো তথ্য decrypt করে re-encrypt করার পরিকল্পনা লাগবে।

## Admin ও 2FA
- `ADMIN_ID` শুধু label; এটি নিজে admin account তৈরি করে না।
- Public registration ব্যবহার করে কাউকে admin বানাবেন না। Production admin provisioning-এর জন্য আলাদা, নিরাপদ one-time setup/migration প্রয়োজন।
- `ADMIN_PASSWORD_HASH` ও `ADMIN_TOTP_SECRET` বর্তমানে secure admin provisioning flow দ্বারা স্বয়ংক্রিয়ভাবে সেট হয় না। Admin login enable করার আগে secure provisioning এবং recovery process বাস্তবায়ন ও পরীক্ষা করুন।

## পেমেন্ট ব্যবস্থা: কী বাকি
- bKash, Nagad, Rocket: অনুমোদিত merchant/business account, provider-এর official API credentials, webhook/callback signature verification, idempotency, transaction reconciliation এবং sandbox testing দরকার। Provider credentials ছাড়া এখানে API সংযোগ করা সম্ভব নয়।
- USDT BEP20: নিরাপদ payout provider বা পৃথক signer service, key management, address/chain validation, fee handling, transaction confirmation ও reconciliation দরকার। Wallet seed phrase/private key এই অ্যাপে বা chat-এ দেবেন না।
- বিজ্ঞাপন: বিজ্ঞাপন নেটওয়ার্কের policy ও server-side callback যাচাই করে তবেই ledger-এ earning যোগ করতে হবে। Self-click, misleading short links, বা অনুমোদনহীন incentivized traffic ব্যবহার করলে অ্যাকাউন্ট বন্ধ হতে পারে।
- Production-এর আগে CSRF protection, email verification/password reset, payout-data retention/deletion policy, fraud controls, privacy/terms, audit, backup restore drill ও independent security review যোগ করুন।

## API note
Withdrawal request তৈরি করা যায়, কিন্তু বাস্তব transfer হয় না। `approved`/`paid` status বদলানোর আগে provider-এ পেমেন্ট manually বা integrated system দিয়ে সম্পন্ন ও receipt reconcile করতে হবে। এই starter-এ কোনো payment provider client বা live API integration নেই।
