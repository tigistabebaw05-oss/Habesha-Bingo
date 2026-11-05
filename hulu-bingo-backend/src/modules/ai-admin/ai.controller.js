const pool = require("../../../db");
const aiService = require("./ai.service");
const { consumeConfirmationToken, assertNotOwner } = require("./ai.permissions");
const tools = require("./ai.tools");

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
 * Safely executes state-changing actions using single-use confirmation tokens
 */
async function handleActionConfirmation(req, res) {
  const { confirmationToken } = req.body || {};
  if (!confirmationToken) {
    return res.status(400).json({ error: "Confirmation token is required." });
  }

  let tokenData;
  try {
    // Validate and atomically consume the single-use token
    tokenData = consumeConfirmationToken(confirmationToken, req.user.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { action, payload } = tokenData;
  const client = await pool.connect();

  try {
    if (action === "APPROVE_DEPOSIT") {
      const { transactionId, userId, amount, wallet = "main" } = payload;
      await client.query("BEGIN");

      // Lock transaction row
      const txRes = await client.query(
        "SELECT * FROM transactions WHERE id = $1 FOR UPDATE",
        [transactionId]
      );
      const tx = txRes.rows[0];

      if (!tx) {
        throw new Error("TRANSACTION_NOT_FOUND");
      }
      if (tx.status !== "pending") {
        throw new Error(`TRANSACTION_ALREADY_${tx.status.toUpperCase()}`);
      }

      // Lock wallet row
      const col = wallet === "vip" ? "vip_balance" : "main_balance";
      const wRes = await client.query(
        `SELECT ${col} FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      if (!wRes.rows[0]) {
        throw new Error("WALLET_NOT_FOUND");
      }

      const before = Number(wRes.rows[0][col]);
      const delta = Number(amount);
      const after = Math.round((before + delta) * 100) / 100;

      // Update wallet balance using the same secure pattern
      await client.query(
        `UPDATE wallets SET ${col} = $1, updated_at = now() WHERE user_id = $2`,
        [after, userId]
      );

      // Update transaction status
      await client.query(
        `UPDATE transactions
         SET status = 'approved', balance_before = $1, balance_after = $2, admin_id = $3, processed_at = now()
         WHERE id = $4`,
        [before, after, req.user.id, transactionId]
      );

      await client.query("COMMIT");

      // Record audit log
      await auditAction(
        req.user.id,
        "ai.transaction.approved",
        "transaction",
        transactionId,
        { userId, amount: delta, wallet, via: "HABESHA_AI_ADMIN" },
        req.ip
      );

      return res.json({
        ok: true,
        message: `✅ Deposit #${transactionId} approved successfully! Credited ${delta.toFixed(2)} ETB to player's wallet.`,
        messageAmharic: `✅ የገቢ ጥያቄ #${transactionId} ፀድቋል! ${delta.toFixed(2)} ብር ወደ ተጫዋቹ ዋሌት ገብቷል።`,
        details: { transactionId, userId, creditedAmount: delta, newBalance: after }
      });
    }

    if (action === "REJECT_DEPOSIT") {
      const { transactionId, userId } = payload;
      await client.query("BEGIN");

      const txRes = await client.query(
        "SELECT * FROM transactions WHERE id = $1 FOR UPDATE",
        [transactionId]
      );
      const tx = txRes.rows[0];
      if (!tx || tx.status !== "pending") {
        throw new Error("CANNOT_REJECT_NON_PENDING_TRANSACTION");
      }

      await client.query(
        "UPDATE transactions SET status = 'rejected', admin_id = $1, processed_at = now() WHERE id = $2",
        [req.user.id, transactionId]
      );

      await client.query("COMMIT");

      await auditAction(
        req.user.id,
        "ai.transaction.rejected",
        "transaction",
        transactionId,
        { userId, via: "HABESHA_AI_ADMIN" },
        req.ip
      );

      return res.json({
        ok: true,
        message: `🚫 Deposit #${transactionId} has been rejected.`,
        messageAmharic: `🚫 የገቢ ጥያቄ #${transactionId} ውድቅ ተደርጓል።`,
        details: { transactionId, userId }
      });
    }

    if (action === "TOGGLE_USER_STATUS") {
      const { userId, isActive } = payload;
      await assertNotOwner(userId); // Strict owner defense

      await client.query(
        "UPDATE users SET is_active = $1 WHERE id = $2",
        [isActive, userId]
      );

      const actionName = isActive ? "user.reactivated" : "user.suspended";
      await auditAction(
        req.user.id,
        `ai.${actionName}`,
        "user",
        userId,
        { isActive, via: "HABESHA_AI_ADMIN" },
        req.ip
      );

      return res.json({
        ok: true,
        message: `Account #${userId} status updated to: ${isActive ? "ACTIVE" : "SUSPENDED"}.`,
        messageAmharic: `የተጠቃሚ #${userId} ሁኔታ ወደ ${isActive ? "ንቁ (Active)" : "የታገደ (Suspended)"} ተቀይሯል።`,
        details: { userId, isActive }
      });
    }

    throw new Error(`UNSUPPORTED_ACTION: ${action}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[AIController] Confirmation execution error:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Failed to execute confirmed action."
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
    const pendingDeposits = await tools.getPendingDeposits();
    const pendingWithdrawals = await tools.getPendingWithdrawals();
    const threats = await tools.detectSecurityThreats();
    const games = await tools.getGamesOverview();
    const activeGamesCount = games.filter(g => g.status === "running" || g.status === "waiting").length;

    res.json({
      ok: true,
      stats: {
        pendingDepositsCount: pendingDeposits.length,
        pendingWithdrawalsCount: pendingWithdrawals.length,
        securityThreatsCount: threats.threatCount,
        activeGamesCount,
        aiConfigured: aiService.isAIConfigured()
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
    version: "1.0.0",
    aiConfigured: aiService.isAIConfigured(),
    model: aiService.model,
    ownerProtectionEnabled: true,
    supportedLanguages: ["English", "Amharic (አማርኛ)"]
  });
}

module.exports = {
  handleChatMessage,
  handleActionConfirmation,
  getQuickStats,
  getStatus
};
