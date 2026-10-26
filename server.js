require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const speakeasy = require("speakeasy");
const crypto = require("crypto");
const { z } = require("zod");
const { pool } = require("./db");
const { encryptPayoutDetails, decryptPayoutDetails } = require("./payout-crypto");

const app = express();
const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  const required = ["DATABASE_URL", "SESSION_SECRET", "APP_ORIGIN", "PAYOUT_ENCRYPTION_KEY"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  if (process.env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters in production");
}

if (isProd) app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: process.env.APP_ORIGIN, credentials: true }));
app.use(express.json({ limit: "32kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  name: "taka.sid",
  secret: process.env.SESSION_SECRET || (isProd ? (()=>{throw new Error("SESSION_SECRET is required in production")})() : "local-development-only-secret-change-me"),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProd || process.env.COOKIE_SECURE === "true", maxAge: 1000*60*60*12 }
}));
app.use((req,res,next)=>{res.setHeader("Cache-Control","no-store"); next();});

const emailSchema = z.string().email().max(254);
const passwordSchema = z.string().min(10).max(128);
const allowedMethods = ["bKash","Nagad","Rocket","USDT_BEP20","OTHER_WALLET"];
const safeUser = r => ({ id:r.id, email:r.email, referralCode:r.referral_code, isAdmin:r.is_admin });

function requireAuth(req,res,next) {
  if (!req.session.user) return res.status(401).json({error:"লগইন করুন"});
  next();
}
function requireAdmin(req,res,next) {
  if (!req.session.user || !req.session.user.isAdmin) return res.status(403).json({error:"অ্যাডমিন অনুমতি প্রয়োজন"});
  next();
}
function makeCode(n=9) { return crypto.randomBytes(12).toString("base64url").slice(0,n); }

app.get("/api/health", (req,res)=>res.json({ok:true, service:"Taka Income API", mode:"starter"}));

app.post("/api/register", rateLimit({windowMs:60*60*1000,limit:8}), async (req,res,next)=>{
  try {
    const schema=z.object({email:emailSchema, password:passwordSchema, referralCode:z.string().max(30).optional()});
    const body=schema.parse(req.body);
    const email=body.email.toLowerCase();
    const hash=await bcrypt.hash(body.password,12);
    const referral=body.referralCode ? await pool.query("SELECT id FROM users WHERE referral_code=$1 AND is_active=true",[body.referralCode]) : {rows:[]};
    const result=await pool.query(
      "INSERT INTO users(email,password_hash,referral_code,referred_by) VALUES($1,$2,$3,$4) RETURNING *",
      [email,hash,makeCode(),referral.rows[0]?.id || null]
    );
    req.session.user=safeUser(result.rows[0]);
    res.status(201).json({user:req.session.user});
  } catch(e) { if(e.code==="23505") return res.status(409).json({error:"এই ইমেইল দিয়ে অ্যাকাউন্ট আছে"}); next(e); }
});

app.post("/api/login", rateLimit({windowMs:15*60*1000,limit:10}), async (req,res,next)=>{
  try {
    const body=z.object({email:emailSchema,password:z.string().min(1).max(128),totp:z.string().optional()}).parse(req.body);
    const r=await pool.query("SELECT * FROM users WHERE email=$1 AND is_active=true",[body.email.toLowerCase()]);
    const user=r.rows[0];
    if(!user || !(await bcrypt.compare(body.password,user.password_hash))) return res.status(401).json({error:"লগইন তথ্য সঠিক নয়"});
    if(user.is_admin) {
      if(!process.env.ADMIN_TOTP_SECRET) return res.status(503).json({error:"অ্যাডমিন 2FA এখনো কনফিগার করা হয়নি"});
      const valid=speakeasy.totp.verify({secret:process.env.ADMIN_TOTP_SECRET,encoding:"base32",token:body.totp||"",window:1});
      if(!valid) return res.status(401).json({error:"অ্যাডমিন 2FA কোড সঠিক নয়"});
    }
    req.session.regenerate(err=>{if(err)return next(err); req.session.user=safeUser(user); req.session.save(err2=>{if(err2)return next(err2);res.json({user:req.session.user});});});
  } catch(e){next(e);}
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>{res.clearCookie("taka.sid");res.json({ok:true});}));

app.get("/api/me",requireAuth,async(req,res,next)=>{
  try{
    const bal=await pool.query("SELECT COALESCE(SUM(amount_usd),0)::numeric(12,2) AS balance FROM ledger WHERE user_id=$1",[req.session.user.id]);
    const tx=await pool.query("SELECT id,amount_usd,kind,reference,note,created_at FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 50",[req.session.user.id]);
    res.json({user:req.session.user,balance:bal.rows[0].balance,ledger:tx.rows});
  }catch(e){next(e);}
});

app.post("/api/links",requireAuth,async(req,res,next)=>{
  try{
    const body=z.object({url:z.string().url().max(2048)}).parse(req.body);
    const u=new URL(body.url);
    if(!["http:","https:"].includes(u.protocol)) return res.status(400).json({error:"শুধু HTTP/HTTPS URL গ্রহণযোগ্য"});
    const code=makeCode(7);
    const r=await pool.query("INSERT INTO short_links(user_id,code,destination_url) VALUES($1,$2,$3) RETURNING code,destination_url,created_at",[req.session.user.id,code,u.toString()]);
    res.status(201).json({link:r.rows[0],shortPath:`/s/${code}`, note:"শর্ট লিংক ক্লিকের জন্য কোনো আয় স্বয়ংক্রিয়ভাবে যোগ হয় না; অনুমোদিত ad network integration দরকার।"});
  }catch(e){next(e);}
});
app.get("/api/links",requireAuth,async(req,res,next)=>{
  try{const r=await pool.query("SELECT code,destination_url,created_at,is_active FROM short_links WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[req.session.user.id]);res.json({links:r.rows});}catch(e){next(e);}
});
app.get("/s/:code",async(req,res,next)=>{
  try{
    const r=await pool.query("SELECT destination_url,is_active FROM short_links WHERE code=$1",[req.params.code]);
    if(!r.rows[0]||!r.rows[0].is_active)return res.status(404).send("লিংক পাওয়া যায়নি");
    // Do not credit earnings here. Only verified ad-network callbacks should create ledger entries.
    res.redirect(302,r.rows[0].destination_url);
  }catch(e){next(e);}
});

app.get("/api/withdrawals",requireAuth,async(req,res,next)=>{
 try{const r=await pool.query("SELECT id,amount_usd,method,status,admin_note,created_at,updated_at FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 50",[req.session.user.id]);res.json({withdrawals:r.rows});}catch(e){next(e);}
});
app.post("/api/withdrawals",requireAuth,async(req,res,next)=>{
 const client=await pool.connect();
 try{
  const body=z.object({amount:z.number().finite().min(3).max(100000),method:z.enum(allowedMethods),payoutDetails:z.string().min(3).max(250)}).parse(req.body);
  if(body.method==="USDT_BEP20" && !/^0x[a-fA-F0-9]{40}$/.test(body.payoutDetails)) return res.status(400).json({error:"USDT BEP20 address format সঠিক নয়"});
  await client.query("BEGIN");
  await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[req.session.user.id]);
  const bal=await client.query("SELECT COALESCE(SUM(amount_usd),0)::numeric(12,2) AS balance FROM ledger WHERE user_id=$1",[req.session.user.id]);
  if(Number(bal.rows[0].balance)<body.amount){await client.query("ROLLBACK");return res.status(400).json({error:"পর্যাপ্ত যাচাইকৃত ব্যালেন্স নেই"});}
  // Encrypt payout details before storing them in PostgreSQL. Production requires a 32-byte key.
  const encryptedPayoutDetails = encryptPayoutDetails(body.payoutDetails);
  const w=await client.query("INSERT INTO withdrawals(user_id,amount_usd,method,payout_details) VALUES($1,$2,$3,$4) RETURNING id,amount_usd,method,status,created_at",[req.session.user.id,body.amount,body.method,encryptedPayoutDetails]);
  await client.query("INSERT INTO ledger(user_id,amount_usd,kind,reference,note) VALUES($1,$2,'withdrawal_hold',$3,'Withdrawal requested')",[req.session.user.id,-body.amount,`withdrawal:${w.rows[0].id}`]);
  await client.query("COMMIT");res.status(201).json({withdrawal:w.rows[0],note:"আবেদন তৈরি হয়েছে; বাস্তব পেমেন্ট এখনো সংযুক্ত নয়।"});
 }catch(e){await client.query("ROLLBACK").catch(()=>{});next(e);}finally{client.release();}
});

app.get("/api/admin/withdrawals",requireAuth,requireAdmin,async(req,res,next)=>{
 try{const r=await pool.query("SELECT w.id,w.user_id,u.email,w.amount_usd,w.method,w.payout_details,w.status,w.created_at FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 200");res.json({withdrawals:r.rows.map(w=>({...w,payout_details:decryptPayoutDetails(w.payout_details)}))});}catch(e){next(e);}
});
app.post("/api/admin/withdrawals/:id/status",requireAuth,requireAdmin,async(req,res,next)=>{
 const client=await pool.connect();
 try{
  const body=z.object({status:z.enum(["approved","paid","rejected"]),note:z.string().max(500).optional()}).parse(req.body);
  await client.query("BEGIN");
  const r=await client.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",[req.params.id]);
  const w=r.rows[0]; if(!w){await client.query("ROLLBACK");return res.status(404).json({error:"আবেদন পাওয়া যায়নি"});}
  if(w.status==="paid"||w.status==="rejected"){await client.query("ROLLBACK");return res.status(409).json({error:"এই আবেদন ইতিমধ্যে চূড়ান্ত হয়েছে"});}
  if(body.status==="paid") { 
    // This only records admin confirmation. It does NOT transfer funds; reconcile against provider receipt first.
    await client.query("UPDATE withdrawals SET status='paid',admin_note=$1,updated_at=NOW() WHERE id=$2",[body.note||"Admin marked paid",w.id]);
  } else if(body.status==="rejected") {
    await client.query("UPDATE withdrawals SET status='rejected',admin_note=$1,updated_at=NOW() WHERE id=$2",[body.note||"Rejected",w.id]);
    await client.query("INSERT INTO ledger(user_id,amount_usd,kind,reference,note) VALUES($1,$2,'withdrawal_release',$3,$4)",[w.user_id,Number(w.amount_usd),`withdrawal:${w.id}`,body.note||"Withdrawal rejected; funds released"]);
  } else {
    await client.query("UPDATE withdrawals SET status='approved',admin_note=$1,updated_at=NOW() WHERE id=$2",[body.note||"Approved",w.id]);
  }
  await client.query("INSERT INTO audit_log(admin_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'withdrawal',$3,$4)",[req.session.user.id,`withdrawal_${body.status}`,String(w.id),JSON.stringify({note:body.note||""})]);
  await client.query("COMMIT");res.json({ok:true,status:body.status,note:"স্ট্যাটাস আপডেট হয়েছে; পেমেন্ট provider API সংযুক্ত নয়।"});
 }catch(e){await client.query("ROLLBACK").catch(()=>{});next(e);}finally{client.release();}
});

app.use((err,req,res,next)=>{
 if(err instanceof z.ZodError) return res.status(400).json({error:"ইনপুট যাচাই ব্যর্থ",details:err.issues.map(i=>({field:i.path.join("."),message:i.message}))});
 if(err.code==="23505") return res.status(409).json({error:"এই তথ্য আগে থেকেই আছে"});
 console.error(err.message);
 res.status(500).json({error:"সার্ভারে সমস্যা হয়েছে"});
});
const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log(`Taka Income API listening on ${port}`));