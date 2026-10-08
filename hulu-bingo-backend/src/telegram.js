const crypto = require("crypto");
const jwt = require("jsonwebtoken");

class TelegramBingoService {
  constructor(options = {}) {
    this.pool = options.pool;
    this.io = options.io;
    this.token = process.env.TELEGRAM_BOT_TOKEN || "";
    this.botUsername = process.env.TELEGRAM_BOT_USERNAME || "HbeshabingoBot";
    this.groupTitle = process.env.TELEGRAM_GROUP_TITLE || "Hbesha bingo";
    this.groupId = process.env.TELEGRAM_GROUP_ID ? Number(process.env.TELEGRAM_GROUP_ID) : null;
    this.polling = false;
    this.pollingTimeout = null;
    this.lastUpdateId = 0;
    this.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");
    this.baseUrl = "https://api.telegram.org";
    this.botInfo = null;
    this.isSyncEnabled = true;
    this.userState = new Map();
    this.gameEngine = null;
  }

  setGameEngine(engine) {
    this.gameEngine = engine;
  }

  async createSessionForUser(user) {
    if (!user || !user.id || !this.pool) return null;
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    try {
      const jti = crypto.randomUUID();
      const token = jwt.sign(
        { id: user.id, name: user.name, phone: user.phone, role: String(user.role || "PLAYER").toUpperCase() },
        secret,
        { expiresIn: "7d", jwtid: jti }
      );
      const hash = crypto.createHash("sha256").update(String(jti)).digest("hex");
      await this.pool.query(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '7 days')",
        [user.id, hash]
      );
      return token;
    } catch (e) {
      console.warn("[Telegram] Could not create session for user:", e.message);
      return null;
    }
  }

  async getWebAppUrl(user, view = "") {
    let baseUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    baseUrl = baseUrl.replace(/\/$/, "");
    const params = [];
    if (user && user.id) {
      const token = await this.createSessionForUser(user);
      if (token) params.push(`auth_token=${encodeURIComponent(token)}`);
      params.push(`tg_user=${user.id}`);
    }
    if (view) params.push(`view=${encodeURIComponent(view)}`);
    return params.length > 0 ? `${baseUrl}?${params.join("&")}` : baseUrl;
  }

  async init() {
    // Try to load persisted telegram settings from app_settings
    try {
      const rows = (await this.pool.query(
        "SELECT key, value FROM app_settings WHERE key LIKE 'telegram_%'"
      )).rows;
      for (const row of rows) {
        if (row.key === "telegram_bot_token" && row.value) this.token = row.value;
        if (row.key === "telegram_group_id" && row.value) this.groupId = Number(row.value);
        if (row.key === "telegram_group_title" && row.value) this.groupTitle = row.value;
        if (row.key === "telegram_sync_enabled") this.isSyncEnabled = row.value === "true";
      }
    } catch (e) {
      console.warn("[Telegram] Could not read app_settings for telegram config:", e.message);
    }

    if (!this.token) {
      console.log("[Telegram] TELEGRAM_BOT_TOKEN is not configured yet. Bot is standing by in setup mode.");
      return;
    }

    try {
      const me = await this.apiCall("getMe");
      if (me && me.ok) {
        this.botInfo = me.result;
        this.botUsername = me.result.username || this.botUsername;
        console.log(`[Telegram] Successfully connected as @${this.botUsername} (${me.result.first_name})`);

        // Configure full set of Telegram bot commands
        try {
          await this.apiCall("setMyCommands", {
            commands: [
              { command: "start", description: "🎮 ጨዋታ ጀምር / START HULU BINGO" },
              { command: "deposit", description: "📥 ገቢ አድርግ (ዋና ከ10 ብር / VIP ከ50 ብር)" },
              { command: "withdraw", description: "📤 ወጪ አድርግ / Withdraw Funds" },
              { command: "balance", description: "💰 ቀሪ ሂሳብ / Wallet Balance" },
              { command: "play", description: "🎟 ዋና ጨዋታ ተጫወት (8 ETB)" },
              { command: "vip", description: "💎 VIP ክፍል ግባ (50 ETB)" },
              { command: "status", description: "📊 የቀጥታ ጨዋታ ሁኔታ" },
              { command: "card", description: "🎴 የቢንጎ ካርድዎን ይመልከቱ" },
              { command: "bingo", description: "🏆 ቢንጎ አሸንፍ / Claim Bingo!" },
              { command: "rules", description: "📜 የጨዋታ ህጎችና ደንቦች" },
              { command: "support", description: "🆘 የደንበኞች ድጋፍ / Contact Support" },
              { command: "language", description: "🌐 ቋንቋ ቀይር / Change Language" }
            ]
          });
          console.log("[Telegram] Full bot commands registered successfully");
        } catch (cErr) {
          console.warn("[Telegram] Could not set bot commands:", cErr.message);
        }

        // Configure Telegram Chat Menu Button as commands popup [ ✕ Menu ]
        try {
          await this.apiCall("setChatMenuButton", {
            menu_button: {
              type: "commands"
            }
          });
          console.log("[Telegram] Chat menu button configured as 'commands'");
        } catch (mErr) {
          console.warn("[Telegram] Could not set chat menu button:", mErr.message);
        }

        // Start long-polling if webhook is not set
        const webhookInfo = await this.apiCall("getWebhookInfo");
        if (!webhookInfo?.result?.url) {
          this.startPolling();
        } else {
          console.log(`[Telegram] Webhook is active at: ${webhookInfo.result.url}`);
        }
      } else {
        console.warn("[Telegram] getMe returned error:", me);
      }
    } catch (e) {
      console.error("[Telegram] Init error:", e.message);
    }
  }

  async apiCall(method, body = {}) {
    if (!this.token) {
      throw new Error("Telegram Bot Token is not configured.");
    }
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  }

  async sendMessage(chatId, text, extra = {}) {
    if (!chatId) return null;
    try {
      return await this.apiCall("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...extra
      });
    } catch (e) {
      console.error(`[Telegram] Error sending message to ${chatId}:`, e.message);
      return null;
    }
  }

  async broadcastToGroup(text, extra = {}) {
    if (!this.isSyncEnabled) return null;
    if (!this.groupId) {
      console.log(`[Telegram] Broadcast skipped: Group ID for "${this.groupTitle}" not discovered yet.`);
      return null;
    }
    return await this.sendMessage(this.groupId, text, extra);
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    console.log(`[Telegram] Started polling for @${this.botUsername}...`);
    this.pollLoop();
  }

  stopPolling() {
    this.polling = false;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
    console.log("[Telegram] Stopped polling.");
  }

  async pollLoop() {
    if (!this.polling) return;
    try {
      const updates = await this.apiCall("getUpdates", {
        offset: this.lastUpdateId + 1,
        timeout: 20
      });
      if (updates && updates.ok && Array.isArray(updates.result)) {
        for (const update of updates.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      }
    } catch (e) {
      if (!e.message?.includes("timeout") && !e.message?.includes("fetch")) {
        console.warn("[Telegram] Polling warning:", e.message);
      }
    }
    if (this.polling) {
      this.pollingTimeout = setTimeout(() => this.pollLoop(), 1000);
    }
  }

  async handleUpdate(update) {
    try {
      // 0. Handle callback query from inline buttons
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
        return;
      }

      // Handle bot added to group or promoted
      const chatMember = update.my_chat_member || update.chat_member;
      if (chatMember && chatMember.chat && (chatMember.chat.type === "group" || chatMember.chat.type === "supergroup")) {
        const c = chatMember.chat;
        const title = c.title || this.groupTitle;
        this.groupId = c.id;
        this.groupTitle = title;
        console.log(`[Telegram] 🎯 Bot membership updated in group "${title}" (ID: ${c.id})!`);
        await this.pool.query(
          "INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_group_id', $1, now()), ('telegram_group_title', $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
          [String(c.id), title]
        );
        await this.sendMessage(
          c.id,
          `🎮 <b>HABESHA BINGO ወደ "${title}" ተገናኝቷል!</b>\n\nየቢንጎ ጨዋታው ከድረ-ገጹ ጋር በቀጥታ ተቀናጅቷል። ቁጥሮች፣ አሸናፊዎች እና ትኬቶች እዚህ በቅጽበት ይዘመናሉ!\n\nለመጀመር <b>/help</b> ወይም <b>/play</b> ይጫኑ።`
        );
        return;
      }

      const message = update.message || update.edited_message || update.channel_post;
      if (!message) return;

      const chat = message.chat;
      const from = message.from;
      const text = (message.text || "").trim();

      // Group auto-discovery
      if (chat && (chat.type === "group" || chat.type === "supergroup")) {
        const title = chat.title || "";
        const shouldLink = !this.groupId ||
          title.toLowerCase().includes("hbesha") ||
          title.toLowerCase().includes("habesha") ||
          title.toLowerCase() === this.groupTitle.toLowerCase() ||
          text.startsWith("/setgroup") ||
          text.startsWith("/connect") ||
          text.startsWith("/start");

        if (shouldLink && (!this.groupId || this.groupId !== chat.id)) {
          this.groupId = chat.id;
          this.groupTitle = title || this.groupTitle;
          console.log(`[Telegram] 🎯 Successfully linked group "${this.groupTitle}" (ID: ${chat.id}) to HABESHA BINGO!`);
          await this.pool.query(
            "INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_group_id', $1, now()), ('telegram_group_title', $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            [String(chat.id), this.groupTitle]
          );
          await this.sendMessage(
            chat.id,
            `🎮 <b>HABESHA BINGO ወደ "${this.groupTitle}" ተገናኝቷል!</b>\n\nየቢንጎ ጨዋታው ከድረ-ገጹ ጋር በቀጥታ ተቀናጅቷል።\n\nመመሪያዎችን ለማየት <b>/help</b> ይጫኑ።`
          );
        }
      }

      // Route commands or text
      if (text.startsWith("/")) {
        await this.handleCommand(message);
      } else if (text) {
        await this.handleTextMessage(message);
      }
    } catch (e) {
      console.error("[Telegram] Error handling update:", e);
    }
  }

  // ==================== CALLBACK QUERIES ====================
  async handleCallbackQuery(cq) {
    const data = cq.data || "";
    const chatId = cq.message?.chat?.id;
    const from = cq.from;

    try {
      await this.apiCall("answerCallbackQuery", { callback_query_id: cq.id });
    } catch (e) {}

    if (!chatId) return;

    let user = await this.getOrCreateTelegramUser(from);

    if (data === "cmd_deposit") {
      await this.cmdDepositStep1(chatId, user);
    } else if (data.startsWith("dep_target:")) {
      const targetKey = data.split(":")[1];
      const target = targetKey === "vip" ? "💎 VIP ክፍል" : "🎮 ዋና ጨዋታ";
      await this.cmdDepositStep2_Amount(chatId, target);
    } else if (data.startsWith("dep_amt:")) {
      const amtStr = data.split(":")[1];
      const currentState = this.userState.get(chatId) || {};
      const target = currentState.target || "🎮 ዋና ጨዋታ";
      const isVip = target.includes("VIP");
      const minDeposit = isVip ? 50 : 10;

      if (amtStr === "custom") {
        this.userState.set(chatId, { step: "deposit_amount", target });
        await this.sendMessage(
          chatId,
          `💸 <b>የገቢ መጠን ያስገቡ (Deposit Amount)</b>\n🎯 Target: <b>${target}</b>\n💡 <i>ዝቅተኛው መጠን: <b>${minDeposit} ETB</b></i>\n\nእባክዎን ማስገባት የሚፈልጉትን የብር መጠን እዚህ ጽፈው ይላኩ (ለምሳሌ፡ ${isVip ? 150 : 35}):`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]]
            }
          }
        );
      } else {
        const amount = Number(amtStr) || minDeposit;
        await this.cmdDepositStep3_Method(chatId, target, amount);
      }
    } else if (data.startsWith("dep_method:")) {
      const methodKey = data.split(":")[1];
      const methodMap = {
        telebirr: "TeleBirr",
        cbe: "CBE Birr",
        mpesa: "MPesa",
        ebirr: "E-Birr"
      };
      const method = methodMap[methodKey] || "TeleBirr";
      await this.cmdDepositStep4_Instruction(chatId, user, method);
    } else if (data === "dep_confirm") {
      await this.sendMessage(chatId, `📲 <b>የግብይት ቁጥር (Txn ID) ያስገቡ</b>\n\nከባንክ የደረሰዎትን የክፍያ ማረጋገጫ ቁጥር (Txn ID) ወይም ሙሉውን SMS እዚህ መልሰው ይላኩ/ይለጥፉ:`, {
        reply_markup: {
          inline_keyboard: [[{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]]
        }
      });
    } else if (data === "cmd_withdraw") {
      await this.cmdWithdrawStep1(chatId, user);
    } else if (data.startsWith("with_method:")) {
      const methodKey = data.split(":")[1];
      const method = methodKey === "cbe" ? "CBE Birr" : "TeleBirr";
      await this.cmdWithdrawStep2_Amount(chatId, user, method);
    } else if (data.startsWith("with_amt:")) {
      const amtStr = data.split(":")[1];
      const currentState = this.userState.get(chatId) || {};
      const method = currentState.withdrawMethod || "TeleBirr";
      const balRow = (await this.pool.query("SELECT main_balance FROM wallets WHERE user_id = $1", [user?.id || 0])).rows[0];
      const balance = Number(balRow?.main_balance || 0);

      if (amtStr === "custom") {
        this.userState.set(chatId, { step: "withdraw_amount", withdrawMethod: method });
        await this.sendMessage(chatId, `📤 <b>የማውጫ መጠን ያስገቡ</b>\n💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n\nማውጣት የሚፈልጉትን የብር መጠን እዚህ ጽፈው ይላኩ (ቢያንስ 100 ETB):`, {
          reply_markup: {
            inline_keyboard: [[{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]]
          }
        });
      } else {
        let amount = amtStr === "all" ? Math.floor(balance) : Number(amtStr);
        if (amount < 100) amount = 100;
        await this.cmdWithdrawStep3_AccountPrompt(chatId, user, method, amount);
      }
    } else if (data === "cmd_balance") {
      await this.cmdBalance(chatId, user);
    } else if (data === "cmd_play") {
      await this.cmdJoinOrPlayPrompt(chatId, user);
    } else if (data === "cmd_buy") {
      await this.cmdJoinGame(chatId, user);
    } else if (data === "cmd_buy_vip") {
      await this.cmdJoinVipGame(chatId, user);
    } else if (data === "cmd_transfer_vip") {
      await this.cmdTransferMainToVip(chatId, user);
    } else if (data === "cmd_status") {
      await this.cmdGameStatus(chatId);
    } else if (data === "cmd_card") {
      await this.cmdMyCard(chatId, user);
    } else if (data === "cmd_vip") {
      await this.cmdVIPRoom(chatId, user);
    } else if (data === "cmd_support") {
      await this.cmdSupport(chatId);
    } else if (data === "cmd_referral") {
      await this.cmdReferralInfo(chatId, user);
    } else if (data === "cmd_promoter") {
      await this.cmdPromoterInfo(chatId, user);
    } else if (data === "cmd_language") {
      await this.cmdLanguage(chatId, user);
    } else if (data === "cmd_rules") {
      await this.cmdRules(chatId);
    } else if (data === "cmd_cancel") {
      await this.cmdCancel(chatId);
    } else if (data === "lang_am") {
      await this.sendMessage(chatId, "✅ <b>ቋንቋ ወደ አማርኛ ተቀይሯል!</b>", { reply_markup: this.getMainKeyboard() });
    } else if (data === "lang_en") {
      await this.sendMessage(chatId, "✅ <b>Language set to English!</b>", { reply_markup: this.getMainKeyboard() });
    }
  }

  // ==================== COMMAND ROUTER ====================
  async handleCommand(msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const parts = (msg.text || "").split(/\s+/);
    const rawCmd = parts[0].toLowerCase().split("@")[0];

    let user = await this.getOrCreateTelegramUser(from);

    switch (rawCmd) {
      case "/start":
        await this.cmdStart(chatId, from, user, isGroup);
        break;
      case "/deposit":
        await this.cmdDepositStep1(chatId, user);
        break;
      case "/withdraw":
        await this.cmdWithdrawStep1(chatId, user);
        break;
      case "/balance":
      case "/wallet":
        await this.cmdBalance(chatId, user);
        break;
      case "/play":
      case "/join":
        await this.cmdJoinOrPlayPrompt(chatId, user);
        break;
      case "/buy":
        await this.cmdJoinGame(chatId, user);
        break;
      case "/vip":
        await this.cmdVIPRoom(chatId, user);
        break;
      case "/buy_vip":
        await this.cmdJoinVipGame(chatId, user);
        break;
      case "/card":
      case "/ticket":
        await this.cmdMyCard(chatId, user);
        break;
      case "/game":
      case "/status":
        await this.cmdGameStatus(chatId);
        break;
      case "/bingo":
      case "/claim":
        await this.cmdClaimBingo(chatId, user);
        break;
      case "/support":
      case "/contact":
        await this.cmdSupport(chatId);
        break;
      case "/rules":
      case "/rule":
        await this.cmdRules(chatId);
        break;
      case "/language":
      case "/lang":
        await this.cmdLanguage(chatId, user);
        break;
      case "/referral":
      case "/invite":
        await this.cmdReferralInfo(chatId, user);
        break;
      case "/promoter":
        await this.cmdPromoterInfo(chatId, user);
        break;
      case "/help":
        await this.cmdHelp(chatId, isGroup);
        break;
      case "/cancel":
        await this.cmdCancel(chatId);
        break;
      case "/link":
        await this.cmdLinkAccount(chatId, user, parts[1], parts[2]);
        break;
      default:
        break;
    }
  }

  // ==================== PERSISTENT KEYBOARD ====================
  getMainKeyboard(customUrl) {
    const webAppUrl = customUrl || process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    return {
      keyboard: [
        [{ text: "🎮 ጨዋታውን ይክፈቱ (Play)", web_app: { url: webAppUrl } }],
        [{ text: "💰 ሂሳብ" }, { text: "📥 ገቢ ለማድረግ" }],
        [{ text: "📤 ወጪ ለማድረግ" }, { text: "💎 VIP ክፍል" }],
        [{ text: "🎟 ትኬት ቁረጥ (8 ETB)" }, { text: "📊 የጨዋታ ሁኔታ" }],
        [{ text: "🔗 ጋብዝ & አግኝ" }, { text: "⭐ Special Promoter" }],
        [{ text: "🆘 እርዳታ" }, { text: "📜 ደንቦች" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    };
  }

  // ==================== START FLOW ====================
  async cmdStart(chatId, from, user, isGroup) {
    let mainBal = 0;
    let vipBal = 0;
    try {
      if (user?.id) {
        const balRow = (await this.pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
        mainBal = Number(balRow?.main_balance ?? 0);
        vipBal = Number(balRow?.vip_balance ?? 0);
      }
    } catch (e) {
      mainBal = Number(user?.main_balance || 0);
      vipBal = Number(user?.vip_balance || 0);
    }

    const userName = user ? user.name : (from.first_name || "ተጫዋች");
    const playUrl = await this.getWebAppUrl(user);

    // If zero balance, emphasize Deposit as the first step!
    if (mainBal <= 0 && vipBal <= 0) {
      const text = `🎉 <b>እንኳን ወደ ሀበሻ ቢንጎ (HABESHA BINGO) በደህና መጡ!</b>\n\n` +
        `👤 ተጫዋች: <b>${userName}</b>\n` +
        `💰 ዋና ሂሳብ: <b>0.00 ETB</b>\n` +
        `💎 VIP ሂሳብ: <b>0.00 ETB</b>\n\n` +
        `⚠️ <b>ጨዋታ ከመጀመርዎ በፊት እባክዎ መጀመሪያ ሂሳብዎን ይሙሉ (Deposit ያድርጉ)!</b>\n\n` +
        `🎮 <b>ዋናው ጨዋታ (Main Game):</b> ከ <b>10 ብር ጀምሮ</b>\n` +
        `💎 <b>VIP ክፍል (VIP Room):</b> ከ <b>50 ብር ጀምሮ</b>\n\n` +
        `በ TeleBirr፣ CBE Birr፣ MPesa ወይም E-Birr በቀላሉ ገቢ ማድረግ ይችላሉ።\n` +
        `ለመጀመር ከታች ያለውን <b>"📥 ሂሳብ ገቢ አድርግ (Deposit)"</b> ይጫኑ:`;

      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📥 ሂሳብ ገቢ አድርግ (Deposit Fund)", callback_data: "cmd_deposit" }],
            [{ text: "🎮 ጨዋታውን በ WebApp ክፈት", web_app: { url: playUrl } }],
            [
              { text: "💎 VIP ክፍል (VIP Room)", callback_data: "cmd_vip" },
              { text: "🆘 እርዳታ (Support)", callback_data: "cmd_support" }
            ]
          ]
        }
      });
    } else {
      const text = `🎉 <b>እንኳን ወደ ሀበሻ ቢንጎ (HABESHA BINGO) በደህና መጡ!</b>\n\n` +
        `👤 ተጫዋች: <b>${userName}</b>\n` +
        `💰 ዋና ሂሳብ: <b>${mainBal.toFixed(2)} ETB</b>\n` +
        `💎 VIP ሂሳብ: <b>${vipBal.toFixed(2)} ETB</b>\n\n` +
        `✅ <b>ሂሳብዎ ዝግጁ ነው!</b> አሁኑኑ መጫወት ይችላሉ፡\n` +
        `🎮 ዋናው ጨዋታ: <b>8 ETB</b>\n` +
        `💎 VIP ክፍል: <b>50 ETB</b>\n\n` +
        `ከታች ካሉት አማራጮች ይምረጡ:`;

      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎮 ጨዋታውን ጀምር (Start Playing)", web_app: { url: playUrl } }],
            [
              { text: "🎟 እዚሁ ትኬት ቁረጥ (8 ETB)", callback_data: "cmd_buy" },
              { text: "💎 VIP ክፍል (50 ETB)", callback_data: "cmd_vip" }
            ],
            [
              { text: "📥 ተጨማሪ ገቢ (Deposit)", callback_data: "cmd_deposit" },
              { text: "📤 ወጪ አድርግ (Withdraw)", callback_data: "cmd_withdraw" }
            ],
            [
              { text: "📊 የጨዋታ ሁኔታ (Status)", callback_data: "cmd_status" },
              { text: "🆘 እርዳታ (Support)", callback_data: "cmd_support" }
            ]
          ]
        }
      });
    }

    if (!isGroup) {
      await this.sendMessage(chatId, `📋 ከታች ባለው ሜኑ አማራጮችን በማንኛውም ሰዓት መጠቀም ይችላሉ:`, {
        reply_markup: this.getMainKeyboard(playUrl)
      });
    }
  }

  // ==================== DEPOSIT FLOW ====================
  // Step 1: Select Game (Main from 10 ETB, VIP from 50 ETB)
  async cmdDepositStep1(chatId, user) {
    this.userState.set(chatId, { step: "deposit_target" });
    const text = `📥 <b>ገንዘብ ማስገቢያ (Deposit Funds)</b>\n\n` +
      `እባክዎ ገቢ ማድረግ የሚፈልጉበትን የጨዋታ አይነት ይምረጡ:\n\n` +
      `🎮 <b>ዋናው ጨዋታ (Main Game):</b> ከ <b>10 ብር ጀምሮ</b>\n` +
      `💎 <b>VIP ክፍል (VIP Room):</b> ከ <b>50 ብር ጀምሮ</b>`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎮 ዋና ጨዋታ (ከ 10 ብር ጀምሮ)", callback_data: "dep_target:main" },
            { text: "💎 VIP ክፍል (ከ 50 ብር ጀምሮ)", callback_data: "dep_target:vip" }
          ],
          [{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  // Step 2: Select Amount
  async cmdDepositStep2_Amount(chatId, target = "🎮 ዋና ጨዋታ") {
    this.userState.set(chatId, { step: "deposit_amount", target });
    const isVip = target.includes("VIP");

    let text = "";
    let buttons = [];

    if (isVip) {
      text = `💸 <b>የ VIP ገቢ መጠን ይምረጡ (VIP Deposit)</b>\n` +
        `🎯 Target: <b>${target}</b>\n` +
        `💡 <i>ዝቅተኛው የ VIP ማስገቢያ: <b>50 ETB</b></i>\n\n` +
        `እባክዎ ገቢ ማድረግ የሚፈልጉትን የብር መጠን ይምረጡ ወይም ጽፈው ይላኩ:`;
      buttons = [
        [
          { text: "50 ETB", callback_data: "dep_amt:50" },
          { text: "100 ETB", callback_data: "dep_amt:100" },
          { text: "200 ETB", callback_data: "dep_amt:200" }
        ],
        [
          { text: "500 ETB", callback_data: "dep_amt:500" },
          { text: "1000 ETB", callback_data: "dep_amt:1000" },
          { text: "2000 ETB", callback_data: "dep_amt:2000" }
        ],
        [
          { text: "✏️ ሌላ መጠን ጻፍ (Custom)", callback_data: "dep_amt:custom" }
        ],
        [
          { text: "⬅️ ተመለስ", callback_data: "cmd_deposit" },
          { text: "❌ አቋርጥ", callback_data: "cmd_cancel" }
        ]
      ];
    } else {
      text = `💸 <b>የገቢ መጠን ይምረጡ (Deposit Amount)</b>\n` +
        `🎯 Target: <b>${target}</b>\n` +
        `💡 <i>ዝቅተኛው ማስገቢያ: <b>10 ETB</b></i>\n\n` +
        `እባክዎ ገቢ ማድረግ የሚፈልጉትን የብር መጠን ይምረጡ ወይም ጽፈው ይላኩ:`;
      buttons = [
        [
          { text: "10 ETB", callback_data: "dep_amt:10" },
          { text: "20 ETB", callback_data: "dep_amt:20" },
          { text: "50 ETB", callback_data: "dep_amt:50" }
        ],
        [
          { text: "100 ETB", callback_data: "dep_amt:100" },
          { text: "200 ETB", callback_data: "dep_amt:200" },
          { text: "500 ETB", callback_data: "dep_amt:500" }
        ],
        [
          { text: "✏️ ሌላ መጠን ጻፍ (Custom)", callback_data: "dep_amt:custom" }
        ],
        [
          { text: "⬅️ ተመለስ", callback_data: "cmd_deposit" },
          { text: "❌ አቋርጥ", callback_data: "cmd_cancel" }
        ]
      ];
    }

    await this.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // Step 3: Payment Method
  async cmdDepositStep3_Method(chatId, target = "🎮 ዋና ጨዋታ", amount = 10) {
    this.userState.set(chatId, { step: "deposit_method", target, amount });
    const text = `💳 <b>የክፍያ ዘዴ ይምረጡ (Select Payment Method)</b>\n\n` +
      `💰 መጠን: <b>${amount} ETB</b>\n` +
      `🎯 Target: <b>${target}</b>\n\n` +
      `ገንዘብ ገቢ ለማድረግ የሚፈልጉትን የክፍያ አማራጭ ይምረጡ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📱 TeleBirr", callback_data: "dep_method:telebirr" },
            { text: "🏦 CBE Birr", callback_data: "dep_method:cbe" }
          ],
          [
            { text: "🟢 MPesa", callback_data: "dep_method:mpesa" },
            { text: "🟡 E-Birr", callback_data: "dep_method:ebirr" }
          ],
          [
            { text: "⬅️ መጠን ቀይር", callback_data: "dep_target:" + (target.includes("VIP") ? "vip" : "main") },
            { text: "❌ አቋርጥ", callback_data: "cmd_cancel" }
          ]
        ]
      }
    });
  }

  // Step 4: Transfer Instructions
  async cmdDepositStep4_Instruction(chatId, user, method = "TeleBirr") {
    const currentState = this.userState.get(chatId) || {};
    const target = currentState.target || "🎮 ዋና ጨዋታ";
    const amount = currentState.amount || 10;
    this.userState.set(chatId, { step: "deposit_confirm", target, method, amount });

    let receiverName = "Tirualem";
    let receiverPhone = "0951666750";

    if (method === "CBE Birr") {
      receiverName = "Abrham";
      receiverPhone = "0951666750";
    } else if (method === "MPesa") {
      receiverName = "Abrham";
      receiverPhone = "0726666750";
    } else if (method === "E-Birr") {
      receiverName = "Abdu";
      receiverPhone = "0919307468";
    }

    const text = `🔄 <b>የክፍያ መመሪያ (${method})</b>\n\n` +
      `1️⃣ <b>${amount} ETB</b> በ <b>${method}</b> ወደዚህ ቁጥር ይላኩ:\n` +
      `👉 <code>${receiverPhone}</code> (<b>${receiverName}</b>)\n\n` +
      `2️⃣ ክፍያውን ከፈጸሙ በኋላ ከባንክ የሚደርስዎትን <b>Txn ID</b> ኮፒ ያድርጉ።\n\n` +
      `3️⃣ የደረሰዎትን <b>Transaction ID</b> (ወይም ሙሉውን SMS) እዚህ ጋር ጽፈው ይላኩ/ይለጥፉ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ ከፍያለሁ / Txn ID አስገባ (Confirm)", callback_data: "dep_confirm" }],
          [{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  // Step 5: Complete Deposit & Record Transaction
  async cmdDepositComplete(chatId, user, inputMessage) {
    const currentState = this.userState.get(chatId) || {};
    const target = currentState.target || "🎮 ዋና ጨዋታ";
    const method = currentState.method || "TeleBirr";
    let amount = currentState.amount || 10;
    let txnId = "—";

    const trimmed = (inputMessage || "").trim();
    if (trimmed !== "1" && trimmed !== "dep_confirm") {
      const amtMatch = trimmed.match(/(?:ETB|Birr|ብር|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/i) ||
                       trimmed.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:ETB|Birr|ብር)/i);
      if (amtMatch) amount = Number(amtMatch[1]);

      const txnMatch = trimmed.match(/(?:Txn\s*ID|Transaction\s*ID|የግብይት\s*ቁጥር|ቁጥር|Txn|Ref)[:\s]*([A-Za-z0-9]+)/i);
      if (txnMatch) {
        txnId = txnMatch[1];
      } else if (trimmed.length <= 40 && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
        txnId = trimmed;
      } else {
        txnId = trimmed.slice(0, 30);
      }
    }

    const isDemo = process.env.DEMO_MODE !== "false";
    const isVip = target.includes("VIP");
    const walletType = isVip ? "vip" : "main";
    const wCol = isVip ? "vip_balance" : "main_balance";

    if (user && this.pool) {
      try {
        if (isDemo) {
          await this.pool.query(
            `UPDATE wallets SET ${wCol} = ${wCol} + $1, updated_at = now() WHERE user_id = $2`,
            [amount, user.id]
          );
        }
        await this.pool.query(
          `INSERT INTO transactions (user_id, type, wallet, amount, status, method, reference, provider, provider_reference, metadata)
           VALUES ($1, 'deposit', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            user.id,
            walletType,
            amount,
            isDemo ? "completed" : "pending",
            method,
            `Telegram Deposit (${method})`,
            method,
            txnId !== "—" && txnId !== "-" ? txnId : null,
            JSON.stringify({
              source: "telegram_bot",
              chat_id: chatId,
              target,
              raw_input: trimmed,
              demo: isDemo
            })
          ]
        );
      } catch (dbErr) {
        console.warn("[Telegram] Could not save deposit transaction:", dbErr.message);
      }
    }

    this.userState.delete(chatId);

    const playUrl = await this.getWebAppUrl(user);
    const confirmationText = isDemo
      ? `✅ <b>የገቢ ጥያቄዎ በተሳካ ሁኔታ ተጠናቋል!</b>\n\n` +
        `💰 መጠን: <b>${amount} ETB</b>\n` +
        `💳 ዘዴ: <b>${method}</b>\n` +
        `🔢 Txn ID: <b>${txnId}</b>\n` +
        `🎯 ዋሌት: <b>${isVip ? "💎 VIP ዋሌት" : "🎮 ዋና ዋሌት"}</b>\n\n` +
        `🎉 <b>ገንዘቡ ወደ ዋሌትዎ ገብቷል!</b> አሁኑኑ ጨዋታውን ለመጀመር ከታች ያለውን <b>"🎮 ጨዋታውን ጀምር (Start Playing)"</b> ይጫኑ!`
      : `✅ <b>የገቢ ጥያቄዎ በተሳካ ሁኔታ ተልኳል!</b>\n\n` +
        `💰 መጠን: <b>${amount} ETB</b>\n` +
        `💳 ዘዴ: <b>${method}</b>\n` +
        `🔢 Txn ID: <b>${txnId}</b>\n` +
        `🎯 ዋሌት: <b>${isVip ? "💎 VIP ዋሌት" : "🎮 ዋና ዋሌት"}</b>\n\n` +
        `⏳ <i>አድሚን ክፍያውን እንዳረጋገጠ በደቂቃዎች ውስጥ ወደ ሂሳብዎ ይገባል!</i>`;

    const nextButtons = isVip
      ? [
          [{ text: "💎 VIP ክፍል በ WebApp ክፈት", web_app: { url: `${playUrl}&view=vip` } }],
          [{ text: "🎟 የ VIP ትኬት ቁረጥ (50 ETB)", callback_data: "cmd_buy_vip" }],
          [{ text: "💰 ሂሳብ ይመልከቱ (Balance)", callback_data: "cmd_balance" }]
        ]
      : [
          [{ text: "🎮 ጨዋታውን ጀምር (Start Playing)", web_app: { url: playUrl } }],
          [{ text: "🎟 እዚሁ ዋና ትኬት ቁረጥ (8 ETB)", callback_data: "cmd_buy" }],
          [{ text: "💰 ሂሳብ ይመልከቱ (Balance)", callback_data: "cmd_balance" }]
        ];

    await this.sendMessage(chatId, confirmationText, {
      reply_markup: { inline_keyboard: nextButtons }
    });
  }

  // ==================== WITHDRAW FLOW ====================
  async cmdWithdrawStep1(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ እባክዎ መጀመሪያ /start በማድረግ አካውንትዎን ያግብሩ።");
      return;
    }

    let balance = 0;
    try {
      const balRow = (await this.pool.query("SELECT main_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
      balance = Number(balRow?.main_balance || 0);
    } catch (e) {
      balance = Number(user.main_balance || 0);
    }

    if (balance < 100) {
      const text = `📤 <b>ወጪ ለማድረግ (Withdraw)</b>\n\n` +
        `👤 ተጠቃሚ: <b>${user.name}</b>\n` +
        `💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n\n` +
        `⚠️ <b>ዝቅተኛው የማውጫ መጠን 100 ETB ነው።</b>\n` +
        `ያሸነፉትን ገንዘብ ወጪ ለማድረግ ቢያንስ 100 ETB ሊኖርዎት ይገባል።\n\n` +
        `ለመጫወት እና ለማሸነፍ ሂሳብዎን ይሙሉ:`;
      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📥 ሂሳብ ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" }],
            [{ text: "🎮 ጨዋታውን ይክፈቱ", callback_data: "cmd_play" }]
          ]
        }
      });
      return;
    }

    this.userState.set(chatId, { step: "withdraw_method", maxBalance: balance });
    const text = `📤 <b>ወጪ ለማድረግ (Withdraw Funds)</b>\n\n` +
      `👤 ተጠቃሚ: <b>${user.name}</b>\n` +
      `💰 ሊወጣ የሚችል ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n\n` +
      `ገንዘብዎ እንዲላክ የሚፈልጉበትን የክፍያ ዘዴ ይምረጡ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📱 TeleBirr", callback_data: "with_method:telebirr" },
            { text: "🏦 CBE Birr", callback_data: "with_method:cbe" }
          ],
          [{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  async cmdWithdrawStep2_Amount(chatId, user, method = "TeleBirr") {
    let balance = 0;
    try {
      const balRow = (await this.pool.query("SELECT main_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
      balance = Number(balRow?.main_balance || 0);
    } catch (e) {
      balance = Number(user.main_balance || 0);
    }

    this.userState.set(chatId, { step: "withdraw_amount", withdrawMethod: method, maxBalance: balance });
    const text = `💸 <b>የማውጫ መጠን ይምረጡ (Withdrawal Amount)</b>\n\n` +
      `💳 ዘዴ: <b>${method}</b>\n` +
      `💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n\n` +
      `ማውጣት የሚፈልጉትን የብር መጠን ይምረጡ ወይም ጽፈው ይላኩ:`;

    const buttons = [];
    const row1 = [{ text: "100 ETB", callback_data: "with_amt:100" }];
    if (balance >= 200) row1.push({ text: "200 ETB", callback_data: "with_amt:200" });
    if (balance >= 500) row1.push({ text: "500 ETB", callback_data: "with_amt:500" });
    buttons.push(row1);

    buttons.push([
      { text: `💰 ሙሉውን (${balance.toFixed(0)} ETB)`, callback_data: "with_amt:all" },
      { text: "✏️ ሌላ መጠን ጻፍ", callback_data: "with_amt:custom" }
    ]);
    buttons.push([
      { text: "⬅️ ተመለስ", callback_data: "cmd_withdraw" },
      { text: "❌ አቋርጥ", callback_data: "cmd_cancel" }
    ]);

    await this.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  async cmdWithdrawStep3_AccountPrompt(chatId, user, method = "TeleBirr", amount = 100) {
    this.userState.set(chatId, { step: "withdraw_account", withdrawMethod: method, withdrawAmount: amount });
    const text = `📱 <b>የተቀባይ መረጃ ያስገቡ</b>\n\n` +
      `💰 የወጣ መጠን: <b>${amount} ETB</b>\n` +
      `💳 ዘዴ: <b>${method}</b>\n\n` +
      `ገንዘቡ እንዲገባ የሚፈልጉትን የ <b>${method} ስልክ ወይም አካውንት ቁጥር</b> እዚህ ጽፈው ይላኩ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]]
      }
    });
  }

  async cmdWithdrawComplete(chatId, user, account) {
    const currentState = this.userState.get(chatId) || {};
    const method = currentState.withdrawMethod || "TeleBirr";
    const amount = Number(currentState.withdrawAmount) || 100;
    const cleanAccount = (account || "").trim();

    if (!cleanAccount || cleanAccount.length < 5) {
      await this.sendMessage(chatId, "⚠️ <b>ትክክለኛ የስልክ ወይም የአካውንት ቁጥር ያስገቡ:</b>", {
        reply_markup: { inline_keyboard: [[{ text: "❌ አቋርጥ", callback_data: "cmd_cancel" }]] }
      });
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const wRow = (await client.query("SELECT main_balance FROM wallets WHERE user_id=$1 FOR UPDATE", [user.id])).rows[0];
      const before = Number(wRow?.main_balance || 0);

      if (before < amount) {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, `❌ <b>ቀሪ ሂሳብዎ በቂ አይደለም!</b>\nየእርስዎ ሂሳብ: <b>${before.toFixed(2)} ETB</b>\nየጠየቁት መጠን: <b>${amount} ETB</b>`);
        this.userState.delete(chatId);
        return;
      }

      const after = Math.round((before - amount) * 100) / 100;
      await client.query("UPDATE wallets SET main_balance=$1, updated_at=now() WHERE user_id=$2", [after, user.id]);

      await client.query(
        `INSERT INTO transactions (user_id, type, wallet, amount, balance_before, balance_after, status, method, reference, provider)
         VALUES ($1, 'withdrawal', 'main', $2, $3, $4, 'pending', $5, $6, $7)`,
        [user.id, -amount, before, after, method, cleanAccount, method]
      );
      await client.query("COMMIT");

      this.userState.delete(chatId);

      const text = `✅ <b>የገንዘብ ማውጣት ጥያቄዎ በተሳካ ሁኔታ ተመዝግቧል!</b>\n\n` +
        `💰 የወጣ መጠን: <b>${amount} ETB</b>\n` +
        `💳 ዘዴ: <b>${method}</b>\n` +
        `📞 ተቀባይ ቁጥር: <b>${cleanAccount}</b>\n` +
        `💵 አዲሱ ቀሪ ሂሳብ: <b>${after.toFixed(2)} ETB</b>\n` +
        `📋 ሁኔታ: <b>በመጠባበቅ ላይ (Pending)</b>\n\n` +
        `⏳ <i>አድሚን ጥያቄውን አይቶ ገንዘቡን በ ${method} በደቂቃዎች ውስጥ ይልክልዎታል!</i>`;

      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 ቀሪ ሂሳብ (Balance)", callback_data: "cmd_balance" }],
            [{ text: "🎮 ጨዋታውን ይክፈቱ (Play)", callback_data: "cmd_play" }]
          ]
        }
      });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Telegram] Withdraw error:", e.message);
      await this.sendMessage(chatId, "⚠️ የገንዘብ ማውጣት ጥያቄውን ማከናወን አልተቻለም: " + e.message);
    } finally {
      client.release();
    }
  }

  // ==================== BALANCE ====================
  async cmdBalance(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ መጀመሪያ /start በማድረግ ይመዝገቡ።");
      return;
    }
    const bal = (await this.pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
    const mainBal = Number(bal?.main_balance || 0).toFixed(2);
    const vipBal = Number(bal?.vip_balance || 0).toFixed(2);

    const text = `💰 <b>የእርስዎ የዋሌት መረጃ (Wallet Information)</b>\n\n` +
      `👤 ተጠቃሚ: <b>${user.name}</b>\n` +
      `💵 <b>ዋና ሂሳብ (Main Game):</b> <b>${mainBal} ETB</b> (መነሻ 8 ETB)\n` +
      `💎 <b>VIP ሂሳብ (VIP Room):</b> <b>${vipBal} ETB</b> (መነሻ 50 ETB)\n\n` +
      `ምን ማድረግ ይፈልጋሉ?`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📥 ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" },
            { text: "📤 ወጪ አድርግ (Withdraw)", callback_data: "cmd_withdraw" }
          ],
          [
            { text: "🎟 ዋና ጨዋታ (8 ETB)", callback_data: "cmd_buy" },
            { text: "💎 VIP ክፍል (50 ETB)", callback_data: "cmd_vip" }
          ],
          [
            { text: "🔄 አድስ (Refresh)", callback_data: "cmd_balance" }
          ]
        ]
      }
    });
  }

  // ==================== MAIN GAME PROMPT & JOIN ====================
  async cmdJoinOrPlayPrompt(chatId, user) {
    const webAppUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    let balance = 0;
    try {
      const balRow = (await this.pool.query("SELECT main_balance FROM wallets WHERE user_id = $1", [user?.id || 0])).rows[0];
      balance = Number(balRow?.main_balance || 0);
    } catch (e) {
      balance = Number(user?.main_balance || 0);
    }

    if (balance < 10) {
      const text = `⚠️ <b>ጨዋታ ለመጀመር ቀሪ ሂሳብዎ ዝቅተኛ ነው!</b>\n\n` +
        `👤 ተጫዋች: <b>${user ? user.name : "ተጫዋች"}</b>\n` +
        `💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n` +
        `🎟 የመግቢያ ክፍያ: <b>10.00 ETB</b>\n\n` +
        `ትኬት ቆርጠው በሙሉ ዕድል ለመጫወት እባክዎ መጀመሪያ ሂሳብዎን ይሙሉ (Deposit ያድርጉ):`;
      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📥 አሁኑኑ Deposit አድርግ (10+ ETB)", callback_data: "dep_target:main" }],
            [{ text: "🎮 ጨዋታውን በ WebApp ክፈት", web_app: { url: webAppUrl } }]
          ]
        }
      });
      return;
    }

    const text = `🎉 <b>ሁሉ ቢንጎ ለመጫወት ዝግጁ ነዎት!</b>\n\n` +
      `👤 ተጫዋች: <b>${user ? user.name : "ተጫዋች"}</b>\n` +
      `💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n` +
      `🎟 የመግቢያ ክፍያ: <b>8.00 ETB</b>\n\n` +
      `በ WebApp ውብ ገፅታ ለመጫወት ከታች ያለውን ይጫኑ ወይም እዚሁ ትኬት ይቁረጡ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎮 በ WebApp ክፈት (Open Game)", web_app: { url: webAppUrl } }],
          [
            { text: "🎟 እዚሁ ዋና ትኬት ቁረጥ (8 ETB)", callback_data: "cmd_buy" },
            { text: "📊 የጨዋታ ሁኔታ (Status)", callback_data: "cmd_status" }
          ],
          [
            { text: "💎 VIP ክፍል (50 ETB)", callback_data: "cmd_vip" }
          ]
        ]
      }
    });
  }

  // Join Main Game (8 ETB)
  async cmdJoinGame(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ እባክዎ መጀመሪያ /start በማለት አካውንትዎን ያግብሩ።");
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [390711]);

      let g = (await client.query("SELECT * FROM games WHERE status IN ('waiting', 'running') AND entry <= 20 ORDER BY id DESC LIMIT 1 FOR UPDATE")).rows[0];
      if (!g) {
        const createGame = await client.query("INSERT INTO games(name, entry) VALUES('Main Game', 8.00) RETURNING *");
        g = createGame.rows[0];
      }

      if (g.status !== "waiting") {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "⚠️ ይህ ዙር አስቀድሞ ተጀምሯል! እባክዎ ጥቂት ሰከንዶች ቆይተው ቀጣዩ ዙር ሲጀምር ትኬት ይቁረጡ።");
        return;
      }

      // Check if user already joined
      const existingTicket = (await client.query("SELECT id FROM tickets WHERE game_id = $1 AND user_id = $2", [g.id, user.id])).rows[0];
      if (existingTicket) {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "ℹ️ አስቀድመው ለዚህ ጨዋታ ትኬት ቆርጠዋል! ካርድዎን ለማየት <b>/card</b> ይጫኑ።");
        return;
      }

      // Check balance
      const walletRow = (await client.query("SELECT main_balance FROM wallets WHERE user_id = $1 FOR UPDATE", [user.id])).rows[0];
      const entryFee = Number(g.entry || 8.00);
      if (!walletRow || Number(walletRow.main_balance) < entryFee) {
        await client.query("ROLLBACK");
        await this.sendMessage(
          chatId,
          `❌ <b>ቀሪ ሂሳብዎ በቂ አይደለም!</b>\nየመግቢያ ክፍያ: <b>${entryFee.toFixed(2)} ETB</b>\nየእርስዎ ሂሳብ: <b>${Number(walletRow?.main_balance || 0).toFixed(2)} ETB</b>\n\nእባክዎ መጀመሪያ ሂሳብዎን ይሙሉ:`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: "📥 ሂሳብ ገቢ አድርግ (Deposit)", callback_data: "dep_target:main" }]]
            }
          }
        );
        return;
      }

      // Deduct entry
      const newBal = Math.round((Number(walletRow.main_balance) - entryFee) * 100) / 100;
      await client.query("UPDATE wallets SET main_balance = $1, updated_at = now() WHERE user_id = $2", [newBal, user.id]);
      await client.query(
        "INSERT INTO transactions (user_id, type, wallet, amount, balance_before, balance_after, status, method, reference) VALUES ($1, 'game_entry', 'main', $2, $3, $4, 'completed', 'telegram', $5)",
        [user.id, -entryFee, Number(walletRow.main_balance), newBal, "Main Game #" + g.id]
      );

      // Generate authentic 75-ball standard ticket
      const ticketNumbers = this.generateRandomTicket();
      await client.query(
        "INSERT INTO tickets (game_id, user_id, numbers) VALUES ($1, $2, $3)",
        [g.id, user.id, JSON.stringify(ticketNumbers)]
      );

      // Count players & update prize pool
      const pCount = (await client.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id = $1", [g.id])).rows[0].count;
      const feePer = pCount >= 3 ? 2 : 0;
      const prizePool = pCount * (entryFee - feePer);

      if (pCount >= 1) {
        await client.query("UPDATE games SET status = 'running', prize_pool = $1, platform_fee = $2 WHERE id = $3", [prizePool, pCount * feePer, g.id]);
        g.status = "running";
      } else {
        await client.query("UPDATE games SET prize_pool = $1, platform_fee = $2 WHERE id = $3", [prizePool, pCount * feePer, g.id]);
      }

      await client.query("COMMIT");

      // Format card preview
      const cardGrid = this.formatCardGrid(ticketNumbers, []);

      await this.sendMessage(
        chatId,
        `🎟 <b>ትኬትዎ በተሳካ ሁኔታ ተቆርጧል!</b>\n\n` +
        `👤 ተጫዋች: <b>${user.name}</b>\n` +
        `🏷 ጨዋታ: <b>#${g.id} (Main Game)</b>\n` +
        `🎟 የመግቢያ ክፍያ: <b>${entryFee.toFixed(2)} ETB</b>\n` +
        `🏆 የሽልማት ፈንድ: <b>${prizePool.toFixed(2)} ETB</b>\n\n` +
        `<b>የእርስዎ 75-Ball የቢንጎ ካርድ:</b>\n<pre>${cardGrid}</pre>\n\n` +
        `ቁጥሮች በየ 5 ሰከንዱ ይወጣሉ። 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ ሲሞሉ ወዲያውኑ <b>/bingo</b> ይበሉ!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏆 BINGO! (አሸንፌያለሁ)", callback_data: "cmd_claim" }],
              [{ text: "🎴 ካርድ አድስ (My Card)", callback_data: "cmd_card" }],
              [{ text: "📊 የጨዋታ ሁኔታ", callback_data: "cmd_status" }]
            ]
          }
        }
      );

      if (this.io) {
        this.io.to("game:" + g.id).emit("update", {
          ...g,
          players: pCount,
          prize_pool: prizePool
        });
      }

      if (!chatId.toString().includes("-")) {
        await this.broadcastToGroup(`🎟 አዲስ ተጫዋች <b>${user.name}</b> ጨዋታ #${g.id}ን ተቀላቅሏል! (ተጫዋቾች: ${pCount})`);
      }

    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Telegram] Join error:", e);
      await this.sendMessage(chatId, "⚠️ ጨዋታውን መቀላቀል አልተቻለም: " + e.message);
    } finally {
      client.release();
    }
  }

  // ==================== VIP ROOM (50 ETB) ====================
  async cmdVIPRoom(chatId, user) {
    const webAppUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    let vipBalance = 0;
    let mainBalance = 0;
    try {
      const row = (await this.pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1", [user?.id || 0])).rows[0];
      vipBalance = Number(row?.vip_balance || 0);
      mainBalance = Number(row?.main_balance || 0);
    } catch (e) {}

    const text = `💎 <b>VIP ክፍል (VIP Bingo Room)</b>\n\n` +
      `🔥 <b>ከፍተኛ ዕድል • 50 ETB ውርድ • ከፍተኛ ሽልማት</b>\n` +
      `🎴 ለየት ያለ ፈጣን ጨዋታ ለልዩ VIP አባላት\n\n` +
      `💰 <b>የእርስዎ VIP ሂሳብ:</b> <b>${vipBalance.toFixed(2)} ETB</b>\n` +
      `💵 <b>የእርስዎ ዋና ሂሳብ:</b> <b>${mainBalance.toFixed(2)} ETB</b>\n\n` +
      `አሁኑኑ ይግቡ ወይም ሂሳብዎን ይሙሉ:`;

    const buttons = [];

    if (vipBalance >= 50) {
      buttons.push([{ text: "🎟 የ VIP ትኬት ቁረጥ (50 ETB)", callback_data: "cmd_buy_vip" }]);
    } else if (mainBalance >= 50) {
      buttons.push([{ text: "🔄 ከዋና ሂሳብ 50 ETB ወደ VIP አዛውር", callback_data: "cmd_transfer_vip" }]);
    }

    buttons.push([
      { text: "💎 VIP ክፍል በ WebApp ክፈት", web_app: { url: `${webAppUrl}?view=vip` } }
    ]);
    buttons.push([
      { text: "📥 ወደ VIP ሂሳብ አስገባ (Deposit 50+)", callback_data: "dep_target:vip" },
      { text: "⬅️ ተመለስ", callback_data: "cmd_cancel" }
    ]);

    await this.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // Transfer 50 ETB from Main to VIP
  async cmdTransferMainToVip(chatId, user) {
    if (!user) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id=$1 FOR UPDATE", [user.id])).rows[0];
      const main = Number(row?.main_balance || 0);
      const vip = Number(row?.vip_balance || 0);

      if (main < 50) {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, `⚠️ በዋና ዋሌትዎ ውስጥ በቂ ሂሳብ የለም (ዝቅተኛ 50 ETB ያስፈልጋል፤ የእርስዎ: ${main.toFixed(2)} ETB)። እባክዎ ገቢ ያድርጉ:`, {
          reply_markup: { inline_keyboard: [[{ text: "📥 ገቢ አድርግ (Deposit)", callback_data: "dep_target:vip" }]] }
        });
        return;
      }

      const newMain = Math.round((main - 50) * 100) / 100;
      const newVip = Math.round((vip + 50) * 100) / 100;

      await client.query("UPDATE wallets SET main_balance=$1, vip_balance=$2, updated_at=now() WHERE user_id=$3", [newMain, newVip, user.id]);
      await client.query("COMMIT");

      await this.sendMessage(
        chatId,
        `✅ <b>50 ETB ከዋና ሂሳብዎ ወደ VIP ሂሳብዎ በተሳካ ሁኔታ ተዛውሯል!</b>\n\n` +
        `💎 አዲሱ VIP ሂሳብ: <b>${newVip.toFixed(2)} ETB</b>\n` +
        `💵 አዲሱ ዋና ሂሳብ: <b>${newMain.toFixed(2)} ETB</b>\n\n` +
        `አሁን የ VIP ጨዋታውን መጫወት ይችላሉ:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎟 የ VIP ትኬት ቁረጥ (50 ETB)", callback_data: "cmd_buy_vip" }],
              [{ text: "💎 VIP ክፍል በ WebApp ክፈት", callback_data: "cmd_vip" }]
            ]
          }
        }
      );
    } catch (e) {
      await client.query("ROLLBACK");
      await this.sendMessage(chatId, "⚠️ ማዘዋወር አልተቻለም: " + e.message);
    } finally {
      client.release();
    }
  }

  // Join VIP Game (50 ETB)
  async cmdJoinVipGame(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ እባክዎ መጀመሪያ /start በማለት አካውንትዎን ያግብሩ።");
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [390712]);

      let g = (await client.query("SELECT * FROM games WHERE status IN ('waiting', 'running') AND entry >= 50 ORDER BY id DESC LIMIT 1 FOR UPDATE")).rows[0];
      if (!g) {
        const createGame = await client.query("INSERT INTO games(name, entry) VALUES('VIP Game', 50.00) RETURNING *");
        g = createGame.rows[0];
      }

      if (g.status !== "waiting") {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "⚠️ ይህ የ VIP ዙር አስቀድሞ ተጀምሯል! እባክዎ ቀጣዩ ዙር ሲጀምር ይጠብቁ።");
        return;
      }

      // Check if user already joined
      const existingTicket = (await client.query("SELECT id FROM tickets WHERE game_id = $1 AND user_id = $2", [g.id, user.id])).rows[0];
      if (existingTicket) {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "ℹ️ አስቀድመው ለዚህ VIP ጨዋታ ትኬት ቆርጠዋል! ካርድዎን ለማየት <b>/card</b> ይጫኑ።");
        return;
      }

      // Check balance: prefer VIP balance, fallback to main balance
      const walletRow = (await client.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1 FOR UPDATE", [user.id])).rows[0];
      const vipBal = Number(walletRow?.vip_balance || 0);
      const mainBal = Number(walletRow?.main_balance || 0);
      const entryFee = Number(g.entry || 50.00);

      let usedWallet = "vip";
      if (vipBal >= entryFee) {
        usedWallet = "vip";
        const newVip = Math.round((vipBal - entryFee) * 100) / 100;
        await client.query("UPDATE wallets SET vip_balance = $1, updated_at = now() WHERE user_id = $2", [newVip, user.id]);
      } else if (mainBal >= entryFee) {
        usedWallet = "main";
        const newMain = Math.round((mainBal - entryFee) * 100) / 100;
        await client.query("UPDATE wallets SET main_balance = $1, updated_at = now() WHERE user_id = $2", [newMain, user.id]);
      } else {
        await client.query("ROLLBACK");
        await this.sendMessage(
          chatId,
          `❌ <b>ቀሪ ሂሳብዎ በቂ አይደለም!</b>\nየ VIP መግቢያ ክፍያ: <b>50.00 ETB</b>\nየእርስዎ VIP ሂሳብ: <b>${vipBal.toFixed(2)} ETB</b>\nየእርስዎ ዋና ሂሳብ: <b>${mainBal.toFixed(2)} ETB</b>\n\nእባክዎ መጀመሪያ ገቢ ያድርጉ:`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: "📥 ወደ VIP ገቢ አድርግ (50+ ETB)", callback_data: "dep_target:vip" }]]
            }
          }
        );
        return;
      }

      await client.query(
        "INSERT INTO transactions (user_id, type, wallet, amount, status, method, reference) VALUES ($1, 'game_entry', $2, $3, 'completed', 'telegram', $4)",
        [user.id, usedWallet, -entryFee, "VIP Game #" + g.id]
      );

      // Generate authentic 75-ball standard ticket
      const ticketNumbers = this.generateRandomTicket();
      await client.query(
        "INSERT INTO tickets (game_id, user_id, numbers) VALUES ($1, $2, $3)",
        [g.id, user.id, JSON.stringify(ticketNumbers)]
      );

      const pCount = (await client.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id = $1", [g.id])).rows[0].count;
      const feePer = pCount > 3 ? 5 : 0;
      const prizePool = pCount * (entryFee - feePer);

      if (pCount >= 1) {
        await client.query("UPDATE games SET status = 'running', prize_pool = $1, platform_fee = $2 WHERE id = $3", [prizePool, pCount * feePer, g.id]);
        g.status = "running";
      } else {
        await client.query("UPDATE games SET prize_pool = $1, platform_fee = $2 WHERE id = $3", [prizePool, pCount * feePer, g.id]);
      }

      await client.query("COMMIT");

      const cardGrid = this.formatCardGrid(ticketNumbers, []);

      await this.sendMessage(
        chatId,
        `💎 <b>የ VIP ትኬትዎ በተሳካ ሁኔታ ተቆርጧል!</b>\n\n` +
        `👤 ተጫዋች: <b>${user.name}</b>\n` +
        `🏷 ጨዋታ: <b>#${g.id} (VIP Game)</b>\n` +
        `🎟 የመግቢያ ክፍያ: <b>${entryFee.toFixed(2)} ETB</b> (ከተቀነሰበት: ${usedWallet === "vip" ? "VIP ዋሌት" : "ዋና ዋሌት"})\n` +
        `🏆 የሽልማት ፈንድ: <b>${prizePool.toFixed(2)} ETB</b>\n\n` +
        `<b>የእርስዎ VIP ቢንጎ ካርድ:</b>\n<pre>${cardGrid}</pre>\n\n` +
        `መስመር ሲሞሉ ወዲያውኑ <b>/bingo</b> ይበሉ!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏆 BINGO! (አሸንፌያለሁ)", callback_data: "cmd_claim" }],
              [{ text: "🎴 ካርድ አድስ (My Card)", callback_data: "cmd_card" }],
              [{ text: "📊 የጨዋታ ሁኔታ", callback_data: "cmd_status" }]
            ]
          }
        }
      );

      if (this.io) {
        this.io.to("game:" + g.id).emit("update", {
          ...g,
          players: pCount,
          prize_pool: prizePool
        });
      }

      await this.broadcastToGroup(`💎 አዲስ ተጫዋች <b>${user.name}</b> VIP ጨዋታ #${g.id}ን ተቀላቅሏል! (ተጫዋቾች: ${pCount})`);

    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Telegram] Join VIP error:", e);
      await this.sendMessage(chatId, "⚠️ የ VIP ጨዋታውን መቀላቀል አልተቻለም: " + e.message);
    } finally {
      client.release();
    }
  }

  // ==================== REFERRAL & PROMOTER ====================
  async cmdReferralInfo(chatId, user) {
    const botUrl = `https://t.me/${this.botUsername}?start=ref_${user?.id || ""}`;
    const text = `🔗 <b>ጋብዝ & አግኝ (Refer & Earn)</b>\n\n` +
      `ጓደኞችዎን ይጋብዙና ተጨማሪ ገቢ ያግኙ!\n\n` +
      `የእርስዎ መጋበዣ ሊንክ:\n<code>${botUrl}</code>\n\n` +
      `ጓደኛዎ በዚህ ሊንክ ተመዝግቦ ሲጫወት ኮሚሽን ያገኛሉ!`;

    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(botUrl)}&text=${encodeURIComponent("በ ሀበሻ ቢንጎ (HABESHA BINGO) ተጫውተው በቅጽበት ያሸንፉ! በ 10 ብር ጀምረው አሁኑኑ ይቀላቀሉ!")}`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 ሊንኩን ለጓደኛ አጋራ (Share Link)", url: shareUrl }],
          [{ text: "⬅️ ተመለስ", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  async cmdPromoterInfo(chatId, user) {
    const text = `⭐ <b>Special Promoter ፕሮግራም</b>\n\n` +
      `የ Habesha Bingo ልዩ ፕሮሞተር በመሆን በየቀኑ ከፍተኛ ገቢ ማግኘት ይችላሉ!\n\n` +
      `📌 <b>ጥቅሞች:</b>\n` +
      `• ለሚያመጧቸው ተጫዋቾች በየጨዋታው ቋሚ ኮሚሽን\n` +
      `• ፈጣን የቀን ክፍያ በ TeleBirr ወይም CBE\n` +
      `• የተለየ የአድሚን እገዛ\n\n` +
      `ለበለጠ መረጃ እና ምዝገባ የአድሚን ስልክ: <b>0919307468</b> / <b>0951666750</b> ያነጋግሩ።`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🆘 አድሚን አነጋግር (Contact Admin)", callback_data: "cmd_support" }],
          [{ text: "⬅️ ተመለስ", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  // ==================== RULES & SUPPORT ====================
  async cmdRules(chatId) {
    const text = `📜 <b>የቢንጎ ጨዋታ ህጎች እና ደንቦች</b>\n\n` +
      `1️⃣ <b>የጨዋታ አይነቶች:</b>\n` +
      `• <b>ዋና ጨዋታ:</b> የመግቢያ ክፍያ 8 ETB\n` +
      `• <b>VIP ክፍል:</b> የመግቢያ ክፍያ 50 ETB\n\n` +
      `2️⃣ <b>የካርድ አወቃቀር:</b>\n` +
      `እያንዳንዱ ካርድ 5x5 የቢንጎ ሰንጠረዥ ይዞ B-I-N-G-O በሆኑ 5 ዓምዶች የተከፋፈሉ 25 ቁጥሮችን ይዟል።\n\n` +
      `3️⃣ <b>ቁጥሮች መጠራት:</b>\n` +
      `ሲስተሙ ከ 1 እስከ 75 ያሉ ቁጥሮችን በየ 5 ሰከንዱ በራስ-ሰር ይጠራል።\n\n` +
      `4️⃣ <b>አሸናፊነት (BINGO):</b>\n` +
      `በካርድዎ ላይ 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ የሞላ የመጀመሪያው ተጫዋች አሸናፊ ይሆናል። መስመር ሲሞላ ወዲያውኑ <b>/bingo</b> ይበሉ!\n\n` +
      `5️⃣ <b>ሽልማት:</b>\n` +
      `የተሸለሙት ገንዘብ በቀጥታ ወደ ዋሌትዎ ይገባል፤ ወዲያውኑ ወጪ ማድረግ ወይም መጫወት ይችላሉ።`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎟 ዋና ጨዋታ ጀምር (8 ETB)", callback_data: "cmd_buy" },
            { text: "💎 VIP ክፍል (50 ETB)", callback_data: "cmd_vip" }
          ],
          [{ text: "📥 ሂሳብ ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" }]
        ]
      }
    });
  }

  async cmdSupport(chatId) {
    this.userState.set(chatId, { step: "support" });
    const text = `🆘 <b>ሀበሻ ቢንጎ የደንበኞች ድጋፍ (Support)</b>\n\n` +
      `👤 <b>Admin 1:</b> adissu (<code>0919307468</code>)\n` +
      `👤 <b>Admin 2:</b> abirham (<code>0951666750</code>)\n\n` +
      `👇 <b>ወይም እዚሁ ይጻፉ:</b>\n` +
      `ጥያቄዎን ወይም አስተያየትዎን እዚህ ጽፈው ይላኩ፣ በቀጥታ ለአድሚን ይደርሳል።`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "መልእክትዎን እዚህ ይጻፉ..."
      }
    });
  }

  async cmdLanguage(chatId, user) {
    const text = `🌐 <b>Change Language / ቋንቋ ይምረጡ</b>\n\nእባክዎ የሚፈልጉትን ቋንቋ ይምረጡ / Please choose your language:`;
    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🇪🇹 አማርኛ (Amharic)", callback_data: "lang_am" },
            { text: "🇬🇧 English", callback_data: "lang_en" }
          ],
          [{ text: "⬅️ ተመለስ", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  async cmdHelp(chatId, isGroup) {
    const text = `ℹ️ <b>የ HABESHA BINGO ጨዋታ መመሪያዎች</b>\n\n` +
      `1️⃣ <b>ገንዘብ ማስገባት:</b> <b>/deposit</b> በማለት ለዋና ጨዋታ ከ 10 ብር ጀምሮ ወይም ለ VIP ከ 50 ብር ጀምሮ ይሙሉ!\n` +
      `2️⃣ <b>ትኬት መቁረጥ:</b> <b>/play</b> ወይም <b>/buy</b> ሲሉ ከሂሳብዎ 8 ETB ተቀንሶ 5x5 የቢንጎ ካርድ ይሰጥዎታል።\n` +
      `3️⃣ <b>VIP ክፍል:</b> <b>/vip</b> በማለት በ 50 ETB ከፍተኛ ሽልማት ባለው ክፍል ይጫወቱ!\n` +
      `4️⃣ <b>ቁጥሮች መጠራት:</b> ሲስተሙ በየ 5 ሰከንዱ አዳዲስ ቁጥሮችን ይጠራል፤ እዚህ ግሩፕ ላይ በቅጽበት ይለጠፋሉ።\n` +
      `5️⃣ <b>ቢንጎ ማሸነፍ:</b> በካርድዎ ላይ 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ ሲሞሉ ወዲያውኑ <b>/bingo</b> ይበሉ!\n` +
      `6️⃣ <b>ወጪ ማድረግ:</b> <b>/withdraw</b> በማለት ያሸነፉትን ገንዘብ ወደ TeleBirr ወይም CBE Birr ያውጡ!`;

    await this.sendMessage(chatId, text);
  }

  async cmdCancel(chatId) {
    this.userState.delete(chatId);
    const text = `❌ <b>ተሰርዟል (Cancelled)</b>\n\nወደ ዋናው ሜኑ ተመልሰዋል።`;
    await this.sendMessage(chatId, text, { reply_markup: this.getMainKeyboard() });
  }

  // ==================== TEXT MESSAGE ROUTER ====================
  async handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    const from = msg.from;
    const user = await this.getOrCreateTelegramUser(from);
    const state = this.userState.get(chatId);
    const norm = text.toLowerCase();

    // Support state
    if (state?.step === "support") {
      this.userState.delete(chatId);
      await this.sendMessage(
        chatId,
        `✅ <b>መልእክትዎ ለአድሚን ደርሷል!</b>\nመልእክት: "<i>${text.slice(0, 100)}</i>"\n\nበቅርቡ ምላሽ ይሰጥዎታል። እናመሰግናለን!`,
        { reply_markup: this.getMainKeyboard() }
      );
      if (this.groupId) {
        this.broadcastToGroup(`🆘 <b>የእርዳታ ጥያቄ (ከ @${from.username || from.first_name || chatId}):</b>\n"${text}"`).catch(()=>{});
      }
      return;
    }

    // Cancel checks
    if (norm.includes("አቋርጥ") || norm === "cancel" || norm.includes("ተሰርዟል")) {
      await this.cmdCancel(chatId);
      return;
    }

    // Language
    if (norm.includes("language") || norm.includes("ቋንቋ") || norm === "english" || norm === "አማርኛ") {
      await this.cmdLanguage(chatId, user);
      return;
    }

    // Ongoing State handling: deposit_amount
    if (state?.step === "deposit_amount") {
      const match = text.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
      const amount = match ? Number(match[1]) : 0;
      const target = state?.target || "🎮 ዋና ጨዋታ";
      const isVip = target.includes("VIP");
      const minDeposit = isVip ? 50 : 10;

      if (amount < minDeposit || isNaN(amount)) {
        await this.sendMessage(chatId, `⚠️ <b>ዝቅተኛው የ${isVip ? "VIP ክፍል" : "ዋናው ጨዋታ"} ገቢ መጠን ${minDeposit} ETB ነው።</b>\nእባክዎ ከ ${minDeposit} ETB ጀምሮ ያስገቡ:`, {
          reply_markup: {
            inline_keyboard: [[{ text: "❌ አቋርጥ", callback_data: "cmd_cancel" }]]
          }
        });
        return;
      }
      await this.cmdDepositStep3_Method(chatId, target, amount);
      return;
    }

    // Ongoing State handling: deposit_method
    if (state?.step === "deposit_method") {
      const method = norm.includes("cbe") ? "CBE Birr" :
                     (norm.includes("mpesa") || norm.includes("pesa")) ? "MPesa" :
                     (norm.includes("ebirr") || norm.includes("e-birr")) ? "E-Birr" : "TeleBirr";
      await this.cmdDepositStep4_Instruction(chatId, user, method);
      return;
    }

    // Ongoing State handling: deposit_confirm
    if (state?.step === "deposit_confirm" || text === "1") {
      await this.cmdDepositComplete(chatId, user, text);
      return;
    }

    // Ongoing State handling: withdraw_amount
    if (state?.step === "withdraw_amount") {
      const match = text.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
      const amount = match ? Number(match[1]) : 0;
      const maxBal = state?.maxBalance || 0;

      if (amount < 100 || isNaN(amount)) {
        await this.sendMessage(chatId, "⚠️ <b>አነስተኛው የማውጫ መጠን 100 ETB ነው።</b> እባክዎ ከ 100 ETB ጀምሮ ያስገቡ:", {
          reply_markup: { inline_keyboard: [[{ text: "❌ አቋርጥ", callback_data: "cmd_cancel" }]] }
        });
        return;
      }
      if (amount > maxBal) {
        await this.sendMessage(chatId, `⚠️ <b>በቂ ቀሪ ሂሳብ የለዎትም!</b> የአሁኑ ቀሪ ሂሳብዎ: <b>${maxBal.toFixed(2)} ETB</b> ነው።`, {
          reply_markup: { inline_keyboard: [[{ text: "❌ አቋርጥ", callback_data: "cmd_cancel" }]] }
        });
        return;
      }
      await this.cmdWithdrawStep3_AccountPrompt(chatId, user, state.withdrawMethod || "TeleBirr", amount);
      return;
    }

    // Ongoing State handling: withdraw_account
    if (state?.step === "withdraw_account") {
      await this.cmdWithdrawComplete(chatId, user, text);
      return;
    }

    // Main Keyboard clicks & text commands
    if (norm.includes("ገቢ") || norm.includes("deposit") || norm.includes("ማስገባት")) {
      await this.cmdDepositStep1(chatId, user);
      return;
    }

    if (norm.includes("ወጪ") || norm.includes("withdraw") || norm.includes("ማውጣት")) {
      await this.cmdWithdrawStep1(chatId, user);
      return;
    }

    if (norm.includes("ሂሳብ") || norm.includes("balance") || norm.includes("ዋሌት") || norm.includes("ቀሪ")) {
      await this.cmdBalance(chatId, user);
      return;
    }

    if (norm.includes("vip") || norm.includes("ቪአይፒ") || norm.includes("ቪ አይ ፒ")) {
      await this.cmdVIPRoom(chatId, user);
      return;
    }

    if (norm.includes("ትኬት") || norm.includes("ticket") || norm.includes("ቁረጥ")) {
      await this.cmdJoinGame(chatId, user);
      return;
    }

    if (norm.includes("ሁኔታ") || norm.includes("status")) {
      await this.cmdGameStatus(chatId);
      return;
    }

    if (norm.includes("ጋብዝ") || norm.includes("referral") || norm.includes("invite") || norm.includes("አጋር")) {
      await this.cmdReferralInfo(chatId, user);
      return;
    }

    if (norm.includes("promoter") || norm.includes("ፕሮሞተር")) {
      await this.cmdPromoterInfo(chatId, user);
      return;
    }

    if (norm.includes("እርዳታ") || norm.includes("ድጋፍ") || norm.includes("support") || norm.includes("help") || norm.includes("contact")) {
      await this.cmdSupport(chatId);
      return;
    }

    if (norm.includes("ደንቦች") || norm.includes("ህግ") || norm.includes("rules") || norm.includes("rule")) {
      await this.cmdRules(chatId);
      return;
    }

    if (norm === "start" || norm === "/start" || norm.includes("ጀምር") || norm.includes("ይክፈቱ") || norm.includes("play")) {
      await this.cmdStart(chatId, from, user, msg.chat.type === "group" || msg.chat.type === "supergroup");
      return;
    }

    if (norm.includes("bingo") || norm.includes("ቢንጎ") || norm.includes("claim") || norm.includes("አሸነፍኩ")) {
      await this.cmdClaimBingo(chatId, user);
      return;
    }

    if (norm.includes("card") || norm.includes("ካርድ") || norm.includes("ካርዴ")) {
      await this.cmdMyCard(chatId, user);
      return;
    }

    // Standalone number typed (shortcut for deposit)
    const standaloneNum = text.match(/^([0-9]{2,5})$/);
    if (standaloneNum) {
      const amt = Number(standaloneNum[1]);
      if (amt >= 10) {
        await this.cmdDepositStep3_Method(chatId, amt >= 50 ? "🎮 ዋና ጨዋታ" : "🎮 ዋና ጨዋታ", amt);
        return;
      }
    }

    // Default Fallback
    await this.sendMessage(
      chatId,
      `👋 <b>እንደምን አደሩ/ዋሉ ${user ? user.name : "ተጫዋች"}!</b>\n\nከታች ያሉትን ቁልፎች በመጠቀም መጫወት፣ ሂሳብ መሙላት ወይም ወጪ ማድረግ ይችላሉ:`,
      { reply_markup: this.getMainKeyboard() }
    );
  }

  // ==================== USER MANAGEMENT ====================
  async getOrCreateTelegramUser(tgUser) {
    if (!tgUser) return null;
    const tgId = tgUser.id;
    const tgUsername = tgUser.username || "";
    const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || `TG_${tgId}`;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        "SELECT u.*, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.telegram_id = $1",
        [tgId]
      );
      if (res.rows.length) {
        await client.query("COMMIT");
        return res.rows[0];
      }

      const placeholderPhone = `TG${tgId}`;
      const existingByPhone = await client.query("SELECT id FROM users WHERE phone = $1", [placeholderPhone]);
      if (existingByPhone.rows.length) {
        await client.query(
          "UPDATE users SET telegram_id = $1, telegram_username = $2 WHERE id = $3",
          [tgId, tgUsername, existingByPhone.rows[0].id]
        );
        const updated = await client.query(
          "SELECT u.*, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1",
          [existingByPhone.rows[0].id]
        );
        await client.query("COMMIT");
        return updated.rows[0];
      }

      const dummyPassword = crypto.randomBytes(16).toString("hex");
      const insertUser = await client.query(
        "INSERT INTO users (name, phone, password_hash, role, telegram_id, telegram_username) VALUES ($1, $2, $3, 'PLAYER', $4, $5) RETURNING *",
        [name, placeholderPhone, dummyPassword, tgId, tgUsername]
      );
      const newUser = insertUser.rows[0];
      await client.query(
        "INSERT INTO wallets (user_id, main_balance, vip_balance) VALUES ($1, 0.00, 0.00) ON CONFLICT (user_id) DO NOTHING",
        [newUser.id]
      );
      await client.query("COMMIT");
      newUser.main_balance = "0.00";
      newUser.vip_balance = "0.00";
      return newUser;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Telegram] Error in getOrCreateTelegramUser:", e.message);
      return null;
    } finally {
      client.release();
    }
  }

  // ==================== GAME STATUS & CARDS ====================
  async cmdGameStatus(chatId) {
    try {
      const g = (await this.pool.query(
        "SELECT * FROM games WHERE status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1"
      )).rows[0];

      if (!g) {
        await this.sendMessage(chatId, "ℹ️ በአሁኑ ሰዓት ንቁ ጨዋታ የለም። አዲስ ጨዋታ በቅርቡ ይጀምራል!");
        return;
      }

      const pCount = (await this.pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id = $1", [g.id])).rows[0].count;
      const called = g.called_numbers || [];
      const lastCalled = called.length > 0 ? called[called.length - 1] : "ገና አልተጠራም";

      const text = `🎲 <b>HABESHA BINGO - የቀጥታ ጨዋታ ሁኔታ</b>\n\n` +
        `🏷 ጨዋታ: <b>#${g.id} (${g.name})</b>\n` +
        `📊 ሁኔታ: <b>${g.status === "running" ? "🟢 እየተካሄደ ያለ (Running)" : "🟡 በመጠባበቅ ላይ (Waiting for players)"}</b>\n` +
        `🎟 የመግቢያ ክፍያ: <b>${Number(g.entry).toFixed(2)} ETB</b>\n` +
        `🏆 የሽልማት ፈንድ: <b>${Number(g.prize_pool).toFixed(2)} ETB</b>\n` +
        `👥 ተጫዋቾች: <b>${pCount}</b>\n` +
        `🎱 የመጨረሻ የተጠራው ቁጥር: <b>${lastCalled}</b>\n` +
        `🔢 እስካሁን የተጠሩ ቁጥሮች ብዛት: <b>${called.length}/75</b>\n\n` +
        `ለመቀላቀል <b>/play</b> ይጫኑ ወይም ከታች ያለውን ይምረጡ:`;

      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎟 ዋና ትኬት ቁረጥ (8 ETB)", callback_data: "cmd_buy" }],
            [{ text: "💎 VIP ክፍል (50 ETB)", callback_data: "cmd_vip" }]
          ]
        }
      });
    } catch (e) {
      await this.sendMessage(chatId, "⚠️ የጨዋታውን መረጃ ማግኘት አልተቻለም: " + e.message);
    }
  }

  async cmdMyCard(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ እባክዎ መጀመሪያ /start በማድረግ ይመዝገቡ።");
      return;
    }
    const g = (await this.pool.query("SELECT * FROM games WHERE status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1")).rows[0];
    if (!g) {
      await this.sendMessage(chatId, "ℹ️ በአሁኑ ሰዓት ንቁ ጨዋታ የለም።");
      return;
    }
    const t = (await this.pool.query("SELECT numbers FROM tickets WHERE game_id = $1 AND user_id = $2", [g.id, user.id])).rows[0];
    if (!t) {
      await this.sendMessage(chatId, "ℹ️ ለጨዋታ #" + g.id + " ትኬት አልቆረጡም። ትኬት ለመቁረጥ <b>/play</b> ይጫኑ።", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎟 ትኬት ቁረጥ (8 ETB)", callback_data: "cmd_buy" }],
            [{ text: "📥 ሂሳብ ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" }]
          ]
        }
      });
      return;
    }
    const called = g.called_numbers || [];
    const cardGrid = this.formatCardGrid(t.numbers, called);
    await this.sendMessage(
      chatId,
      `🎟 <b>የእርስዎ የቢንጎ ካርድ (ጨዋታ #${g.id})</b>\n\n` +
      `[ * ምልክት የተጠራውን ቁጥር ያመለክታል ]\n\n` +
      `<pre>${cardGrid}</pre>\n\n` +
      `የተጠሩ ቁጥሮች ብዛት: <b>${called.length}/75</b>\n` +
      `መስመር ከሞሉ <b>/bingo</b> በማለት ያሸንፉ!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🏆 BINGO! (አሸንፌያለሁ)", callback_data: "cmd_claim" }],
            [{ text: "🔄 ካርድ አድስ (Refresh)", callback_data: "cmd_card" }]
          ]
        }
      }
    );
  }

  async cmdClaimBingo(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ እባክዎ መጀመሪያ /start ያድርጉ።");
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const g = (await client.query("SELECT * FROM games WHERE status = 'running' ORDER BY id DESC LIMIT 1 FOR UPDATE")).rows[0];
      if (!g) {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "⚠️ በአሁኑ ሰዓት እየተካሄደ ያለ ንቁ ጨዋታ የለም።");
        return;
      }
      const t = (await client.query("SELECT numbers FROM tickets WHERE game_id = $1 AND user_id = $2", [g.id, user.id])).rows[0];
      if (!t) {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "❌ ለዚህ ጨዋታ ትኬት አልቆረጡም!");
        return;
      }

      const called = g.called_numbers || [];
      const hasWon = this.checkBingo(t.numbers, called);

      if (!hasWon) {
        await client.query("ROLLBACK");
        await this.sendMessage(
          chatId,
          `❌ <b>ቢንጎ አልሞላም (No Bingo yet)!</b>\n\nበካርድዎ ላይ 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ እስኪጠሩ ድረስ ይጠብቁ።\nካርድዎን ለማየት <b>/card</b> ይጫኑ።`
        );
        return;
      }

      // User Won!
      const prize = Number(g.prize_pool);
      const isVip = Number(g.entry) >= 50;
      const targetWallet = isVip ? "vip" : "main";
      const wCol = isVip ? "vip_balance" : "main_balance";

      await client.query(
        "INSERT INTO winners (game_id, user_id, prize_amount, ticket_snapshot) VALUES ($1, $2, $3, $4)",
        [g.id, user.id, prize, JSON.stringify(t.numbers)]
      );

      const wallet = (await client.query(`SELECT ${wCol} FROM wallets WHERE user_id = $1 FOR UPDATE`, [user.id])).rows[0];
      const newBal = Math.round((Number(wallet[wCol]) + prize) * 100) / 100;
      await client.query(`UPDATE wallets SET ${wCol} = $1, updated_at = now() WHERE user_id = $2`, [newBal, user.id]);
      await client.query(
        "INSERT INTO transactions (user_id, type, wallet, amount, balance_before, balance_after, status, method, reference) VALUES ($1, 'prize', $2, $3, $4, $5, 'completed', 'telegram', $6)",
        [user.id, targetWallet, prize, Number(wallet[wCol]), newBal, "Bingo Prize Game #" + g.id]
      );

      await client.query(
        "UPDATE games SET status = 'finished', winner_id = $1, winner_ticket = $2, finished_at = now() WHERE id = $3",
        [user.id, JSON.stringify(t.numbers), g.id]
      );

      await client.query("COMMIT");

      const winMsg = `🏆 <b>ቢንጎ (BINGO)! እንኳን ደስ አለዎት!</b>\n\n` +
        `👑 አሸናፊ: <b>${user.name}</b>\n` +
        `💰 የተሸለሙት መጠን: <b>${prize.toFixed(2)} ETB</b>\n` +
        `🏷 ጨዋታ ቁጥር: <b>#${g.id}</b>\n\n` +
        `ገንዘቡ በቀጥታ ወደ ዋሌትዎ ገብቷል!`;

      await this.sendMessage(chatId, winMsg);
      await this.broadcastToGroup(
        `🎉🏆 <b>ቢንጎ (BINGO)!</b> 🏆🎉\n\n` +
        `👤 አሸናፊ: <b>${user.name}</b>\n` +
        `💵 ሽልማት: <b>${prize.toFixed(2)} ETB</b>\n` +
        `🏷 ጨዋታ: <b>#${g.id}</b>\n\n` +
        `አዲስ ጨዋታ በቅርቡ ይጀምራል! ለመጫወት <b>/play</b> ይጫኑ።`
      );

      if (this.io) {
        this.io.to("game:" + g.id).emit("finished", {
          ...g,
          status: "finished",
          winner_id: user.id,
          winner_name: user.name,
          prize_amount: prize
        });
      }

    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Telegram] Claim error:", e);
      await this.sendMessage(chatId, "⚠️ ቢንጎ ማረጋገጥ አልተቻለም: " + e.message);
    } finally {
      client.release();
    }
  }

  async cmdLinkAccount(chatId, tgUser, phone, password) {
    if (!phone || !password) {
      await this.sendMessage(chatId, "ℹ️ የድረ-ገጽ አካውንትዎን ከቴሌግራም ጋር ለማገናኘት:\n<code>/link [ስልክ_ቁጥር] [የይለፍ_ቃል]</code>\nምሳሌ: <code>/link 0911000000 Pass@1234</code>");
      return;
    }
    const bcrypt = require("bcryptjs");
    try {
      const u = (await this.pool.query("SELECT * FROM users WHERE phone = $1", [phone])).rows[0];
      if (!u || !(await bcrypt.compare(password, u.password_hash))) {
        await this.sendMessage(chatId, "❌ የስልክ ቁጥር ወይም የይለፍ ቃል የተሳሳተ ነው!");
        return;
      }
      await this.pool.query("UPDATE users SET telegram_id = $1, telegram_username = $2 WHERE id = $3", [
        tgUser.telegram_id,
        tgUser.telegram_username,
        u.id
      ]);
      await this.sendMessage(chatId, `✅ <b>ተገናኝቷል!</b>\nየድረ-ገጽ አካውንትዎ (${u.name} - ${u.phone}) ከቴሌግራም ጋር በተሳካ ሁኔታ ተቆራኝቷል!`);
    } catch (e) {
      await this.sendMessage(chatId, "⚠️ ማገናኘት አልተቻለም: " + e.message);
    }
  }

  // ==================== BROADCAST HOOKS CALLED BY SERVER.JS ====================
  async notifyNumberCalled(gameId, number, calledNumbers) {
    if (!this.isSyncEnabled) return;
    const count = calledNumbers.length;
    if (count % 3 === 0 || count <= 5) {
      const lastThree = calledNumbers.slice(-3).reverse().join(", ");
      await this.broadcastToGroup(
        `🎱 <b>ቁጥር ተጠርቷል: [ ${number} ]</b>\n` +
        `🔢 የቅርብ ቁጥሮች: ${lastThree}\n` +
        `📊 የተጠሩት ብዛት: ${count}/75\n` +
        `ካርድዎን ለማየት <b>/card</b> ፣ መስመር ከሞሉ <b>/bingo</b> ይበሉ!`
      );
    }
  }

  async notifyWinner(gameId, winnerName, prizeAmount, ticket) {
    if (!this.isSyncEnabled) return;
    await this.broadcastToGroup(
      `🏆🎉 <b>ቢንጎ (BINGO) አሸናፊ ተገኝቷል!</b> 🎉🏆\n\n` +
      `👑 አሸናፊ: <b>${winnerName}</b>\n` +
      `💰 የተሸለመው: <b>${Number(prizeAmount).toFixed(2)} ETB</b>\n` +
      `🏷 ጨዋታ #: <b>${gameId}</b>\n\n` +
      `እንኳን ደስ አለዎት! ቀጣዩ ዙር በቅርቡ ይጀምራል!`
    );
  }

  async notifyGameStarted(gameId, entryFee, prizePool, playerCount) {
    if (!this.isSyncEnabled) return;
    await this.broadcastToGroup(
      `🎮 <b>አዲስ የቢንጎ ጨዋታ ጀመረ (Game #${gameId})!</b>\n\n` +
      `🎟 የመግቢያ ክፍያ: <b>${Number(entryFee).toFixed(2)} ETB</b>\n` +
      `🏆 የሽልማት ፈንድ: <b>${Number(prizePool).toFixed(2)} ETB</b>\n` +
      `👥 ተጫዋቾች: <b>${playerCount}</b>\n\n` +
      `ትኬት ለመቁረጥ <b>/play</b> ይጫኑ ወይም በድረ-ገጹ ይሳተፉ!`
    );
  }

  async notifyDepositApproved(userId, amount, method) {
    if (!this.pool || !userId) return;
    try {
      const uRes = await this.pool.query(
        "SELECT u.telegram_id, u.name, u.phone, u.role, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1",
        [userId]
      );
      const user = uRes.rows[0];
      if (!user || !user.telegram_id) return;
      const playUrl = await this.getWebAppUrl({ id: userId, name: user.name, phone: user.phone, role: user.role || 'PLAYER' });
      const balance = Number(user.main_balance || 0);

      const msg = `🎉 <b>የገቢ ጥያቄዎ ጸድቋል (Deposit Approved)!</b>\n\n` +
        `👤 ተጫዋች: <b>${user.name}</b>\n` +
        `💰 የገባ መጠን: <b>${Number(amount).toFixed(2)} ETB</b>\n` +
        `💳 ዘዴ: <b>${method || "TeleBirr"}</b>\n` +
        `💵 አዲሱ ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n\n` +
        `✅ <b>ሂሳብዎ ዝግጁ ነው!</b> ጨዋታውን ለመጀመር <b>/start</b> ይበሉ ወይም ከታች ያለውን <b>🎮 አሁኑኑ ተጫወት (Play Now)</b> ይጫኑ:`;

      await this.sendMessage(user.telegram_id, msg, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎮 አሁኑኑ ተጫወት (Play Now)", web_app: { url: playUrl } }],
            [{ text: "💰 ቀሪ ሂሳብ (Balance)", callback_data: "cmd_balance" }]
          ]
        }
      });
    } catch (e) {
      console.warn("[Telegram] Could not notify deposit approved:", e.message);
    }
  }

  // ==================== 75-BALL BINGO CARD GENERATOR & CHECKER ====================
  generateRandomTicket() {
    const cols = [
      Array.from({ length: 15 }, (_, i) => i + 1),      // B: 1-15
      Array.from({ length: 15 }, (_, i) => i + 16),     // I: 16-30
      Array.from({ length: 15 }, (_, i) => i + 31),     // N: 31-45
      Array.from({ length: 15 }, (_, i) => i + 46),     // G: 46-60
      Array.from({ length: 15 }, (_, i) => i + 61)      // O: 61-75
    ];
    const card = [];
    for (let c = 0; c < 5; c++) {
      const pool = [...cols[c]];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      card.push(pool.slice(0, 5));
    }
    return [0, 1, 2, 3, 4].map(r => [card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  }

  checkBingo(ticket, called) {
    const s = new Set(called);
    const m = ticket.map(r => r.map(n => s.has(n)));
    for (let r = 0; r < 5; r++) if (m[r].every(Boolean)) return true;
    for (let c = 0; c < 5; c++) if ([0, 1, 2, 3, 4].every(r => m[r][c])) return true;
    return [0, 1, 2, 3, 4].every(i => m[i][i]) || [0, 1, 2, 3, 4].every(i => m[i][4 - i]);
  }

  formatCardGrid(ticket, called) {
    const s = new Set(called || []);
    let out = "┌─────┬─────┬─────┬─────┬─────┐\n";
    out += "│  B  │  I  │  N  │  G  │  O  │\n";
    out += "├─────┼─────┼─────┼─────┼─────┤\n";
    for (let r = 0; r < 5; r++) {
      out += "│";
      for (let c = 0; c < 5; c++) {
        const num = ticket[r][c];
        const isHit = s.has(num);
        const cell = isHit ? `*${num}` : `${num}`;
        out += cell.padStart(4, " ").padEnd(5, " ") + "│";
      }
      out += "\n";
      if (r < 4) out += "├─────┼─────┼─────┼─────┼─────┤\n";
    }
    out += "└─────┴─────┴─────┴─────┴─────┘";
    return out;
  }
}

module.exports = TelegramBingoService;
