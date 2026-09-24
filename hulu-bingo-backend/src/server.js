require("dotenv").config();
const express=require("express");
const cors=require("cors");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");
const http=require("http");
const {Server}=require("socket.io");

const app=express(), server=http.createServer(app);
const io=new Server(server,{cors:{origin:process.env.FRONTEND_ORIGIN||"*"}});
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const PORT=process.env.PORT||4000, SECRET=process.env.JWT_SECRET||"dev-only-change-me";

app.use(cors({origin:process.env.FRONTEND_ORIGIN||"*"}));
app.use(express.json());

async function init(){
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT DEFAULT 'player',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS wallets(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    main_balance NUMERIC(12,2) DEFAULT 0, vip_balance NUMERIC(12,2) DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS games(
    id SERIAL PRIMARY KEY, name TEXT DEFAULT 'Main Game', entry NUMERIC(12,2) DEFAULT 10,
    status TEXT DEFAULT 'waiting', prize_pool NUMERIC(12,2) DEFAULT 0,
    platform_fee NUMERIC(12,2) DEFAULT 0, current_number INTEGER,
    called_numbers JSONB DEFAULT '[]', winner_id INTEGER REFERENCES users(id),
    winner_ticket JSONB, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS tickets(
    id SERIAL PRIMARY KEY, game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, numbers JSONB NOT NULL,
    UNIQUE(game_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS transactions(
    id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL, wallet TEXT DEFAULT 'main', amount NUMERIC(12,2) NOT NULL,
    status TEXT DEFAULT 'pending', method TEXT, reference TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );`);
}
function auth(req,res,next){
  try{req.user=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),SECRET);next()}
  catch{return res.status(401).json({error:"Authentication required"})}
}
function makeToken(u){return jwt.sign({id:u.id,name:u.name,phone:u.phone,role:u.role},SECRET,{expiresIn:"7d"})}
function randomTicket(){
  const a=Array.from({length:150},(_,i)=>i+1);
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return [a.slice(0,5),a.slice(5,10),a.slice(10,15),a.slice(15,20),a.slice(20,25)];
}
function isBingo(ticket,called){
  const s=new Set(called),m=ticket.map(r=>r.map(n=>s.has(n)));
  for(let r=0;r<5;r++)if(m[r].every(Boolean))return true;
  for(let c=0;c<5;c++)if([0,1,2,3,4].every(r=>m[r][c]))return true;
  return [0,1,2,3,4].every(i=>m[i][i])||[0,1,2,3,4].every(i=>m[i][4-i]);
}
async function currentGame(){
  const r=await pool.query("SELECT * FROM games WHERE status IN ('waiting','running') ORDER BY id DESC LIMIT 1");
  if(r.rows[0])return r.rows[0];
  const x=await pool.query("INSERT INTO games(name) VALUES('Main Game') RETURNING *");return x.rows[0];
}
async function publicGame(g){
  const p=await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[g.id]);
  return {...g,players:p.rows[0].count,called_numbers:g.called_numbers||[]};
}
async function recalc(gameId){
  const g=(await pool.query("SELECT * FROM games WHERE id=$1",[gameId])).rows[0];
  const p=Number((await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[gameId])).rows[0].count);
  const feePer=p>3?2:0, poolAmount=p*(Number(g.entry)-feePer);
  await pool.query("UPDATE games SET prize_pool=$1,platform_fee=$2 WHERE id=$3",[poolAmount,p*feePer,gameId]);
}
async function broadcast(id){
  const g=(await pool.query("SELECT * FROM games WHERE id=$1",[id])).rows[0];
  if(g)io.to("game:"+id).emit("update",await publicGame(g));
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"Habesha Bingo API"}));

app.post("/api/register",async(req,res)=>{
  try{
    const {name,phone,password}=req.body;
    if(!name||!phone||!password)return res.status(400).json({error:"Name, phone and password are required"});
    const h=await bcrypt.hash(password,12);
    const u=(await pool.query("INSERT INTO users(name,phone,password_hash) VALUES($1,$2,$3) RETURNING id,name,phone,role",[name,phone,h])).rows[0];
    await pool.query("INSERT INTO wallets(user_id) VALUES($1)",[u.id]);
    res.json({token:makeToken(u),user:u});
  }catch(e){res.status(409).json({error:"Phone already registered"})}
});
app.post("/api/login",async(req,res)=>{
  const u=(await pool.query("SELECT * FROM users WHERE phone=$1",[req.body.phone])).rows[0];
  if(!u||!(await bcrypt.compare(req.body.password||"",u.password_hash)))return res.status(401).json({error:"Invalid login"});
  res.json({token:makeToken(u),user:{id:u.id,name:u.name,phone:u.phone,role:u.role}});
});
app.get("/api/me",auth,async(req,res)=>{
  const u=(await pool.query("SELECT id,name,phone,role FROM users WHERE id=$1",[req.user.id])).rows[0];
  const w=(await pool.query("SELECT main_balance,vip_balance FROM wallets WHERE user_id=$1",[req.user.id])).rows[0];
  res.json({user:u,wallet:w});
});

app.get("/api/game",auth,async(req,res)=>{
  let g=await currentGame(); await recalc(g.id);
  g=(await pool.query("SELECT * FROM games WHERE id=$1",[g.id])).rows[0];
  const t=(await pool.query("SELECT numbers FROM tickets WHERE game_id=$1 AND user_id=$2",[g.id,req.user.id])).rows[0];
  res.json({game:await publicGame(g),ticket:t?.numbers||null});
});
app.post("/api/join",auth,async(req,res)=>{
  const g=await currentGame();
  if(g.status!=="waiting")return res.status(400).json({error:"Game already started"});
  if((await pool.query("SELECT id FROM tickets WHERE game_id=$1 AND user_id=$2",[g.id,req.user.id])).rows[0])return res.status(400).json({error:"Already joined"});
  const w=(await pool.query("SELECT main_balance FROM wallets WHERE user_id=$1",[req.user.id])).rows[0];
  if(Number(w.main_balance)<10)return res.status(400).json({error:"At least 10 ETB is required in the main wallet"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("UPDATE wallets SET main_balance=main_balance-10 WHERE user_id=$1",[req.user.id]);
    await client.query("INSERT INTO transactions(user_id,type,wallet,amount,status,method,reference) VALUES($1,'game_entry','main',-10,'completed','game',$2)",[req.user.id,"Game #"+g.id]);
    await client.query("INSERT INTO tickets(game_id,user_id,numbers) VALUES($1,$2,$3)",[g.id,req.user.id,JSON.stringify(randomTicket())]);
    const c=(await client.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id=$1",[g.id])).rows[0].count;
    if(c>=1)await client.query("UPDATE games SET status='running' WHERE id=$1",[g.id]);
    await client.query("COMMIT"); await recalc(g.id); await broadcast(g.id); res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");res.status(400).json({error:"Could not join game"})}finally{client.release()}
});

app.post("/api/wallet/deposit",auth,async(req,res)=>{
  const amount=Number(req.body.amount);
  if(amount<50)return res.status(400).json({error:"Minimum deposit is 50 ETB"});
  await pool.query("INSERT INTO transactions(user_id,type,wallet,amount,status,method,reference) VALUES($1,'deposit',$2,$3,'pending',$4,$5)",[req.user.id,req.body.wallet||"main",amount,req.body.method,req.body.reference||""]);
  res.json({message:"Deposit request submitted"});
});
app.post("/api/wallet/withdraw",auth,async(req,res)=>{
  const amount=Number(req.body.amount),wallet=req.body.wallet||"main";
  if(amount<100)return res.status(400).json({error:"Minimum withdrawal is 100 ETB"});
  const col=wallet==="vip"?"vip_balance":"main_balance";
  const w=(await pool.query(`SELECT ${col} FROM wallets WHERE user_id=$1`,[req.user.id])).rows[0];
  if(Number(w[col])<amount)return res.status(400).json({error:"Insufficient balance"});
  await pool.query(`UPDATE wallets SET ${col}=${col}-$1 WHERE user_id=$2`,[amount,req.user.id]);
  await pool.query("INSERT INTO transactions(user_id,type,wallet,amount,status,method,reference) VALUES($1,'withdrawal',$2,$3,'pending',$4,$5)",[req.user.id,wallet,-amount,req.body.method,req.body.account||""]);
  res.json({message:"Withdrawal request submitted"});
});
app.get("/api/winners",auth,async(req,res)=>{
  const r=await pool.query("SELECT g.id,g.prize_pool AS pool,u.name FROM games g JOIN users u ON u.id=g.winner_id WHERE g.winner_id IS NOT NULL ORDER BY g.id DESC LIMIT 20");
  res.json(r.rows);
});

io.on("connection",socket=>socket.on("room",id=>socket.join("game:"+Number(id))));

let running=false;
async function callNumber(){
  if(running)return; running=true;
  try{
    const g=await currentGame(); if(!g||g.status!=="running")return;
    const called=g.called_numbers||[];
    const available=Array.from({length:150},(_,i)=>i+1).filter(n=>!called.includes(n));
    if(!available.length)return;
    const n=available[Math.floor(Math.random()*available.length)], next=[...called,n];
    await pool.query("UPDATE games SET current_number=$1,called_numbers=$2 WHERE id=$3",[n,JSON.stringify(next),g.id]);
    const ts=(await pool.query("SELECT * FROM tickets WHERE game_id=$1",[g.id])).rows;
    for(const t of ts){
      if(isBingo(t.numbers,next)){
        await pool.query("UPDATE wallets SET main_balance=main_balance+$1 WHERE user_id=$2",[g.prize_pool,t.user_id]);
        await pool.query("UPDATE games SET status='finished',winner_id=$1,winner_ticket=$2 WHERE id=$3",[t.user_id,JSON.stringify(t.numbers),g.id]);
        io.to("game:"+g.id).emit("finished",await publicGame((await pool.query("SELECT * FROM games WHERE id=$1",[g.id])).rows[0]));
        return;
      }
    }
    await broadcast(g.id);
  }finally{running=false}
}
setInterval(callNumber,5000);

init().then(()=>server.listen(PORT,()=>console.log(`Habesha Bingo API running on http://localhost:${PORT}`))).catch(console.error);
