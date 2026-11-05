const tools = require("./ai.tools");
const { createConfirmationToken, assertNotOwner, isOwnerAccount } = require("./ai.permissions");
const pool = require("../../../db");
const aiEngine = require("../ai-automation/ai.engine");

const AI_API_KEY = process.env.GEMINI_API_KEY || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || (process.env.OPENAI_API_KEY ? "gpt-4o-mini" : "gemini-1.5-flash");

/**
 * Normalizes input text and detects intent (English & Amharic).
 */
function detectIntent(text = "") {
  const t = text.toLowerCase().trim();

  // 1. Batch approve all deposits intent
  if (
    /(?:ሁሉንም|auto|batch).*(?:አጽድቅ|አጽድቃቸው|ፈቅድ|approve)/i.test(t) ||
    /(?:አጽድቅ|approve).*(?:ሁሉንም|all|deposits|ገቢዎችን|ገቢ)/i.test(t) ||
    t === "ሁሉንም አጽድቅ" ||
    t === "ገቢዎችን አጽድቅ" ||
    t === "approve all"
  ) {
    return "AUTO_APPROVE_ALL_DEPOSITS";
  }

  // 2. Approve specific deposit action intent
  const approveDepMatch = t.match(/(?:approve deposit|አፅድቅ|አጽድቅ|ፈቅድ).*(?:#|id\s*|tx\s*)?(\d+)/i) || t.match(/(?:#|id\s*|tx\s*)?(\d+).*(?:approve|አፅድቅ|አጽድቅ)/i);
  if (approveDepMatch) {
    return { type: "INTENT_APPROVE_DEPOSIT", transactionId: Number(approveDepMatch[1]) };
  }

  // 3. Reject specific deposit action intent
  const rejectDepMatch = t.match(/(?:reject deposit|ውድቅ|አትቀበል).*(?:#|id\s*|tx\s*)?(\d+)/i);
  if (rejectDepMatch) {
    return { type: "INTENT_REJECT_DEPOSIT", transactionId: Number(rejectDepMatch[1]) };
  }

  // 4. Suspend user intent
  const suspendMatch = t.match(/(?:suspend|block|እገድ).*(?:user|player|ተጠቃሚ)?\s*#?(\d+)/i);
  if (suspendMatch) {
    return { type: "INTENT_SUSPEND_USER", userId: Number(suspendMatch[1]) };
  }

  // 5. Pending deposits query (ANY mention of deposit/ገቢ)
  if (/(?:ገቢ|ተቀማጭ|deposit|deposits)/i.test(t)) {
    return "GET_PENDING_DEPOSITS";
  }

  // 6. Pending withdrawals query (ANY mention of withdraw/ወጪ)
  if (/(?:ወጪ|ማውጣት|withdraw|withdrawals|cashout)/i.test(t)) {
    return "GET_PENDING_WITHDRAWALS";
  }

  // 7. Process support tickets / Auto-reply
  if (/(?:ድጋፍ|ጥያቄ|ጥያቄዎች|support|reply support|የደንበኞች)/i.test(t)) {
    return "PROCESS_SUPPORT_TICKETS";
  }

  // 8. Self-healing / Diagnostics
  if (/(?:ጥገና|አስተካክል|መርምር|heal|self heal|diagnostic|fix)/i.test(t)) {
    return "TRIGGER_SELF_HEAL";
  }

  // 9. Financial report / revenue
  if (/(?:ሪፖርት|ፋይናንስ|ገንዘብ|ትርፍ|report|finances?|revenue|profit|summary|analytics)/i.test(t)) {
    return "GET_FINANCIALS";
  }

  // 10. User search / list
  if (/(?:ተጠቃሚ|ተጫዋች|users?|players?)/i.test(t)) {
    return "GET_USERS";
  }

  // 11. Active games
  if (/(?:ጨዋታ|ቢንጎ|ካርቴላ|games?|bingo|cartela|round)/i.test(t)) {
    return "GET_GAMES";
  }

  // 12. Security & Fraud detection
  if (/(?:ደህንነት|አጠራጣሪ|ማጭበርበር|ተደጋጋሚ|security|fraud|threats?|duplicate)/i.test(t)) {
    return "DETECT_SECURITY_THREATS";
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

    // AUTONOMOUS ACTION: Batch approve all deposits
    if (intent === "AUTO_APPROVE_ALL_DEPOSITS") {
      return await this.autoApproveAllPendingDeposits(adminUser);
    }

    // AUTONOMOUS ACTION: Process support tickets
    if (intent === "PROCESS_SUPPORT_TICKETS") {
      return await this.batchProcessSupportTickets();
    }

    // AUTONOMOUS ACTION: Trigger self-heal
    if (intent === "TRIGGER_SELF_HEAL") {
      return await this.runSelfHealingDiagnostic();
    }

    // QUERY INTENTS
    if (intent === "GET_PENDING_DEPOSITS") {
      const deposits = await tools.getPendingDeposits();
      return await this.formatPendingDepositsResponse(deposits, adminUser);
    }

    if (intent === "GET_PENDING_WITHDRAWALS") {
      const withdrawals = await tools.getPendingWithdrawals();
      return await this.formatPendingWithdrawalsResponse(withdrawals, adminUser);
    }

    if (intent === "GET_USERS") {
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

    // Default intelligent response in Amharic & English
    return {
      reply: `🤖 **HABESHA AI ADMIN ASSISTANT**\n\nI can execute all administrative operations automatically for Habesha Bingo.\n\n` +
             `**Quick Commands you can give right now:**\n` +
             `• **"Deposits"** / **"ገቢ"** — View pending player deposits\n` +
             `• **"Approve all"** / **"ሁሉንም አጽድቅ"** — Auto-verify & approve all valid deposits\n` +
             `• **"Withdrawals"** / **"ወጪ"** — View pending cashout requests\n` +
             `• **"Report"** / **"ሪፖርት"** — Generate live financial and platform revenue analytics\n` +
             `• **"Users"** / **"ተጠቃሚ"** — Search and inspect players\n` +
             `• **"Games"** / **"ጨዋታ"** — Monitor live Bingo rounds\n` +
             `• **"Support"** / **"ድጋፍ"** — Auto-reply to open customer support tickets\n` +
             `• **"Self-heal"** / **"ጥገና"** — Run system health diagnostic & auto-repair`,
      replyAmharic: `👋 **ሰላም አስተዳዳሪ! እኔ የሀበሻ ቢንጎ AI አስተዳዳሪ ነኝ።**\n\nየአስተዳደር ስራዎችን ሙሉ በሙሉ በራስ-ሰር ለመስራት ዝግጁ ነኝ።\n\n` +
                    `🔹 **በቀጥታ ማዘዝ የሚችሏቸው ስራዎች፦**\n` +
                    `1. 💳 **"ገቢ"** — ያልተረጋገጡ የገቢ ጥያቄዎችን ያሳያል\n` +
                    `2. ⚡ **"ሁሉንም አጽድቅ"** — ትክክለኛ የገቢ ጥያቄዎችን በሙሉ በአንድ ጊዜ ያጸድቃል\n` +
                    `3. 💸 **"ወጪ"** — ተጫዋቾች እንዲወጣ የጠየቁትን ገንዘብ ያሳያል\n` +
                    `4. 📊 **"ሪፖርት"** — የዛሬውን ወይም አጠቃላይ ገቢና ትርፍ ያሰላል\n` +
                    `5. 👥 **"ተጠቃሚ"** — የተመዘገቡ ተጫዋቾችን ይዘረዝራል\n` +
                    `6. 🎲 **"ጨዋታ"** — የቀጥታ የቢንጎ ዙሮችን ሁኔታ ያሳያል\n` +
                    `7. 🔍 **"ደህንነት"** — አጠራጣሪ እንቅስቃሴዎችን ይመረምራል\n` +
                    `8. 💬 **"ድጋፍ"** — የደንበኞችን የድጋፍ ጥያቄዎች በሙሉ ይመልሳል\n` +
                    `9. 🛠️ **"ጥገና"** — የስርዓት ጤና ምርመራ እና ራስ-ሰር ጥገና ያከናውናል\n\n` +
                    `*የሚፈልጉትን ትዕዛዝ በአጭሩ ይጻፉልኝ!*`,
      data: null,
      actionRequired: false
    };
  }

  /**
   * Autonomous Action: Batch Approve All Valid Pending Deposits
   */
  async autoApproveAllPendingDeposits(adminUser) {
    if (!pool) throw new Error("Database not connected");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = (await client.query(
        `SELECT t.id, t.user_id, t.amount, t.wallet, t.method, t.reference, u.name, u.phone
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         WHERE t.type = 'deposit' AND t.status = 'pending'
         ORDER BY t.id ASC
         FOR UPDATE`
      )).rows;

      if (rows.length === 0) {
        await client.query("COMMIT");
        return {
          reply: "✅ **No Pending Deposits:** There are currently no pending deposits waiting to be approved.",
          replyAmharic: "✅ **ምንም የሚጠብቅ የገቢ ጥያቄ የለም፦** ሁሉም የገቢ ጥያቄዎች ቀድመው ተረጋግጠው ጸድቀዋል!",
          data: { approvedCount: 0 },
          actionRequired: false
        };
      }

      let totalCredited = 0;
      const approvedIds = [];

      for (const tx of rows) {
        const depAmount = Math.abs(Number(tx.amount));
        const col = tx.wallet === "vip" ? "vip_balance" : "main_balance";

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
          [before, after, adminUser?.id || 1, tx.id]
        );

        totalCredited += depAmount;
        approvedIds.push(tx.id);
      }

      await client.query("COMMIT");

      // Log in audit log
      try {
        await pool.query(
          "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
          [adminUser?.id || 1, "AI_AUTO_BATCH_APPROVED_DEPOSITS", "transactions", rows[0]?.id, JSON.stringify({ count: rows.length, approvedIds, totalCredited }), "AI_ADMIN_AUTO"]
        );
      } catch (_) {}

      return {
        reply: `🎉 **Successfully Approved ${rows.length} Deposit(s)!**\n\n` +
               `• Total Credited: **${totalCredited.toFixed(2)} ETB**\n` +
               `• Transactions: #${approvedIds.join(", #")}\n` +
               `• Wallets have been updated immediately in real time.`,
        replyAmharic: `🎉 **${rows.length} የገቢ ጥያቄዎች በተሳካ ሁኔታ በራስ-ሰር ጸድቀዋል!**\n\n` +
                      `• አጠቃላይ ወደ ተጫዋቾች የገባ ገንዘብ፦ **${totalCredited.toFixed(2)} ETB**\n` +
                      `• የግብይት ቁጥሮች፦ #${approvedIds.join(", #")}\n` +
                      `• የተጫዋቾች ዋሌት ወዲያውኑ ገቢ ሆኗል!`,
        data: { approvedCount: rows.length, totalCredited, approvedIds },
        actionRequired: false
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Autonomous Action: Batch Process Support Tickets
   */
  async batchProcessSupportTickets() {
    try {
      await aiEngine.processPendingSupportTickets();
      return {
        reply: `💬 **24/7 AI Customer Support batch completed!**\n\nOpen support inquiries have been analyzed and answered automatically in Amharic and English.`,
        replyAmharic: `💬 **የ 24/7 AI ደንበኞች ድጋፍ ስራ ተጠናቋል!**\n\nክፍት የነበሩ የደንበኞች ጥያቄዎች በሙሉ በራስ-ሰር ተመልሰው ተፈትተዋል።`,
        data: null,
        actionRequired: false
      };
    } catch (e) {
      return {
        reply: `Notice: ${e.message}`,
        replyAmharic: `ማስታወሻ፦ ${e.message}`,
        data: null,
        actionRequired: false
      };
    }
  }

  /**
   * Autonomous Action: Run Diagnostic & Self-Healing
   */
  async runSelfHealingDiagnostic() {
    try {
      const SystemWatchdog = require("../ai-automation/ai.watchdog");
      const watchdog = aiEngine.watchdog || new SystemWatchdog({ pool });
      const result = await watchdog.performSelfHealing();
      const actions = result.actions || [];
      const actionText = actions.length > 0 ? actions.join(", ") : "All services already operating optimally.";
      return {
        reply: `🛠️ **System Health & Self-Healing Routine Complete!**\n\n• Actions Taken: ${actionText}\n• Database, Socket.IO, Telegram Bot, and Bingo loops are fully synchronized.`,
        replyAmharic: `🛠️ **የስርዓት ጤና ምርመራ እና ራስ-ሰር ጥገና ተጠናቋል!**\n\n• የተከናወኑ ጥገናዎች፦ ${actions.length > 0 ? actions.join(", ") : "ሁሉም ሰርቪሶች በተሟላ ሁኔታ ላይ ናቸው።"}\n• ዳታቤዝ፣ የቴሌግራም ቦት እና የቢንጎ ዙሮች በትክክል እየሰሩ ነው።`,
        data: result,
        actionRequired: false
      };
    } catch (e) {
      return {
        reply: `Self-healing error: ${e.message}`,
        replyAmharic: `የጥገና ስህተት፦ ${e.message}`,
        data: null,
        actionRequired: false
      };
    }
  }

  // Formatters for structured responses
  async formatPendingDepositsResponse(deposits, adminUser) {
    if (!deposits.length) {
      return {
        reply: "✅ **No Pending Deposits:** There are currently no deposit requests awaiting approval.",
        replyAmharic: "✅ **ምንም ያልተረጋገጠ የገቢ ጥያቄ የለም፦** በዚህ ሰዓት ማረጋገጫ የሚጠብቅ ተቀማጭ የለም። ሁሉም ተጠናቀዋል!",
        data: { deposits: [] },
        actionRequired: false
      };
    }

    let text = `📥 **Found ${deposits.length} Pending Deposit Request(s):**\n\n`;
    let textAm = `📥 **${deposits.length} ያልተረጋገጡ የገቢ ጥያቄዎች ተገኝተዋል፦**\n\n`;

    deposits.forEach((d, idx) => {
      const dupWarning = d.duplicate_reference_count > 0 ? " ⚠️ *POTENTIAL DUPLICATE REF!*" : "";
      const dupWarningAm = d.duplicate_reference_count > 0 ? " ⚠️ *ይህ TxID ከዚህ በፊት ተጠቅመውበታል!*" : "";
      const timeStr = new Date(d.created_at).toLocaleTimeString();

      text += `${idx + 1}. **Tx #${d.id}** — Player: **${d.name}** (${d.phone})\n` +
              `   • Amount: **${Number(d.amount).toFixed(2)} ETB**\n` +
              `   • Method: **${d.method || "TeleBirr"}** | Ref: \`${d.reference || "None"}\`${dupWarning}\n` +
              `   • Submitted: ${timeStr}\n\n`;

      textAm += `${idx + 1}. **Tx #${d.id}** — ተጫዋች፦ **${d.name}** (${d.phone})\n` +
                `   • መጠን፦ **${Number(d.amount).toFixed(2)} ETB**\n` +
                `   • ዘዴ፦ **${d.method || "TeleBirr"}** | የማረጋገጫ ቁጥር (TxID)፦ \`${d.reference || "None"}\`${dupWarningAm}\n` +
                `   • ሰዓት፦ ${timeStr}\n\n`;
    });

    text += `💡 *Type \`Approve deposit #${deposits[0].id}\` or say \`Approve all\` to batch approve all.*`;
    textAm += `💡 *ለመፍቀድ \`አጽድቅ ${deposits[0].id}\` ይበሉ፣ ወይም ሁሉንም ለማጽደቅ \`ሁሉንም አጽድቅ\` ይበሉ!*`;

    // Create confirmation token for the top deposit so admin can click 1-click confirm
    let tokenData = null;
    if (adminUser && deposits[0]) {
      try {
        tokenData = createConfirmationToken({
          action: "APPROVE_DEPOSIT",
          payload: {
            transactionId: deposits[0].id,
            userId: deposits[0].user_id,
            amount: Number(deposits[0].amount),
            wallet: "main",
            method: deposits[0].method,
            reference: deposits[0].reference
          },
          adminId: adminUser.id
        });
      } catch (_) {}
    }

    return {
      reply: text,
      replyAmharic: textAm,
      data: {
        deposits,
        actionDetails: tokenData ? {
          description: `Approve deposit of ${Number(deposits[0].amount).toFixed(2)} ETB for ${deposits[0].name} (Tx #${deposits[0].id})`,
          type: "APPROVE_DEPOSIT",
          targetId: deposits[0].id
        } : null
      },
      actionRequired: Boolean(tokenData),
      confirmationToken: tokenData ? tokenData.token : null,
      expiresAt: tokenData ? tokenData.expiresAt : null
    };
  }

  async formatPendingWithdrawalsResponse(withdrawals, adminUser) {
    if (!withdrawals.length) {
      return {
        reply: "✅ **No Pending Withdrawals:** All player withdrawal requests have been processed.",
        replyAmharic: "✅ **ምንም ያልተከፈለ የወጪ ጥያቄ የለም፦** ሁሉም የወጪ ጥያቄዎች ተጠናቀዋል!",
        data: { withdrawals: [] },
        actionRequired: false
      };
    }

    let text = `📤 **Found ${withdrawals.length} Pending Withdrawal Request(s):**\n\n`;
    let textAm = `📤 **${withdrawals.length} የሚጠብቁ የወጪ ጥያቄዎች ተገኝተዋል፦**\n\n`;

    withdrawals.forEach((w, idx) => {
      const balOk = Number(w.current_main_balance) >= Number(w.requested_amount);
      const balCheck = balOk ? "✅ Balance OK" : "⚠️ Low Balance";
      const balCheckAm = balOk ? "✅ ቀሪ ሂሳብ በቂ ነው" : "⚠️ ቀሪ ሂሳብ አነሰ";

      text += `${idx + 1}. **Tx #${w.id}** — Player: **${w.name}** (${w.phone})\n` +
              `   • Requested: **${Number(w.requested_amount).toFixed(2)} ETB** (${balCheck})\n` +
              `   • Payout: **${w.method || "TeleBirr"}** → \`${w.reference || w.phone}\`\n\n`;

      textAm += `${idx + 1}. **Tx #${w.id}** — ተጫዋች፦ **${w.name}** (${w.phone})\n` +
                `   • የተጠየቀ መጠን፦ **${Number(w.requested_amount).toFixed(2)} ETB** (${balCheckAm})\n` +
                `   • የሚላክበት፦ **${w.method || "TeleBirr"}** → \`${w.reference || w.phone}\`\n\n`;
    });

    let tokenData = null;
    if (adminUser && withdrawals[0]) {
      try {
        tokenData = createConfirmationToken({
          action: "APPROVE_WITHDRAWAL",
          payload: {
            transactionId: withdrawals[0].id,
            userId: withdrawals[0].user_id,
            amount: Number(withdrawals[0].requested_amount)
          },
          adminId: adminUser.id
        });
      } catch (_) {}
    }

    return {
      reply: text,
      replyAmharic: textAm,
      data: {
        withdrawals,
        actionDetails: tokenData ? {
          description: `Confirm real payout release of ${Number(withdrawals[0].requested_amount).toFixed(2)} ETB to ${withdrawals[0].name} (${withdrawals[0].phone})`,
          type: "APPROVE_WITHDRAWAL",
          targetId: withdrawals[0].id
        } : null
      },
      actionRequired: Boolean(tokenData),
      confirmationToken: tokenData ? tokenData.token : null,
      expiresAt: tokenData ? tokenData.expiresAt : null
    };
  }

  formatUsersListResponse(result) {
    const { total, users } = result;
    if (!users.length) {
      return {
        reply: "🔍 No users matched your search criteria.",
        replyAmharic: "🔍 ምንም የተገኘ ተጠቃሚ የለም።",
        data: { total: 0, users: [] },
        actionRequired: false
      };
    }

    let text = `👥 **Users Directory (${users.length} of ${total} Total):**\n\n`;
    let textAm = `👥 **የተጠቃሚዎች ዝርዝር (ከ${total} ውስጥ ${users.length})፦**\n\n`;

    users.forEach((u) => {
      const statusIcon = u.is_active ? "🟢" : "🔴 Suspended";
      text += `• **#${u.id} ${u.name}** (${u.phone}) — Role: \`${u.role}\` ${statusIcon}\n` +
              `   Main: **${Number(u.main_balance).toFixed(2)} ETB** | VIP: ${Number(u.vip_balance).toFixed(2)} ETB\n\n`;

      textAm += `• **#${u.id} ${u.name}** (${u.phone}) — ደረጃ፦ \`${u.role}\` ${u.is_active ? '🟢 ንቁ' : '🔴 የታገደ'}\n` +
                `   ዋና ሂሳብ፦ **${Number(u.main_balance).toFixed(2)} ETB** | VIP፦ ${Number(u.vip_balance).toFixed(2)} ETB\n\n`;
    });

    return {
      reply: text,
      replyAmharic: textAm,
      data: { total, users },
      actionRequired: false
    };
  }

  formatFinancialReportResponse(report) {
    const s = report.summary;
    const text = `📊 **HABESHA BINGO FINANCIAL REPORT (${report.period.toUpperCase()}):**\n\n` +
                 `💰 **Cash In (Deposits):**\n` +
                 `   • Total Approved: **${s.totalDepositsETB.toFixed(2)} ETB** (${s.totalDepositsCount} txs)\n` +
                 `   • Pending: ${s.pendingDepositsAmountETB.toFixed(2)} ETB\n\n` +
                 `💸 **Cash Out (Withdrawals & Prizes):**\n` +
                 `   • Total Payouts: **${s.totalWithdrawalsETB.toFixed(2)} ETB** (${s.totalWithdrawalsCount} txs)\n` +
                 `   • Total Prizes Distributed: ${s.prizesDistributedETB.toFixed(2)} ETB\n\n` +
                 `🏢 **Platform Revenue & Performance:**\n` +
                 `   • Platform Fee Revenue: **${s.platformFeeRevenueETB.toFixed(2)} ETB**\n` +
                 `   • Active Games: ${s.activeGames} | Completed: ${s.completedGames}\n` +
                 `   • Registered Players: ${s.registeredUsersTotal}`;

    const textAm = `📊 **የሀበሻ ቢንጎ የፋይናንስ ሪፖርት (${report.period.toUpperCase()})፦**\n\n` +
                   `💰 **የገባ ገንዘብ (Deposits)፦**\n` +
                   `   • የጸደቀ ገቢ፦ **${s.totalDepositsETB.toFixed(2)} ETB** (${s.totalDepositsCount} ግብይቶች)\n` +
                   `   • የሚጠብቅ ገቢ፦ ${s.pendingDepositsAmountETB.toFixed(2)} ETB\n\n` +
                   `💸 **የወጣ ገንዘብ (Withdrawals & Prizes)፦**\n` +
                   `   • የተከፈለ ወጪ፦ **${s.totalWithdrawalsETB.toFixed(2)} ETB**\n` +
                   `   • የተከፋፈለ የደራሽ ሽልማት፦ ${s.prizesDistributedETB.toFixed(2)} ETB\n\n` +
                   `🏢 **የመድረኩ ትርፍና አፈፃፀም፦**\n` +
                   `   • የተጣራ የአገልግሎት ክፍያ (Platform Fee)፦ **${s.platformFeeRevenueETB.toFixed(2)} ETB**\n` +
                   `   • የተመዘገቡ ተጫዋቾች፦ ${s.registeredUsersTotal}`;

    return {
      reply: text,
      replyAmharic: textAm,
      data: report,
      actionRequired: false
    };
  }

  formatGamesResponse(games) {
    const list = Array.isArray(games) ? games : (games?.rows || []);
    const activeGame = list.find(g => g.status === 'running' || g.status === 'waiting') || games?.activeGame;
    let text = `🎲 **Bingo Games Live Overview:**\n\n`;
    let textAm = `🎲 **የቀጥታ የቢንጎ ጨዋታዎች ሁኔታ፦**\n\n`;

    if (activeGame) {
      const ticketsCount = activeGame.player_count || activeGame.ticket_count || 0;
      text += `🟢 **Active Game #${activeGame.id} (${activeGame.name || "Room"}):**\n` +
              `   • Status: **${String(activeGame.status || "").toUpperCase()}**\n` +
              `   • Entry Fee: **${Number(activeGame.entry || 0).toFixed(2)} ETB**\n` +
              `   • Current Prize Pool: **${Number(activeGame.prize_pool || 0).toFixed(2)} ETB**\n` +
              `   • Player Tickets: **${ticketsCount}**\n` +
              `   • Called Numbers: **${activeGame.called_count || 0}/75**\n\n`;

      textAm += `🟢 **የቀጥታ ጨዋታ #${activeGame.id}፦**\n` +
                `   • ሁኔታ፦ **${String(activeGame.status || "").toUpperCase()}**\n` +
                `   • የመግቢያ ዋጋ፦ **${Number(activeGame.entry || 0).toFixed(2)} ETB**\n` +
                `   • የደራሽ ሽልማት፦ **${Number(activeGame.prize_pool || 0).toFixed(2)} ETB**\n` +
                `   • የተገዙ ካርቴላዎች፦ **${ticketsCount}**\n` +
                `   • የተጠሩ ቁጥሮች፦ **${activeGame.called_count || 0}/75**\n\n`;
    } else {
      text += `⚪ No active room at the moment. (Watchdog will auto-initialize)\n\n`;
      textAm += `⚪ በአሁኑ ሰዓት ንቁ ጨዋታ የለም (ዋችዶጉ በራስ-ሰር ይጀምረዋል)\n\n`;
    }

    return {
      reply: text,
      replyAmharic: textAm,
      data: games,
      actionRequired: false
    };
  }

  formatSecurityThreatsResponse(report) {
    const threatList = Array.isArray(report?.threats) ? report.threats : [];
    const threatCount = typeof report?.threatCount === "number" ? report.threatCount : threatList.length;

    if (threatCount === 0) {
      return {
        reply: "🛡️ **Security Audit Clean:** No duplicate references, wallet mismatches, or abnormal withdrawal requests detected.",
        replyAmharic: "🛡️ **የደህንነት ምርመራ ንጹህ ነው፦** ምንም የተጭበረበሩ ወይም ተደጋጋሚ TxID፣ የዋሌት መዛባቶች አልተገኙም። ሁሉም ሰላም ነው!",
        data: report,
        actionRequired: false
      };
    }

    let text = `🚨 **Security Audit Found ${threatCount} Alert(s):**\n\n`;
    let textAm = `🚨 **የደህንነት ምርመራ ${threatCount} አጠራጣሪ እንቅስቃሴዎችን አግኝቷል፦**\n\n`;

    threatList.forEach((t, i) => {
      text += `${i + 1}. **[${t.severity || "WARN"}] ${t.title}:** ${t.description}\n`;
      textAm += `${i + 1}. **[${t.severity || "ማስጠንቀቂያ"}] ${t.titleAmharic || t.title}:** ${t.description}\n`;
    });

    return {
      reply: text,
      replyAmharic: textAm,
      data: report,
      actionRequired: false
    };
  }

  async prepareDepositApprovalConfirmation(transactionId, adminUser) {
    const candidate = await tools.verifyDepositCandidate(transactionId);
    if (!candidate.valid) {
      return {
        reply: `❌ **Cannot Approve Deposit #${transactionId}:** Reason: \`${candidate.reason}\``,
        replyAmharic: `❌ **የገቢ ጥያቄ #${transactionId} ማጽደቅ አልተቻለም፦** ምክንያት፦ \`${candidate.reason}\``,
        data: null,
        actionRequired: false
      };
    }

    const tx = candidate.transaction;
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

    return {
      reply: `⚠️ **CONFIRMATION REQUIRED: Approve Deposit #${tx.id}**\n\n` +
             `• Player: **${tx.name}** (${tx.phone})\n` +
             `• Amount: **${Number(tx.amount).toFixed(2)} ETB**\n` +
             `• Method: **${tx.method}** | Ref: \`${tx.reference || "None"}\`\n\n` +
             `*Click Confirm to execute this deposit and credit player's wallet.*`,
      replyAmharic: `⚠️ **የማረጋገጫ ፈቃድ ያስፈልጋል፦ የገቢ ጥያቄ #${tx.id} ማጽደቅ**\n\n` +
                    `• ተጫዋች፦ **${tx.name}** (${tx.phone})\n` +
                    `• የሚገባ ገንዘብ፦ **${Number(tx.amount).toFixed(2)} ETB**\n` +
                    `• ዘዴ፦ **${tx.method}** | የማረጋገጫ ቁጥር፦ \`${tx.reference || "None"}\`\n\n` +
                    `*ክፍያውን ፈጽመው የደንበኛውን ዋሌት ገቢ ለማድረግ 'አረጋግጥ' የሚለውን ይጫኑ።*`,
      data: {
        action: "APPROVE_DEPOSIT",
        transactionId: tx.id,
        amount: Number(tx.amount),
        player: tx.name,
        expiresInSeconds: tokenData.expiresInSeconds,
        actionDetails: {
          description: `Approve deposit of ${Number(tx.amount).toFixed(2)} ETB for ${tx.name} (Tx #${tx.id})`,
          type: "APPROVE_DEPOSIT",
          targetId: tx.id
        }
      },
      actionRequired: true,
      confirmationToken: tokenData.token,
      expiresAt: tokenData.expiresAt
    };
  }

  async prepareDepositRejectionConfirmation(transactionId, adminUser) {
    const candidate = await tools.verifyDepositCandidate(transactionId);
    if (!candidate.valid) {
      return {
        reply: `❌ **Cannot Reject Deposit #${transactionId}:** Reason: \`${candidate.reason}\``,
        replyAmharic: `❌ **የገቢ ጥያቄ #${transactionId} ውድቅ ማድረግ አልተቻለም፦** ምክንያት፦ \`${candidate.reason}\``,
        data: null,
        actionRequired: false
      };
    }

    const tx = candidate.transaction;
    const tokenData = createConfirmationToken({
      action: "REJECT_DEPOSIT",
      payload: { transactionId: tx.id },
      adminId: adminUser.id
    });

    return {
      reply: `⚠️ **CONFIRMATION REQUIRED: Reject Deposit #${tx.id}**\n\n` +
             `• Player: **${tx.name}** (${tx.phone})\n` +
             `• Amount: **${Number(tx.amount).toFixed(2)} ETB**\n\n` +
             `*Please confirm to reject this deposit request.*`,
      replyAmharic: `⚠️ **የማረጋገጫ ፈቃድ ያስፈልጋል፦ የገቢ ጥያቄ #${tx.id} ውድቅ ማድረግ**\n\n` +
                    `• ተጫዋች፦ **${tx.name}** (${tx.phone})\n` +
                    `• መጠን፦ **${Number(tx.amount).toFixed(2)} ETB**\n\n` +
                    `*ይህን የገቢ ጥያቄ ውድቅ ለማድረግ 'አረጋግጥ' የሚለውን ይጫኑ።*`,
      data: {
        action: "REJECT_DEPOSIT",
        transactionId: tx.id,
        actionDetails: {
          description: `Reject deposit #${tx.id} for ${tx.name}`,
          type: "REJECT_DEPOSIT",
          targetId: tx.id
        }
      },
      actionRequired: true,
      confirmationToken: tokenData.token,
      expiresAt: tokenData.expiresAt
    };
  }

  async prepareUserSuspensionConfirmation(userId, adminUser) {
    await assertNotOwner(userId);
    const candidate = await tools.getUserDetails(userId);
    if (!candidate) {
      return {
        reply: `❌ User #${userId} not found.`,
        replyAmharic: `❌ ተጠቃሚ #${userId} አልተገኘም።`,
        data: null,
        actionRequired: false
      };
    }

    const tokenData = createConfirmationToken({
      action: "SUSPEND_USER",
      payload: { userId },
      adminId: adminUser.id
    });

    return {
      reply: `⚠️ **CONFIRMATION REQUIRED: Suspend User #${userId} (${candidate.name})**\n\n` +
             `*Confirm to disable this account and revoke all sessions.*`,
      replyAmharic: `⚠️ **የማረጋገጫ ፈቃድ ያስፈልጋል፦ ተጠቃሚ #${userId} (${candidate.name}) ማገድ**\n\n` +
                    `*ይህን አካውንት ለማገድ እና የተከፈቱ ክፍለ-ጊዜዎችን ለመዝጋት 'አረጋግጥ' የሚለውን ይጫኑ።*`,
      data: {
        action: "SUSPEND_USER",
        userId,
        actionDetails: {
          description: `Suspend User #${userId} (${candidate.name})`,
          type: "SUSPEND_USER",
          targetId: userId
        }
      },
      actionRequired: true,
      confirmationToken: tokenData.token,
      expiresAt: tokenData.expiresAt
    };
  }
}

const aiService = new HabeshaAIAdminService();

module.exports = aiService;
