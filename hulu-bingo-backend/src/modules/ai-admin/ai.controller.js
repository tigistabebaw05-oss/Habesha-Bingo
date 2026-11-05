const pool = require("../../../db");
const aiService = require("./ai.service");
const { consumeConfirmationToken, assertNotOwner } = require("./ai.permissions");
const tools = require("./ai.tools");
const aiEngine = require("../ai-automation/ai.engine");

/**
 * Record action in audit_logs table (matching existing project format)
 */
async function auditAction(adminId, action, entityType, entityId, details, ip) {
  try {
    await pool.query(
      `INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address)
       VALUES($1, $2, $3, $4, $5, $6)`,
      [adminId, action, entityType, entityId, JSON.stringify(details), ip]
    );
  } catch (err) {
    console.warn("[AIAudit] Warning: Could not write audit log:", err.message);
  }
}

/**
 * POST /api/admin/ai/chat
 */
async function handleChatMessage(req, res) {
  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    const result = await aiService.processAdminMessage({
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      adminUser: req.user
    });

    res.json({
      ok: true,
      reply: result.reply,
      replyAmharic: result.replyAmharic || null,
      data: result.data || null,
      actionRequired: Boolean(result.actionRequired),
      confirmationToken: result.confirmationToken || null,
      expiresAt: result.expiresAt || null
    });
  } catch (err) {
    console.error("[AIController] Chat error:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Failed to process message."
    });
  }
}

/**
 * POST /api/admin/ai/confirm
 * Single-use token confirmation handler
 */
async function handleActionConfirmation(req, res) {
  const { confirmationToken } = req.body || {};
  if (!confirmationToken || typeof confirmationToken !== "string") {
    return res.status(400).json({ error: "confirmationToken is required." });
  }

  let tokenData;
  try {
    tokenData = consumeConfirmationToken(confirmationToken.trim(), req.user.id);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message === "TOKEN_EXPIRED" ? "Confirmation token expired. Please re-issue the command." : "Invalid or already used confirmation token."
    });
  }

  const { action, payload } = tokenData;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let result = null;

    if (action === "APPROVE_DEPOSIT") {
      const tx = (await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [payload.transactionId])).rows[0];
      if (!tx || tx.status !== "pending" || tx.type !== "deposit") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Transaction is not pending or is not a deposit." });
      }

      const col = tx.wallet === "vip" ? "vip_balance" : "main_balance";
      const depAmount = Math.abs(Number(tx.amount));

      let w = (await client.query(`SELECT ${col} FROM wallets WHERE user_id = $1 FOR UPDATE`, [tx.user_id])).rows[0];
      if (!w) {
        await client.query("INSERT INTO wallets(user_id, main_balance, vip_balance) VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING", [tx.user_id]);
        w = (await client.query(`SELECT ${col} FROM wallets WHERE user_id = $1 FOR UPDATE`, [tx.user_id])).rows[0];
      }

      const before = Number(w ? w[col] : 0);
      const after = Math.round((before + depAmount) * 100) / 100;

      await client.query(`UPDATE wallets SET ${col} = $1 WHERE user_id = $2`, [after, tx.user_id]);
      await client.query(
        "UPDATE transactions SET status = 'approved', balance_before = $1, balance_after = $2, admin_id = $3, processed_at = now() WHERE id = $4",
        [before, after, req.user.id, payload.transactionId]
      );

      result = {
        message: `Successfully approved deposit #${payload.transactionId} of ${depAmount} ETB for User #${tx.user_id}.`,
        transactionId: payload.transactionId,
        creditedAmount: depAmount,
        newBalance: after
      };

    } else if (action === "REJECT_DEPOSIT") {
      const resReject = await client.query(
        "UPDATE transactions SET status = 'rejected', admin_id = $1, processed_at = now() WHERE id = $2 AND status = 'pending' AND type = 'deposit' RETURNING id, user_id, amount",
        [req.user.id, payload.transactionId]
      );
      if (resReject.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Deposit not found or not pending." });
      }
      result = {
        message: `Deposit #${payload.transactionId} rejected.`,
        transactionId: payload.transactionId
      };

    } else if (action === "APPROVE_WITHDRAWAL") {
      const tx = (await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [payload.transactionId])).rows[0];
      if (!tx || tx.status !== "pending" || tx.type !== "withdrawal") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Withdrawal not found or already processed." });
      }

      const withAmount = Math.abs(Number(tx.amount));
      const col = tx.wallet === "vip" ? "vip_balance" : "main_balance";
      const w = (await client.query(`SELECT ${col} FROM wallets WHERE user_id = $1 FOR UPDATE`, [tx.user_id])).rows[0];
      const curBal = Number(w ? w[col] : 0);

      if (curBal < withAmount) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Insufficient wallet balance: User has ${curBal.toFixed(2)} ETB, requested ${withAmount.toFixed(2)} ETB.`
        });
      }

      const after = Math.round((curBal - withAmount) * 100) / 100;
      await client.query(`UPDATE wallets SET ${col} = $1 WHERE user_id = $2`, [after, tx.user_id]);
      await client.query(
        "UPDATE transactions SET status = 'approved', balance_before = $1, balance_after = $2, admin_id = $3, processed_at = now() WHERE id = $4",
        [curBal, after, req.user.id, payload.transactionId]
      );

      result = {
        message: `Withdrawal #${payload.transactionId} of ${withAmount} ETB approved and ledger debited. Ready for disbursement.`,
        transactionId: payload.transactionId,
        newBalance: after
      };

    } else if (action === "REJECT_WITHDRAWAL") {
      const resReject = await client.query(
        "UPDATE transactions SET status = 'rejected', admin_id = $1, processed_at = now() WHERE id = $2 AND status = 'pending' AND type = 'withdrawal' RETURNING id, user_id, amount",
        [req.user.id, payload.transactionId]
      );
      if (resReject.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Withdrawal not found or not pending." });
      }
      result = {
        message: `Withdrawal #${payload.transactionId} rejected.`,
        transactionId: payload.transactionId
      };

    } else if (action === "SUSPEND_USER") {
      await assertNotOwner(payload.userId);
      await client.query("UPDATE users SET is_active = FALSE WHERE id = $1", [payload.userId]);
      await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [payload.userId]);
      result = {
        message: `User #${payload.userId} suspended and active sessions revoked.`,
        userId: payload.userId
      };

    } else if (action === "REACTIVATE_USER") {
      await client.query("UPDATE users SET is_active = TRUE WHERE id = $1", [payload.userId]);
      result = {
        message: `User #${payload.userId} reactivated.`,
        userId: payload.userId
      };

    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Unsupported action type: ${action}` });
    }

    await client.query("COMMIT");

    // Audit the confirmed action
    await auditAction(
      req.user.id,
      `AI_CONFIRMED_${action}`,
      action.includes("USER") ? "users" : "transactions",
      payload.transactionId || payload.userId,
      result,
      req.ip
    );

    res.json({
      ok: true,
      action,
      result
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[AIController] Confirmation execution error:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Failed to execute confirmed operation."
    });
  } finally {
    client.release();
  }
}

/**
 * GET /api/admin/ai/quick-stats
 */
async function getQuickStats(req, res) {
  try {
    const [depRes, withRes, userRes, threatRes] = await Promise.all([
      tools.getPendingDeposits(),
      tools.getPendingWithdrawals(),
      pool.query("SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE is_active)::int as active FROM users"),
      tools.detectSecurityThreats()
    ]);

    res.json({
      ok: true,
      stats: {
        pendingDepositsCount: depRes.count,
        pendingDepositsTotal: depRes.totalAmount,
        pendingWithdrawalsCount: withRes.count,
        pendingWithdrawalsTotal: withRes.totalAmount,
        totalUsers: userRes.rows[0]?.total || 0,
        activeUsers: userRes.rows[0]?.active || 0,
        securityThreatsCount: threatRes.threatCount
      }
    });
  } catch (err) {
    console.error("[AIController] Quick stats error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch quick stats." });
  }
}

/**
 * GET /api/admin/ai/status
 */
function getStatus(req, res) {
  res.json({
    ok: true,
    service: "HABESHA AI ADMIN",
    version: "2.0.0",
    aiConfigured: aiService.isAIConfigured(),
    model: aiService.model,
    ownerProtectionEnabled: true,
    automationEngine: aiEngine.isRunning ? "active" : "standby",
    supportedLanguages: ["English", "Amharic (አማርኛ)"]
  });
}

/**
 * GET /api/admin/ai/dashboard
 */
async function getDashboard(req, res) {
  try {
    const snapshot = await aiEngine.getDashboardSnapshot();
    res.json(snapshot);
  } catch (err) {
    console.error("[AIController] Dashboard error:", err);
    res.status(500).json({ ok: false, error: err.message || "Failed to load AI dashboard" });
  }
}

/**
 * POST /api/admin/ai/support/auto-reply-all
 */
async function handleAutoReplySupport(req, res) {
  try {
    await aiEngine.processPendingSupportTickets();
    res.json({ ok: true, message: "Support tickets auto-reply batch completed." });
  } catch (err) {
    console.error("[AIController] Auto-reply error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /api/admin/ai/watchdog/self-heal
 */
async function handleTriggerSelfHeal(req, res) {
  try {
    const result = await aiEngine.watchdog.performSelfHealing();
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[AIController] Self-heal trigger error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  handleChatMessage,
  handleActionConfirmation,
  getQuickStats,
  getStatus,
  getDashboard,
  handleAutoReplySupport,
  handleTriggerSelfHeal
};
