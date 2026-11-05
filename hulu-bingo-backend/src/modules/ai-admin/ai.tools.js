const pool = require("../../../db");

/**
 * 1. USER MANAGEMENT TOOLS
 */

async function getUsersList({ search = "", status = "all", limit = 20, offset = 0 } = {}) {
  const params = [];
  const conditions = [];

  if (search) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR CAST(u.id AS TEXT) = $${params.length} OR CAST(u.telegram_id AS TEXT) = $${params.length})`);
  }

  if (status === "active") {
    conditions.push("u.is_active = TRUE");
  } else if (status === "suspended") {
    conditions.push("u.is_active = FALSE");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT u.id, u.name, u.phone, u.role, u.is_active, u.telegram_id, u.telegram_username, u.created_at,
           COALESCE(w.main_balance, 0) AS main_balance,
           COALESCE(w.vip_balance, 0) AS vip_balance,
           (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id AND t.type = 'deposit' AND t.status IN ('completed', 'approved')) AS completed_deposits,
           (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id AND t.type = 'withdrawal' AND t.status IN ('completed', 'approved')) AS completed_withdrawals
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
    ${whereClause}
    ORDER BY u.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  params.push(Math.min(limit, 100), offset);

  const res = await pool.query(query, params);
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM users u ${whereClause}`, params.slice(0, -2));

  return {
    total: Number(countRes.rows[0]?.total || 0),
    users: res.rows
  };
}

async function getUserDetails(identifier) {
  if (!identifier) return null;
  const isNumeric = /^\d+$/.test(String(identifier).trim());
  let userQuery;
  let params;

  if (isNumeric) {
    userQuery = `
      SELECT u.id, u.name, u.phone, u.role, u.is_active, u.telegram_id, u.telegram_username, u.created_at,
             COALESCE(w.main_balance, 0) AS main_balance,
             COALESCE(w.vip_balance, 0) AS vip_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1 OR u.telegram_id = $1 OR u.phone = $2
    `;
    params = [identifier, String(identifier)];
  } else {
    userQuery = `
      SELECT u.id, u.name, u.phone, u.role, u.is_active, u.telegram_id, u.telegram_username, u.created_at,
             COALESCE(w.main_balance, 0) AS main_balance,
             COALESCE(w.vip_balance, 0) AS vip_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.phone = $1 OR u.name ILIKE $2
    `;
    params = [String(identifier).trim(), `%${String(identifier).trim()}%`];
  }

  const userRes = await pool.query(userQuery, params);
  const user = userRes.rows[0];
  if (!user) return null;

  // Fetch recent transactions
  const txRes = await pool.query(
    `SELECT id, type, wallet, amount, balance_before, balance_after, status, method, reference, provider_reference, created_at
     FROM transactions
     WHERE user_id = $1
     ORDER BY id DESC LIMIT 10`,
    [user.id]
  );

  // Fetch ticket & game stats
  const statsRes = await pool.query(
    `SELECT 
       (SELECT COUNT(*) FROM tickets WHERE user_id = $1) AS total_tickets_bought,
       (SELECT COUNT(*) FROM winners WHERE user_id = $1) AS total_games_won,
       (SELECT COALESCE(SUM(prize_amount), 0) FROM winners WHERE user_id = $1) AS total_prizes_amount
    `,
    [user.id]
  );

  // Compute calculated ledger balance
  const ledgerRes = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN wallet = 'main' AND status IN ('completed', 'approved') THEN amount ELSE 0 END), 0) AS calculated_main_balance,
       COALESCE(SUM(CASE WHEN wallet = 'vip' AND status IN ('completed', 'approved') THEN amount ELSE 0 END), 0) AS calculated_vip_balance
     FROM transactions
     WHERE user_id = $1`,
    [user.id]
  );

  const stats = statsRes.rows[0] || {};
  const ledger = ledgerRes.rows[0] || {};

  return {
    user,
    stats: {
      totalTickets: Number(stats.total_tickets_bought || 0),
      totalWins: Number(stats.total_games_won || 0),
      totalPrizesETB: Number(stats.total_prizes_amount || 0)
    },
    ledgerBalances: {
      main: Number(ledger.calculated_main_balance || 0),
      vip: Number(ledger.calculated_vip_balance || 0),
      hasDiscrepancy: Math.abs(Number(user.main_balance) - Number(ledger.calculated_main_balance)) > 0.01
    },
    recentTransactions: txRes.rows
  };
}

/**
 * 2. DEPOSIT MANAGEMENT TOOLS
 */

async function getPendingDeposits() {
  const res = await pool.query(`
    SELECT t.id, t.user_id, u.name, u.phone, u.telegram_id, u.role,
           t.type, t.wallet, t.amount, t.status, t.method, t.reference,
           t.provider, t.provider_reference, t.metadata, t.created_at,
           (SELECT COUNT(*) FROM transactions dup WHERE dup.reference = t.reference AND dup.id != t.id AND t.reference IS NOT NULL AND t.reference != '') AS duplicate_reference_count
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    WHERE t.type = 'deposit' AND t.status = 'pending'
    ORDER BY t.id ASC
  `);
  return res.rows;
}

async function verifyDepositCandidate(transactionId) {
  const res = await pool.query(
    `SELECT t.*, u.name, u.phone, u.role, u.is_active
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE t.id = $1`,
    [transactionId]
  );
  const tx = res.rows[0];
  if (!tx) {
    return { valid: false, reason: "TRANSACTION_NOT_FOUND" };
  }

  if (tx.type !== "deposit") {
    return { valid: false, reason: "NOT_A_DEPOSIT" };
  }

  if (tx.status !== "pending") {
    return { valid: false, reason: `ALREADY_PROCESSED_${tx.status.toUpperCase()}`, status: tx.status };
  }

  if (!tx.is_active) {
    return { valid: false, reason: "USER_ACCOUNT_SUSPENDED", user: tx.name };
  }

  // Check duplicate references
  let duplicates = [];
  if (tx.reference && tx.reference.trim()) {
    const dupRes = await pool.query(
      `SELECT id, user_id, amount, status, method, reference, created_at
       FROM transactions
       WHERE reference = $1 AND id != $2`,
      [tx.reference.trim(), tx.id]
    );
    duplicates = dupRes.rows;
  }

  return {
    valid: true,
    transaction: tx,
    hasDuplicateReference: duplicates.length > 0,
    duplicateReferences: duplicates,
    recommendation: duplicates.length > 0 ? "REVIEW_CAREFULLY_POTENTIAL_DUPLICATE" : "SAFE_TO_APPROVE"
  };
}

/**
 * 3. WITHDRAWAL MANAGEMENT TOOLS
 */

async function getPendingWithdrawals() {
  const res = await pool.query(`
    SELECT t.id, t.user_id, u.name, u.phone, u.telegram_id, u.role,
           t.type, t.wallet, ABS(t.amount) AS requested_amount, t.amount,
           t.status, t.method, t.reference, t.account_name, t.bank_name,
           t.created_at,
           COALESCE(w.main_balance, 0) AS current_main_balance,
           (SELECT COUNT(*) FROM transactions unp WHERE unp.user_id = t.user_id AND unp.type = 'withdrawal' AND unp.status = 'approved') AS pending_payouts_count
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN wallets w ON w.user_id = t.user_id
    WHERE t.type = 'withdrawal' AND t.status IN ('pending', 'approved')
    ORDER BY t.id ASC
  `);
  return res.rows;
}

async function verifyWithdrawalCandidate(transactionId) {
  const res = await pool.query(
    `SELECT t.*, u.name, u.phone, u.role, u.is_active,
            COALESCE(w.main_balance, 0) AS current_main_balance,
            COALESCE(w.vip_balance, 0) AS current_vip_balance
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN wallets w ON w.user_id = t.user_id
     WHERE t.id = $1`,
    [transactionId]
  );
  const tx = res.rows[0];
  if (!tx) {
    return { valid: false, reason: "TRANSACTION_NOT_FOUND" };
  }

  if (tx.type !== "withdrawal") {
    return { valid: false, reason: "NOT_A_WITHDRAWAL" };
  }

  const requestedAmount = Math.abs(Number(tx.amount));
  const currentBalance = Number(tx.current_main_balance);

  return {
    valid: true,
    transaction: tx,
    requestedAmount,
    currentBalance,
    hasSufficientFunds: currentBalance >= requestedAmount || tx.status === "approved",
    status: tx.status
  };
}

/**
 * 4. FINANCIAL ANALYTICS & REPORTS
 */

async function getFinancialAnalytics({ period = "today", startDate = null, endDate = null } = {}) {
  let timeFilter = "created_at >= CURRENT_DATE";
  const params = [];

  if (period === "all_time") {
    timeFilter = "1=1";
  } else if (period === "yesterday") {
    timeFilter = "created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE";
  } else if (period === "week") {
    timeFilter = "created_at >= date_trunc('week', CURRENT_DATE)";
  } else if (period === "month") {
    timeFilter = "created_at >= date_trunc('month', CURRENT_DATE)";
  } else if (startDate && endDate) {
    params.push(startDate, endDate);
    timeFilter = `created_at >= $1 AND created_at <= $2`;
  }

  // Transactions metrics
  const txStats = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN type = 'deposit' AND status IN ('completed', 'approved') THEN amount ELSE 0 END), 0) AS total_deposits_amount,
       COUNT(CASE WHEN type = 'deposit' AND status IN ('completed', 'approved') THEN 1 END) AS total_deposits_count,
       COUNT(CASE WHEN type = 'deposit' AND status = 'pending' THEN 1 END) AS pending_deposits_count,
       COALESCE(SUM(CASE WHEN type = 'deposit' AND status = 'pending' THEN amount ELSE 0 END), 0) AS pending_deposits_amount,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND status IN ('completed', 'approved') THEN ABS(amount) ELSE 0 END), 0) AS total_withdrawals_amount,
       COUNT(CASE WHEN type = 'withdrawal' AND status IN ('completed', 'approved') THEN 1 END) AS total_withdrawals_count,
       COUNT(CASE WHEN type = 'withdrawal' AND status = 'pending' THEN 1 END) AS pending_withdrawals_count,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND status = 'pending' THEN ABS(amount) ELSE 0 END), 0) AS pending_withdrawals_amount,
       COALESCE(SUM(CASE WHEN type = 'prize' AND status = 'completed' THEN amount ELSE 0 END), 0) AS total_prizes_distributed
     FROM transactions
     WHERE ${timeFilter}`,
    params
  );

  // Platform Game revenue metrics
  const gameStats = await pool.query(
    `SELECT 
       COUNT(*) AS total_games_count,
       COUNT(CASE WHEN status = 'finished' THEN 1 END) AS finished_games_count,
       COUNT(CASE WHEN status IN ('waiting', 'running') THEN 1 END) AS active_games_count,
       COALESCE(SUM(platform_fee), 0) AS total_platform_fees_earned,
       COALESCE(SUM(prize_pool), 0) AS total_prize_pools
     FROM games
     WHERE ${timeFilter.replace(/created_at/g, "created_at")}`,
    params
  );

  // Platform Total User Balances (Current liability)
  const walletStats = await pool.query(`
    SELECT 
      COALESCE(SUM(main_balance), 0) AS total_players_main_balance,
      COALESCE(SUM(vip_balance), 0) AS total_players_vip_balance,
      COUNT(CASE WHEN main_balance > 0 OR vip_balance > 0 THEN 1 END) AS funded_accounts_count
    FROM wallets
  `);

  // Registrations in period
  const userStats = await pool.query(
    `SELECT 
       COUNT(*) AS new_registered_users,
       (SELECT COUNT(*) FROM users) AS all_time_total_users,
       (SELECT COUNT(*) FROM users WHERE is_active = TRUE) AS active_users_count
     FROM users
     WHERE ${timeFilter}`,
    params
  );

  const tx = txStats.rows[0];
  const g = gameStats.rows[0];
  const w = walletStats.rows[0];
  const u = userStats.rows[0];

  const totalDeposits = Number(tx.total_deposits_amount || 0);
  const totalWithdrawals = Number(tx.total_withdrawals_amount || 0);
  const platformRevenue = Number(g.total_platform_fees_earned || 0);

  return {
    period,
    summary: {
      registeredUsersNew: Number(u.new_registered_users || 0),
      registeredUsersTotal: Number(u.all_time_total_users || 0),
      activeUsers: Number(u.active_users_count || 0),
      totalDepositsETB: totalDeposits,
      totalDepositsCount: Number(tx.total_deposits_count || 0),
      pendingDepositsCount: Number(tx.pending_deposits_count || 0),
      pendingDepositsAmountETB: Number(tx.pending_deposits_amount || 0),
      totalWithdrawalsETB: totalWithdrawals,
      totalWithdrawalsCount: Number(tx.total_withdrawals_count || 0),
      pendingWithdrawalsCount: Number(tx.pending_withdrawals_count || 0),
      pendingWithdrawalsAmountETB: Number(tx.pending_withdrawals_amount || 0),
      prizesDistributedETB: Number(tx.total_prizes_distributed || 0),
      platformFeeRevenueETB: platformRevenue,
      activeGames: Number(g.active_games_count || 0),
      completedGames: Number(g.finished_games_count || 0),
      platformCurrentWalletLiabilityETB: Number(w.total_players_main_balance || 0),
      fundedAccountsCount: Number(w.funded_accounts_count || 0)
    }
  };
}

/**
 * 5. BINGO GAME MANAGEMENT TOOLS
 */

async function getGamesOverview() {
  const res = await pool.query(`
    SELECT g.id, g.name, g.entry, g.status, g.prize_pool, g.platform_fee,
           g.current_number, jsonb_array_length(g.called_numbers) AS called_count,
           g.winner_id, u.name AS winner_name, g.created_at, g.finished_at,
           (SELECT COUNT(*)::int FROM tickets t WHERE t.game_id = g.id) AS player_count
    FROM games g
    LEFT JOIN users u ON u.id = g.winner_id
    ORDER BY g.id DESC
    LIMIT 15
  `);
  return res.rows;
}

/**
 * 6. ADVANCED SECURITY & FRAUD DETECTION
 */

async function detectSecurityThreats() {
  const threats = [];

  // A. Duplicate payment references
  const duplicateRefs = await pool.query(`
    SELECT reference, COUNT(*) AS count, array_agg(id) AS transaction_ids, array_agg(user_id) AS user_ids, SUM(amount) AS total_amount
    FROM transactions
    WHERE reference IS NOT NULL AND reference != '' AND method != 'game'
    GROUP BY reference
    HAVING COUNT(*) > 1
    ORDER BY count DESC LIMIT 10
  `);

  if (duplicateRefs.rows.length) {
    threats.push({
      type: "DUPLICATE_PAYMENT_REFERENCES",
      severity: "HIGH",
      title: "Duplicate Payment References Detected",
      titleAmharic: "የተደጋገሙ የክፍያ መለያዎች (Duplicate References) ተገኝተዋል",
      description: `Found ${duplicateRefs.rows.length} transaction reference(s) used across multiple entries.`,
      items: duplicateRefs.rows
    });
  }

  // B. Large or unusual pending withdrawal requests
  const largeWithdrawals = await pool.query(`
    SELECT t.id, t.user_id, u.name, u.phone, ABS(t.amount) AS amount, t.method, t.reference, t.created_at
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    WHERE t.type = 'withdrawal' AND t.status = 'pending' AND ABS(t.amount) >= 1000
    ORDER BY ABS(t.amount) DESC LIMIT 5
  `);

  if (largeWithdrawals.rows.length) {
    threats.push({
      type: "LARGE_PENDING_WITHDRAWALS",
      severity: "MEDIUM",
      title: "High-Value Withdrawal Requests Requiring Verification",
      titleAmharic: "ትላልቅ የገንዘብ ወጪ ጥያቄዎች (ልዩ ማረጋገጫ የሚሹ)",
      description: `There are ${largeWithdrawals.rows.length} pending withdrawal(s) of 1,000 ETB or more.`,
      items: largeWithdrawals.rows
    });
  }

  // C. Multiple accounts sharing same phone digits or telegram ID
  const sharedAccounts = await pool.query(`
    SELECT phone, COUNT(*) AS count, array_agg(id) AS user_ids
    FROM users
    GROUP BY phone
    HAVING COUNT(*) > 1
  `);

  if (sharedAccounts.rows.length) {
    threats.push({
      type: "SHARED_PHONE_ACCOUNTS",
      severity: "HIGH",
      title: "Multiple Accounts Sharing Same Identifier",
      titleAmharic: "ተመሳሳይ ስልክ ቁጥር ያላቸው አካውንቶች",
      description: "Multiple user profiles found linked to the exact same phone number.",
      items: sharedAccounts.rows
    });
  }

  // D. Discrepancy between ledger and cached wallets
  const discrepancies = await pool.query(`
    SELECT u.id, u.name, u.phone, w.main_balance AS cached_balance,
           COALESCE(sub.ledger_sum, 0) AS ledger_balance,
           (w.main_balance - COALESCE(sub.ledger_sum, 0)) AS diff
    FROM users u
    JOIN wallets w ON w.user_id = u.id
    LEFT JOIN (
      SELECT user_id, SUM(amount) AS ledger_sum
      FROM transactions
      WHERE wallet = 'main' AND status IN ('completed', 'approved')
      GROUP BY user_id
    ) sub ON sub.user_id = u.id
    WHERE ABS(w.main_balance - COALESCE(sub.ledger_sum, 0)) > 1.00
    ORDER BY ABS(w.main_balance - COALESCE(sub.ledger_sum, 0)) DESC
    LIMIT 10
  `);

  if (discrepancies.rows.length) {
    threats.push({
      type: "WALLET_LEDGER_MISMATCH",
      severity: "MEDIUM",
      title: "Wallet Ledger Discrepancies",
      titleAmharic: "የዋሌት እና የግብይት ታሪክ ልዩነቶች (Ledger Mismatch)",
      description: `${discrepancies.rows.length} account(s) have discrepancies between the cached balance and the transaction ledger.`,
      items: discrepancies.rows
    });
  }

  return {
    threatCount: threats.length,
    threats
  };
}

module.exports = {
  getUsersList,
  getUserDetails,
  getPendingDeposits,
  verifyDepositCandidate,
  getPendingWithdrawals,
  verifyWithdrawalCandidate,
  getFinancialAnalytics,
  getGamesOverview,
  detectSecurityThreats
};
