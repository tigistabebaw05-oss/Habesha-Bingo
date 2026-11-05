const tools = require("./ai.tools");
const { createConfirmationToken, assertNotOwner, isOwnerAccount } = require("./ai.permissions");

const AI_API_KEY = process.env.GEMINI_API_KEY || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || (process.env.OPENAI_API_KEY ? "gpt-4o-mini" : "gemini-1.5-flash");

/**
 * Normalizes input text and detects intent (English & Amharic).
 */
function detectIntent(text = "") {
  const t = text.toLowerCase().trim();

  // 1. Pending deposits
  if (t.includes("pending deposit") || t.includes("show deposits") || t.includes("ያልተረጋገጡ የገቢ") || t.includes("የገቢ ጥያቄ") || t.includes("deposit list") || t.includes("pending transactions")) {
    return "GET_PENDING_DEPOSITS";
  }

  // 2. Pending withdrawals
  if (t.includes("pending withdrawal") || t.includes("show withdrawals") || t.includes("የወጪ ጥያቄ") || t.includes("ያልተከፈሉ ወጪ") || t.includes("withdrawal request")) {
    return "GET_PENDING_WITHDRAWALS";
  }

  // 3. User search / list
  if (t.includes("search user") || t.includes("find user") || t.includes("show users") || t.includes("ተጠቃሚ") || t.includes("users list") || t.includes("registered today") || t.includes("how many users")) {
    return "GET_USERS";
  }

  // 4. Financial report / revenue
  if (t.includes("financial report") || t.includes("revenue") || t.includes("profit") || t.includes("report") || t.includes("የገንዘብ ሪፖርት") || t.includes("ገቢና ወጪ") || t.includes("summary") || t.includes("analytics")) {
    return "GET_FINANCIALS";
  }

  // 5. Active games
  if (t.includes("active game") || t.includes("bingo game") || t.includes("show games") || t.includes("ጨዋታ") || t.includes("cartela") || t.includes("game status")) {
    return "GET_GAMES";
  }

  // 6. Security & Fraud detection
  if (t.includes("suspicious") || t.includes("fraud") || t.includes("security") || t.includes("duplicate") || t.includes("አጠራጣሪ") || t.includes("ማጭበርበር") || t.includes("threats")) {
    return "DETECT_SECURITY_THREATS";
  }

  // 7. Approve deposit action intent
  const approveDepMatch = t.match(/(?:approve deposit|አፅድቅ|ፈቅድ).*(?:#|id\s*|tx\s*)?(\d+)/i) || t.match(/(?:#|id\s*|tx\s*)?(\d+).*(?:approve|አፅድቅ)/i);
  if (approveDepMatch) {
    return { type: "INTENT_APPROVE_DEPOSIT", transactionId: Number(approveDepMatch[1]) };
  }

  // 8. Reject deposit action intent
  const rejectDepMatch = t.match(/(?:reject deposit|ውድቅ|አትቀበል).*(?:#|id\s*|tx\s*)?(\d+)/i);
  if (rejectDepMatch) {
    return { type: "INTENT_REJECT_DEPOSIT", transactionId: Number(rejectDepMatch[1]) };
  }

  // 9. Suspend user intent
  const suspendMatch = t.match(/(?:suspend|block|እገድ).*(?:user|player|ተጠቃሚ)?\s*#?(\d+)/i);
  if (suspendMatch) {
    return { type: "INTENT_SUSPEND_USER", userId: Number(suspendMatch[1]) };
  }

  return "GENERAL_INQUIRY";
}

/**
 * Formats Amharic & English responses for common tools
 */
class HabeshaAIAdminService {
  constructor() {
    this.apiKey = AI_API_KEY;
    this.model = AI_MODEL;
  }

  isAIConfigured() {
    return Boolean(this.apiKey && this.apiKey.length > 5);
  }

  async processAdminMessage({ message, history = [], adminUser }) {
    if (!message || typeof message !== "string") {
      throw new Error("Message text is required.");
    }

    const intent = detectIntent(message);

    // ACTION INTENT 1: Request to approve deposit
    if (typeof intent === "object" && intent.type === "INTENT_APPROVE_DEPOSIT") {
      return await this.prepareDepositApprovalConfirmation(intent.transactionId, adminUser);
    }

    // ACTION INTENT 2: Request to reject deposit
    if (typeof intent === "object" && intent.type === "INTENT_REJECT_DEPOSIT") {
      return await this.prepareDepositRejectionConfirmation(intent.transactionId, adminUser);
    }

    // ACTION INTENT 3: Request to suspend user
    if (typeof intent === "object" && intent.type === "INTENT_SUSPEND_USER") {
      return await this.prepareUserSuspensionConfirmation(intent.userId, adminUser);
    }

    // QUERY INTENTS
    if (intent === "GET_PENDING_DEPOSITS") {
      const deposits = await tools.getPendingDeposits();
      return this.formatPendingDepositsResponse(deposits);
    }

    if (intent === "GET_PENDING_WITHDRAWALS") {
      const withdrawals = await tools.getPendingWithdrawals();
      return this.formatPendingWithdrawalsResponse(withdrawals);
    }

    if (intent === "GET_USERS") {
      // Extract search term if present
      const cleanSearch = message.replace(/show|users|search|find|ተጠቃሚ|ፈልግ|list/gi, "").trim();
      const result = await tools.getUsersList({ search: cleanSearch, limit: 10 });
      return this.formatUsersListResponse(result);
    }

    if (intent === "GET_FINANCIALS") {
      let period = "today";
      const m = message.toLowerCase();
      if (m.includes("week") || m.includes("ሳምንት")) period = "week";
      if (m.includes("month") || m.includes("ወር")) period = "month";
      if (m.includes("all") || m.includes("ሁሉም")) period = "all_time";
      
      const report = await tools.getFinancialAnalytics({ period });
      return this.formatFinancialReportResponse(report);
    }

    if (intent === "GET_GAMES") {
      const games = await tools.getGamesOverview();
      return this.formatGamesResponse(games);
    }

    if (intent === "DETECT_SECURITY_THREATS") {
      const report = await tools.detectSecurityThreats();
      return this.formatSecurityThreatsResponse(report);
    }

    // If an external LLM key is configured, query the LLM with context
    if (this.isAIConfigured()) {
      return await this.callExternalLLM({ message, history, adminUser });
    }

    // Default intelligent fallback when no key is set
    return {
      reply: `🤖 **HABESHA AI ADMIN**\n\nI am your intelligent assistant for Habesha Bingo. I can execute secure administrative analysis, search users, inspect transactions, monitor games, and detect security threats in both **English** and **አማርኛ**.\n\n` +
             `💡 *Tip: To enable open-ended generative reasoning, configure \`GEMINI_API_KEY\` or \`AI_API_KEY\` in your \`.env\` file.*\n\n` +
             `**Quick Commands you can ask me right now:**\n` +
             `• *"Show pending deposits"* (ያልተረጋገጡ የገቢ ጥያቄዎችን አሳየኝ)\n` +
             `• *"Show pending withdrawals"* (ያልተከፈሉ የወጪ ጥያቄዎችን አሳየኝ)\n` +
             `• *"Generate financial report"* (የገንዘብና ገቢ ሪፖርት አውጣ)\n` +
             `• *"Find suspicious transactions"* (አጠራጣሪ እንቅስቃሴዎችን መርምር)\n` +
             `• *"Show active Bingo games"* (ንቁ የቢንጎ ጨዋታዎችን አሳየኝ)\n` +
             `• *"Search user <name or phone>"* (ተጠቃሚ ፈልግ)`,
      data: null,
      actionRequired: false
    };
  }

  // Formatters for structured responses
  formatPendingDepositsResponse(deposits) {
    if (!deposits.length) {
      return {
        reply: "✅ **No Pending Deposits:** There are currently no deposit requests awaiting approval.",
        replyAmharic: "✅ **ምንም ያልተረጋገጠ የገቢ ጥያቄ የለም፦** በዚህ ሰዓት ማረጋገጫ የሚጠብቅ ተቀማጭ የለም።",
        data: { deposits: [] },
        actionRequired: false
      };
    }

    let text = `📥 **Found ${deposits.length} Pending Deposit Request(s):**\n\n`;
    deposits.forEach((d, idx) => {
      const dupWarning = d.duplicate_reference_count > 0 ? " ⚠️ *POTENTIAL DUPLICATE REF!*" : "";
      text += `${idx + 1}. **Tx #${d.id}** — Player: **${d.name}** (${d.phone})\n` +
              `   • Amount: **${Number(d.amount).toFixed(2)} ETB**\n` +
              `   • Method: **${d.method || "TeleBirr"}** | Ref: \`${d.reference || "None"}\`${dupWarning}\n` +
              `   • Submitted: ${new Date(d.created_at).toLocaleTimeString()}\n\n`;
    });

    text += `💡 *To review and safely approve a deposit, type: \`Approve deposit #<ID>\`.*`;

    return {
      reply: text,
      data: { deposits },
      actionRequired: false
    };
  }

  formatPendingWithdrawalsResponse(withdrawals) {
    if (!withdrawals.length) {
      return {
        reply: "✅ **No Pending Withdrawals:** All player withdrawal requests have been processed.",
        data: { withdrawals: [] },
        actionRequired: false
      };
    }

    let text = `📤 **Found ${withdrawals.length} Pending Withdrawal Request(s):**\n\n`;
    withdrawals.forEach((w, idx) => {
      const balCheck = Number(w.current_main_balance) >= Number(w.requested_amount) ? "✅ Balance OK" : "⚠️ Low Balance";
      text += `${idx + 1}. **Tx #${w.id}** — Player: **${w.name}** (${w.phone})\n` +
              `   • Requested: **${Number(w.requested_amount).toFixed(2)} ETB** (${balCheck})\n` +
              `   • Payout Method: **${w.method || "TeleBirr"}** → Account: \`${w.reference || w.phone}\`\n` +
              `   • Account Name: **${w.account_name || "N/A"}**\n` +
              `   • Status: **${w.status.toUpperCase()}**\n\n`;
    });

    return {
      reply: text,
      data: { withdrawals },
      actionRequired: false
    };
  }

  formatUsersListResponse(result) {
    const { total, users } = result;
    if (!users.length) {
      return {
        reply: "🔍 No users matched your search criteria.",
        data: { total: 0, users: [] },
        actionRequired: false
      };
    }

    let text = `👥 **Users Directory (${users.length} of ${total} Total):**\n\n`;
    users.forEach((u) => {
      const statusIcon = u.is_active ? "🟢" : "🔴 Suspended";
      text += `• **#${u.id} ${u.name}** (${u.phone}) — Role: \`${u.role}\` ${statusIcon}\n` +
              `   Main Balance: **${Number(u.main_balance).toFixed(2)} ETB** | VIP: ${Number(u.vip_balance).toFixed(2)} ETB\n` +
              `   Deposits: ${u.completed_deposits} | Withdrawals: ${u.completed_withdrawals}\n\n`;
    });

    return {
      reply: text,
      data: { total, users },
      actionRequired: false
    };
  }

  formatFinancialReportResponse(report) {
    const s = report.summary;
    const text = `📊 **HABESHA BINGO FINANCIAL REPORT (${report.period.toUpperCase()}):**\n\n` +
                 `💰 **Cash In (Deposits):**\n` +
                 `   • Total Approved: **${s.totalDepositsETB.toFixed(2)} ETB** (${s.totalDepositsCount} txs)\n` +
                 `   • Pending Inflow: ${s.pendingDepositsAmountETB.toFixed(2)} ETB (${s.pendingDepositsCount} pending)\n\n` +
                 `💸 **Cash Out (Withdrawals & Prizes):**\n` +
                 `   • Total Payouts: **${s.totalWithdrawalsETB.toFixed(2)} ETB** (${s.totalWithdrawalsCount} txs)\n` +
                 `   • Pending Payouts: ${s.pendingWithdrawalsAmountETB.toFixed(2)} ETB (${s.pendingWithdrawalsCount} pending)\n` +
                 `   • Total Prizes Distributed: ${s.prizesDistributedETB.toFixed(2)} ETB\n\n` +
                 `🏢 **Platform Revenue & Performance:**\n` +
                 `   • Platform Fee Revenue: **${s.platformFeeRevenueETB.toFixed(2)} ETB**\n` +
                 `   • Active Games: ${s.activeGames} | Completed: ${s.completedGames}\n` +
                 `   • Player Wallet Liability: ${s.platformCurrentWalletLiabilityETB.toFixed(2)} ETB (${s.fundedAccountsCount} funded players)\n` +
                 `   • Registered Players: ${s.registeredUsersTotal} (+${s.registeredUsersNew} new)\n\n` +
                 `⚖️ *Note: Platform Net Profit is derived strictly from Platform Fees collected, not raw player deposits.*`;

    return {
      reply: text,
      data: report,
      actionRequired: false
    };
  }

  formatGamesResponse(games) {
    if (!games.length) {
      return {
        reply: "🎮 No games recorded yet.",
        data: { games: [] },
        actionRequired: false
      };
    }

    let text = `🎲 **Current & Recent Bingo Games:**\n\n`;
    games.slice(0, 5).forEach((g) => {
      const statusIcon = g.status === "running" ? "🔥 LIVE" : g.status === "waiting" ? "⏳ Waiting" : "🏁 Finished";
      text += `• **Game #${g.id}** (${g.name}) — ${statusIcon}\n` +
              `   Players: **${g.player_count}** | Entry: ${Number(g.entry).toFixed(2)} ETB\n` +
              `   Prize Pool: **${Number(g.prize_pool).toFixed(2)} ETB** | Numbers Called: ${g.called_count}/75\n` +
              `   ${g.winner_name ? `Winner: **${g.winner_name}**` : "Awaiting Winner"}\n\n`;
    });

    return {
      reply: text,
      data: { games },
      actionRequired: false
    };
  }

  formatSecurityThreatsResponse(threatReport) {
    if (!threatReport.threatCount) {
      return {
        reply: "🛡️ **Security Audit Complete:** No immediate security threats or duplicate transaction alerts detected.",
        data: threatReport,
        actionRequired: false
      };
    }

    let text = `🚨 **SECURITY MONITORING ALERT: ${threatReport.threatCount} Issue(s) Detected:**\n\n`;
    threatReport.threats.forEach((th, idx) => {
      text += `${idx + 1}. **[${th.severity}] ${th.title}**\n` +
              `   • *${th.titleAmharic}*\n` +
              `   • Details: ${th.description}\n\n`;
    });

    return {
      reply: text,
      data: threatReport,
      actionRequired: false
    };
  }

  // Two-step confirmation preparer for Deposit Approval
  async prepareDepositApprovalConfirmation(transactionId, adminUser) {
    const candidate = await tools.verifyDepositCandidate(transactionId);
    if (!candidate.valid) {
      return {
        reply: `❌ **Cannot Approve Deposit #${transactionId}:** Reason: \`${candidate.reason}\``,
        data: null,
        actionRequired: false
      };
    }

    const tx = candidate.transaction;
    const isOwner = await isOwnerAccount(tx.user_id);

    const tokenData = createConfirmationToken({
      action: "APPROVE_DEPOSIT",
      payload: {
        transactionId: tx.id,
        userId: tx.user_id,
        amount: Number(tx.amount),
        wallet: tx.wallet || "main",
        method: tx.method,
        reference: tx.reference
      },
      adminId: adminUser.id
    });

    const warningText = candidate.hasDuplicateReference
      ? "\n⚠️ **CRITICAL WARNING:** This transaction reference was already used in another transaction! Verify bank receipt before confirming."
      : "";

    return {
      reply: `⚠️ **CONFIRMATION REQUIRED: Approve Deposit #${tx.id}**\n\n` +
             `• Player: **${tx.name}** (${tx.phone})\n` +
             `• Amount to Credit: **${Number(tx.amount).toFixed(2)} ETB**\n` +
             `• Method: **${tx.method}**\n` +
             `• Payment Reference: \`${tx.reference || "None"}\`${warningText}\n\n` +
             `*Please confirm to execute this deposit and credit the player's wallet.*`,
      data: {
        action: "APPROVE_DEPOSIT",
        transactionId: tx.id,
        amount: Number(tx.amount),
        player: tx.name,
        expiresInSeconds: tokenData.expiresInSeconds
      },
      actionRequired: true,
      confirmationToken: tokenData.token,
      expiresAt: tokenData.expiresAt
    };
  }

  // Two-step confirmation preparer for Deposit Rejection
  async prepareDepositRejectionConfirmation(transactionId, adminUser) {
    const candidate = await tools.verifyDepositCandidate(transactionId);
    if (!candidate.valid) {
      return {
        reply: `❌ **Cannot Reject Deposit #${transactionId}:** Reason: \`${candidate.reason}\``,
        data: null,
        actionRequired: false
      };
    }

    const tx = candidate.transaction;
    const tokenData = createConfirmationToken({
      action: "REJECT_DEPOSIT",
      payload: {
        transactionId: tx.id,
        userId: tx.user_id,
        amount: Number(tx.amount)
      },
      adminId: adminUser.id
    });

    return {
      reply: `⚠️ **CONFIRMATION REQUIRED: Reject Deposit #${tx.id}**\n\n` +
             `• Player: **${tx.name}** (${tx.phone})\n` +
             `• Amount: **${Number(tx.amount).toFixed(2)} ETB**\n` +
             `• Reference: \`${tx.reference || "None"}\`\n\n` +
             `*Are you sure you want to reject this deposit request?*`,
      data: {
        action: "REJECT_DEPOSIT",
        transactionId: tx.id,
        player: tx.name
      },
      actionRequired: true,
      confirmationToken: tokenData.token,
      expiresAt: tokenData.expiresAt
    };
  }

  // Two-step confirmation preparer for User Suspension
  async prepareUserSuspensionConfirmation(userId, adminUser) {
    await assertNotOwner(userId); // Protected owner shield

    const userRes = await tools.getUserDetails(userId);
    if (!userRes || !userRes.user) {
      return {
        reply: `❌ **User #${userId} not found.**`,
        data: null,
        actionRequired: false
      };
    }

    const targetUser = userRes.user;
    const tokenData = createConfirmationToken({
      action: "TOGGLE_USER_STATUS",
      payload: {
        userId: targetUser.id,
        isActive: false
      },
      adminId: adminUser.id
    });

    return {
      reply: `⚠️ **CONFIRMATION REQUIRED: Suspend Account #${targetUser.id}**\n\n` +
             `• Name: **${targetUser.name}**\n` +
             `• Phone: **${targetUser.phone}**\n` +
             `• Role: **${targetUser.role}**\n` +
             `• Main Balance: **${Number(targetUser.main_balance).toFixed(2)} ETB**\n\n` +
             `*This will restrict the player from joining games or logging in until reactivated.*`,
      data: {
        action: "TOGGLE_USER_STATUS",
        userId: targetUser.id,
        name: targetUser.name
      },
      actionRequired: true,
      confirmationToken: tokenData.token,
      expiresAt: tokenData.expiresAt
    };
  }

  // Optional external LLM fallback for conversational reasoning
  async callExternalLLM({ message, history, adminUser }) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const systemInstruction = `You are HABESHA AI ADMIN, the official AI Administrator for Habesha Bingo.
Your role: Intelligent, highly disciplined, cybersecurity-focused administrative assistant.
Languages: English and Amharic (አማርኛ).
Never invent mock financial numbers. Never fabricate payment verifications. Owner accounts are 100% protected.`;

      const body = {
        contents: [
          { role: "user", parts: [{ text: `${systemInstruction}\n\nAdmin: ${message}` }] }
        ]
      };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error(`LLM API returned status ${res.status}`);
      }

      const data = await res.json();
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "I have received your request.";
      return {
        reply: answer,
        data: null,
        actionRequired: false
      };
    } catch (err) {
      console.warn("[AIService] External LLM error:", err.message);
      // Fallback cleanly to built-in dispatcher
      return {
        reply: `🤖 **HABESHA AI ADMIN:**\n\nI processed your request: "${message}". For financial safety and guaranteed accuracy, please use direct administrative commands like: *"show pending deposits"*, *"financial report"*, *"find suspicious transactions"*, or *"search user"*.\n\n*(Note: External LLM warning: ${err.message})*`,
        data: null,
        actionRequired: false
      };
    }
  }
}

module.exports = new HabeshaAIAdminService();

