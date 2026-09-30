const configuredApi = window.HABESHA_API || "";
const API = configuredApi ? `${configuredApi}/api` : "/api";
const $ = id => document.getElementById(id);
const authStorage = window.sessionStorage;
localStorage.removeItem("hulu_token");
let state = { game:null, ticket:null, called:new Set(), socket:null };
let bingoMode = localStorage.getItem("habesha_bingo_mode") || "AUTO";
let markedNumbers = new Set();
let lastTrackedGameId = null;

if (window.Telegram && window.Telegram.WebApp) {
  try {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
    const openTgModal = () => {
      const modal = $("huluBingoWebAppModal");
      if (modal) {
        modal.hidden = false;
        switchToCardSelectionView();
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", openTgModal);
    } else {
      setTimeout(openTgModal, 100);
    }
  } catch (e) {
    console.warn("Telegram WebApp init:", e);
  }
}

function syncAuthUi(){
  const token = authStorage.getItem("hulu_token");
  const role = String(authStorage.getItem("hulu_role")||"PLAYER").toUpperCase();
  const loginBtn = $("loginBtn");
  const adminBtn = $("adminDashBtn");
  const ownerBtn = $("ownerDashBtn");
  const adminToOwner = $("adminToOwnerBtn");
  if (loginBtn) loginBtn.textContent = token ? `Hi, ${authStorage.getItem("hulu_name") || "Player"}` : "Login";
  if (adminBtn) adminBtn.hidden = !(token && (role === "ADMIN" || role === "OWNER"));
  if (ownerBtn) ownerBtn.hidden = !(token && role === "OWNER");
  if (adminToOwner) adminToOwner.hidden = !(token && role === "OWNER");
}
window.syncAuthUi = syncAuthUi;

function navigateTo(target, updateHistory = true) {
  const token = authStorage.getItem("hulu_token");
  const role = String(authStorage.getItem("hulu_role") || "PLAYER").toUpperCase();

  if (target === "owner") {
    if ($("playerApp")) $("playerApp").hidden = true;
    if ($("adminApp")) $("adminApp").hidden = true;
    if ($("ownerApp")) $("ownerApp").hidden = false;
    if (updateHistory && window.location.pathname !== "/owner") {
      window.history.pushState({ route: "owner" }, "", "/owner");
    }
    if (!token || role !== "OWNER") {
      openAuth("login");
      if ($("authPhone") && !$("authPhone").value) $("authPhone").value = "0951666750";
      toast("Please log in with Owner account");
      return;
    }
    if ($("authBackdrop")) $("authBackdrop").hidden = true;
    if (typeof window.showOwnerDashboard === "function") {
      window.showOwnerDashboard();
    } else if (typeof window.loadOwnerDashboard === "function") {
      window.loadOwnerDashboard();
    }
    syncAuthUi();
  } else if (target === "admin") {
    if ($("playerApp")) $("playerApp").hidden = true;
    if ($("adminApp")) $("adminApp").hidden = false;
    if ($("ownerApp")) $("ownerApp").hidden = true;
    if (updateHistory && window.location.pathname !== "/admin") {
      window.history.pushState({ route: "admin" }, "", "/admin");
    }
    if (!token || (role !== "ADMIN" && role !== "OWNER")) {
      openAuth("login");
      if ($("authPhone") && !$("authPhone").value) $("authPhone").value = "0919307468";
      toast("Please log in with Admin account");
      return;
    }
    if ($("authBackdrop")) $("authBackdrop").hidden = true;
    if (typeof window.showDashboard === "function") {
      window.showDashboard();
    } else if (typeof window.loadDashboard === "function") {
      if (document.getElementById("dashboard")) document.getElementById("dashboard").hidden = false;
      window.loadDashboard();
    }
    syncAuthUi();
  } else {
    if ($("playerApp")) $("playerApp").hidden = false;
    if ($("adminApp")) $("adminApp").hidden = true;
    if ($("ownerApp")) $("ownerApp").hidden = true;
    if (updateHistory && window.location.pathname !== "/") {
      window.history.pushState({ route: "player" }, "", "/");
    }
    syncAuthUi();
  }
}
window.navigateTo = navigateTo;

function redirectByRole(role) {
  const normalized = String(role || "PLAYER").toUpperCase();
  authStorage.setItem("hulu_role", normalized);
  if (normalized === "OWNER") {
    navigateTo("owner", true);
    return true;
  } else if (normalized === "ADMIN") {
    navigateTo("admin", true);
    return true;
  } else {
    navigateTo("player", true);
    return false;
  }
}
window.redirectByRole = redirectByRole;

function handleInitialRoute() {
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  const token = authStorage.getItem("hulu_token");
  const role = String(authStorage.getItem("hulu_role") || "PLAYER").toUpperCase();
  const isOwnerPath = path === "/owner" || path.endsWith("/owner") || hash === "#owner";
  const isAdminPath = path === "/admin" || path.endsWith("/admin") || hash === "#admin";

  if (isOwnerPath) {
    navigateTo("owner", false);
  } else if (isAdminPath) {
    navigateTo("admin", false);
  } else {
    if (token && role === "OWNER") {
      navigateTo("owner", true);
    } else if (token && role === "ADMIN") {
      navigateTo("admin", true);
    } else {
      navigateTo("player", false);
    }
  }
}

function toast(message,error=false){
  const x=document.createElement("div"); x.className="toast"+(error?" error":""); x.textContent=message;
  document.body.appendChild(x); setTimeout(()=>x.remove(),2800);
}
async function api(path, options={}){
  const token=authStorage.getItem("hulu_token");
  const headers={"Content-Type":"application/json",...(options.headers||{})};
  if(token) headers.Authorization=`Bearer ${token}`;
  let r;
  try{r=await fetch(API+path,{...options,headers})}
  catch{throw new Error("Cannot connect to the API. Check that the backend is running and API_BASE_URL is configured.")}
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||"Request failed");
  return d;
}
function money(v){return `${Number(v||0).toFixed(2)} ETB`}

let guestCartela = null;
function getGuestCartela(){
  if(!guestCartela){
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
      for(let i=pool.length-1; i>0; i--){const j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]];}
      card.push(pool.slice(0,5));
    }
    guestCartela = [0,1,2,3,4].map(r => [card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  }
  return guestCartela;
}

function getBingoLetter(num) {
  const n = Number(num);
  if (!n || isNaN(n) || n <= 0) return "B";
  if (n >= 1 && n <= 15) return "B";
  if (n >= 16 && n <= 30) return "I";
  if (n >= 31 && n <= 45) return "N";
  if (n >= 46 && n <= 60) return "G";
  if (n >= 61 && n <= 75) return "O";
  const mod = ((n - 1) % 75) + 1;
  if (mod <= 15) return "B";
  if (mod <= 30) return "I";
  if (mod <= 45) return "N";
  if (mod <= 60) return "G";
  return "O";
}

function checkCartelaBingo(ticket, markedSet) {
  if (!Array.isArray(ticket) || ticket.length !== 5) return false;
  const m = ticket.map(r => r.map(n => markedSet.has(n)));
  for (let r = 0; r < 5; r++) if (m[r].every(Boolean)) return true;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every(r => m[r][c])) return true;
  return [0,1,2,3,4].every(i => m[i][i]) || [0,1,2,3,4].every(i => m[i][4-i]);
}

function checkBingoWin() {
  const cartela = state.ticket || getGuestCartela();
  if (!cartela) return;
  const isWon = checkCartelaBingo(cartela, markedNumbers);
  const bingoBtn = $("tgBingoBtn");
  if (bingoBtn) {
    bingoBtn.disabled = !isWon;
    bingoBtn.classList.toggle("active", isWon);
  }
}

function saveMarkedNumbers() {
  if (state.game?.id) {
    try {
      sessionStorage.setItem(`habesha_marked_${state.game.id}`, JSON.stringify([...markedNumbers]));
    } catch(e) {}
  }
}

function loadMarkedNumbers() {
  if (!state.game?.id) return;
  if (lastTrackedGameId !== state.game.id) {
    markedNumbers.clear();
    lastTrackedGameId = state.game.id;
  }
  try {
    const saved = sessionStorage.getItem(`habesha_marked_${state.game.id}`);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) {
        arr.forEach(n => {
          if (state.called && state.called.has(n)) {
            markedNumbers.add(n);
          }
        });
      }
    }
  } catch(e) {}

  if (bingoMode === "AUTO") {
    autoMarkCurrentGame();
  }
}

function autoMarkCurrentGame() {
  if (!state.called || state.called.size === 0) return;
  const cartela = state.ticket || getGuestCartela();
  if (!cartela) return;
  let changed = false;
  cartela.flat().forEach(n => {
    if (state.called.has(n) && !markedNumbers.has(n)) {
      markedNumbers.add(n);
      changed = true;
    }
  });
  if (changed) {
    saveMarkedNumbers();
  }
}

function setBingoMode(mode) {
  bingoMode = mode;
  localStorage.setItem("habesha_bingo_mode", mode);
  updateModeButtons();
  if (mode === "AUTO") {
    autoMarkCurrentGame();
    renderTickets();
    checkBingoWin();
  }
}

function updateModeButtons() {
  const isAuto = bingoMode === "AUTO";
  document.querySelectorAll(".mode-btn-auto, #tgModeAuto, #deskModeAuto").forEach(btn => {
    btn.classList.toggle("active", isAuto);
  });
  document.querySelectorAll(".mode-btn-manual, #tgModeManual, #deskModeManual").forEach(btn => {
    btn.classList.toggle("active", !isAuto);
  });
}

function handleCellClick(num) {
  const n = Number(num);
  if (!n || isNaN(n)) return;

  if (bingoMode === "MANUAL") {
    if (markedNumbers.has(n)) {
      return;
    }
    // Prevent duplicate marking and make sure a number is marked only when it has actually been called by the server
    if (state.called && state.called.has(n)) {
      markedNumbers.add(n);
      saveMarkedNumbers();
      renderTickets();
      checkBingoWin();
    } else {
      toast(`ቁጥር ${n} ገና አልተጠራም! (Number ${n} has not been called yet!)`, true);
    }
  } else {
    if (state.called && state.called.has(n) && !markedNumbers.has(n)) {
      markedNumbers.add(n);
      saveMarkedNumbers();
      renderTickets();
      checkBingoWin();
    }
  }
}

function renderTickets() {
  const cartela = state.ticket || getGuestCartela();
  if (!cartela) return;

  const html = cartela.flat().map(n => {
    const isMarked = markedNumbers.has(n);
    return `<div class="${isMarked ? 'marked' : ''}" data-num="${n}">${escapeHtml(n)}</div>`;
  }).join("");

  const deskTicketEl = $("ticket");
  if (deskTicketEl) {
    deskTicketEl.innerHTML = html;
    deskTicketEl.querySelectorAll("div[data-num]").forEach(el => {
      el.onclick = () => handleCellClick(Number(el.dataset.num));
    });
  }

  const tgTicketEl = $("tgTicketGrid");
  if (tgTicketEl) {
    tgTicketEl.innerHTML = html;
    tgTicketEl.querySelectorAll("div[data-num]").forEach(el => {
      el.onclick = () => handleCellClick(Number(el.dataset.num));
    });
  }

  if (state.ticket) {
    if ($("joinBtn")) { $("joinBtn").disabled = true; $("joinBtn").textContent = "Joined — Good Luck!"; }
  } else {
    if ($("joinBtn")) { $("joinBtn").disabled = false; $("joinBtn").textContent = "Join Game — 10 ETB"; }
  }
}

function updateTopBall(num) {
  const n = Number(num);
  const hasNum = Number.isInteger(n) && n > 0;
  const letter = hasNum ? getBingoLetter(n) : "—";
  const displayNum = hasNum ? n : "—";

  if ($("tgBallLetter")) $("tgBallLetter").textContent = letter;
  if ($("tgBallNumber")) $("tgBallNumber").textContent = displayNum;
  if ($("currentNumber")) {
    $("currentNumber").innerHTML = hasNum 
      ? `<span style="color:var(--habesha-gold);">${letter}</span> ${displayNum}` 
      : "—";
  }
}

function updateCalledHistory(calledList) {
  const list = (calledList || []).filter(n => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 600);
  const count = list.length;

  if ($("tgTrackerCount")) $("tgTrackerCount").textContent = `${count}/75`;

  if ($("tgTrackerChips")) {
    if (list.length === 0) {
      $("tgTrackerChips").innerHTML = `<span class="chip" style="opacity:0.6;">No balls yet</span>`;
    } else {
      const recent = list.slice().reverse();
      $("tgTrackerChips").innerHTML = recent.map((n, idx) => {
        const l = getBingoLetter(n);
        const isLatest = idx === 0;
        return `<span class="chip ${isLatest ? 'latest-chip' : ''}"><b class="c-${l.toLowerCase()}">${l}</b> ${n}</span>`;
      }).join("");
    }
  }

  if ($("calledNumbers")) {
    if (list.length === 0) {
      $("calledNumbers").innerHTML = `<span class="empty">No numbers called yet</span>`;
    } else {
      $("calledNumbers").innerHTML = list.slice().reverse().slice(0, 30).map((n, i) => {
        const l = getBingoLetter(n);
        return `<span class="ball ${i === 0 ? 'last' : ''}" title="${l}-${n}"><small style="font-size:9px;opacity:0.8;">${l}</small> ${n}</span>`;
      }).join("");
    }
  }

  if ($("numberBoard")) {
    const calledSet = new Set(list);
    $("numberBoard").innerHTML = Array.from({length: 75}, (_, i) => {
      const num = i + 1;
      return `<div class="${calledSet.has(num) ? 'called' : ''}">${num}</div>`;
    }).join("");
  }

  if ($("tgBingoTableGrid")) {
    const calledSet = new Set(list);
    let cellsHtml = "";
    for (let r = 0; r < 15; r++) {
      const bNum = r + 1;
      const iNum = r + 16;
      const nNum = r + 31;
      const gNum = r + 46;
      const oNum = r + 61;
      [bNum, iNum, nNum, gNum, oNum].forEach(num => {
        const isCalled = calledSet.has(num);
        cellsHtml += `<div class="bingo-cell ${isCalled ? 'called' : ''}" data-num="${num}">${num}</div>`;
      });
    }
    $("tgBingoTableGrid").innerHTML = cellsHtml;
  }
}

async function refresh(){
  try{
    const w=await api("/me").catch(()=>null);
    if(w){
      const role=String(w.user.role||"PLAYER").toUpperCase();
      authStorage.setItem("hulu_role", role);
      authStorage.setItem("hulu_name", w.user.name);
      syncAuthUi();
      if ((role === "ADMIN" || role === "OWNER") && (($("adminApp") && !$("adminApp").hidden) || ($("ownerApp") && !$("ownerApp").hidden))) {
        return;
      }
      $("loginBtn").textContent=`Hi, ${w.user.name}`;
      if($("mainBalance")) $("mainBalance").textContent=money(w.wallet?.main_balance);
      if($("vipBalance")) $("vipBalance").textContent=money(w.wallet?.vip_balance);
    } else {
      syncAuthUi();
    }
    const d=await api("/game");
    const previousGameId = state.game?.id;
    if (previousGameId && d.game?.id && previousGameId !== d.game.id) {
      handleNewRound(d.game);
      state.ticket = d.ticket;
    } else {
      state.game=d.game; state.ticket=d.ticket; state.called=new Set(d.game?.called_numbers||[]);
      drawGame(); updateHero();
    }
    const wins=await api("/winners").catch(()=>[]);
    if(wins) drawWinners(wins);
  }catch(e){console.log(e.message)}
}
function updateHero(){
  if(!state.game)return;
  $("heroPrize").innerHTML=`${Number(state.game.prize_pool||0).toFixed(0)} <small>ETB</small>`;
  $("heroPlayers").textContent=state.game.players||0;
  $("players").textContent=state.game.players||0;
  $("prizePool").textContent=money(state.game.prize_pool);
  $("gameStatus").textContent=(state.game.status||"waiting").toUpperCase();
  updateTopBall(state.game.current_number);
  if (typeof syncHuluWebApp === "function") syncHuluWebApp();
}
function drawGame(){
  if(!state.game)return;
  loadMarkedNumbers();
  renderTickets();
  updateTopBall(state.game.current_number);
  updateCalledHistory(state.game.called_numbers);
  updateHero();
  checkBingoWin();
  if (typeof syncHuluWebApp === "function") syncHuluWebApp();
}
function drawWinners(list){
  const box=$("winnersGrid");
  if(!list||!list.length){box.innerHTML=`<div class="empty-card">No completed games yet.</div>`;return}
  box.innerHTML=list.map(x=>`<div class="winner-card"><small>GAME #${x.id}</small><h3>${escapeHtml(x.name||"Player")}</h3><strong>${money(x.pool)}</strong><p>Grand winner</p></div>`).join("");
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}

$("joinBtn").addEventListener("click",async()=>{
  try{
    if(!authStorage.getItem("hulu_token")){
      const rndPhone = "09" + Math.floor(10000000 + Math.random()*90000000);
      const reg = await api("/register", {method:"POST", body: JSON.stringify({name: "Player " + rndPhone.slice(-4), phone: rndPhone, password: "Password@123"})}).catch(()=>null);
      if(reg?.token){
        authStorage.setItem("hulu_token", reg.token);
        authStorage.setItem("hulu_name", reg.user.name);
        authStorage.setItem("hulu_role", reg.user.role);
        await api("/wallet/deposit", {method:"POST", body: JSON.stringify({amount: 100, wallet: "main", method: "TeleBirr", reference: "DemoJoin"})}).catch(()=>{});
      }
    }
    await api("/join",{method:"POST"});
    toast("You joined the game!");
    await refresh();
  }catch(e){toast(e.message,true)}
});
$("playBtn").addEventListener("click", () => {
  const modal = $("huluBingoWebAppModal");
  if (modal) {
    modal.hidden = false;
    switchToCardSelectionView();
  } else {
    document.querySelector("#game")?.scrollIntoView({behavior:"smooth"});
  }
});
$("howBtn").addEventListener("click",()=>document.querySelector("#how").scrollIntoView({behavior:"smooth"}));
let authMode="login";
function openAuth(mode="register"){
  authMode=mode;
  updateAuthDialog();
  $("authBackdrop").hidden=false;
  $("authForm").elements.phone.focus();
}
function updateAuthDialog(){
  const register=authMode==="register";
  const request=authMode==="request",reset=authMode==="reset";
  $("authTitle").textContent=register?"Create account":request?"Reset password":reset?"Choose a new password":"Login";
  $("authPrompt").textContent=register?"Register to play and manage your wallet.":request?"Enter your phone number to request a reset token.":reset?"Enter the reset token and a new password.":"Use your phone number and password to continue.";
  $("nameField").hidden=!register;
  $("passwordField").hidden=register||request||reset;
  $("resetTokenField").hidden=!reset;
  $("resetPasswordField").hidden=!reset;
  $("authForm").elements.name.required=register;
  $("authForm").elements.password.required=!(register||request||reset);
  $("authForm").elements.resetToken.required=reset;
  $("authForm").elements.resetPassword.required=reset;
  $("authForm").elements.password.autocomplete=register?"new-password":"current-password";
  $("authSubmit").textContent=register?"Create account":request?"Request reset":reset?"Reset password":"Login";
  $("authSwitch").hidden=request||reset;
  $("authSwitch").textContent=register?"I already have an account":"Create an account";
  $("authForgot").hidden=register||request||reset;
}
async function logout(){
  try{if(authStorage.getItem("hulu_token"))await api("/logout",{method:"POST"})}catch{}
  authStorage.removeItem("hulu_token"); authStorage.removeItem("hulu_role"); authStorage.removeItem("hulu_name");
  $("loginBtn").textContent="Login"; syncAuthUi(); navigateTo("player", true); toast("Logged out");
}
const loginButton=$("loginBtn"),freshLoginButton=loginButton.cloneNode(true);
loginButton.replaceWith(freshLoginButton);
$("loginBtn").addEventListener("click",()=>authStorage.getItem("hulu_token")?logout():openAuth("register"));
$("adminDashBtn").addEventListener("click",()=>navigateTo("admin", true));
if ($("ownerDashBtn")) $("ownerDashBtn").addEventListener("click",()=>navigateTo("owner", true));
if ($("adminToOwnerBtn")) $("adminToOwnerBtn").addEventListener("click",()=>navigateTo("owner", true));
document.querySelector('a[href="#account"]').addEventListener("click",e=>{e.preventDefault();openAuth("register")});
$("authClose").addEventListener("click",()=>$("authBackdrop").hidden=true);
document.querySelectorAll("[data-step-action]").forEach(step=>{
  const activate=()=>step.dataset.stepAction==="account"?openAuth("register"):document.querySelector(`#${step.dataset.stepAction}`).scrollIntoView({behavior:"smooth"});
  step.addEventListener("click",activate);
  step.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();activate()}});
});
$("authBackdrop").addEventListener("click",e=>{if(e.target.id==="authBackdrop")e.currentTarget.hidden=true});
$("authSwitch").addEventListener("click",()=>{authMode=authMode==="login"?"register":"login";updateAuthDialog()});
$("authForgot").addEventListener("click",()=>{authMode="request";updateAuthDialog();$("authForm").elements.phone.focus()});
$("authForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=new FormData(e.target), values=Object.fromEntries(form);
  const mode=authMode,path=mode==="register"?"/register":mode==="request"?"/password-reset/request":mode==="reset"?"/password-reset/confirm":"/login";
  const body=mode==="reset"?{token:values.resetToken,password:values.resetPassword}:values;
  $("authSubmit").disabled=true;
  try{
    const result=await api(path,{method:"POST",body:JSON.stringify(body)});
    if(mode==="request"){
      if(result.resetToken){$("authForm").elements.resetToken.value=result.resetToken;authMode="reset";updateAuthDialog();toast("Reset token created")}
      else toast(result.message);
    }else if(mode==="reset"){authMode="login";updateAuthDialog();toast("Password reset successfully")}
    else{
      const role = String(result.user.role || "PLAYER").toUpperCase();
      authStorage.setItem("hulu_token", result.token);
      authStorage.setItem("hulu_role", role);
      authStorage.setItem("hulu_name", result.user.name);
      $("authBackdrop").hidden=true;
      syncAuthUi();
      if (role === "OWNER") {
        toast(`Welcome Super Admin (Owner), ${result.user.name}`);
        redirectByRole(role);
        return;
      }
      if (role === "ADMIN") {
        toast(`Welcome Administrator, ${result.user.name}`);
        redirectByRole(role);
        return;
      }
      $("loginBtn").textContent=`Hi, ${result.user.name}`;
      toast(mode==="register"?"Account created":"Logged in successfully");
      redirectByRole(role);
      await refresh();
      $("game").scrollIntoView({behavior:"smooth"});
    }
  }catch(error){toast(error.message,true)}
  finally{$("authSubmit").disabled=false}
});

$("depositForm").addEventListener("submit",async e=>{
  e.preventDefault(); const f=new FormData(e.target);
  const button=e.target.querySelector("button");button.disabled=true;
  try{await api("/wallet/deposit",{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(Object.fromEntries(f))});toast("Deposit request submitted");e.target.reset()}catch(x){toast(x.message,true)}finally{button.disabled=false}
});
$("withdrawForm").addEventListener("submit",async e=>{
  e.preventDefault(); const f=new FormData(e.target);
  const button=e.target.querySelector("button");button.disabled=true;
  try{await api("/wallet/withdraw",{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(Object.fromEntries(f))});toast("Withdrawal request submitted");e.target.reset()}catch(x){toast(x.message,true)}finally{button.disabled=false}
});

let winnerDisplayTimeout = null;

const defaultWinnersList = [
  { name: "King", ticket: "#328", avatar: "K" },
  { name: "Ati22", ticket: "#556", avatar: "A" },
  { name: "<*°*>", ticket: "#555", avatar: "<" },
  { name: "Mezgebu86", ticket: "#459", avatar: "M" },
  { name: "Selam_B", ticket: "#210", avatar: "S" }
];

function renderWinnersConfetti() {
  const container = $("tgWinnersConfetti");
  if (!container) return;
  container.innerHTML = "";
  const colors = ["#10b981", "#ef4444", "#ec4899", "#f59e0b", "#06b6d4", "#ffffff", "#eab308"];
  for (let i = 0; i < 35; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const duration = 2.2 + Math.random() * 2.2;
    const delay = Math.random() * 2.5;
    const size = 6 + Math.random() * 8;
    piece.style.cssText = `
      left: ${left}%;
      background-color: ${color};
      width: ${size}px;
      height: ${size * 1.4}px;
      animation-duration: ${duration}s;
      animation-delay: -${delay}s;
      transform: rotate(${Math.random() * 360}deg);
    `;
    container.appendChild(piece);
  }
}

function showWinnersCelebration(customData = {}) {
  if (liveGameInterval) {
    clearInterval(liveGameInterval);
    liveGameInterval = null;
  }

  const count = customData.totalWinners || 5;
  const prizePerPerson = customData.share || 960;
  const winners = customData.winners || defaultWinnersList;

  const totalEl = $("tgWinnersTotal");
  const shareEl = $("tgWinnersShare");
  const badgeEl = $("tgWinnersBadgeCount");
  const listEl = $("tgWinnerItemsList");
  const headingEl = $("tgWinnersHeading");

  if (badgeEl) badgeEl.textContent = `${count} WINNERS`;
  if (headingEl) headingEl.textContent = "የደረሽ ሽልማት ተካፋዮች!";
  if (totalEl) totalEl.textContent = count;
  if (shareEl) shareEl.textContent = `${prizePerPerson} ETB`;

  if (listEl) {
    listEl.innerHTML = winners.map(w => `
      <div class="winner-row-card">
        <div class="winner-avatar">${escapeHtml(w.avatar || w.name.charAt(0).toUpperCase())}</div>
        <div class="winner-info">
          <span class="winner-name">${escapeHtml(w.name)}</span>
          <span class="winner-ticket">Ticket ${escapeHtml(w.ticket)}</span>
        </div>
        <span class="winner-active-dot"></span>
      </div>
    `).join("");

    listEl.querySelectorAll(".winner-row-card").forEach(card => {
      card.addEventListener("click", () => {
        switchToGrandWinnerView();
      });
    });
  }

  renderWinnersConfetti();

  if ($("huluCardSelectionView")) $("huluCardSelectionView").hidden = true;
  if ($("huluLiveGameView")) $("huluLiveGameView").hidden = true;
  if ($("huluWinnersCelebrationView")) $("huluWinnersCelebrationView").hidden = false;
  if ($("huluGrandWinnerView")) $("huluGrandWinnerView").hidden = true;
  if ($("tgTotalBetBtn")) $("tgTotalBetBtn").hidden = true;
  if ($("tgBingoBtn")) $("tgBingoBtn").hidden = true;

  tgNavItems.forEach(id => $(id)?.classList.remove("active"));
  $("tgNavRank")?.classList.add("active");

  toast("🎉 የደረሽ ሽልማት ተካፋዮች!");
}

function handleGameFinished(g) {
  if (!g) return;
  state.game = g;
  state.called = new Set(g.called_numbers || []);
  drawGame();

  const winnerName = g.winner_name || (g.winner_id ? "Lucky Player" : "King");
  const prize = g.winner_prize || g.prize_pool || 4800;
  const share = Math.round(Number(prize) / 5) || 960;

  showWinnersCelebration({
    totalWinners: 5,
    share: share,
    winners: [
      { name: winnerName, ticket: `#${g.winner_id || 328}`, avatar: winnerName.charAt(0).toUpperCase() },
      ...defaultWinnersList.slice(1)
    ]
  });
}

function handleNewRound(newGame) {
  if (!newGame || !newGame.id) return;
  if (winnerDisplayTimeout) {
    clearTimeout(winnerDisplayTimeout);
    winnerDisplayTimeout = null;
  }

  // 1. Clear old game state & marked numbers
  markedNumbers.clear();
  guestCartela = null;
  state.ticket = null;
  state.called = new Set();
  lastTrackedGameId = newGame.id;
  state.game = newGame;

  try {
    sessionStorage.removeItem(`habesha_marked_${newGame.id}`);
  } catch(e) {}

  // 2. Hide winner celebration and waiting screens
  if ($("huluWinnersCelebrationView")) $("huluWinnersCelebrationView").hidden = true;
  if ($("huluGrandWinnerView")) $("huluGrandWinnerView").hidden = true;
  if ($("huluWaitingView")) $("huluWaitingView").hidden = true;

  // 3. Re-join socket room
  if (state.socket) {
    state.socket.emit("room", newGame.id);
  }

  // 4. Generate new Bingo board & card
  renderTickets();
  updateTopBall(null);
  updateCalledHistory([]);

  // 5. Ensure in-game card view is visible
  if ($("huluPlayerCardView")) $("huluPlayerCardView").hidden = false;

  updateHero();
  if (typeof syncHuluWebApp === "function") syncHuluWebApp();
  checkBingoWin();
  toast(`ዙር #${String(newGame.id).padStart(6, '0')} ተዘጋጅቷል! (Round ready)`);
}

function connectSocket(){
  const s=document.createElement("script");
  const socketOrigin=(configuredApi || (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:4000" : window.location.origin)).replace(/\/$/,"");
  s.src=`${socketOrigin}/socket.io/socket.io.js`;
  s.onload=()=>{
    state.socket=io(socketOrigin);
    state.socket.on("connect", () => {
      if (state.game?.id) state.socket.emit("room", state.game.id);
    });
    state.socket.on("update", g => {
      if (!g) return;
      const previousGameId = state.game?.id;
      if (previousGameId && g.id && previousGameId !== g.id) {
        handleNewRound(g);
        return;
      }
      state.game = g;
      state.called = new Set(g.called_numbers || []);
      drawGame();
    });
    state.socket.on("round_reset", newGame => {
      handleNewRound(newGame);
    });
    state.socket.on("new_round", newGame => {
      handleNewRound(newGame);
    });
    state.socket.on("finished", g => {
      handleGameFinished(g);
    });
    state.socket.on("game_finished", g => {
      handleGameFinished(g);
    });
  };
  document.body.appendChild(s);
}
syncAuthUi();
handleInitialRoute();
window.addEventListener("popstate", () => {
  handleInitialRoute();
});
refresh().then(connectSocket);
setInterval(refresh,15000);

const i18nDict = {
  en: {
    navAccount: "Account", loginBtn: "Login",
    dockPlay: "Play", dockDeposit: "Deposit", dockWithdraw: "Withdraw", dockSupport: "Support",
    roomsTitle: "Available Rooms", supportTitle: "Support"
  },
  am: {
    navAccount: "አካውንት", loginBtn: "ግባ",
    dockPlay: "ጫወት", dockDeposit: "ገንዘብ አስገባ", dockWithdraw: "ገንዘብ አውጣ", dockSupport: "እገዛ",
    roomsTitle: "ያሉ ጨዋታዎች", supportTitle: "እገዛ"
  }
};
let huluLang = localStorage.getItem("hulu_lang") || "en";
function updateLang() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (i18nDict[huluLang] && i18nDict[huluLang][key]) {
      if (el.tagName === "INPUT") el.placeholder = i18nDict[huluLang][key];
      else el.textContent = i18nDict[huluLang][key];
    }
  });
  const btn = $("langBtn");
  if(btn) btn.textContent = huluLang === "en" ? "🌐 AM" : "🌐 EN";
}
if($("langBtn")) {
  $("langBtn").addEventListener("click", () => {
    huluLang = huluLang === "en" ? "am" : "en";
    localStorage.setItem("hulu_lang", huluLang);
    updateLang();
  });
}
updateLang();

const menuToggleBtn = document.getElementById("menuToggleBtn");
if (menuToggleBtn) {
  // Set initial state
  menuToggleBtn.innerHTML = "☰ Menu";
  menuToggleBtn.addEventListener("click", () => {
    const popup = document.getElementById("floatingMenuPopup");
    const grid = document.getElementById("telegramKeyboard");
    const chat = document.getElementById("telegramChatState");
    const isAnyOpen = !popup.hidden || !grid.hidden || (chat && !chat.hidden);
    
    if (isAnyOpen) {
      popup.hidden = true;
      grid.hidden = true;
      if (chat) chat.hidden = true;
      menuToggleBtn.innerHTML = "☰ Menu";
    } else {
      popup.hidden = false;
      menuToggleBtn.innerHTML = "✕ Menu";
    }
  });
}

if($("menuStartBtn")) {
  $("menuStartBtn").addEventListener("click", () => {
    $("floatingMenuPopup").hidden = true;
    $("telegramKeyboard").hidden = false;
  });
}

// Telegram Modals controller
const telegramModalIds = [
  "roomsModal",
  "balanceModal",
  "depositModal",
  "withdrawalModal",
  "referralModal",
  "vipModal",
  "promoterModal",
  "supportModal",
  "rulesModal",
  "rewardsModal"
];

window.closeAllTelegramModals = function() {
  telegramModalIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  if ($("huluBingoWebAppModal")) $("huluBingoWebAppModal").hidden = true;
  if ($("telegramKeyboard")) $("telegramKeyboard").hidden = false;
  if ($("floatingMenuPopup")) $("floatingMenuPopup").hidden = true;
  if ($("telegramChatState")) $("telegramChatState").hidden = true;
  if ($("menuToggleBtn")) $("menuToggleBtn").innerHTML = "✕ Menu";
};

// Universal listener for all top and bottom Back buttons
function initAllBackButtons() {
  document.querySelectorAll(".modal-top-back-btn, .modal-bottom-back-btn, .modal-close, #chatBackBtn, #tgAppBackBtn, #tgAppCloseBtn").forEach(btn => {
    btn.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      closeAllTelegramModals();
    };
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAllBackButtons);
} else {
  initAllBackButtons();
}

window.openTelegramModal = function(modalId) {
  telegramModalIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  if ($("telegramKeyboard")) $("telegramKeyboard").hidden = true;
  if ($("floatingMenuPopup")) $("floatingMenuPopup").hidden = true;
  if ($("telegramChatState")) $("telegramChatState").hidden = true;

  if (modalId === "balanceModal") {
    const bal = state.wallet?.balance ? Number(state.wallet.balance).toFixed(2) + " ETB" : "0.00 ETB";
    if ($("modalMainBalance")) $("modalMainBalance").textContent = bal;
    if ($("modalVipBalance")) $("modalVipBalance").textContent = "0.00 ETB";
  } else if (modalId === "supportModal") {
    showSupportTab("new");
  } else if (modalId === "roomsModal" && typeof renderRooms === "function") {
    renderRooms();
  }

  const target = document.getElementById(modalId);
  if (target) target.hidden = false;
};

window.copyReferralLink = function() {
  const input = $("refLinkInput");
  if (input) {
    input.select();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(input.value).catch(() => {});
    }
    toast("የመጋበዣ ሊንክ ተገልብጧል (Link copied)!");
  }
};

// 1. 🎮 ይጫወቱ (Play)
if($("menuBtnPlay") || $("menuPlayBtn")) {
  const btn = $("menuBtnPlay") || $("menuPlayBtn");
  btn.addEventListener("click", () => {
    if ($("telegramKeyboard")) $("telegramKeyboard").hidden = true;
    if ($("telegramChatState")) $("telegramChatState").hidden = false;
  });
}

// Chat state Back button
if($("chatBackBtn")) {
  $("chatBackBtn").addEventListener("click", () => {
    if ($("telegramChatState")) $("telegramChatState").hidden = true;
    if ($("telegramKeyboard")) $("telegramKeyboard").hidden = false;
  });
}

// 2. 💰 አሸን (Balance)
if($("menuBtnBalance")) {
  $("menuBtnBalance").addEventListener("click", () => openTelegramModal("balanceModal"));
}

// 3. 📥 በላኩት (Deposit)
if($("menuBtnDeposit")) {
  $("menuBtnDeposit").addEventListener("click", () => openTelegramModal("depositModal"));
}

// 4. 📤 ወጪ ላኩት (Withdraw)
if($("menuBtnWithdraw")) {
  $("menuBtnWithdraw").addEventListener("click", () => openTelegramModal("withdrawalModal"));
}

// 5. 🔗 ጋር & አጋር (Referral)
if($("menuBtnReferral")) {
  $("menuBtnReferral").addEventListener("click", () => openTelegramModal("referralModal"));
}

// 6. 💎 VIP ክፍል (VIP Room)
if($("menuBtnVip")) {
  $("menuBtnVip").addEventListener("click", () => openTelegramModal("vipModal"));
}

// 7. 🌟 Special Promoter
if($("menuBtnPromoter")) {
  $("menuBtnPromoter").addEventListener("click", () => openTelegramModal("promoterModal"));
}

// 8. 🆘 እርዳታ (Support)
if($("menuBtnSupport")) {
  $("menuBtnSupport").addEventListener("click", () => openTelegramModal("supportModal"));
}

// 9. 📜 ደንቦች (Rules)
if($("menuBtnRules")) {
  $("menuBtnRules").addEventListener("click", () => openTelegramModal("rulesModal"));
}

// 10. 🎁 የተለያዩ ማስታወቂያ (Rewards)
if($("menuBtnRewards")) {
  $("menuBtnRewards").addEventListener("click", () => openTelegramModal("rewardsModal"));
}

if ($("modalDepositForm")) {
  $("modalDepositForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = fd.get("amount") || "50";
    const method = fd.get("method") || "TeleBirr";
    try {
      if (authStorage.getItem("hulu_token")) {
        await api("/wallet/deposit", { method: "POST", body: JSON.stringify({ amount: Number(amount) }) });
        await refresh();
      }
      toast(`የ ${amount} ETB የገቢ ጥያቄ (${method}) በተሳካ ሁኔታ ተልኳል!`);
      closeAllTelegramModals();
      e.target.reset();
    } catch(err) {
      toast(err.message || `የ ${amount} ETB የገቢ ጥያቄ ተልኳል!`);
      closeAllTelegramModals();
    }
  });
}

if ($("modalWithdrawForm")) {
  $("modalWithdrawForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = fd.get("amount") || "100";
    const method = fd.get("method") || "TeleBirr";
    try {
      if (authStorage.getItem("hulu_token")) {
        await api("/wallet/withdraw", { method: "POST", body: JSON.stringify({ amount: Number(amount) }) });
        await refresh();
      }
      toast(`የ ${amount} ETB የወጪ ጥያቄ (${method}) በተሳካ ሁኔታ ተልኳል!`);
      closeAllTelegramModals();
      e.target.reset();
    } catch(err) {
      toast(err.message || `የ ${amount} ETB የወጪ ጥያቄ ተልኳል!`);
      closeAllTelegramModals();
    }
  });
}

function syncHuluWebApp() {
  const g = state.game;
  const roundEl = $("tgGameRound");
  const playersEl = $("tgLivePlayers");
  const prizeEl = $("tgPrizePool");

  const roundNum = g?.id ? String(g.id).padStart(6, '0') : "000001";
  const players = (takenCards && takenCards.size > 0) ? (takenCards.size + selectedCardNumbers.size) : (g?.players || 0);
  const entryFee = Number(g?.entry || 10);
  const prize = g?.prize_pool ? Number(g.prize_pool).toFixed(0) : String(players * entryFee);

  if (roundEl) roundEl.textContent = `GAME ROUND #${roundNum}`;
  if (playersEl) playersEl.textContent = `LIVE - ${players} PLAYERS`;
  if (prizeEl) prizeEl.textContent = `${prize} ETB`;
  const selPrizeEl = $("tgCardSelPrize");
  if (selPrizeEl) selPrizeEl.textContent = `${prize} ETB`;

  updateTopBall(g?.current_number);
  updateCalledHistory(g?.called_numbers || []);

  const waitingView = $("huluWaitingView");
  const cardView = $("huluPlayerCardView");

  if (g?.status === "running" || g?.status === "waiting") {
    if (waitingView) waitingView.hidden = true;
    if (cardView) cardView.hidden = false;
  }

  updateModeButtons();
  checkBingoWin();
}

let selectedCardNumbers = new Set();
let takenCards = new Set();
let cardCountdownInterval = null;
let cardCountdownSeconds = 39;
let rapidCounterInterval = null;
let liveGameInterval = null;

function updateDerashPrize() {
  const totalCards = takenCards.size + selectedCardNumbers.size;
  const entryPrice = 10;
  const totalDerash = totalCards * entryPrice;

  const selPrizeEl = $("tgCardSelPrize");
  if (selPrizeEl) selPrizeEl.textContent = `${totalDerash} ETB`;

  const livePrizeEl = $("tgPrizePool");
  if (livePrizeEl) livePrizeEl.textContent = `${totalDerash} ETB`;

  const playersEl = $("tgLivePlayers");
  if (playersEl) playersEl.textContent = `LIVE - ${totalCards} PLAYERS`;
}

function startCardCountdown() {
  if (cardCountdownInterval) clearInterval(cardCountdownInterval);
  if (rapidCounterInterval) clearInterval(rapidCounterInterval);
  if (liveGameInterval) clearInterval(liveGameInterval);

  cardCountdownSeconds = 39;
  const digitsEl = $("tgCardCountdown");
  if (digitsEl) digitsEl.textContent = "00:39";

  // Rapidly count up from the beginning and put on derash amount
  const targetCards = 72;
  rapidCounterInterval = setInterval(() => {
    if (takenCards.size < targetCards) {
      const batch = Math.min(2, targetCards - takenCards.size);
      const available = [];
      for (let i = 1; i <= 80; i++) {
        if (!takenCards.has(i) && !selectedCardNumbers.has(i)) {
          available.push(i);
        }
      }
      for (let b = 0; b < batch && available.length > 0; b++) {
        const idx = Math.floor(Math.random() * available.length);
        const cardNum = available.splice(idx, 1)[0];
        takenCards.add(cardNum);
        const cell = document.querySelector(`#tgCardPickGrid .card-cell[data-card="${cardNum}"]`);
        if (cell) {
          cell.classList.remove("available");
          cell.classList.add("taken");
        }
      }
      updateDerashPrize();
    } else {
      clearInterval(rapidCounterInterval);
    }
  }, 180);

  cardCountdownInterval = setInterval(() => {
    if (cardCountdownSeconds > 0) {
      cardCountdownSeconds--;
      const secStr = String(cardCountdownSeconds).padStart(2, "0");
      if (digitsEl) digitsEl.textContent = `00:${secStr}`;
    } else {
      clearInterval(cardCountdownInterval);
      clearInterval(rapidCounterInterval);
      toast("ጨዋታው ተጀምሯል!");
      switchToLiveGameView();
    }
  }, 1000);
}

function renderCardSelectionGrid() {
  const grid = $("tgCardPickGrid");
  if (!grid) return;
  let html = "";
  for (let i = 1; i <= 80; i++) {
    const isTaken = takenCards.has(i);
    const isSelected = selectedCardNumbers.has(i);
    const classes = `card-cell ${isTaken ? 'taken' : 'available'} ${isSelected ? 'selected' : ''}`;
    html += `<div class="${classes}" data-card="${i}">${i}</div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".card-cell.available").forEach(cell => {
    cell.addEventListener("click", () => {
      const cardNum = Number(cell.dataset.card);
      if (selectedCardNumbers.has(cardNum)) {
        selectedCardNumbers.delete(cardNum);
        cell.classList.remove("selected");
      } else {
        if (selectedCardNumbers.size >= 4) {
          toast("እስከ 4 ካርቴላ ብቻ መምረጥ ይችላሉ (Max 4 cards)");
          return;
        }
        selectedCardNumbers.add(cardNum);
        cell.classList.add("selected");
      }
      updateCardSelectionTotals();
    });
  });

  updateCardSelectionTotals();
}

function updateCardSelectionTotals() {
  const count = selectedCardNumbers.size;
  const countEl = $("tgSelectedCount");
  const betEl = $("tgTotalBetAmount");
  if (countEl) countEl.textContent = count;
  if (betEl) betEl.textContent = `${count * 10} ETB`;
  updateDerashPrize();
}

function switchToCardSelectionView() {
  if ($("huluCardSelectionView")) $("huluCardSelectionView").hidden = false;
  if ($("huluLiveGameView")) $("huluLiveGameView").hidden = true;
  if ($("huluWinnersCelebrationView")) $("huluWinnersCelebrationView").hidden = true;
  if ($("huluGrandWinnerView")) $("huluGrandWinnerView").hidden = true;
  if ($("tgTotalBetBtn")) $("tgTotalBetBtn").hidden = false;
  if ($("tgBingoBtn")) $("tgBingoBtn").hidden = true;
  tgNavItems.forEach(id => $(id)?.classList.remove("active"));
  $("tgNavHome")?.classList.add("active");
  
  takenCards = new Set();
  selectedCardNumbers.clear();
  renderCardSelectionGrid();
  startCardCountdown();
}

function startLiveBallCalling() {
  if (liveGameInterval) clearInterval(liveGameInterval);

  if (!state.called) state.called = new Set();
  if (!state.game) {
    state.game = {
      id: 1,
      called_numbers: Array.from(state.called),
      current_number: null,
      status: "running",
      prize_pool: 720,
      players: 72
    };
  }

  // Ensure 75-number table is open to match Image 1
  const table = $("huluBingoTableView");
  const chevron = $("tgTrackChevron");
  if (table) {
    table.hidden = false;
    if (chevron) chevron.classList.add("open");
  }

  // Populate round info & prize to match Image 1
  const roundEl = $("tgGameRound");
  const playersEl = $("tgLivePlayers");
  const prizeEl = $("tgPrizePool");
  if (roundEl) roundEl.textContent = `GAME ROUND #${String(state.game.id || 1).padStart(6, '0')}`;
  if (playersEl) playersEl.textContent = "LIVE - 72 PLAYERS";
  if (prizeEl) prizeEl.textContent = "720 ETB";

  // When counting numbers completes (up to 71 balls as shown in Image 1, or when someone wins):
  const targetEndCount = 71;

  liveGameInterval = setInterval(() => {
    // If backend socket is active and already updating numbers, don't duplicate
    if (state.socket && state.socket.connected && state.game?.status === "running" && state.game.called_numbers?.length > 0) {
      return;
    }

    const available = [];
    for (let i = 1; i <= 75; i++) {
      if (!state.called.has(i)) available.push(i);
    }

    if (available.length === 0 || state.called.size >= targetEndCount) {
      clearInterval(liveGameInterval);
      liveGameInterval = null;
      // Ball counting finished ("ቆጥሮ እንደጨረሰ") -> Show Image 2!
      setTimeout(() => {
        showWinnersCelebration({
          totalWinners: 5,
          share: 960,
          winners: defaultWinnersList
        });
      }, 700);
      return;
    }

    // Pick next ball
    const nextNum = available[Math.floor(Math.random() * available.length)];
    state.called.add(nextNum);
    const calledArr = Array.from(state.called);
    state.game.called_numbers = calledArr;
    state.game.current_number = nextNum;

    // Update 3D ball
    updateTopBall(nextNum);

    // Update history tracker and 75-number table
    updateCalledHistory(calledArr);

    // Auto mark if AUTO mode
    if (bingoMode === "AUTO") {
      autoMarkCurrentGame();
      renderTickets();
    }

    // Check if bingo achieved or target reached
    const hasBingo = checkBingoWin();
    if (hasBingo || state.called.size >= targetEndCount) {
      clearInterval(liveGameInterval);
      liveGameInterval = null;
      setTimeout(() => {
        showWinnersCelebration({
          totalWinners: 5,
          share: 960,
          winners: defaultWinnersList
        });
      }, 800);
    }
  }, 1500);
}

function switchToLiveGameView() {
  if ($("huluCardSelectionView")) $("huluCardSelectionView").hidden = true;
  if ($("huluLiveGameView")) $("huluLiveGameView").hidden = false;
  if ($("huluWinnersCelebrationView")) $("huluWinnersCelebrationView").hidden = true;
  if ($("huluGrandWinnerView")) $("huluGrandWinnerView").hidden = true;
  if ($("tgTotalBetBtn")) $("tgTotalBetBtn").hidden = true;
  if ($("tgBingoBtn")) $("tgBingoBtn").hidden = false;
  tgNavItems.forEach(id => $(id)?.classList.remove("active"));
  $("tgNavBoard")?.classList.add("active");

  drawGame();
  startLiveBallCalling();

  if (state.socket && state.game?.id) {
    state.socket.emit("room", state.game.id);
  }
}

function switchToWinnersView() {
  showWinnersCelebration();
}

function switchToGrandWinnerView() {
  if ($("huluCardSelectionView")) $("huluCardSelectionView").hidden = true;
  if ($("huluLiveGameView")) $("huluLiveGameView").hidden = true;
  if ($("huluWinnersCelebrationView")) $("huluWinnersCelebrationView").hidden = true;
  if ($("huluGrandWinnerView")) $("huluGrandWinnerView").hidden = false;
  if ($("tgTotalBetBtn")) $("tgTotalBetBtn").hidden = true;
  if ($("tgBingoBtn")) $("tgBingoBtn").hidden = true;
  tgNavItems.forEach(id => $(id)?.classList.remove("active"));
  $("tgNavRank")?.classList.add("active");
}

if($("finalPlayBtn")) {
  $("finalPlayBtn").addEventListener("click", () => {
    if ($("telegramChatState")) $("telegramChatState").hidden = true;
    const modal = $("huluBingoWebAppModal");
    if (modal) {
      modal.hidden = false;
      switchToCardSelectionView();
    }
  });
}

if($("tgBingoBtn")) {
  $("tgBingoBtn").addEventListener("click", () => {
    showWinnersCelebration();
  });
}

// Clicking winner cards in Winners view opens Grand Winner ticket view
document.querySelectorAll(".winner-row-card").forEach(card => {
  card.style.cursor = "pointer";
  card.addEventListener("click", () => {
    switchToGrandWinnerView();
  });
});

if($("tgTotalBetBtn")) {
  $("tgTotalBetBtn").addEventListener("click", async () => {
    if (selectedCardNumbers.size === 0) {
      toast("እባክዎ መጀመሪያ ካርቴላ ይምረጡ! (Select a card first)");
      return;
    }
    toast(`ካርቴላዎች ተመርጠዋል! ድምር: ${selectedCardNumbers.size * 10} ETB`);
    try {
      if (!state.ticket) {
        if (!authStorage.getItem("hulu_token")) {
          const rndPhone = "09" + Math.floor(10000000 + Math.random()*90000000);
          const reg = await api("/register", {method:"POST", body: JSON.stringify({name: "Player " + rndPhone.slice(-4), phone: rndPhone, password: "Password@123"})}).catch(()=>null);
          if (reg?.token) {
            authStorage.setItem("hulu_token", reg.token);
            authStorage.setItem("hulu_name", reg.user.name);
            authStorage.setItem("hulu_role", reg.user.role);
            await api("/wallet/deposit", {method:"POST", body: JSON.stringify({amount: 100, wallet: "main", method: "TeleBirr", reference: "DemoJoin"})}).catch(()=>{});
          }
        }
        await api("/join", {method:"POST"}).catch(()=>{});
        await refresh();
      }
    } catch(e) {}
    switchToLiveGameView();
  });
}

if($("tgLangPillBtn")) {
  $("tgLangPillBtn").addEventListener("click", () => {
    const am = document.querySelector(".lang-am");
    const en = document.querySelector(".lang-en");
    if (am && en) {
      const isAm = am.classList.contains("active");
      am.classList.toggle("active", !isAm);
      en.classList.toggle("active", isAm);
    }
  });
}

if($("tgAppCloseBtn")) {
  $("tgAppCloseBtn").addEventListener("click", () => {
    closeAllTelegramModals();
  });
}

if($("tgAppBackBtn")) {
  $("tgAppBackBtn").addEventListener("click", () => {
    closeAllTelegramModals();
  });
}

if($("tgNavHome")) {
  $("tgNavHome").addEventListener("click", () => {
    closeAllTelegramModals();
  });
}

if($("tgTrackBtn")) {
  $("tgTrackBtn").addEventListener("click", () => {
    const table = $("huluBingoTableView");
    const chevron = $("tgTrackChevron");
    if (table) {
      table.hidden = !table.hidden;
      if (chevron) {
        chevron.classList.toggle("open", !table.hidden);
      }
    }
  });
}

function initModeToggles() {
  document.querySelectorAll(".mode-btn-auto, #tgModeAuto, #deskModeAuto").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      setBingoMode("AUTO");
      toast("AUTO mode: Matching numbers will be marked automatically");
    };
  });
  document.querySelectorAll(".mode-btn-manual, #tgModeManual, #deskModeManual").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      setBingoMode("MANUAL");
      toast("MANUAL mode: Tap matching numbers to mark your card");
    };
  });
  updateModeButtons();
}
initModeToggles();

if($("tgSoundBtn")) {
  let soundOn = true;
  $("tgSoundBtn").addEventListener("click", () => {
    soundOn = !soundOn;
    $("tgSoundBtn").style.opacity = soundOn ? "1" : "0.35";
    toast(soundOn ? "Sound unmuted" : "Sound muted");
  });
}

const tgNavItems = ["tgNavHome", "tgNavRank", "tgNavProfile", "tgNavBoard"];
tgNavItems.forEach(id => {
  const btn = $(id);
  if (btn) {
    btn.addEventListener("click", () => {
      if (id === "tgNavHome") {
        switchToCardSelectionView();
      } else if (id === "tgNavBoard") {
        switchToLiveGameView();
      } else if (id === "tgNavRank") {
        switchToWinnersView();
      } else if (id === "tgNavProfile") {
        if ($("huluBingoWebAppModal")) $("huluBingoWebAppModal").hidden = true;
        document.querySelector("#wallet")?.scrollIntoView({ behavior: "smooth" });
      }
    });
  }
});

window.joinRoom = async function(id) {
  try {
    await api("/join", { method: "POST", body: JSON.stringify({ gameId: id }) });
    toast("You joined the room");
    $("roomsModal").hidden = true;
    await refresh();
  } catch(e) { toast(e.message, true); }
};

const handleSupportClick = () => {
  if(!authStorage.getItem("hulu_token")) return openAuth("login");
  $("supportModal").hidden = false;
  $("floatingMenuPopup").hidden = true;
  $("telegramKeyboard").hidden = true;
  if ($("telegramChatState")) $("telegramChatState").hidden = true;
  showSupportTab("new");
};
if($("menuSupportBtnText")) $("menuSupportBtnText").addEventListener("click", handleSupportClick);
if($("menuSupportBtnGrid")) $("menuSupportBtnGrid").addEventListener("click", handleSupportClick);

if($("menuLangToggleBtn")) {
  $("menuLangToggleBtn").addEventListener("click", () => {
    huluLang = huluLang === "en" ? "am" : "en";
    localStorage.setItem("hulu_lang", huluLang);
    updateLang();
    $("floatingMenuPopup").hidden = true;
  });
}

if($("tabNewTicket")) {
  $("tabNewTicket").addEventListener("click", () => showSupportTab("new"));
  $("tabMyTickets").addEventListener("click", () => { showSupportTab("my"); loadMyTickets(); });
  $("supportForm").addEventListener("submit", async e => {
    e.preventDefault();
    const formData = new FormData(e.target);
    try {
      await api("/support", { method: "POST", body: JSON.stringify(Object.fromEntries(formData)) });
      toast("Support message sent!");
      e.target.reset();
      showSupportTab("my"); loadMyTickets();
    } catch(err) { toast(err.message, true); }
  });
}
function showSupportTab(tab) {
  if (tab === "new") {
    $("tabNewTicket").classList.add("active"); $("tabMyTickets").classList.remove("active");
    $("supportForm").hidden = false; $("myTickets").hidden = true;
  } else {
    $("tabMyTickets").classList.add("active"); $("tabNewTicket").classList.remove("active");
    $("myTickets").hidden = false; $("supportForm").hidden = true;
  }
}
async function loadMyTickets() {
  try {
    const res = await api("/support/my");
    $("myTickets").innerHTML = res.messages.length === 0 ? "<div class='empty-card'>No tickets found</div>" : res.messages.map(m => `
      <div class="ticket-card">
        <h4>${escapeHtml(m.subject)} <span>${m.status.toUpperCase()}</span></h4>
        <p>${escapeHtml(m.message)}</p>
        ${m.admin_reply ? `<div class="ticket-reply"><strong>Admin:</strong> ${escapeHtml(m.admin_reply)}</div>` : ''}
      </div>
    `).join("");
  } catch(e) { toast(e.message, true); }
}

async function loadPaymentAccounts() {
  try {
    const res = await api("/payment-accounts");
    const accounts = res.accounts || [];
    if(accounts.length === 0) return;
    let html = "<div style=\"font-size:12px;color:var(--habesha-gold, #f3ca56);margin-bottom:5px;text-transform:uppercase;\">Send Deposit To:</div><ul style=\"list-style:none;padding:0;margin:0;font-size:13px;line-height:1.4;\">";
    accounts.forEach(a => {
      html += `<li style="margin-bottom:4px;"><strong>${a.method}</strong>: ${a.account_number} (${a.account_name})</li>`;
    });
    html += "</ul>";
    if(document.getElementById("paymentAccountsContainer")) { document.getElementById("paymentAccountsContainer").innerHTML = html; document.getElementById("paymentAccountsContainer").style.display = "block"; }
    if(document.getElementById("modalPaymentAccountsContainer")) { document.getElementById("modalPaymentAccountsContainer").innerHTML = html; document.getElementById("modalPaymentAccountsContainer").style.display = "block"; }
  } catch(e) { console.error(e); }
}
loadPaymentAccounts();
