(function() {
  const configuredApi = window.HABESHA_API || "";
  const API = configuredApi ? `${configuredApi}/api` : "/api";
  const $ = id => document.getElementById(id);
  const storage = window.sessionStorage;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function money(value) {
    return `${Number(value || 0).toFixed(2)} ETB`;
  }

  async function api(path, options = {}) {
    const token = storage.getItem("hulu_token");
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(API + path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function showError(id, message) {
    const el = $(id);
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
  }

  function clearError(id) {
    const el = $(id);
    if (el) el.hidden = true;
  }

  function renderUsers(users) {
    const el = $("usersBody");
    if (!el) return;
    el.innerHTML = users.map(user => {
      const role = String(user.role || "PLAYER").toUpperCase();
      const isActive = Boolean(user.is_active);
      return `<tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.phone)}</td>
        <td>${role}</td>
        <td>${isActive ? "Active" : "Disabled"}</td>
        <td>
          <button class="table-action user-save" data-id="${user.id}" data-role="${role}" data-active="${String(isActive)}">${isActive ? "Disable" : "Enable"}</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="5">No users.</td></tr>`;
  }

  function renderWallets(wallets) {
    const el = $("walletsBody");
    if (!el) return;
    el.innerHTML = wallets.map(wallet => `<tr><td>${escapeHtml(wallet.name)}</td><td>${money(wallet.main_balance)}</td><td>${money(wallet.vip_balance)}</td></tr>`).join("") || `<tr><td colspan="3">No wallets.</td></tr>`;
  }

  function renderGames(games) {
    const el = $("gamesBody");
    if (!el) return;
    el.innerHTML = games.map(game => `<tr><td>#${game.id} ${escapeHtml(game.name)}</td><td>${game.players}</td><td>${money(game.prize_pool)}</td><td><select class="status-select game-status" data-id="${game.id}">${["waiting","running","finished","cancelled"].map(status=>`<option ${game.status===status?"selected":""}>${status}</option>`).join("")}</select></td><td><button class="table-action game-save" data-id="${game.id}">Save</button></td></tr>`).join("") || `<tr><td colspan="5">No games.</td></tr>`;
  }

  function renderTransactions(transactions) {
    const el = $("transactionsBody");
    if (!el) return;
    el.innerHTML = transactions.map(transaction => `<tr><td>${escapeHtml(transaction.name)}</td><td>${escapeHtml(transaction.type)}</td><td>${escapeHtml(transaction.wallet)}</td><td>${money(transaction.amount)}</td><td>${escapeHtml(transaction.status)}</td><td>${transaction.status==="pending"?`<button class="table-action transaction-action" data-action="approve" data-id="${transaction.id}">Approve</button> <button class="table-action danger transaction-action" data-action="reject" data-id="${transaction.id}">Reject</button>`:""}</td></tr>`).join("") || `<tr><td colspan="6">No transactions.</td></tr>`;
  }

  function renderWinners(winners) {
    const el = $("winnersBody");
    if (!el) return;
    el.innerHTML = winners.map(winner => `<tr><td>${escapeHtml(winner.name)}</td><td>#${winner.game_id}</td><td>${money(winner.prize_amount)}</td></tr>`).join("") || `<tr><td colspan="3">No winners.</td></tr>`;
  }

  function renderAudit(logs) {
    const el = $("auditBody");
    if (!el) return;
    el.innerHTML = logs.map(log => `<tr><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.entity_type||"")} #${escapeHtml(log.entity_id||"")}</td><td>${escapeHtml(new Date(log.created_at).toLocaleString())}</td></tr>`).join("") || `<tr><td colspan="3">No audit events.</td></tr>`;
  }

  function renderOverview(overview) {
    if ($("activeUserCount")) $("activeUserCount").textContent = overview.users.active;
    if ($("demoBalance")) $("demoBalance").textContent = money(overview.totalDemoWalletBalance);
    if ($("currentPlayerCount")) $("currentPlayerCount").textContent = overview.currentPlayers;
    if ($("currentPrizePool")) $("currentPrizePool").textContent = money(overview.activeGame?.prize_pool);
    if ($("completedGameCount")) $("completedGameCount").textContent = overview.completedGames;
    if ($("pendingCount")) $("pendingCount").textContent = overview.pendingTransactions;
    if ($("activityBody")) {
      $("activityBody").innerHTML = overview.recentActivity.map(item => `<tr><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.entity_type||"")} #${escapeHtml(item.entity_id||"")}</td><td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td></tr>`).join("") || `<tr><td colspan="3">No recent activity.</td></tr>`;
    }
  }

  function renderSettings(settings) {
    for (const setting of settings) {
      const input = document.querySelector(`[name="${setting.key}"]`);
      if (input) input.value = setting.value;
    }
  }

  function renderSupport(messages) {
    const el = $("supportBody");
    if (!el) return;
    el.innerHTML = messages.map(msg => `<tr>
      <td><strong>${escapeHtml(msg.name)}</strong><br><small>${escapeHtml(msg.phone)}</small></td>
      <td><strong>${escapeHtml(msg.subject)}</strong><br><small>${escapeHtml(msg.message)}</small></td>
      <td>${escapeHtml(msg.status)}</td>
      <td>
        ${msg.status !== 'closed' ? `<input type="text" id="replyInput-${msg.id}" placeholder="Type reply..."><button class="table-action support-reply" data-id="${msg.id}">Reply</button>` : `<span>Closed</span>`}
      </td>
    </tr>`).join("") || `<tr><td colspan="4">No support messages.</td></tr>`;
  }

  function renderPaymentAccounts(accounts) {
    const t = $("paymentAccountsBody");
    if (!t) return;
    t.innerHTML = accounts.map(a => `<tr>
      <td>${escapeHtml(a.method)}</td>
      <td>${escapeHtml(a.account_number)}</td>
      <td>${escapeHtml(a.account_name)}</td>
      <td><span class="status ${a.is_active ? 'running' : 'cancelled'}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button class="btn btn-outline toggle-payment-btn" data-id="${a.id}" data-active="${!a.is_active}">${a.is_active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-outline delete-payment-btn" data-id="${a.id}" style="color:var(--habesha-red); border-color:var(--habesha-red);">Delete</button>
      </td>
    </tr>`).join("");
  }

  async function loadDashboard() {
    clearError("dashboardError");
    try {
      const search = encodeURIComponent($("userSearch")?.value || "");
      const [overview, users, wallets, games, transactions, winners, audit, settings, support, payments] = await Promise.all([
        api("/admin/overview"),
        api(`/admin/users?search=${search}`),
        api("/admin/wallets"),
        api("/admin/games"),
        api("/admin/transactions"),
        api("/admin/winners"),
        api("/admin/audit-logs"),
        api("/admin/settings"),
        api("/admin/support"),
        api("/admin/payment-accounts")
      ]);

      renderUsers(users.users);
      renderWallets(wallets.wallets);
      renderGames(games.games);
      renderTransactions(transactions.transactions);
      renderWinners(winners.winners);
      renderAudit(audit.logs);
      renderOverview(overview);
      renderSettings(settings.settings);
      renderSupport(support.messages);
      renderPaymentAccounts(payments.accounts);

      if ($("userCount")) $("userCount").textContent = overview.users.total;
      if ($("gameCount")) $("gameCount").textContent = games.games.filter(game => ["waiting", "running"].includes(game.status)).length;
      if ($("winnerCount")) $("winnerCount").textContent = winners.winners.length;
    } catch (error) {
      if (error.message === "Authentication required" || error.message === "Access denied") {
        if (typeof window.navigateTo === "function") {
          window.navigateTo("player", true);
        }
      }
      showError("dashboardError", error.message);
    }
  }

  function showDashboard() {
    if ($("dashboard")) $("dashboard").hidden = false;
    if ($("adminLogoutBtn")) $("adminLogoutBtn").hidden = false;
    loadDashboard();
  }

  async function handleAdminLogout(openLoginModal = false) {
    try { await api("/logout", { method: "POST" }); } catch {}
    storage.removeItem("hulu_token");
    storage.removeItem("hulu_role");
    storage.removeItem("hulu_name");
    if (typeof window.navigateTo === "function") {
      window.navigateTo("player", true);
    } else {
      if ($("playerApp")) $("playerApp").hidden = false;
      if ($("adminApp")) $("adminApp").hidden = true;
    }
    if (typeof window.syncAuthUi === "function") window.syncAuthUi();
    if (openLoginModal && typeof window.openAuth === "function") {
      setTimeout(() => window.openAuth("login"), 100);
    }
  }

  if ($("adminLogoutBtn")) $("adminLogoutBtn").addEventListener("click", () => handleAdminLogout(false));
  if ($("adminBackToLoginBtn")) $("adminBackToLoginBtn").addEventListener("click", () => handleAdminLogout(true));
  if ($("adminToPlayerBtn")) {
    $("adminToPlayerBtn").addEventListener("click", () => {
      if (typeof window.navigateTo === "function") {
        window.navigateTo("player", true);
      }
    });
  }
  if ($("adminBrandLink")) {
    $("adminBrandLink").addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof window.navigateTo === "function") {
        window.navigateTo("player", true);
      }
    });
  }

  if ($("refreshBtn")) $("refreshBtn").addEventListener("click", loadDashboard);

  let searchTimer;
  if ($("userSearch")) {
    $("userSearch").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadDashboard, 250);
    });
  }

  if ($("settingsForm")) {
    $("settingsForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await api("/admin/settings", {
          method: "PATCH",
          body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
        });
        await loadDashboard();
      } catch (error) {
        showError("dashboardError", error.message);
      }
    });
  }

  document.addEventListener("click", async event => {
    const userSave = event.target.closest(".user-save");
    if (userSave) {
      const id = userSave.dataset.id, role = userSave.dataset.role || "PLAYER";
      try {
        await api(`/admin/users/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ role, is_active: userSave.dataset.active !== "true" })
        });
        await loadDashboard();
      } catch (error) {
        showError("dashboardError", error.message);
      }
      return;
    }

    const gameSave = event.target.closest(".game-save");
    if (gameSave) {
      const id = gameSave.dataset.id;
      const statusSelect = document.querySelector(`.game-status[data-id="${id}"]`);
      if (statusSelect) {
        try {
          await api(`/admin/games/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: statusSelect.value })
          });
          await loadDashboard();
        } catch (error) {
          showError("dashboardError", error.message);
        }
      }
      return;
    }

    const transactionAction = event.target.closest(".transaction-action");
    if (transactionAction) {
      try {
        await api(`/admin/transactions/${transactionAction.dataset.id}/${transactionAction.dataset.action}`, { method: "POST" });
        await loadDashboard();
      } catch (error) {
        showError("dashboardError", error.message);
      }
      return;
    }

    const supportReply = event.target.closest(".support-reply");
    if (supportReply) {
      const id = supportReply.dataset.id;
      const reply = document.getElementById(`replyInput-${id}`)?.value;
      if (!reply) return alert("Reply cannot be empty");
      try {
        await api(`/admin/support/${id}/reply`, {
          method: "POST",
          body: JSON.stringify({ reply, status: "resolved" })
        });
        await loadDashboard();
      } catch (error) {
        showError("dashboardError", error.message);
      }
      return;
    }

    const togglePayment = event.target.closest(".toggle-payment-btn");
    if (togglePayment) {
      try {
        await api(`/admin/payment-accounts/${togglePayment.dataset.id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: togglePayment.dataset.active === "true" })
        });
        await loadDashboard();
      } catch (e) {
        showError("dashboardError", e.message);
      }
      return;
    }

    const deletePayment = event.target.closest(".delete-payment-btn");
    if (deletePayment && confirm("Are you sure you want to delete this payment account?")) {
      try {
        await api(`/admin/payment-accounts/${deletePayment.dataset.id}`, { method: "DELETE" });
        await loadDashboard();
      } catch (e) {
        showError("dashboardError", e.message);
      }
      return;
    }
  });

  if ($("paymentAccountForm")) {
    $("paymentAccountForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await api("/admin/payment-accounts", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
        });
        event.target.reset();
        await loadDashboard();
      } catch (e) {
        showError("dashboardError", e.message);
      }
    });
  }

  // ==================== OWNER SUITE (SUPER ADMIN) LOGIC ====================

  function renderOwnerAdmins(admins) {
    const el = $("ownerAdminsBody");
    if (!el) return;
    el.innerHTML = admins.map(admin => {
      const isActive = Boolean(admin.is_active);
      return `<tr>
        <td><strong>${escapeHtml(admin.name)}</strong></td>
        <td>${escapeHtml(admin.phone)}</td>
        <td><span class="role-badge" style="background:rgba(245,183,22,0.15);color:var(--habesha-gold);padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;">ADMIN</span></td>
        <td>${isActive ? '<span style="color:var(--habesha-green-light)">Active</span>' : '<span style="color:var(--habesha-red-light)">Disabled</span>'}</td>
        <td><small>${escapeHtml(new Date(admin.created_at).toLocaleDateString())}</small></td>
        <td>
          <button class="table-action owner-admin-toggle" data-id="${admin.id}" data-active="${String(isActive)}">${isActive ? "Disable" : "Enable"}</button>
          <button class="table-action danger owner-admin-delete" data-id="${admin.id}" data-name="${escapeHtml(admin.name)}" style="margin-left:5px;">Delete</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="6">No admin accounts configured yet.</td></tr>`;
  }

  function renderOwnerReports(reports) {
    if ($("ownerPlayerCount")) $("ownerPlayerCount").textContent = reports.users.total_players;
    if ($("ownerAdminCount")) $("ownerAdminCount").textContent = reports.admins.total_admins;
    if ($("ownerTotalRevenue")) $("ownerTotalRevenue").textContent = money(reports.financials.totalFeesCollected);
    if ($("ownerDepositVolume")) $("ownerDepositVolume").textContent = money(reports.financials.totalDeposits);
    if ($("ownerWithdrawalVolume")) $("ownerWithdrawalVolume").textContent = money(reports.financials.totalWithdrawals);
    if ($("ownerActiveGames")) $("ownerActiveGames").textContent = reports.games.active_games;
    if ($("ownerCompletedGames")) $("ownerCompletedGames").textContent = reports.games.finished_games;
    if ($("ownerPrizePayouts")) $("ownerPrizePayouts").textContent = money(reports.financials.totalPrizesPaid);

    if ($("ownerFinDeposits")) $("ownerFinDeposits").textContent = money(reports.financials.totalDeposits);
    if ($("ownerFinWithdrawals")) $("ownerFinWithdrawals").textContent = money(reports.financials.totalWithdrawals);
    if ($("ownerFinNetFee")) $("ownerFinNetFee").textContent = money(reports.financials.totalFeesCollected);
    if ($("ownerFinWallets")) $("ownerFinWallets").textContent = money(reports.financials.systemWalletLiabilities);
    if ($("ownerFinWinners")) $("ownerFinWinners").textContent = money(reports.financials.totalPrizesPaid);
  }

  function renderOwnerSettings(settings) {
    for (const setting of settings) {
      const input = document.querySelector(`#ownerSettingsForm [name="${setting.key}"]`);
      if (input) input.value = setting.value;
    }
  }

  function renderOwnerPaymentAccounts(accounts) {
    const t = $("ownerPaymentAccountsBody");
    if (!t) return;
    t.innerHTML = accounts.map(a => `<tr>
      <td>${escapeHtml(a.method)}</td>
      <td>${escapeHtml(a.account_number)}</td>
      <td>${escapeHtml(a.account_name)}</td>
      <td><span class="status ${a.is_active ? 'running' : 'cancelled'}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button class="btn btn-outline toggle-payment-btn" data-id="${a.id}" data-active="${!a.is_active}">${a.is_active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-outline delete-payment-btn" data-id="${a.id}" style="color:var(--habesha-red); border-color:var(--habesha-red);">Delete</button>
      </td>
    </tr>`).join("");
  }

  function renderOwnerGames(games) {
    const el = $("ownerGamesBody");
    if (!el) return;
    el.innerHTML = games.map(game => `<tr><td>#${game.id} ${escapeHtml(game.name)}</td><td>${game.players}</td><td>${money(game.prize_pool)}</td><td><select class="status-select game-status" data-id="${game.id}">${["waiting","running","finished","cancelled"].map(status=>`<option ${game.status===status?"selected":""}>${status}</option>`).join("")}</select></td><td><button class="table-action game-save" data-id="${game.id}">Save</button></td></tr>`).join("") || `<tr><td colspan="5">No games.</td></tr>`;
  }

  function renderOwnerTransactions(transactions) {
    const el = $("ownerTransactionsBody");
    if (!el) return;
    el.innerHTML = transactions.map(transaction => `<tr><td>${escapeHtml(transaction.name)}</td><td>${escapeHtml(transaction.type)}</td><td>${escapeHtml(transaction.wallet)}</td><td>${money(transaction.amount)}</td><td>${escapeHtml(transaction.status)}</td><td>${transaction.status==="pending"?`<button class="table-action transaction-action" data-action="approve" data-id="${transaction.id}">Approve</button> <button class="table-action danger transaction-action" data-action="reject" data-id="${transaction.id}">Reject</button>`:""}</td></tr>`).join("") || `<tr><td colspan="6">No transactions.</td></tr>`;
  }

  function renderOwnerUsers(users) {
    const el = $("ownerUsersBody");
    if (!el) return;
    el.innerHTML = users.map(user => {
      const isActive = Boolean(user.is_active);
      return `<tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.phone)}</td>
        <td>${isActive ? "Active" : "Disabled"}</td>
        <td>
          <button class="table-action user-save" data-id="${user.id}" data-role="${user.role}" data-active="${String(isActive)}">${isActive ? "Disable" : "Enable"}</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="4">No players.</td></tr>`;
  }

  function renderOwnerWinners(winners) {
    const el = $("ownerWinnersBody");
    if (!el) return;
    el.innerHTML = winners.map(winner => `<tr><td>${escapeHtml(winner.name)}</td><td>#${winner.game_id}</td><td>${money(winner.prize_amount)}</td></tr>`).join("") || `<tr><td colspan="3">No winners.</td></tr>`;
  }

  function renderOwnerAudit(logs) {
    const el = $("ownerAuditBody");
    if (!el) return;
    el.innerHTML = logs.map(log => `<tr><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.entity_type||"")} #${escapeHtml(log.entity_id||"")}</td><td>${escapeHtml(log.ip_address || "—")}</td><td>${escapeHtml(new Date(log.created_at).toLocaleString())}</td></tr>`).join("") || `<tr><td colspan="4">No audit events.</td></tr>`;
  }

  function renderOwnerTelegram(status) {
    if (!status) return;
    if ($("tgDisplayBot")) $("tgDisplayBot").textContent = "@" + (status.botUsername || "HbeshabingoBot");
    if ($("tgDisplayGroup")) $("tgDisplayGroup").textContent = status.groupTitle || "Hbesha bingo";
    if ($("tgGroupIdDisplay")) {
      $("tgGroupIdDisplay").textContent = status.groupId ? `Group ID: ${status.groupId}` : "Auto-discovery active (ready to link)";
    }
    if ($("tgSyncState")) {
      $("tgSyncState").textContent = status.syncEnabled ? "🟢 Active & Synchronized" : "🔴 Synchronization Paused";
      $("tgSyncState").style.color = status.syncEnabled ? "var(--habesha-green-light)" : "var(--danger)";
    }
    if ($("tgConnectionBadge")) {
      if (status.connected) {
        $("tgConnectionBadge").textContent = "🟢 Connected (@" + status.botUsername + ")";
        $("tgConnectionBadge").style.background = "#2e7d32";
      } else {
        $("tgConnectionBadge").textContent = "⚪ Standing By (Token Required)";
        $("tgConnectionBadge").style.background = "#e65100";
      }
    }
    if ($("tgInputGroupId") && status.groupId && !$("tgInputGroupId").value) {
      $("tgInputGroupId").value = status.groupId;
    }
    if ($("tgInputGroupTitle") && status.groupTitle && !$("tgInputGroupTitle").value) {
      $("tgInputGroupTitle").value = status.groupTitle;
    }
    if ($("tgInputSyncEnabled")) {
      $("tgInputSyncEnabled").checked = status.syncEnabled !== false;
    }
  }

  async function loadOwnerDashboard() {
    clearError("ownerDashboardError");
    try {
      const search = encodeURIComponent($("ownerUserSearch")?.value || "");
      const [reports, admins, settings, payments, games, transactions, users, winners, audit, tgStatus] = await Promise.all([
        api("/owner/reports"),
        api("/owner/admins"),
        api("/owner/settings"),
        api("/admin/payment-accounts"),
        api("/admin/games"),
        api("/admin/transactions"),
        api(`/admin/users?search=${search}`),
        api("/admin/winners"),
        api("/admin/audit-logs"),
        api("/telegram/status").catch(() => null)
      ]);

      renderOwnerReports(reports);
      renderOwnerAdmins(admins.admins);
      renderOwnerSettings(settings.settings);
      renderOwnerPaymentAccounts(payments.accounts);
      renderOwnerGames(games.games);
      renderOwnerTransactions(transactions.transactions);
      renderOwnerUsers(users.users);
      renderOwnerWinners(winners.winners);
      renderOwnerAudit(audit.logs);
      if (tgStatus) renderOwnerTelegram(tgStatus);
    } catch (error) {
      if (error.message === "Authentication required" || error.message === "Access denied") {
        if (typeof window.openAuth === "function") {
          window.openAuth("login");
          if (document.getElementById("authPhone") && !document.getElementById("authPhone").value) {
            document.getElementById("authPhone").value = "0951666750";
          }
        }
      }
      showError("ownerDashboardError", error.message);
    }
  }

  function showOwnerDashboard() {
    if ($("ownerDashboard")) $("ownerDashboard").hidden = false;
    loadOwnerDashboard();
  }

  // Owner Form Handlers
  if ($("ownerCreateAdminForm")) {
    $("ownerCreateAdminForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        const formData = Object.fromEntries(new FormData(event.target));
        await api("/owner/admins", { method: "POST", body: JSON.stringify(formData) });
        event.target.reset();
        await loadOwnerDashboard();
        alert("Admin account created successfully!");
      } catch (e) {
        showError("ownerDashboardError", e.message);
      }
    });
  }

  if ($("ownerSettingsForm")) {
    $("ownerSettingsForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await api("/owner/settings", {
          method: "PATCH",
          body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
        });
        await loadOwnerDashboard();
        alert("System settings saved successfully!");
      } catch (e) {
        showError("ownerDashboardError", e.message);
      }
    });
  }

  if ($("ownerPaymentAccountForm")) {
    $("ownerPaymentAccountForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await api("/admin/payment-accounts", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
        });
        event.target.reset();
        await loadOwnerDashboard();
      } catch (e) {
        showError("ownerDashboardError", e.message);
      }
    });
  }

  if ($("ownerTelegramConfigForm")) {
    $("ownerTelegramConfigForm").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        const formData = new FormData(event.target);
        const payload = {
          token: formData.get("token") || undefined,
          groupId: formData.get("groupId") || undefined,
          groupTitle: formData.get("groupTitle") || undefined,
          syncEnabled: $("tgInputSyncEnabled") ? $("tgInputSyncEnabled").checked : true
        };
        const res = await api("/owner/telegram/config", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        if (res.status) renderOwnerTelegram(res.status);
        if ($("tgStatusMsg")) {
          $("tgStatusMsg").textContent = "✅ Telegram configuration saved & synced successfully!";
          $("tgStatusMsg").style.color = "var(--habesha-green-light)";
        }
        alert("Telegram configuration saved!");
      } catch (e) {
        if ($("tgStatusMsg")) {
          $("tgStatusMsg").textContent = "⚠️ Error: " + e.message;
          $("tgStatusMsg").style.color = "var(--danger)";
        }
        showError("ownerDashboardError", e.message);
      }
    });
  }

  if ($("tgTestPingBtn")) {
    $("tgTestPingBtn").addEventListener("click", async () => {
      try {
        $("tgTestPingBtn").disabled = true;
        $("tgTestPingBtn").textContent = "Sending...";
        await api("/owner/telegram/test", { method: "POST" });
        alert("✅ Test message successfully sent to 'Hbesha bingo' Telegram group!");
      } catch (e) {
        alert("⚠️ Telegram test failed: " + e.message);
      } finally {
        $("tgTestPingBtn").disabled = false;
        $("tgTestPingBtn").textContent = "🧪 Test Group Ping";
      }
    });
  }

  if ($("ownerRefreshBtn")) $("ownerRefreshBtn").addEventListener("click", loadOwnerDashboard);

  let ownerSearchTimer;
  if ($("ownerUserSearch")) {
    $("ownerUserSearch").addEventListener("input", () => {
      clearTimeout(ownerSearchTimer);
      ownerSearchTimer = setTimeout(loadOwnerDashboard, 250);
    });
  }

  if ($("ownerToAdminBtn")) {
    $("ownerToAdminBtn").addEventListener("click", () => {
      if (typeof window.navigateTo === "function") window.navigateTo("admin", true);
    });
  }
  if ($("ownerToPlayerBtn")) {
    $("ownerToPlayerBtn").addEventListener("click", () => {
      if (typeof window.navigateTo === "function") window.navigateTo("player", true);
    });
  }
  if ($("ownerLogoutBtn")) $("ownerLogoutBtn").addEventListener("click", () => handleAdminLogout(false));
  if ($("ownerBackToLoginBtn")) $("ownerBackToLoginBtn").addEventListener("click", () => handleAdminLogout(true));
  if ($("ownerBrandLink")) {
    $("ownerBrandLink").addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof window.navigateTo === "function") window.navigateTo("player", true);
    });
  }

  // Owner Table Actions (Delegation)
  document.addEventListener("click", async event => {
    const adminToggle = event.target.closest(".owner-admin-toggle");
    if (adminToggle) {
      const id = adminToggle.dataset.id;
      const isActive = adminToggle.dataset.active === "true";
      try {
        await api(`/owner/admins/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: !isActive })
        });
        await loadOwnerDashboard();
      } catch (e) {
        showError("ownerDashboardError", e.message);
      }
      return;
    }

    const adminDelete = event.target.closest(".owner-admin-delete");
    if (adminDelete) {
      const id = adminDelete.dataset.id;
      const name = adminDelete.dataset.name || "this admin";
      if (confirm(`Are you sure you want to permanently delete admin "${name}"?`)) {
        try {
          await api(`/owner/admins/${id}`, { method: "DELETE" });
          await loadOwnerDashboard();
        } catch (e) {
          showError("ownerDashboardError", e.message);
        }
      }
      return;
    }
  });

  window.showDashboard = showDashboard;
  window.loadDashboard = loadDashboard;
  window.showOwnerDashboard = showOwnerDashboard;
  window.loadOwnerDashboard = loadOwnerDashboard;

  // Auto-init only if already on owner or admin route
  const currentRole = String(storage.getItem("hulu_role") || "").toUpperCase();
  const isPathOwner = window.location.pathname === "/owner" || window.location.pathname.endsWith("/owner") || window.location.hash === "#owner";
  const isPathAdmin = window.location.pathname === "/admin" || window.location.pathname.endsWith("/admin") || window.location.hash === "#admin";

  if (storage.getItem("hulu_token")) {
    if (currentRole === "OWNER" && (isPathOwner || ($("ownerApp") && !$("ownerApp").hidden))) {
      showOwnerDashboard();
    } else if ((currentRole === "ADMIN" || currentRole === "OWNER") && (isPathAdmin || ($("adminApp") && !$("adminApp").hidden))) {
      showDashboard();
    }
  }
})();

