require("dotenv").config();
const express=require("express");
const cors=require("cors");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const crypto=require("crypto");
const http=require("http");
const {Server}=require("socket.io");
const helmet=require("helmet");
const rateLimit=require("express-rate-limit");
const path=require("path");
const pool=require("../db");
const {callProvider,providerStatus,verifyWebhook}=require("./payments");
const TelegramBingoService = require("./telegram");
const DEMO_MODE=process.env.DEMO_MODE!=="false";

const app=express(), server=http.createServer(app);
const corsOptions = {
  origin: true,
  credentials: true
};
const io=new Server(server,{cors:{origin:"*",methods:["GET","POST"]}});
const telegramService = new TelegramBingoService({ pool, io });
const PORT=process.env.PORT||4000, SECRET=process.env.JWT_SECRET;

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "*"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "*"],
      connectSrc: ["'self'", "*", "ws:", "wss:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "*"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:", "*"],
      imgSrc: ["'self'", "data:", "https:", "*"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["*"]
    }
  }
}));
app.use(cors(corsOptions));
app.use("/api/payments/webhook",express.raw({type:"application/json",limit:"64kb"}));
app.use(express.json({limit:"20kb"}));
const apiLimiter=rateLimit({windowMs:15*60*1000,max:300,validate:{trustProxy:false},standardHeaders:"draft-8",legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,max:20,validate:{trustProxy:false},standardHeaders:"draft-8",legacyHeaders:false,skipSuccessfulRequests:true});
app.use("/api",apiLimiter);
app.use(["/api/register","/api/login","/api/password-reset/request","/api/password-reset/confirm"],authLimiter);
const fs=require("fs");
const rootFrontend=path.join(__dirname,"..","..","habesha-bingo-frontend");
const backendFrontend=path.join(__dirname,"..","Habesha-bingo-frontend");
const frontendDir=fs.existsSync(rootFrontend)?rootFrontend:backendFrontend;
app.use(express.static(frontendDir));
app.get(["/","/admin","/owner"],(req,res)=>res.sendFile(path.join(frontendDir,"index.html")));
app.get(["/admin.html","/owner.html"],(req,res)=>res.redirect("/"));

async function init(){
  if(!SECRET||SECRET.length<32||SECRET==="replace-with-a-long-random-secret")throw new Error("JWT_SECRET must be a random value of at least 32 characters");
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, phone VARCHAR(30) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'PLAYER', is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS wallets(
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    main_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (main_balance >= 0),
    vip_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (vip_balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS games(
    id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL DEFAULT 'Main Game', entry NUMERIC(12,2) NOT NULL DEFAULT 10,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','finished','cancelled')),
    prize_pool NUMERIC(14,2) NOT NULL DEFAULT 0, platform_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
    current_number INTEGER CHECK (current_number IS NULL OR current_number BETWEEN 1 AND 600),
    called_numbers JSONB NOT NULL DEFAULT '[]'::jsonb, winner_id BIGINT REFERENCES users(id),
    winner_ticket JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS tickets(
    id BIGSERIAL PRIMARY KEY, game_id BIGINT REFERENCES games(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, numbers JSONB NOT NULL,
    UNIQUE(game_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS transactions(
    id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id),
    type VARCHAR(30) NOT NULL, wallet VARCHAR(20) NOT NULL DEFAULT 'main', amount NUMERIC(14,2) NOT NULL,
    balance_before NUMERIC(14,2), balance_after NUMERIC(14,2), status VARCHAR(20) NOT NULL DEFAULT 'pending', method VARCHAR(30), reference VARCHAR(150),
    provider VARCHAR(30), provider_reference VARCHAR(150), idempotency_key VARCHAR(100), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    failure_reason TEXT, processed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS winners(
    id BIGSERIAL PRIMARY KEY, game_id BIGINT UNIQUE REFERENCES games(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, prize_amount NUMERIC(14,2) NOT NULL,
    ticket_snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions(
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens(
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS audit_logs(
    id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL, entity_type VARCHAR(50), entity_id BIGINT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address VARCHAR(45), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS app_settings(
    key VARCHAR(80) PRIMARY KEY, value VARCHAR(200) NOT NULL,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS support_messages (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL, phone VARCHAR(30) NOT NULL,
    subject VARCHAR(150) NOT NULL DEFAULT 'General Inquiry', message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
    admin_reply TEXT, replied_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    replied_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS payment_accounts (
    id BIGSERIAL PRIMARY KEY,
    method VARCHAR(50) NOT NULL,
    account_number VARCHAR(100) NOT NULL,
    account_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_game ON tickets(game_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
  CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_support_status ON support_messages(status);`);
  await pool.query(`ALTER TABLE transactions 
    ADD COLUMN IF NOT EXISTS balance_before NUMERIC(14,2), 
    ADD COLUMN IF NOT EXISTS balance_after NUMERIC(14,2), 
    ADD COLUMN IF NOT EXISTS provider VARCHAR(30), 
    ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(150), 
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100), 
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb, 
    ADD COLUMN IF NOT EXISTS failure_reason TEXT, 
    ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS account_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS bank_name VARCHAR(50),
    ADD COLUMN IF NOT EXISTS admin_notes TEXT,
    ADD COLUMN IF NOT EXISTS admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payout_proof TEXT`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_transactions_type_status ON transactions(type, status)");
  await pool.query("INSERT INTO app_settings(key,value) VALUES ('demo_mode','true'),('demo_entry_amount','10'),('demo_min_deposit','10'),('demo_min_withdrawal','100'),('demo_number_max','600') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_settings.key IN ('demo_entry_amount', 'demo_min_deposit')");
  await pool.query(`
    INSERT INTO app_settings(key, value) VALUES 
      ('telegram_bot_token', '8608274368:AAE_kGjR_P61Ev2BQPbLgTdvoBYPyAJ1bPg'),
      ('telegram_bot_username', 'HbeshabingoBot'),
      ('telegram_group_title', 'Hbesha bingo'),
      ('telegram_group_id', '-1002766090768'),
      ('telegram_sync_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query("UPDATE games SET entry = 10 WHERE status = 'waiting' AND entry = 8");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE, ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'PLAYER'");
  await pool.query("ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE");
  const telebirrAcc = (await pool.query("SELECT id FROM payment_accounts WHERE method = 'TeleBirr'")).rows[0];
  if (!telebirrAcc) {
    await pool.query(
      "INSERT INTO payment_accounts (method, account_number, account_name, is_active) VALUES ('TeleBirr', '0951666750', 'Tirualem', TRUE)"
    );
  }
  await pool.query(`
    DO $$ 
    BEGIN
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('PLAYER', 'ADMIN', 'OWNER'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);
  // 0. Remove old placeholder owner (0911000000 / 'Habesha Bingo Owner') permanently from PostgreSQL
  await pool.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = '0911000000' OR name = 'Habesha Bingo Owner')").catch(() => {});
  await pool.query("DELETE FROM tickets WHERE user_id IN (SELECT id FROM users WHERE phone = '0911000000' OR name = 'Habesha Bingo Owner')").catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE phone = '0911000000' OR name = 'Habesha Bingo Owner')").catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE phone = '0911000000' OR name = 'Habesha Bingo Owner')").catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id IN (SELECT id FROM users WHERE phone = '0911000000' OR name = 'Habesha Bingo Owner')").catch(() => {});
  await pool.query("DELETE FROM users WHERE phone = '0911000000' OR name = 'Habesha Bingo Owner'").catch(() => {});

  // 1. Ensure Real Owner Account (0951666750) Exists in PostgreSQL
  const ownerPhone = process.env.OWNER_PHONE || "0951666750";
  const ownerName = process.env.OWNER_NAME || "abirham";
  const ownerPassword = process.env.OWNER_PASSWORD || "A@12345";
  const ownerHash = await bcrypt.hash(ownerPassword, 12);
  const existingOwner = (await pool.query("SELECT id, phone, name FROM users WHERE phone = $1 OR (role = 'OWNER' AND phone = $1) LIMIT 1", [ownerPhone])).rows[0];
  if (!existingOwner) {
    const newOwner = (await pool.query("INSERT INTO users(name, phone, password_hash, role, is_active) VALUES($1, $2, $3, 'OWNER', TRUE) RETURNING id", [ownerName, ownerPhone, ownerHash])).rows[0];
    await pool.query("INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING", [newOwner.id]);
  } else {
    await pool.query("UPDATE users SET role = 'OWNER', is_active = TRUE WHERE id = $1", [existingOwner.id]);
  }

  // 2. Ensure Admin Account Exists in PostgreSQL
  const existingAdmin = (await pool.query("SELECT id, phone, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!existingAdmin) {
    const adminPhone = process.env.ADMIN_PHONE || "0919307468";
    const adminName = process.env.ADMIN_NAME || "adissu";
    const adminPassword = process.env.ADMIN_PASSWORD || "Ad@1234";
    const adminHash = await bcrypt.hash(adminPassword, 12);
    const newAdmin = (await pool.query("INSERT INTO users(name, phone, password_hash, role, is_active) VALUES($1, $2, $3, 'ADMIN', TRUE) RETURNING id", [adminName, adminPhone, adminHash])).rows[0];
    await pool.query("INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING", [newAdmin.id]);
  } else {
    await pool.query("UPDATE users SET is_active = TRUE WHERE id = $1", [existingAdmin.id]);
  }
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT UNIQUE, ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(100)");
  await telegramService.init().catch(err => console.warn("[Telegram] Service init warning:", err.message));
}
function auth(req,res,next){
  const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  try{
    const payload=jwt.verify(token,SECRET);
    pool.query("SELECT u.id,u.name,u.phone,u.role,u.is_active FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()",[hashToken(payload.jti)]).then(result=>{
      const user=result.rows[0];
      if(!user||!user.is_active)return res.status(401).json({error:"Authentication required"});
      req.user={...user,role:String(user.role).toUpperCase(),jti:payload.jti};next();
    }).catch(()=>res.status(401).json({error:"Authentication required"}));
  }catch{return res.status(401).json({error:"Authentication required"})}
}
function requireRole(...roles){
  const allowed = roles.map(r => String(r).toUpperCase());
  return (req, res, next) => {
    const userRole = String(req.user?.role).toUpperCase();
    if (allowed.includes("ADMIN") && userRole === "OWNER") return next();
    if (allowed.includes(userRole)) return next();
    return res.status(403).json({ error: "Access denied" });
  };
}
async function audit(req,action,entityType=null,entityId=null,details={}){
  await pool.query("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details,ip_address) VALUES($1,$2,$3,$4,$5,$6)",[req.user.id,action,entityType,entityId,JSON.stringify(details),req.ip]);
}
function text(value,max){return typeof value==="string"?value.trim().slice(0,max):""}
function validPhone(value){return /^[0-9+() -]{5,30}$/.test(value)}
function validName(value){return value.length>=2&&/^[\p{L}][\p{L} .'-]*$/u.test(value)}
function validWallet(value){return value==="main"||value==="vip"}
const methods=new Set(["TeleBirr","CBE Birr","M-Pesa","E-Birr"]);
function amount(value){const parsed=Number(value);return Number.isFinite(parsed)&&parsed>0&&parsed<=1000000?Math.round(parsed*100)/100:null}
async function setting(key,fallback){const row=(await pool.query("SELECT value FROM app_settings WHERE key=$1",[key])).rows[0];return row?.value??fallback}
function walletColumn(wallet){return wallet==="vip"?"vip_balance":"main_balance"}
async function changeBalance(client,{userId,wallet,delta,type,status="completed",method=null,reference=null,transactionId=null,idempotencyKey=null,accountName=null,bankName=null,adminNotes=null,adminId=null}){
  if(!validWallet(wallet)||!Number.isFinite(delta)||delta===0)throw new Error("INVALID_BALANCE_CHANGE");
  if(idempotencyKey){
    const existing=(await client.query("SELECT id,type,wallet,amount,status FROM transactions WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE",[userId,idempotencyKey])).rows[0];
    if(existing){
      if(existing.type!==type||existing.wallet!==wallet||Number(existing.amount)!==delta)throw new Error("IDEMPOTENCY_CONFLICT");
      return {transactionId:existing.id,status:existing.status,existing:true};
    }
  }
  const column=walletColumn(wallet);
  let row=(await client.query(`SELECT ${column} FROM wallets WHERE user_id=$1 FOR UPDATE`,[userId])).rows[0];
  if(!row){
    await client.query(`INSERT INTO wallets(user_id, main_balance, vip_balance) VALUES($1, 0.00, 0.00) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    row=(await client.query(`SELECT ${column} FROM wallets WHERE user_id=$1 FOR UPDATE`,[userId])).rows[0];
  }
  const before=Number(row ? row[column] : 0),after=Math.round((before+delta)*100)/100;
  if(after<0)throw new Error("INSUFFICIENT_BALANCE");
  await client.query(`UPDATE wallets SET ${column}=$1,updated_at=now() WHERE user_id=$2`,[after,userId]);
  let ledgerId=transactionId;
  if(transactionId){
    await client.query("UPDATE transactions SET amount=$1,balance_before=$2,balance_after=$3,status=$4 WHERE id=$5",[delta,before,after,status,transactionId]);
  }else{
    ledgerId=(await client.query("INSERT INTO transactions(user_id,type,wallet,amount,balance_before,balance_after,status,method,reference,idempotency_key,account_name,bank_name,admin_notes,admin_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id",[userId,type,wallet,delta,before,after,status,method,reference,idempotencyKey,accountName,bankName,adminNotes,adminId])).rows[0].id;
  }
  return {before,after,transactionId:ledgerId};
}
function providerMethod(value){
  const normalized=text(value,40).toLowerCase().replace(/[^a-z0-9]+/g,"-");
  const map = {
    "telebirr": "TeleBirr",
    "cbe-birr": "CBE Birr",
    "cbe": "CBE Bank",
    "cbe-bank": "CBE Bank",
    "commercial-bank-of-ethiopia": "CBE Bank",
    "awash": "Awash Bank",
    "awash-bank": "Awash Bank",
    "abyssinia": "Bank of Abyssinia",
    "bank-of-abyssinia": "Bank of Abyssinia",
    "mpesa": "M-Pesa",
    "m-pesa": "M-Pesa",
    "e-birr": "E-Birr",
    "ebirr": "E-Birr"
  };
  return map[normalized] || (value && value.length >= 3 ? text(value, 40) : null);
}
function providerMetadata(result){return JSON.stringify({status:result.status,checkoutUrl:result.checkoutUrl||null})}
async function markPaymentFailed(transactionId,reason){
  const client=await pool.connect();
  try{await client.query("BEGIN");
    const tx=(await client.query("SELECT * FROM transactions WHERE id=$1 FOR UPDATE",[transactionId])).rows[0];
    if(!tx||tx.status!=="pending"){await client.query("ROLLBACK");return}
    if(tx.type==="withdrawal")await changeBalance(client,{userId:tx.user_id,wallet:tx.wallet,delta:Math.abs(Number(tx.amount)),type:"refund",method:"provider",reference:"Failed payment #"+transactionId});
    await client.query("UPDATE transactions SET status='rejected',failure_reason=$1,processed_at=now() WHERE id=$2",[String(reason).slice(0,500),transactionId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}
async function completePayment(transactionId,providerReference,metadata){
  const client=await pool.connect();
  try{await client.query("BEGIN");
    const tx=(await client.query("SELECT * FROM transactions WHERE id=$1 FOR UPDATE",[transactionId])).rows[0];
    if(!tx){await client.query("ROLLBACK");return "missing"}
    if(tx.status!=="pending"){await client.query("COMMIT");return "already_processed"}
    if(tx.type==="deposit")await changeBalance(client,{userId:tx.user_id,wallet:tx.wallet,delta:Number(tx.amount),type:"deposit",status:"completed",method:tx.method,reference:tx.reference,transactionId});
    else if(tx.type!=="withdrawal"){await client.query("ROLLBACK");throw new Error("Unsupported payment transaction")}
    await client.query("UPDATE transactions SET status='completed',provider_reference=COALESCE($1,provider_reference),metadata=$2,processed_at=now() WHERE id=$3",[providerReference,metadata||"{}",transactionId]);
    await client.query("COMMIT");return "completed";
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}
function hashToken(value){return crypto.createHash("sha256").update(String(value)).digest("hex")}
async function createSession(u){
  const jti=crypto.randomUUID(),token=jwt.sign({id:u.id,name:u.name,phone:u.phone,role:String(u.role).toUpperCase()},SECRET,{expiresIn:"7d",jwtid:jti});
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '7 days')",[u.id,hashToken(jti)]);
  return token;
}
function resetToken(){return crypto.randomBytes(32).toString("base64url")}
function randomTicket(){
  const cols = [
    Array.from({length:15}, (_,i)=>i+1),
    Array.from({length:15}, (_,i)=>i+16),
    Array.from({length:15}, (_,i)=>i+31),
    Array.from({length:15}, (_,i)=>i+46),
    Array.from({length:15}, (_,i)=>i+61)
  ];
  const card = [];
  for(let c=0; c<5; c++){
    const pool = [...cols[c]];
    for(let i=pool.length-1; i>0; i--){const j=crypto.randomInt(i+1); [pool[i],pool[j]]=[pool[j],pool[i]];}
    card.push(pool.slice(0,5));
  }
  return [0,1,2,3,4].map(r => [card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
}
function validTicket(ticket){
  return Array.isArray(ticket)&&ticket.length===5&&ticket.every(row=>Array.isArray(row)&&row.length===5&&row.every(n=>Number.isInteger(n)&&n>=1&&n<=600))&&new Set(ticket.flat()).size===25;
}
function isBingo(ticket,called){
  const s=new Set(called),m=ticket.map(r=>r.map(n=>s.has(n)));
  for(let r=0;r<5;r++)if(m[r].every(Boolean))return true;
  for(let c=0;c<5;c++)if([0,1,2,3,4].every(r=>m[r][c]))return true;
  return [0,1,2,3,4].every(i=>m[i][i])||[0,1,2,3,4].every(i=>m[i][4-i]);
}
async function currentGame(){
  const client=await pool.connect();
  try{await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)",[390711]);
    const r=await client.query("SELECT * FROM games WHERE status IN ('waiting','running') ORDER BY id DESC LIMIT 1");
    if(r.rows[0]){await client.query("COMMIT");return r.rows[0]}
    const x=await client.query("INSERT INTO games(name, entry) VALUES('Main Game', 10) RETURNING *");
    await client.query("COMMIT");return x.rows[0];
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}
async function publicGame(g){
  const p=await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[g.id]);
  return {...g,players:p.rows[0].count,called_numbers:g.called_numbers||[]};
}
async function recalc(gameId){
  const g=(await pool.query("SELECT * FROM games WHERE id=$1",[gameId])).rows[0];
  const p=Number((await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[gameId])).rows[0].count);
  const feePer=p>=3?2:0, poolAmount=p*(Number(g.entry)-feePer);
  await pool.query("UPDATE games SET prize_pool=$1,platform_fee=$2 WHERE id=$3",[poolAmount,p*feePer,gameId]);
}
async function broadcast(id){
  const g=(await pool.query("SELECT * FROM games WHERE id=$1",[id])).rows[0];
  if(g){
    const pub = await publicGame(g);
    io.to("game:"+id).emit("update", pub);
    io.emit("update", pub);
  }
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"Habesha Bingo API"}));

app.post("/api/register",async(req,res)=>{
  try{
    const name=text(req.body.name,100),phone=text(req.body.phone,30),password=typeof req.body.password==="string"?req.body.password:"";
    if(!name||name.length<2)return res.status(400).json({error:"Name must be at least 2 characters"});
    if(!validName(name))return res.status(400).json({error:"Please provide a valid name"});
    if(!phone||!validPhone(phone))return res.status(400).json({error:"Please enter a valid phone number"});
    if(!password||password.length<8)return res.status(400).json({error:"Password must be at least 8 characters"});
    if(password.length>128)return res.status(400).json({error:"Password is too long (maximum 128 characters)"});
    const h=await bcrypt.hash(password,12),client=await pool.connect();
    try{await client.query("BEGIN");
      const u=(await client.query("INSERT INTO users(name,phone,password_hash,role) VALUES($1,$2,$3,'PLAYER') RETURNING id,name,phone,role",[name,phone,h])).rows[0];
      await client.query("INSERT INTO wallets(user_id) VALUES($1)",[u.id]);
      await client.query("COMMIT");
      res.json({token:await createSession(u),user:u});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }catch(e){
    if(e.code==="23505")return res.status(409).json({error:"An account with this phone number already exists"});
    console.error(e);res.status(500).json({error:e.message||"Could not create account"});
  }
});
app.post("/api/login",async(req,res)=>{
  const phone=text(req.body.phone,30),password=typeof req.body.password==="string"?req.body.password:"",u=(await pool.query("SELECT * FROM users WHERE phone=$1 AND is_active=TRUE",[phone])).rows[0];
  const passwordHash=u?.password_hash||"$2b$12$C6UzMDM.H6dfI/f/IKcEe.4cH8fR2XhJf8i0s8j9v5z1Q3x2v5j6u";
  if(!(await bcrypt.compare(password,passwordHash))||!u)return res.status(401).json({error:"Invalid login"});
  const user={id:u.id,name:u.name,phone:u.phone,role:String(u.role).toUpperCase()};
  res.json({token:await createSession(user),user});
});
app.post("/api/telegram/webapp-login",async(req,res)=>{
  try{
    const tgUser=req.body.user;
    if(!tgUser||!tgUser.id)return res.status(400).json({error:"Missing Telegram user"});
    const tgId=Number(tgUser.id);
    const tgUsername=tgUser.username||"";
    const name=[tgUser.first_name,tgUser.last_name].filter(Boolean).join(" ")||`TG_${tgId}`;

    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      let u=(await client.query("SELECT u.*, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.telegram_id = $1",[tgId])).rows[0];
      if(!u){
        const placeholderPhone=`TG${tgId}`;
        const existing=(await client.query("SELECT id FROM users WHERE phone = $1",[placeholderPhone])).rows[0];
        if(existing){
          await client.query("UPDATE users SET telegram_id = $1, telegram_username = $2 WHERE id = $3",[tgId,tgUsername,existing.id]);
          u=(await client.query("SELECT u.*, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1",[existing.id])).rows[0];
        }else{
          const dummyPassword=crypto.randomBytes(16).toString("hex");
          const hash=await bcrypt.hash(dummyPassword,12);
          const newUser=(await client.query("INSERT INTO users(name,phone,password_hash,role,telegram_id,telegram_username) VALUES($1,$2,$3,'PLAYER',$4,$5) RETURNING *",[name,placeholderPhone,hash,tgId,tgUsername])).rows[0];
          await client.query("INSERT INTO wallets(user_id,main_balance,vip_balance) VALUES($1,0.00,0.00) ON CONFLICT (user_id) DO NOTHING",[newUser.id]);
          u={...newUser,main_balance:"0.00",vip_balance:"0.00"};
        }
      }
      await client.query("COMMIT");
      const token=await createSession(u);
      res.json({
        token,
        user:{id:u.id,name:u.name,phone:u.phone,role:String(u.role).toUpperCase()},
        wallet:{main_balance:u.main_balance||"0.00",vip_balance:u.vip_balance||"0.00"}
      });
    }catch(dbErr){
      await client.query("ROLLBACK");throw dbErr;
    }finally{client.release()}
  }catch(err){
    console.error("[Telegram WebApp Login Error]:",err.message);
    res.status(500).json({error:"Could not authenticate Telegram user"});
  }
});
app.post("/api/logout",auth,async(req,res)=>{
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",[hashToken(req.user.jti)]);
  res.json({ok:true});
});
app.get("/api/me",auth,async(req,res)=>{
  const u=(await pool.query("SELECT id,name,phone,role FROM users WHERE id=$1",[req.user.id])).rows[0];
  const w=(await pool.query("SELECT main_balance,vip_balance FROM wallets WHERE user_id=$1",[req.user.id])).rows[0];
  if(!u||!w)return res.status(401).json({error:"Account not found"});
  res.json({user:{...u,role:String(u.role).toUpperCase()},wallet:w});
});
app.post("/api/password-reset/request",async(req,res)=>{
  const phone=text(req.body.phone,30),u=(await pool.query("SELECT id FROM users WHERE phone=$1 AND is_active=TRUE",[phone])).rows[0];
  if(u){
    const raw=resetToken();
    await pool.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",[u.id]);
    await pool.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[u.id,hashToken(raw)]);
  }
  res.json({message:"If the account exists, reset instructions have been sent"});
});
app.post("/api/password-reset/confirm",async(req,res)=>{
  const token=text(req.body.token,200),password=typeof req.body.password==="string"?req.body.password:"";
  if(token.length<20||password.length<8)return res.status(400).json({error:"A valid reset token and password of at least 8 characters are required"});
  const client=await pool.connect();
  try{await client.query("BEGIN");
    const row=(await client.query("SELECT id,user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",[hashToken(token)])).rows[0];
    if(!row){await client.query("ROLLBACK");return res.status(400).json({error:"Invalid or expired reset token"})}
    const passwordHash=await bcrypt.hash(password,12);
    await client.query("UPDATE users SET password_hash=$1 WHERE id=$2",[passwordHash,row.user_id]);
    await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE id=$1",[row.id]);
    await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[row.user_id]);
    await client.query("COMMIT");
    res.json({message:"Password reset successfully"});
  }catch(error){await client.query("ROLLBACK");console.error(error);res.status(500).json({error:"Could not reset password"})}finally{client.release()}
});
app.get("/api/admin/users",auth,requireRole("ADMIN"),async(req,res)=>{
  const search=text(req.query.search,80),users=await pool.query("SELECT id,name,phone,role,is_active,created_at FROM users WHERE phone != '0911000000' AND name != 'Habesha Bingo Owner' AND ($1::varchar='' OR name ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%') ORDER BY id DESC LIMIT 500",[search]);
  res.json({users:users.rows});
});
app.get("/api/admin/overview",auth,requireRole("ADMIN"),async(req,res)=>{
  const [users,wallets,active,completed,pending,activity]=await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE is_active)::int AS active FROM users"),
    pool.query("SELECT COALESCE(SUM(main_balance+vip_balance),0) AS total FROM wallets"),
    pool.query("SELECT id,name,prize_pool FROM games WHERE status IN ('waiting','running') ORDER BY id DESC LIMIT 1"),
    pool.query("SELECT COUNT(*)::int AS count FROM games WHERE status='finished'"),
    pool.query("SELECT COUNT(*)::int AS count FROM transactions WHERE status='pending'"),
    pool.query("SELECT action,entity_type,entity_id,created_at FROM audit_logs ORDER BY id DESC LIMIT 10")
  ]);
  const current=active.rows[0]||null;
  let currentPlayers=0;
  if(current)currentPlayers=Number((await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[current.id])).rows[0].count);
  res.json({demo:true,users:users.rows[0],totalDemoWalletBalance:wallets.rows[0].total,activeGame:current,currentPlayers,completedGames:completed.rows[0].count,pendingTransactions:pending.rows[0].count,recentActivity:activity.rows});
});
app.get("/api/admin/users/:id",auth,requireRole("ADMIN"),async(req,res)=>{
  const userId=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(userId))return res.status(400).json({error:"Invalid user id"});
  const user=(await pool.query("SELECT id,name,phone,role,is_active,created_at FROM users WHERE id=$1",[userId])).rows[0];
  if(!user)return res.status(404).json({error:"User not found"});
  const wallet=(await pool.query("SELECT main_balance,vip_balance,updated_at FROM wallets WHERE user_id=$1",[userId])).rows[0];
  const transactions=(await pool.query("SELECT id,type,wallet,amount,status,reference,created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[userId])).rows;
  res.json({user,wallet,transactions});
});
app.patch("/api/admin/users/:id",auth,requireRole("ADMIN"),async(req,res)=>{
  const userId=Number.parseInt(req.params.id,10),role=req.body.role?String(req.body.role).toUpperCase():null;
  if(!Number.isInteger(userId))return res.status(400).json({error:"Invalid user id"});
  const targetUser=(await pool.query("SELECT id,role,is_active FROM users WHERE id=$1",[userId])).rows[0];
  if(!targetUser)return res.status(404).json({error:"User not found"});

  // 1. Strict Owner Protection
  if(targetUser.role==="OWNER"){
    if(req.user.role!=="OWNER"){
      return res.status(403).json({error:"Access denied: Owner account is protected and cannot be modified by Admin"});
    }
    if(req.body.is_active===false){
      return res.status(400).json({error:"Owner account cannot be disabled"});
    }
    if(role&&role!=="OWNER"){
      return res.status(400).json({error:"Owner role cannot be changed"});
    }
  }

  // 2. Admin Permissions: Admin can only manage regular PLAYER accounts
  if(req.user.role!=="OWNER"){
    if(targetUser.role!=="PLAYER"){
      return res.status(403).json({error:"Access denied: Admins can only manage regular Player accounts"});
    }
    if(role&&role!=="PLAYER"){
      return res.status(403).json({error:"Only Owner can assign administrative roles"});
    }
  }

  if(typeof req.body.is_active!=="boolean"&&!role)return res.status(400).json({error:"Valid role or is_active status is required"});
  if(userId===req.user.id&&(role==="PLAYER"||req.body.is_active===false))return res.status(400).json({error:"You cannot remove your own administrative access"});

  const isActive=typeof req.body.is_active==="boolean"?req.body.is_active:targetUser.is_active;
  const finalRole=role||targetUser.role;

  const updated=(await pool.query("UPDATE users SET role=$1,is_active=$2 WHERE id=$3 RETURNING id,name,phone,role,is_active,created_at",[finalRole,isActive,userId])).rows[0];
  await audit(req,"user.updated","user",userId,{role:updated.role,is_active:updated.is_active});
  res.json({user:updated});
});
app.get("/api/admin/wallets",auth,requireRole("ADMIN"),async(req,res)=>{
  const wallets=await pool.query(`
    SELECT u.id AS user_id, u.name, u.phone, u.role, u.is_active,
           COALESCE(w.main_balance, 0.00)::numeric AS main_balance,
           COALESCE(w.vip_balance, 0.00)::numeric AS vip_balance,
           w.updated_at
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
    WHERE u.phone != '0911000000' AND u.name != 'Habesha Bingo Owner'
    ORDER BY u.id DESC
  `);
  res.json({wallets:wallets.rows});
});
app.post("/api/admin/wallets/:userId/adjust",auth,requireRole("ADMIN"),async(req,res)=>{
  const userId=Number.parseInt(req.params.userId,10),wallet=req.body.wallet||"main",delta=Number(req.body.delta),reason=text(req.body.reason,200);
  if(!Number.isInteger(userId)||!validWallet(wallet)||!Number.isFinite(delta)||delta===0||!reason)return res.status(400).json({error:"Valid wallet, non-zero delta and reason are required"});
  const targetUser=(await pool.query("SELECT id,role FROM users WHERE id=$1",[userId])).rows[0];
  if(!targetUser)return res.status(404).json({error:"User not found"});
  if(targetUser.role==="OWNER"&&req.user.role!=="OWNER")return res.status(403).json({error:"Access denied: Cannot adjust Owner wallet"});
  const client=await pool.connect();
  try{await client.query("BEGIN");
    const result=await changeBalance(client,{userId,wallet,delta,type:delta>0?"refund":"platform_fee",method:"admin",reference:reason});
    await client.query("COMMIT");
    await audit(req,"wallet.adjusted","user",userId,{wallet,delta,reason,transactionId:result.transactionId});
    res.json({ok:true,wallet,userId,balance:result.after,transactionId:result.transactionId});
  }catch(error){await client.query("ROLLBACK");if(error.message==="INSUFFICIENT_BALANCE")return res.status(400).json({error:"Adjustment would create a negative balance"});if(error.message==="WALLET_NOT_FOUND")return res.status(404).json({error:"Wallet not found"});console.error(error);res.status(500).json({error:"Could not adjust wallet"})}finally{client.release()}
});
app.get("/api/admin/games",auth,requireRole("ADMIN"),async(req,res)=>{
  const status=["waiting","running","finished","cancelled"].includes(req.query.status)?req.query.status:null;
  const games=await pool.query("SELECT g.*,COUNT(t.id)::int AS players FROM games g LEFT JOIN tickets t ON t.game_id=g.id WHERE ($1::varchar IS NULL OR g.status=$1) GROUP BY g.id ORDER BY g.id DESC LIMIT 200",[status]);
  res.json({games:games.rows});
});
app.get("/api/admin/games/:id/players",auth,requireRole("ADMIN"),async(req,res)=>{
  const gameId=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(gameId))return res.status(400).json({error:"Invalid game id"});
  const players=await pool.query("SELECT t.id AS ticket_id,u.id AS user_id,u.name,u.phone,t.numbers,t.created_at FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.game_id=$1 ORDER BY t.id",[gameId]);
  res.json({players:players.rows});
});
app.patch("/api/admin/games/:id/status",auth,requireRole("ADMIN"),async(req,res)=>{
  const gameId=Number.parseInt(req.params.id,10),status=String(req.body.status||"").toLowerCase();
  if(!Number.isInteger(gameId)||!["waiting","running","finished","cancelled"].includes(status))return res.status(400).json({error:"Invalid game status"});
  const result=await pool.query("UPDATE games SET status=$1,finished_at=CASE WHEN $1 IN ('finished','cancelled') THEN COALESCE(finished_at,now()) ELSE finished_at END WHERE id=$2 RETURNING *",[status,gameId]);
  const game=result.rows[0];
  if(!game)return res.status(404).json({error:"Game not found"});
  await audit(req,"game.status_changed","game",gameId,{status});
  io.to("game:"+gameId).emit("update",await publicGame(game));
  res.json({game:await publicGame(game)});
});
app.get("/api/admin/winners",auth,requireRole("ADMIN"),async(req,res)=>{
  const winners=await pool.query("SELECT w.id,w.game_id,w.user_id,u.name,u.phone,w.prize_amount,w.ticket_snapshot,w.created_at FROM winners w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 200");
  res.json({winners:winners.rows});
});
app.get("/api/admin/audit-logs",auth,requireRole("ADMIN"),async(req,res)=>{
  const logs=await pool.query("SELECT a.id,a.user_id,u.name,a.action,a.entity_type,a.entity_id,a.details,a.ip_address,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200");
  res.json({logs:logs.rows});
});
app.get("/api/admin/settings",auth,requireRole("ADMIN"),async(req,res)=>{
  const rows=await pool.query("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'demo_%' ORDER BY key");
  res.json({demo:true,settings:rows.rows});
});
app.patch("/api/admin/settings",auth,requireRole("ADMIN"),async(req,res)=>{
  const allowed={demo_entry_amount:"demo_entry_amount",demo_min_deposit:"demo_min_deposit",demo_min_withdrawal:"demo_min_withdrawal",demo_number_max:"demo_number_max"},updates=[];
  for(const [key,value] of Object.entries(req.body||{})){if(!allowed[key])continue;const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<1||parsed>1000000)return res.status(400).json({error:"Invalid demo setting"});updates.push([key,String(parsed)])}
  for(const [key,value] of updates)await pool.query("INSERT INTO app_settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()",[key,value,req.user.id]);
  await audit(req,"settings.updated","settings",null,{keys:updates.map(update=>update[0])});
  res.json({demo:true,updated:updates.map(update=>update[0])});
});
app.get("/api/games/available",auth,async(req,res)=>{
  const games=await pool.query("SELECT g.*,COUNT(t.id)::int AS players FROM games g LEFT JOIN tickets t ON t.game_id=g.id WHERE g.status='waiting' GROUP BY g.id ORDER BY g.id DESC LIMIT 50");
  res.json({games:games.rows});
});

app.post("/api/games",auth,requireRole("ADMIN"),async(req,res)=>{
  const name=text(req.body.name,100)||"Main Game",entry=amount(req.body.entry??await setting("demo_entry_amount","10"));
  if(entry===null)return res.status(400).json({error:"Entry fee must be a positive amount"});
  const client=await pool.connect();
  try{await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)",[390711]);
    const active=await client.query("SELECT id FROM games WHERE status IN ('waiting','running') LIMIT 1");
    if(active.rowCount){await client.query("ROLLBACK");return res.status(409).json({error:"An active game already exists"})}
    const game=(await client.query("INSERT INTO games(name,entry) VALUES($1,$2) RETURNING *",[name,entry])).rows[0];
    await client.query("COMMIT");
    await audit(req,"game.created","game",game.id,{name:game.name,entry:game.entry});
    res.status(201).json({game:await publicGame(game)});
  }catch(error){await client.query("ROLLBACK");console.error(error);res.status(500).json({error:"Could not create game"})}finally{client.release()}
});

app.get("/api/game",async(req,res)=>{
  let userId=null;
  const h=req.headers.authorization;
  if(h&&h.startsWith("Bearer ")){
    try{const p=jwt.verify(h.slice(7),SECRET);userId=p.id;}catch(_){}
  }
  let g=await currentGame(); await recalc(g.id);
  g=(await pool.query("SELECT * FROM games WHERE id=$1",[g.id])).rows[0];
  const t=userId?(await pool.query("SELECT numbers FROM tickets WHERE game_id=$1 AND user_id=$2",[g.id,userId])).rows[0]:null;
  res.json({game:await publicGame(g),ticket:t?.numbers||null});
});
app.post("/api/join",auth,async(req,res)=>{
  const requestedGameId=req.body.gameId?Number(req.body.gameId):null;
  let g;
  if(requestedGameId){
    const r=await pool.query("SELECT * FROM games WHERE id=$1 AND status='waiting'",[requestedGameId]);
    g=r.rows[0];
    if(!g)return res.status(404).json({error:"Game not found or not waiting"});
  }else{
    g=await currentGame();
  }
  if(g.status!=="waiting")return res.status(400).json({error:"Game already started"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const lockedGame=(await client.query("SELECT * FROM games WHERE id=$1 FOR UPDATE",[g.id])).rows[0];
    if(lockedGame.status!=="waiting")throw new Error("started");
    if((await client.query("SELECT id FROM tickets WHERE game_id=$1 AND user_id=$2",[g.id,req.user.id])).rows[0])throw new Error("joined");
    const ticket=randomTicket();
    if(!validTicket(ticket))throw new Error("ticket");
    await changeBalance(client,{userId:req.user.id,wallet:"main",delta:-Number(g.entry),type:"game_entry",method:"game",reference:"Game #"+g.id});
    await client.query("INSERT INTO tickets(game_id,user_id,numbers) VALUES($1,$2,$3)",[g.id,req.user.id,JSON.stringify(ticket)]);
    const c=(await client.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[g.id])).rows[0].count;
    if(c>=1)await client.query("UPDATE games SET status='running' WHERE id=$1",[g.id]);
    await client.query("COMMIT"); await recalc(g.id); await broadcast(g.id);
    const updatedGame = (await pool.query("SELECT * FROM games WHERE id=$1",[g.id])).rows[0];
    if(c===1 && updatedGame){
      telegramService.notifyGameStarted(g.id, g.entry, updatedGame.prize_pool, c).catch(()=>{});
    }
    res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");
    const message=e.message==="joined"?"Already joined":e.message==="INSUFFICIENT_BALANCE"?"At least 10 ETB is required in the main wallet":"Could not join game";
    res.status(400).json({error:message});
  }finally{client.release()}
});

app.post("/api/wallet/deposit",auth,async(req,res)=>{
  const value=amount(req.body.amount),wallet=req.body.wallet||"main",rawMethod=req.body.method,method=providerMethod(rawMethod)||text(rawMethod,40)||"TeleBirr",reference=text(req.body.reference,150);
  const minAllowed = wallet === "vip" ? 50 : 10;
  if(value===null||value<minAllowed)return res.status(400).json({error:`Minimum deposit is ${minAllowed} ETB`});
  if(!validWallet(wallet)||!method)return res.status(400).json({error:"Invalid wallet or payment provider"});

  // Deduplication: prevent duplicate deposits with same TxID / reference
  if (reference && reference.trim().length >= 4 && !reference.toLowerCase().includes("demo") && !reference.toLowerCase().includes("telegram")) {
    const existingRef = (await pool.query("SELECT id, status FROM transactions WHERE reference = $1 AND type = 'deposit' LIMIT 1", [reference.trim()])).rows[0];
    if (existingRef) {
      return res.status(409).json({ error: "ይህ የክፍያ ቁጥር (TxID) አስቀድሞ ተመዝግቧል (Transaction reference already submitted)" });
    }
  }

  const idempotencyKey=text(req.get("Idempotency-Key"),100)||crypto.randomUUID();
  const duplicate=(await pool.query("SELECT id,type,wallet,amount,method,status,provider_reference,metadata FROM transactions WHERE user_id=$1 AND idempotency_key=$2",[req.user.id,idempotencyKey])).rows[0];
  if(duplicate&& (duplicate.type!=="deposit"||duplicate.wallet!==wallet||Number(duplicate.amount)!==value||duplicate.method!==method))return res.status(409).json({error:"Idempotency key was reused with different payment details"});
  if(duplicate)return res.status(duplicate.status==="completed"?200:202).json({message:"Deposit request already submitted",paymentStatus:duplicate.status,transactionId:duplicate.id,providerReference:duplicate.provider_reference,metadata:duplicate.metadata});
  
  const initialStatus = DEMO_MODE ? "completed" : "pending";
  const result=await pool.query("INSERT INTO transactions(user_id,type,wallet,amount,status,method,reference,provider,idempotency_key,metadata) VALUES($1,'deposit',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",[req.user.id,wallet,value,initialStatus,method,reference,DEMO_MODE?"DEMO":method,idempotencyKey,JSON.stringify({demo:DEMO_MODE})]);
  const transactionId=result.rows[0].id;

  if (initialStatus === "completed") {
    await changeBalance(pool, {
      userId: req.user.id,
      wallet: wallet,
      delta: value,
      type: "deposit",
      status: "completed",
      method: method,
      reference: reference,
      transactionId: transactionId
    });
  }

  if (typeof telegramService !== "undefined" && telegramService && telegramService.notifyDepositPending && !DEMO_MODE) {
    telegramService.notifyDepositPending(req.user.id, req.user.name || "Player", value, method, reference).catch(() => {});
  }

  const updatedWallet = (await pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id=$1", [req.user.id])).rows[0] || { main_balance: "0.00", vip_balance: "0.00" };

  res.status(initialStatus === "completed" ? 200 : 202).json({
    message: initialStatus === "completed"
      ? `የ ${value.toFixed(2)} ETB ገቢ በተሳካ ሁኔታ ወደ ዋሌትዎ ገብቷል! አሁኑኑ ካርቴላ መምረጥ ይችላሉ።`
      : `የ ${value.toFixed(2)} ETB የገቢ ጥያቄዎ በተሳካ ሁኔታ ቀርቧል! በአስተዳዳሪው ተረጋግጦ ይገባል (Deposit submitted for verification).`,
    paymentStatus: initialStatus,
    transactionId,
    wallet: updatedWallet
  });
});
app.get("/api/wallet/withdrawable", auth, async (req, res) => {
  try {
    const w = (await pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1", [req.user.id])).rows[0];
    const pendingRow = (await pool.query("SELECT COALESCE(SUM(ABS(amount)), 0)::numeric AS pending FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND status = 'pending'", [req.user.id])).rows[0];
    const minWithdrawal = Number(await setting("demo_min_withdrawal", 100));
    const mainBalance = Number(w?.main_balance || 0);
    const vipBalance = Number(w?.vip_balance || 0);
    const pending = Number(pendingRow?.pending || 0);
    res.json({
      main_balance: mainBalance,
      vip_balance: vipBalance,
      pending_withdrawals: pending,
      withdrawable_balance: mainBalance,
      min_withdrawal: minWithdrawal,
      currency: "ETB"
    });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch withdrawable balance" });
  }
});

app.get("/api/wallet/withdrawals", auth, async (req, res) => {
  try {
    const list = await pool.query(
      `SELECT id, amount, ABS(amount) as display_amount, wallet, status, method, reference, account_name, bank_name, provider_reference, failure_reason, created_at, updated_at
       FROM transactions
       WHERE user_id = $1 AND type = 'withdrawal'
       ORDER BY id DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ withdrawals: list.rows });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch withdrawal history" });
  }
});

app.post("/api/wallet/withdraw", auth, async (req, res) => {
  const user = (await pool.query("SELECT id, name, phone, is_active FROM users WHERE id = $1", [req.user.id])).rows[0];
  if (!user || user.is_active === false) {
    return res.status(403).json({ error: "Your account is not active. Please contact support." });
  }

  const value = amount(req.body.amount);
  const wallet = req.body.wallet || "main";
  const rawMethod = req.body.method;
  const method = providerMethod(rawMethod) || text(rawMethod, 40);
  const account = text(req.body.account, 50);
  const accountName = text(req.body.account_name || req.body.accountName || user.name, 100);
  const isAdult = req.body.is_adult === true || req.body.is_adult === "true" || req.body.confirm_18 === true || req.body.is_adult === "on";

  if (!isAdult) {
    return res.status(400).json({ error: "እድሜዎ ከ18 ዓመት በላይ መሆኑን ማረጋገጥ አለብዎት (18+ age confirmation required)" });
  }

  const minWithdrawal = Number(await setting("demo_min_withdrawal", 100));
  if (value === null || value < minWithdrawal) {
    return res.status(400).json({ error: `ዝቅተኛው የወጪ መጠን ${minWithdrawal} ETB ነው (Minimum withdrawal is ${minWithdrawal} ETB)` });
  }
  if (!validWallet(wallet)) {
    return res.status(400).json({ error: "ትክክለኛ ዋሌት ይምረጡ (Invalid wallet selected)" });
  }
  if (!method) {
    return res.status(400).json({ error: "የክፍያ ዘዴ ይምረጡ (Valid payment method is required)" });
  }
  if (!account || account.length < 5) {
    return res.status(400).json({ error: "ትክክለኛ የሂሳብ ወይም የስልክ ቁጥር ያስገቡ (Valid account or phone number is required)" });
  }
  if (!accountName || accountName.length < 3) {
    return res.status(400).json({ error: "የሂሳብ ባለቤት ሙሉ ስም ያስገቡ (Account holder full name is required for verification)" });
  }

  const client = await pool.connect();
  let transactionId;
  let ledger;
  try {
    await client.query("BEGIN");
    const idempotencyKey = text(req.get("Idempotency-Key"), 100) || crypto.randomUUID();

    ledger = await changeBalance(client, {
      userId: req.user.id,
      wallet,
      delta: -value,
      type: "withdrawal",
      status: "pending",
      method,
      reference: account,
      accountName,
      bankName: method,
      idempotencyKey
    });
    transactionId = ledger.transactionId;

    if (ledger.existing) {
      await client.query("COMMIT");
      return res.status(ledger.status === "completed" ? 200 : 202).json({
        message: "የወጪ ጥያቄዎ አስቀድሞ ተመዝግቧል (Withdrawal request already submitted)",
        paymentStatus: ledger.status,
        transactionId
      });
    }

    await client.query(
      "UPDATE transactions SET provider=$1, account_name=$2, bank_name=$3, metadata=$4 WHERE id=$5",
      [
        method,
        accountName,
        method,
        JSON.stringify({
          account_name: accountName,
          account_number: account,
          bank_name: method,
          requested_by_ip: req.ip,
          requested_at: new Date().toISOString()
        }),
        transactionId
      ]
    );

    await pool.query(
      "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
      [
        req.user.id,
        "withdrawal.requested",
        "transaction",
        transactionId,
        JSON.stringify({
          amount: value,
          method,
          account,
          accountName,
          balance_before: ledger.before,
          balance_after: ledger.after
        }),
        req.ip
      ]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ error: "በቂ ሊወጣ የሚችል ቀሪ ሂሳብ የለዎትም (Insufficient withdrawable balance)" });
    }
    if (e.message === "IDEMPOTENCY_CONFLICT") {
      return res.status(409).json({ error: "ይህ ጥያቄ በተለየ መረጃ አስቀድሞ ተልኳል (Idempotency conflict)" });
    }
    return res.status(500).json({ error: "የወጪ ጥያቄውን ማስተናገድ አልተቻለም: " + e.message });
  } finally {
    client.release();
  }

  // Telegram alert to admin
  try {
    if (typeof telegramService !== "undefined" && telegramService && telegramService.notifyAdminWithdrawalRequest) {
      telegramService.notifyAdminWithdrawalRequest(req.user.id, user.name, value, method, account, accountName).catch(() => {});
    }
  } catch (tErr) {}

  // Check if real automated payment provider is configured in environment
  const config = typeof providerConfig === "function" ? providerConfig(method) : null;
  const isAutomatedConfigured = config && config.withdrawalUrl && config.apiKey;

  if (isAutomatedConfigured) {
    try {
      const payment = await callProvider(method, "withdrawal", {
        amount: value,
        currency: "ETB",
        account,
        account_name: accountName,
        customer_reference: String(transactionId),
        callback_url: `${process.env.PUBLIC_API_URL || ""}/api/payments/webhook/${method.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      }, transactionId);

      if (payment.status === "success") {
        await pool.query(
          "UPDATE transactions SET status='completed', provider_reference=$1, processed_at=now() WHERE id=$2",
          [payment.providerReference, transactionId]
        );
        return res.status(200).json({
          message: "ገንዘቡ በተሳካ ሁኔታ ተላልፏል (Withdrawal completed via payment provider)",
          paymentStatus: "completed",
          transactionId,
          providerReference: payment.providerReference
        });
      } else {
        await pool.query(
          "UPDATE transactions SET provider_reference=$1, metadata=$2 WHERE id=$3",
          [payment.providerReference, providerMetadata(payment), transactionId]
        );
        return res.status(202).json({
          message: "የወጪ ጥያቄዎ በክፍያ አቅራቢው በሂደት ላይ ነው (Withdrawal is processing via provider)",
          paymentStatus: "processing",
          transactionId
        });
      }
    } catch (pErr) {
      console.warn("[Payout Provider Error]:", pErr.message);
    }
  }

  return res.status(202).json({
    message: `የ ${value.toFixed(2)} ETB የወጪ ጥያቄዎ በተሳካ ሁኔታ ቀርቧል! በአስተዳዳሪው ተረጋግጦ ወደ ${method} (${account}) ይላካል (Withdrawal submitted for admin payout verification).`,
    paymentStatus: "pending",
    transactionId,
    mode: "manual_payout_review"
  });
});

// ==================== ADMIN WITHDRAWALS MANAGEMENT ====================
app.get("/api/admin/withdrawals", auth, requireRole("ADMIN"), async (req, res) => {
  const status = ["pending", "approved", "completed", "rejected"].includes(req.query.status) ? req.query.status : null;
  const result = await pool.query(`
    SELECT t.id, t.user_id, u.name, u.phone, u.role, t.type, t.wallet,
           ABS(t.amount) AS amount, t.status, t.method, t.reference,
           t.account_name, t.bank_name, t.balance_before, t.balance_after,
           t.provider, t.provider_reference, t.failure_reason, t.admin_notes,
           t.admin_id, admin_u.name AS admin_name, t.processed_at, t.created_at
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users admin_u ON admin_u.id = t.admin_id
    WHERE t.type = 'withdrawal' AND ($1::varchar IS NULL OR t.status = $1)
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 200
  `, [status]);
  res.json({ withdrawals: result.rows });
});

app.post("/api/admin/withdrawals/:id/approve", auth, requireRole("ADMIN"), async (req, res) => {
  const transactionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(transactionId)) return res.status(400).json({ error: "Invalid withdrawal id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = (await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId])).rows[0];
    if (!tx || tx.type !== "withdrawal") throw new Error("NOT_FOUND");
    if (tx.status !== "pending") throw new Error("NOT_PENDING");

    await client.query(
      "UPDATE transactions SET status = 'approved', admin_id = $1, processed_at = now() WHERE id = $2",
      [req.user.id, transactionId]
    );

    await pool.query(
      "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
      [
        req.user.id,
        "withdrawal.approved",
        "transaction",
        transactionId,
        JSON.stringify({
          withdrawalId: transactionId,
          userId: tx.user_id,
          amount: Math.abs(Number(tx.amount)),
          method: tx.method,
          account: tx.reference
        }),
        req.ip
      ]
    );

    await client.query("COMMIT");

    if (typeof telegramService !== "undefined" && telegramService && telegramService.sendMessage) {
      const u = (await pool.query("SELECT telegram_id FROM users WHERE id = $1", [tx.user_id])).rows[0];
      if (u?.telegram_id) {
        telegramService.sendMessage(
          u.telegram_id,
          `✅ <b>የወጪ ጥያቄዎ ጸድቋል (Withdrawal Approved)!</b>\nመጠን: <b>${Math.abs(Number(tx.amount))} ETB</b>\nዘዴ: <b>${tx.method}</b> (${tx.reference})\nክፍያው እየተዘጋጀ ነው፤ በጥቂት ደቂቃዎች ውስጥ ይላካል።`
        ).catch(() => {});
      }
    }

    res.json({ ok: true, message: "Withdrawal approved. Status is now Approved (Unpaid)." });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.message === "NOT_PENDING") return res.status(409).json({ error: "Withdrawal is no longer pending" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ error: "Withdrawal request not found" });
    console.error(e);
    res.status(500).json({ error: "Could not approve withdrawal: " + e.message });
  } finally {
    client.release();
  }
});

app.post("/api/admin/withdrawals/:id/complete", auth, requireRole("ADMIN"), async (req, res) => {
  const transactionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(transactionId)) return res.status(400).json({ error: "Invalid withdrawal id" });
  const txRef = text(req.body.transactionReference || req.body.reference || req.body.providerReference, 150);
  const notes = text(req.body.notes || req.body.adminNotes, 500);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = (await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId])).rows[0];
    if (!tx || tx.type !== "withdrawal") throw new Error("NOT_FOUND");
    if (!["pending", "approved"].includes(tx.status)) throw new Error("ALREADY_PROCESSED");

    await client.query(
      "UPDATE transactions SET status = 'completed', provider_reference = $1, admin_notes = $2, admin_id = $3, processed_at = now() WHERE id = $4",
      [txRef || "MANUAL_PAID", notes, req.user.id, transactionId]
    );

    await pool.query(
      "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
      [
        req.user.id,
        "withdrawal.completed",
        "transaction",
        transactionId,
        JSON.stringify({
          withdrawalId: transactionId,
          userId: tx.user_id,
          amount: Math.abs(Number(tx.amount)),
          method: tx.method,
          account: tx.reference,
          reference: txRef,
          notes
        }),
        req.ip
      ]
    );

    await client.query("COMMIT");

    if (typeof telegramService !== "undefined" && telegramService && telegramService.sendMessage) {
      const u = (await pool.query("SELECT telegram_id FROM users WHERE id = $1", [tx.user_id])).rows[0];
      if (u?.telegram_id) {
        telegramService.sendMessage(
          u.telegram_id,
          `🎉 <b>ገንዘብዎ በተሳካ ሁኔታ ተላልፏል (Payment Completed)!</b>\nመጠን: <b>${Math.abs(Number(tx.amount))} ETB</b>\nዘዴ: <b>${tx.method}</b> (${tx.reference})\nየማረጋገጫ ቁጥር (TxID): <b>${txRef || "Completed"}</b>\nመልካም ጨዋታ!`
        ).catch(() => {});
      }
    }

    res.json({ ok: true, message: "Withdrawal marked as completed and paid." });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.message === "ALREADY_PROCESSED") return res.status(409).json({ error: "Withdrawal has already been processed" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ error: "Withdrawal request not found" });
    console.error(e);
    res.status(500).json({ error: "Could not complete withdrawal: " + e.message });
  } finally {
    client.release();
  }
});

app.post("/api/admin/withdrawals/:id/reject", auth, requireRole("ADMIN"), async (req, res) => {
  const transactionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(transactionId)) return res.status(400).json({ error: "Invalid withdrawal id" });
  const reason = text(req.body.reason || req.body.failure_reason, 500) || "Verification failed";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = (await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId])).rows[0];
    if (!tx || tx.type !== "withdrawal") throw new Error("NOT_FOUND");
    if (!["pending", "approved"].includes(tx.status)) throw new Error("ALREADY_PROCESSED");

    const refundAmount = Math.abs(Number(tx.amount));
    const walletCol = tx.wallet === "vip" ? "vip_balance" : "main_balance";
    const wRow = (await client.query(`SELECT ${walletCol} FROM wallets WHERE user_id = $1 FOR UPDATE`, [tx.user_id])).rows[0];
    const beforeBal = Number(wRow[walletCol]);
    const afterBal = Math.round((beforeBal + refundAmount) * 100) / 100;

    await client.query(`UPDATE wallets SET ${walletCol} = $1, updated_at = now() WHERE user_id = $2`, [afterBal, tx.user_id]);

    await client.query(
      "UPDATE transactions SET status = 'rejected', failure_reason = $1, admin_id = $2, processed_at = now() WHERE id = $3",
      [reason, req.user.id, transactionId]
    );

    await client.query(
      "INSERT INTO transactions(user_id, type, wallet, amount, balance_before, balance_after, status, method, reference, failure_reason) VALUES($1, 'refund', $2, $3, $4, $5, 'completed', 'admin', $6, $7)",
      [
        tx.user_id,
        tx.wallet,
        refundAmount,
        beforeBal,
        afterBal,
        `Refund for rejected withdrawal #${transactionId}`,
        reason
      ]
    );

    await pool.query(
      "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
      [
        req.user.id,
        "withdrawal.rejected",
        "transaction",
        transactionId,
        JSON.stringify({
          withdrawalId: transactionId,
          userId: tx.user_id,
          amount: refundAmount,
          reason,
          balance_before: beforeBal,
          balance_after: afterBal
        }),
        req.ip
      ]
    );

    await client.query("COMMIT");

    if (typeof telegramService !== "undefined" && telegramService && telegramService.sendMessage) {
      const u = (await pool.query("SELECT telegram_id FROM users WHERE id = $1", [tx.user_id])).rows[0];
      if (u?.telegram_id) {
        telegramService.sendMessage(
          u.telegram_id,
          `⚠️ <b>የወጪ ጥያቄዎ ውድቅ ተደርጓል (Withdrawal Rejected)</b>\nመጠን: <b>${refundAmount} ETB</b>\nምክንያት: <i>${reason}</i>\n💰 ገንዘቡ ሙሉ በሙሉ ወደ ዋሌትዎ ተመልሷል (አሁን መጫወት ወይም እንደገና መጠየቅ ይችላሉ)።`
        ).catch(() => {});
      }
    }

    res.json({ ok: true, message: `Withdrawal rejected and ${refundAmount.toFixed(2)} ETB refunded to player wallet.` });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.message === "ALREADY_PROCESSED") return res.status(409).json({ error: "Withdrawal has already been processed" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ error: "Withdrawal request not found" });
    console.error(e);
    res.status(500).json({ error: "Could not reject withdrawal: " + e.message });
  } finally {
    client.release();
  }
});

app.post("/api/payments/webhook/:provider", async (req, res) => {
  const method = providerMethod(req.params.provider), raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (!method || !verifyWebhook(method, raw, req.headers["x-payment-signature"] || req.headers["x-signature"])) return res.status(401).json({ error: "Invalid payment webhook" });
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")) } catch { return res.status(400).json({ error: "Invalid webhook payload" }) }
  const providerReference = text(payload.reference || payload.transaction_id || payload.transactionId || payload.id, 150), status = providerStatus(payload.status || payload.payment_status || payload.transaction_status);
  if (!providerReference) return res.status(400).json({ error: "Missing provider transaction reference" });
  const tx = (await pool.query("SELECT * FROM transactions WHERE provider=$1 AND provider_reference=$2", [method, providerReference])).rows[0];
  if (!tx) return res.status(404).json({ error: "Payment transaction not found" });
  if (payload.amount !== undefined && Number(payload.amount) !== Math.abs(Number(tx.amount))) return res.status(400).json({ error: "Payment amount mismatch" });
  try {
    if (status === "failed") await markPaymentFailed(tx.id, "Provider webhook reported failure");
    else if (status === "success") await completePayment(tx.id, providerReference, JSON.stringify({ status: "success" }));
    else await pool.query("UPDATE transactions SET metadata=$1 WHERE id=$2 AND status='pending'", [JSON.stringify({ status: "pending" }), tx.id]);
    res.json({ ok: true });
  } catch (error) { console.error("Payment webhook settlement failed:", error.message); res.status(500).json({ error: "Payment settlement failed" }) }
});

app.get("/api/wallet/transactions", auth, async (req, res) => {
  const requested = Number.parseInt(req.query.limit, 10), limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  const result = await pool.query("SELECT id,type,wallet,amount,balance_before,balance_after,status,method,reference,account_name,bank_name,provider,provider_reference,failure_reason,admin_notes,processed_at,created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2", [req.user.id, limit]);
  res.json({ transactions: result.rows });
});

app.get("/api/admin/transactions", auth, requireRole("ADMIN"), async (req, res) => {
  const status = ["pending", "approved", "rejected", "completed"].includes(req.query.status) ? req.query.status : null;
  const result = await pool.query(`
    SELECT t.id,t.user_id,u.name,u.phone,t.type,t.wallet,t.amount,t.status,t.method,t.reference,t.account_name,t.bank_name,t.provider,t.provider_reference,t.failure_reason,t.admin_notes,t.processed_at,t.created_at
    FROM transactions t
    JOIN users u ON u.id=t.user_id
    WHERE ($1::varchar IS NULL OR t.status=$1)
    ORDER BY CASE WHEN t.status = 'pending' THEN 0 ELSE 1 END, t.created_at DESC, t.id DESC
    LIMIT 200
  `, [status]);
  res.json({ transactions: result.rows });
});

app.post("/api/admin/transactions/:id/approve", auth, requireRole("ADMIN"), async (req, res) => {
  const transactionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(transactionId)) return res.status(400).json({ error: "Invalid transaction id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = (await client.query("SELECT * FROM transactions WHERE id=$1 FOR UPDATE", [transactionId])).rows[0];
    if (!tx || tx.status !== "pending") throw new Error("NOT_PENDING");
    if (tx.type === "deposit") {
      const depositAmount = Math.abs(Number(tx.amount));
      await changeBalance(client, { userId: tx.user_id, wallet: tx.wallet, delta: depositAmount, type: tx.type, status: "completed", method: tx.method, reference: tx.reference, transactionId });
      telegramService.notifyDepositApproved(tx.user_id, depositAmount, tx.method).catch(() => {});
    } else if (tx.type === "withdrawal") {
      await client.query("UPDATE transactions SET status='approved', admin_id=$1, processed_at=now() WHERE id=$2", [req.user.id, transactionId]);
    } else throw new Error("UNSUPPORTED");
    await client.query("COMMIT");
    await audit(req, "transaction.approved", "transaction", transactionId, { type: tx.type, userId: tx.user_id, amount: tx.amount });
    res.json({ ok: true, message: "Transaction approved and wallet balance updated successfully." });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.message === "NOT_PENDING") return res.status(409).json({ error: "Transaction is no longer pending" });
    if (e.message === "UNSUPPORTED") return res.status(400).json({ error: "Transaction type cannot be approved" });
    console.error(e);
    res.status(500).json({ error: "Could not approve transaction: " + e.message });
  } finally { client.release() }
});

app.post("/api/admin/transactions/:id/reject", auth, requireRole("ADMIN"), async (req, res) => {
  const transactionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(transactionId)) return res.status(400).json({ error: "Invalid transaction id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = (await client.query("SELECT * FROM transactions WHERE id=$1 FOR UPDATE", [transactionId])).rows[0];
    if (!tx || !["pending", "approved"].includes(tx.status)) throw new Error("NOT_PENDING");
    if (tx.type === "withdrawal") {
      await changeBalance(client, { userId: tx.user_id, wallet: tx.wallet, delta: Math.abs(Number(tx.amount)), type: "refund", method: "wallet", reference: "Rejected transaction #" + transactionId });
    }
    if (tx.type !== "deposit" && tx.type !== "withdrawal") throw new Error("UNSUPPORTED");
    await client.query("UPDATE transactions SET status='rejected', processed_at=now() WHERE id=$1", [transactionId]);
    await client.query("COMMIT");
    await audit(req, "transaction.rejected", "transaction", transactionId, { type: tx.type, userId: tx.user_id });
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.message === "NOT_PENDING") return res.status(409).json({ error: "Transaction is no longer pending" });
    if (e.message === "UNSUPPORTED") return res.status(400).json({ error: "Transaction type cannot be rejected" });
    console.error(e);
    res.status(500).json({ error: "Could not reject transaction" });
  } finally { client.release() }
});
app.get("/api/winners",auth,async(req,res)=>{
  const r=await pool.query("SELECT g.id,g.prize_pool AS pool,u.name FROM games g JOIN users u ON u.id=g.winner_id WHERE g.winner_id IS NOT NULL ORDER BY g.id DESC LIMIT 20");
  res.json(r.rows);
});

app.post("/api/support",auth,async(req,res)=>{
  const subject=text(req.body.subject,150)||"General Inquiry",message=text(req.body.message,2000);
  if(!message)return res.status(400).json({error:"Message is required"});
  const u=(await pool.query("SELECT name,phone FROM users WHERE id=$1",[req.user.id])).rows[0];
  await pool.query("INSERT INTO support_messages(user_id,name,phone,subject,message) VALUES($1,$2,$3,$4,$5)",[req.user.id,u.name,u.phone,subject,message]);
  res.status(201).json({ok:true,message:"Message sent successfully"});
});
app.get("/api/support/my",auth,async(req,res)=>{
  const messages=await pool.query("SELECT id,subject,message,status,admin_reply,replied_at,created_at FROM support_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 50",[req.user.id]);
  res.json({messages:messages.rows});
});
app.get("/api/admin/support",auth,requireRole("ADMIN"),async(req,res)=>{
  const status=["open","in_progress","resolved","closed"].includes(req.query.status)?req.query.status:null;
  const result=await pool.query("SELECT id,user_id,name,phone,subject,message,status,admin_reply,replied_by,replied_at,created_at FROM support_messages WHERE ($1::varchar IS NULL OR status=$1) ORDER BY id DESC LIMIT 100",[status]);
  res.json({messages:result.rows});
});
app.post("/api/admin/support/:id/reply",auth,requireRole("ADMIN"),async(req,res)=>{
  const msgId=Number.parseInt(req.params.id,10),reply=text(req.body.reply,2000),status=req.body.status||"resolved";
  if(!Number.isInteger(msgId)||!reply)return res.status(400).json({error:"Valid message id and reply are required"});
  if(!["open","in_progress","resolved","closed"].includes(status))return res.status(400).json({error:"Invalid status"});
  const updated=(await pool.query("UPDATE support_messages SET admin_reply=$1,status=$2,replied_by=$3,replied_at=now(),updated_at=now() WHERE id=$4 RETURNING *",[reply,status,req.user.id,msgId])).rows[0];
  if(!updated)return res.status(404).json({error:"Message not found"});
  await audit(req,"support.replied","support",msgId,{status});
  res.json({message:updated});
});

app.get("/api/payment-accounts", async (req, res) => {
  try {
    const accounts = (await pool.query("SELECT id, method, account_number, account_name FROM payment_accounts WHERE is_active = TRUE ORDER BY id ASC")).rows;
    res.json({ accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/payment-accounts", auth, requireRole("ADMIN"), async (req, res) => {
  try {
    const accounts = (await pool.query("SELECT * FROM payment_accounts ORDER BY id ASC")).rows;
    res.json({ accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/payment-accounts", auth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { method, account_number, account_name } = req.body;
    if (!method || !account_number || !account_name) return res.status(400).json({ error: "Missing fields" });
    const newAccount = (await pool.query(
      "INSERT INTO payment_accounts (method, account_number, account_name) VALUES ($1, $2, $3) RETURNING *",
      [String(method), String(account_number), String(account_name)]
    )).rows[0];
    res.json({ account: newAccount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/payment-accounts/:id", auth, requireRole("ADMIN"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const { method, account_number, account_name, is_active } = req.body;
    const updated = (await pool.query(
      "UPDATE payment_accounts SET method = COALESCE($1, method), account_number = COALESCE($2, account_number), account_name = COALESCE($3, account_name), is_active = COALESCE($4, is_active) WHERE id = $5 RETURNING *",
      [method, account_number, account_name, is_active, id]
    )).rows[0];
    if(!updated) return res.status(404).json({error: "Not found"});
    res.json({ account: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/payment-accounts/:id", auth, requireRole("ADMIN"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    await pool.query("DELETE FROM payment_accounts WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== OWNER (SUPER ADMIN) ROUTES ====================

// 1. List Admin Accounts
app.get("/api/owner/admins", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT u.id, u.name, u.phone, u.role, u.is_active, u.created_at, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.role = 'ADMIN' ORDER BY u.id DESC"
    );
    res.json({ admins: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Create Admin Account
app.post("/api/owner/admins", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const name = text(req.body.name, 100);
    const phone = text(req.body.phone, 30);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!name || name.length < 2) return res.status(400).json({ error: "Name must be at least 2 characters" });
    if (!validName(name)) return res.status(400).json({ error: "Please provide a valid name" });
    if (!phone || !validPhone(phone)) return res.status(400).json({ error: "Please enter a valid phone number" });
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const h = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = (await client.query("SELECT id FROM users WHERE phone = $1", [phone])).rows[0];
      if (existing) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "User with this phone number already exists" });
      }
      const newAdmin = (await client.query(
        "INSERT INTO users(name, phone, password_hash, role, is_active) VALUES($1, $2, $3, 'ADMIN', TRUE) RETURNING id, name, phone, role, is_active, created_at",
        [name, phone, h]
      )).rows[0];
      await client.query("INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING", [newAdmin.id]);
      await client.query("COMMIT");
      await audit(req, "admin.created", "user", newAdmin.id, { name, phone });
      res.status(201).json({ admin: newAdmin });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Edit Admin Account
app.patch("/api/owner/admins/:id", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const adminId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(adminId)) return res.status(400).json({ error: "Invalid admin id" });
    const target = (await pool.query("SELECT id, role FROM users WHERE id = $1", [adminId])).rows[0];
    if (!target) return res.status(404).json({ error: "Admin not found" });
    if (target.role === "OWNER") return res.status(403).json({ error: "Cannot modify Owner account via this endpoint" });

    const updates = [];
    const values = [];
    let idx = 1;

    if (req.body.name) {
      const name = text(req.body.name, 100);
      if (!validName(name)) return res.status(400).json({ error: "Invalid name" });
      updates.push(`name = $${idx++}`);
      values.push(name);
    }
    if (req.body.phone) {
      const phone = text(req.body.phone, 30);
      if (!validPhone(phone)) return res.status(400).json({ error: "Invalid phone number" });
      updates.push(`phone = $${idx++}`);
      values.push(phone);
    }
    if (typeof req.body.is_active === "boolean") {
      updates.push(`is_active = $${idx++}`);
      values.push(req.body.is_active);
    }
    if (req.body.password && typeof req.body.password === "string" && req.body.password.length >= 8) {
      const h = await bcrypt.hash(req.body.password, 12);
      updates.push(`password_hash = $${idx++}`);
      values.push(h);
    }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

    values.push(adminId);
    const updated = (await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, name, phone, role, is_active, created_at`,
      values
    )).rows[0];

    await audit(req, "admin.updated", "user", adminId, { fields: Object.keys(req.body) });
    res.json({ admin: updated });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Phone number already in use" });
    res.status(500).json({ error: e.message });
  }
});

// 4. Delete Admin Account
app.delete("/api/owner/admins/:id", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const adminId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(adminId)) return res.status(400).json({ error: "Invalid admin id" });
    if (adminId === req.user.id) return res.status(400).json({ error: "Cannot delete your own account" });
    const target = (await pool.query("SELECT id, role, name FROM users WHERE id = $1", [adminId])).rows[0];
    if (!target) return res.status(404).json({ error: "Admin not found" });
    if (target.role === "OWNER") return res.status(403).json({ error: "Cannot delete Owner account" });

    await pool.query("DELETE FROM sessions WHERE user_id = $1", [adminId]);
    await pool.query("DELETE FROM users WHERE id = $1", [adminId]);
    await audit(req, "admin.deleted", "user", adminId, { name: target.name });
    res.json({ ok: true, message: "Admin account deleted successfully" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. Owner System Reports and Statistics
app.get("/api/owner/reports", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const [
      userStats,
      adminStats,
      walletStats,
      gameStats,
      depositStats,
      withdrawalStats,
      winnerStats,
      feeStats
    ] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total_users, COUNT(*) FILTER (WHERE is_active)::int AS active_users, COUNT(*) FILTER (WHERE role='PLAYER')::int AS total_players FROM users"),
      pool.query("SELECT COUNT(*)::int AS total_admins, COUNT(*) FILTER (WHERE is_active)::int AS active_admins FROM users WHERE role='ADMIN'"),
      pool.query("SELECT COALESCE(SUM(main_balance),0)::numeric AS total_main, COALESCE(SUM(vip_balance),0)::numeric AS total_vip, COALESCE(SUM(main_balance+vip_balance),0)::numeric AS total_wallets FROM wallets"),
      pool.query("SELECT COUNT(*)::int AS total_games, COUNT(*) FILTER (WHERE status='finished')::int AS finished_games, COUNT(*) FILTER (WHERE status IN ('waiting','running'))::int AS active_games, COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_games, COALESCE(SUM(prize_pool),0)::numeric AS total_prize_pools, COALESCE(SUM(platform_fee),0)::numeric AS total_platform_fees FROM games"),
      pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS total_amount FROM transactions WHERE type='deposit' AND status IN ('completed','approved')"),
      pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS total_amount FROM transactions WHERE type='withdrawal' AND status IN ('completed','approved')"),
      pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(prize_amount),0)::numeric AS total_paid FROM winners"),
      pool.query("SELECT COALESCE(SUM(amount),0)::numeric AS total_fees FROM transactions WHERE type='platform_fee'")
    ]);

    const users = userStats.rows[0];
    const admins = adminStats.rows[0];
    const wallets = walletStats.rows[0];
    const games = gameStats.rows[0];
    const deposits = depositStats.rows[0];
    const withdrawals = withdrawalStats.rows[0];
    const winners = winnerStats.rows[0];
    const fees = feeStats.rows[0];

    res.json({
      users,
      admins,
      wallets,
      games,
      deposits,
      withdrawals,
      winners,
      financials: {
        totalDeposits: Number(deposits.total_amount),
        totalWithdrawals: Number(withdrawals.total_amount),
        totalFeesCollected: Number(games.total_platform_fees) + Number(fees.total_fees),
        totalPrizesPaid: Number(winners.total_paid),
        systemWalletLiabilities: Number(wallets.total_wallets)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. Owner System Settings
app.get("/api/owner/settings", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const rows = await pool.query("SELECT key, value, updated_at FROM app_settings ORDER BY key");
    res.json({ settings: rows.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/owner/settings", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const updates = [];
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!key || typeof key !== "string" || value === undefined) continue;
      updates.push([key.trim(), String(value).trim()]);
    }
    for (const [key, value] of updates) {
      await pool.query(
        "INSERT INTO app_settings(key, value, updated_by, updated_at) VALUES($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
        [key, value, req.user.id]
      );
    }
    await audit(req, "owner.settings_updated", "settings", null, { keys: updates.map(u => u[0]) });
    res.json({ ok: true, updated: updates.map(u => u[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== TELEGRAM BOT & GROUP API ROUTES ====================

app.post("/api/telegram/webhook", async (req, res) => {
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (telegramService.webhookSecret && secretHeader && secretHeader !== telegramService.webhookSecret) {
    return res.status(401).json({ error: "Unauthorized webhook" });
  }
  try {
    await telegramService.handleUpdate(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: "Webhook error" });
  }
});

app.get("/api/telegram/status", async (req, res) => {
  res.json({
    connected: !!telegramService.botInfo,
    botUsername: telegramService.botUsername,
    botName: telegramService.botInfo?.first_name || null,
    groupTitle: telegramService.groupTitle,
    groupId: telegramService.groupId,
    syncEnabled: telegramService.isSyncEnabled,
    polling: telegramService.polling
  });
});

app.post("/api/owner/telegram/config", auth, requireRole("OWNER"), async (req, res) => {
  try {
    const { token, groupId, groupTitle, syncEnabled } = req.body;
    if (token !== undefined) {
      telegramService.token = String(token).trim();
      await pool.query(
        "INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_bot_token', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [telegramService.token]
      );
    }
    if (groupId !== undefined) {
      telegramService.groupId = groupId ? Number(groupId) : null;
      await pool.query(
        "INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_group_id', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [String(groupId || "")]
      );
    }
    if (groupTitle !== undefined) {
      telegramService.groupTitle = String(groupTitle).trim();
      await pool.query(
        "INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_group_title', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [telegramService.groupTitle]
      );
    }
    if (syncEnabled !== undefined) {
      telegramService.isSyncEnabled = Boolean(syncEnabled);
      await pool.query(
        "INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_sync_enabled', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [String(Boolean(syncEnabled))]
      );
    }

    if (token) {
      await telegramService.init();
    }

    res.json({
      ok: true,
      status: {
        connected: !!telegramService.botInfo,
        botUsername: telegramService.botUsername,
        groupTitle: telegramService.groupTitle,
        groupId: telegramService.groupId,
        syncEnabled: telegramService.isSyncEnabled
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/owner/telegram/test", auth, requireRole("OWNER"), async (req, res) => {
  try {
    if (!telegramService.token) {
      return res.status(400).json({ error: "Telegram Bot Token is not configured yet. Please configure it in settings." });
    }
    if (!telegramService.groupId) {
      return res.status(400).json({
        error: `Group ID for "${telegramService.groupTitle}" not discovered yet. Please invite @${telegramService.botUsername} into your group "${telegramService.groupTitle}" or send a message in the group.`
      });
    }
    const result = await telegramService.sendMessage(
      telegramService.groupId,
      `🔔 <b>የ HABESHA BINGO ግንኙነት ሙከራ (Telegram Connection Test)</b>\n\nይህ መልዕክት ከ HABESHA BINGO ድረ-ገጽ የቀጥታ ማመሳሰያ (Real-Time Sync) የተላከ ነው። ቦቱ እና ግሩፑ በተሳካ ሁኔታ ተገናኝተዋል! ✅`
    );
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

io.on("connection", socket => {
  socket.on("room", async id => {
    const gameId = Number(id);
    if (!Number.isSafeInteger(gameId) || gameId < 1) return;
    for (const r of socket.rooms) {
      if (r.startsWith("game:") && r !== "game:" + gameId) {
        socket.leave(r);
      }
    }
    socket.join("game:" + gameId);
    const game = (await pool.query("SELECT * FROM games WHERE id=$1", [gameId])).rows[0];
    if (game) socket.emit("update", await publicGame(game));
  });

  // Provide initial active game on connect
  currentGame().then(async g => {
    if (g) {
      socket.join("game:" + g.id);
      socket.emit("update", await publicGame(g));
    }
  }).catch(() => {});
});

let running = false;
let waitCycle = 0;
let nextRoundTimeout = null;

async function startNextGame(previousGameId) {
  if (nextRoundTimeout) {
    clearTimeout(nextRoundTimeout);
    nextRoundTimeout = null;
  }
  const client = await pool.connect();
  let g = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [390711]);
    const r = await client.query("SELECT * FROM games WHERE status IN ('waiting','running') ORDER BY id DESC LIMIT 1");
    if (r.rows[0]) {
      g = r.rows[0];
    } else {
      const x = await client.query("INSERT INTO games(name, entry, status, prize_pool, platform_fee, current_number, called_numbers) VALUES('Main Game', 10, 'waiting', 0, 0, NULL, '[]'::jsonb) RETURNING *");
      g = x.rows[0];
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error starting next game:", error.message);
    return null;
  } finally {
    client.release();
  }

  if (g) {
    const pub = await publicGame(g);
    if (previousGameId) {
      io.to("game:" + previousGameId).emit("round_reset", pub);
    }
    io.emit("new_round", pub);
    io.emit("update", pub);
  }
  return g;
}

async function callNumber() {
  if (running) return;
  running = true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let g = (await client.query("SELECT * FROM games WHERE status IN ('waiting','running') ORDER BY id DESC LIMIT 1 FOR UPDATE")).rows[0];
    if (!g) {
      const x = await client.query("INSERT INTO games(name, entry, status, prize_pool, platform_fee, current_number, called_numbers) VALUES('Main Game', 10, 'waiting', 0, 0, NULL, '[]'::jsonb) RETURNING *");
      g = x.rows[0];
      waitCycle = 0;
    }

    if (g.status === 'waiting') {
      const currentTickets = (await client.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1", [g.id])).rows[0].count;

      // Requirement: If there are no players, keep the new round in WAITING state
      if (currentTickets === 0) {
        waitCycle = 0;
        await client.query("UPDATE games SET prize_pool=0, platform_fee=0 WHERE id=$1", [g.id]);
        await client.query("COMMIT");
        const updated = (await pool.query("SELECT * FROM games WHERE id=$1", [g.id])).rows[0];
        const pub = await publicGame(updated);
        io.to("game:" + g.id).emit("update", pub);
        return;
      }

      // If players exist, update prize pool and transition to running
      const entryFee = Number(g.entry || 10);
      const fee = currentTickets >= 3 ? (currentTickets * 2) : 0;
      const prize = currentTickets * (entryFee - (currentTickets >= 3 ? 2 : 0));
      await client.query("UPDATE games SET prize_pool=$1, platform_fee=$2, status='running' WHERE id=$3", [prize, fee, g.id]);
      g.status = 'running';
      waitCycle = 0;

      await client.query("COMMIT");
      const updated = (await pool.query("SELECT * FROM games WHERE id=$1", [g.id])).rows[0];
      const pub = await publicGame(updated);
      io.to("game:" + g.id).emit("update", pub);
      io.emit("update", pub);
      telegramService.notifyGameStarted(g.id, g.entry, prize, currentTickets).catch(() => {});
      return;
    }

    const called = g.called_numbers || [];
    const available = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !called.includes(n));
    if (!available.length) {
      await client.query("UPDATE games SET status='finished', finished_at=now() WHERE id=$1", [g.id]);
      await client.query("COMMIT");
      const finishedGame = (await pool.query("SELECT * FROM games WHERE id=$1", [g.id])).rows[0];
      const pub = await publicGame(finishedGame);
      io.to("game:" + g.id).emit("finished", pub);
      io.emit("game_finished", pub);
      if (nextRoundTimeout) clearTimeout(nextRoundTimeout);
      nextRoundTimeout = setTimeout(() => startNextGame(g.id).catch(() => {}), 4500);
      return;
    }

    const n = available[crypto.randomInt(available.length)], next = [...called, n];
    const ts = (await client.query("SELECT * FROM tickets WHERE game_id=$1 ORDER BY id", [g.id])).rows;
    const playerCount = ts.length;
    const entryFee = Number(g.entry || 10);
    const fee = playerCount >= 3 ? (playerCount * 2) : 0;
    const prize = playerCount * (entryFee - (playerCount >= 3 ? 2 : 0));
    const winner = ts.find(t => validTicket(t.numbers) && isBingo(t.numbers, next));
    await client.query("UPDATE games SET current_number=$1, called_numbers=$2, prize_pool=$3, platform_fee=$4 WHERE id=$5", [n, JSON.stringify(next), prize, fee, g.id]);
    
    let winnerUser = null;
    if (winner) {
      await client.query("INSERT INTO winners(game_id, user_id, prize_amount, ticket_snapshot) VALUES($1,$2,$3,$4)", [g.id, winner.user_id, prize, JSON.stringify(winner.numbers)]);
      await changeBalance(client, { userId: winner.user_id, wallet: "main", delta: prize, type: "prize", method: "game", reference: "Game #" + g.id });
      await client.query("UPDATE games SET status='finished', winner_id=$1, winner_ticket=$2, finished_at=now() WHERE id=$3", [winner.user_id, JSON.stringify(winner.numbers), g.id]);
      winnerUser = (await client.query("SELECT name FROM users WHERE id=$1", [winner.user_id])).rows[0];
    }
    await client.query("COMMIT");

    const updated = (await pool.query("SELECT * FROM games WHERE id=$1", [g.id])).rows[0];
    const pub = await publicGame(updated);
    if (winner) {
      pub.winner_name = winnerUser ? winnerUser.name : "Winner";
      pub.winner_prize = prize;
      pub.winner_ticket = winner.numbers;
      io.to("game:" + g.id).emit("finished", pub);
      io.emit("game_finished", pub);
      telegramService.notifyWinner(g.id, winnerUser ? winnerUser.name : "Winner", prize, winner.numbers).catch(() => {});
      if (nextRoundTimeout) clearTimeout(nextRoundTimeout);
      nextRoundTimeout = setTimeout(() => startNextGame(g.id).catch(() => {}), 4500);
    } else {
      io.to("game:" + g.id).emit("update", pub);
      telegramService.notifyNumberCalled(g.id, n, next).catch(() => {});
    }
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Game loop error:", error.message);
  } finally {
    client.release();
    running = false;
  }
}
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    return res.sendFile(path.join(frontendDir, "index.html"));
  }
  next();
});

app.use((error,req,res,next)=>{
  if(error.message==="Origin not allowed")return res.status(403).json({error:"Origin not allowed"});
  next(error);
});
init().then(()=>{
  server.listen(PORT,()=>console.log(`Habesha Bingo API running on http://localhost:${PORT}`));
  setInterval(callNumber,5000);

  // Anti-Sleep Heartbeat for Render (keeps service 24/7 active)
  const PING_TARGET = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
  if (PING_TARGET && !PING_TARGET.includes("localhost") && !PING_TARGET.includes("127.0.0.1")) {
    console.log(`[KeepAlive] 💓 Automatic anti-sleep heartbeat enabled for ${PING_TARGET}`);
    setInterval(async () => {
      try {
        const pingUrl = `${PING_TARGET.replace(/\/$/, "")}/api/health`;
        const res = await fetch(pingUrl, {
          headers: { "User-Agent": "HabeshaBingo-AntiSleep/1.0" }
        });
        if (res.ok) {
          console.log(`[KeepAlive] 💓 Heartbeat ping to ${pingUrl} OK (preventing auto-sleep)`);
        }
      } catch (pErr) {
        console.warn(`[KeepAlive] Ping note:`, pErr.message);
      }
    }, 8 * 60 * 1000); // 8 minutes (Render free tier timeout is 15 minutes)
  }
}).catch(error=>{
  console.error("Database initialization failed:",error.message);
  process.exitCode=1;
});
