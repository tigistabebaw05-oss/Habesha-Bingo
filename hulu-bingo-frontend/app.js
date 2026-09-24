const API = `http://${window.location.hostname}:4000/api`;
const $ = id => document.getElementById(id);
let state = { game:null, ticket:null, called:new Set(), socket:null };

function toast(message,error=false){
  const x=document.createElement("div"); x.className="toast"+(error?" error":""); x.textContent=message;
  document.body.appendChild(x); setTimeout(()=>x.remove(),2800);
}
async function api(path, options={}){
  const token=localStorage.getItem("hulu_token");
  const headers={"Content-Type":"application/json",...(options.headers||{})};
  if(token) headers.Authorization=`Bearer ${token}`;
  let r;
  try{r=await fetch(API+path,{...options,headers})}
  catch{throw new Error("Cannot connect to the API. Start the backend and PostgreSQL, then try again.")}
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||"Request failed");
  return d;
}
function money(v){return `${Number(v||0).toFixed(2)} ETB`}

async function refresh(){
  try{
    const d=await api("/game");
    state.game=d.game; state.ticket=d.ticket; state.called=new Set(d.game.called_numbers||[]);
    drawGame(); updateHero();
    const w=await api("/me");
    $("mainBalance").textContent=money(w.wallet.main_balance);
    $("vipBalance").textContent=money(w.wallet.vip_balance);
    const wins=await api("/winners"); drawWinners(wins);
  }catch(e){console.log(e.message)}
}
function updateHero(){
  if(!state.game)return;
  $("heroPrize").innerHTML=`${Number(state.game.prize_pool||0).toFixed(0)} <small>ETB</small>`;
  $("heroPlayers").textContent=state.game.players||0;
  $("players").textContent=state.game.players||0;
  $("prizePool").textContent=money(state.game.prize_pool);
  $("gameStatus").textContent=(state.game.status||"waiting").toUpperCase();
  $("currentNumber").textContent=state.game.current_number||"—";
}
function drawGame(){
  if(!state.game)return;
  const called=state.called;
  $("calledNumbers").innerHTML=(state.game.called_numbers||[]).slice().reverse().slice(0,28).map((n,i)=>`<span class="ball ${i===0?"last":""}">${n}</span>`).join("")||`<span class="empty">No numbers called yet</span>`;
  $("numberBoard").innerHTML=Array.from({length:150},(_,i)=>`<div class="${called.has(i+1)?"called":""}">${i+1}</div>`).join("");
  if(state.ticket){
    $("ticket").innerHTML=state.ticket.flat().map(n=>`<div class="${called.has(n)?"marked":""}">${n}</div>`).join("");
    $("joinBtn").disabled=true; $("joinBtn").textContent="Joined — Good Luck!";
  }else{
    $("ticket").innerHTML=`<div style="grid-column:1/-1;aspect-ratio:auto;padding:35px 8px;text-align:center;color:#9badc2">Join the game to receive your ticket.</div>`;
    $("joinBtn").disabled=false; $("joinBtn").textContent="Join Game — 10 ETB";
  }
}
function drawWinners(list){
  const box=$("winnersGrid");
  if(!list.length){box.innerHTML=`<div class="empty-card">No completed games yet.</div>`;return}
  box.innerHTML=list.map(x=>`<div class="winner-card"><small>GAME #${x.id}</small><h3>${escapeHtml(x.name||"Player")}</h3><strong>${money(x.pool)}</strong><p>Grand winner</p></div>`).join("");
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}

$("joinBtn").addEventListener("click",async()=>{
  try{await api("/join",{method:"POST"});toast("You joined the game");await refresh()}catch(e){toast(e.message,true)}
});
$("playBtn").addEventListener("click",()=>document.querySelector("#game").scrollIntoView({behavior:"smooth"}));
let authMode="login";
function openAuth(){
  authMode="login";
  updateAuthDialog();
  $("authBackdrop").hidden=false;
  $("authForm").elements.phone.focus();
}
function updateAuthDialog(){
  const register=authMode==="register";
  $("authTitle").textContent=register?"Create account":"Login";
  $("authPrompt").textContent=register?"Register to play and manage your wallet.":"Use your phone number and password to continue.";
  $("nameField").hidden=!register;
  $("authForm").elements.name.required=register;
  $("authForm").elements.password.autocomplete=register?"new-password":"current-password";
  $("authSubmit").textContent=register?"Create account":"Login";
  $("authSwitch").textContent=register?"I already have an account":"Create an account";
}
$("loginBtn").addEventListener("click",openAuth);
document.querySelector('a[href="#account"]').addEventListener("click",e=>{e.preventDefault();openAuth()});
$("authClose").addEventListener("click",()=>$("authBackdrop").hidden=true);
document.querySelectorAll("[data-step-action]").forEach(step=>{
  const activate=()=>step.dataset.stepAction==="account"?openAuth():document.querySelector(`#${step.dataset.stepAction}`).scrollIntoView({behavior:"smooth"});
  step.addEventListener("click",activate);
  step.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();activate()}});
});
$("authBackdrop").addEventListener("click",e=>{if(e.target.id==="authBackdrop")e.currentTarget.hidden=true});
$("authSwitch").addEventListener("click",()=>{authMode=authMode==="login"?"register":"login";updateAuthDialog()});
$("authForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=new FormData(e.target), values=Object.fromEntries(form);
  const path=authMode==="register"?"/register":"/login";
  $("authSubmit").disabled=true;
  try{
    const result=await api(path,{method:"POST",body:JSON.stringify(values)});
    localStorage.setItem("hulu_token",result.token);
    $("authBackdrop").hidden=true;
    $("loginBtn").textContent=`Hi, ${result.user.name}`;
    toast(authMode==="register"?"Account created":"Logged in successfully");
    await refresh();
  }catch(error){toast(error.message,true)}
  finally{$("authSubmit").disabled=false}
});

$("depositForm").addEventListener("submit",async e=>{
  e.preventDefault(); const f=new FormData(e.target);
  try{await api("/wallet/deposit",{method:"POST",body:JSON.stringify(Object.fromEntries(f))});toast("Deposit request submitted");e.target.reset()}catch(x){toast(x.message,true)}
});
$("withdrawForm").addEventListener("submit",async e=>{
  e.preventDefault(); const f=new FormData(e.target);
  try{await api("/wallet/withdraw",{method:"POST",body:JSON.stringify(Object.fromEntries(f))});toast("Withdrawal request submitted");e.target.reset()}catch(x){toast(x.message,true)}
});

function connectSocket(){
  const s=document.createElement("script");
  s.src=`http://${window.location.hostname}:4000/socket.io/socket.io.js`;
  s.onload=()=>{
    state.socket=io(`http://${window.location.hostname}:4000`);
    state.socket.on("connect",()=>state.socket.emit("room",state.game?.id));
    state.socket.on("update",g=>{state.game=g;state.called=new Set(g.called_numbers||[]);drawGame();updateHero()});
    state.socket.on("finished",g=>{state.game=g;state.called=new Set(g.called_numbers||[]);drawGame();updateHero();toast(g.winner_id?"BINGO — game finished!":"Game finished")});
  };
  document.body.appendChild(s);
}
refresh().then(connectSocket);
setInterval(refresh,15000);
