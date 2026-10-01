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

    // Callbacks provided by server.js
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
        
        // Configure Telegram bot commands matching screenshot exactly
        try {
          await this.apiCall("setMyCommands", {
            commands: [
              { command: "start", description: "START PLAYING HULU BINGO GAME!" },
              { command: "deposit", description: "Deposit Fund!" },
              { command: "withdraw", description: "Withdraw Funds!" },
              { command: "support", description: "Contact the Support! (...or send your message here)" },
              { command: "language", description: "Change the language from Amharic to English!" }
            ]
          });
          console.log("[Telegram] Commands menu set successfully matching screenshot");
        } catch (cErr) {
          console.warn("[Telegram] Could not set bot commands:", cErr.message);
        }

        // Configure Telegram Chat Menu Button as commands popup so [ ✕ Menu ] appears and opens the list
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

  // Auto-detect or broadcast to group
  async broadcastToGroup(text, extra = {}) {
    if (!this.isSyncEnabled) return null;
    if (!this.groupId) {
      console.log(`[Telegram] Broadcast skipped: Group ID for "${this.groupTitle}" not discovered yet. Invite @${this.botUsername} to the group or send a message in "${this.groupTitle}".`);
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
      // Network timeout is normal in long polling
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

      // 1. Group Auto-Discovery: Check if this message came from a group or supergroup
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
            `🎮 <b>HABESHA BINGO ወደ "${this.groupTitle}" ተገናኝቷል!</b>\n\nየቢንጎ ጨዋታው ከድረ-ገጹ ጋር በቀጥታ ተቀናጅቷል። ቁጥሮች፣ አሸናፊዎች እና ትኬቶች እዚህ በቅጽበት ይዘመናሉ!\n\nመመሪያዎችን ለማየት <b>/help</b> ይጫኑ።`
          );
        }
      }

      // Check if command
      if (text.startsWith("/")) {
        await this.handleCommand(message);
      } else if (text) {
        await this.handleTextMessage(message);
      }
    } catch (e) {
      console.error("[Telegram] Error handling update:", e);
    }
  }

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
      const target = targetKey === "vip" ? "💎 VIP Room" : "🎮 Main Game";
      await this.cmdDepositStep2_Amount(chatId, target);
    } else if (data.startsWith("dep_amt:")) {
      const amtStr = data.split(":")[1];
      const currentState = this.userState.get(chatId) || {};
      const target = currentState.target || "🎮 Main Game";
      if (amtStr === "custom") {
        this.userState.set(chatId, { step: "deposit_amount", target });
        await this.sendMessage(chatId, `💸 <b>ገቢ ለማድረግ (Deposit)</b>\n🎯 Target: <b>${target}</b>\n\nእባክዎን ማስገባት የሚፈልጉትን የብር መጠን እዚህ ጽፈው ይላኩ (ለምሳሌ፡ 350):`, {
          reply_markup: {
            inline_keyboard: [[{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]]
          }
        });
      } else {
        const amount = Number(amtStr) || 100;
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
    } else if (data === "cmd_status") {
      await this.cmdGameStatus(chatId);
    } else if (data === "cmd_vip") {
      await this.cmdVIPRoom(chatId, user);
    } else if (data === "cmd_support") {
      await this.cmdSupport(chatId);
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

  async handleCommand(msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const parts = (msg.text || "").split(/\s+/);
    const rawCmd = parts[0].toLowerCase().split("@")[0]; // remove @botname

    // Find or link user
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
      case "/support":
        await this.cmdSupport(chatId);
        break;
      case "/language":
        await this.cmdLanguage(chatId, user);
        break;
      case "/help":
        await this.cmdHelp(chatId, isGroup);
        break;
      case "/game":
      case "/status":
        await this.cmdGameStatus(chatId);
        break;
      case "/card":
      case "/ticket":
        await this.cmdMyCard(chatId, user);
        break;
      case "/play":
      case "/join":
      case "/buy":
        await this.cmdJoinOrPlayPrompt(chatId, user);
        break;
      case "/bingo":
      case "/claim":
        await this.cmdClaimBingo(chatId, user);
        break;
      case "/link":
        await this.cmdLinkAccount(chatId, user, parts[1], parts[2]);
        break;
      default:
        break;
    }
  }

  getMainKeyboard(customUrl) {
    const webAppUrl = customUrl || process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    return {
      keyboard: [
        [{ text: "🎮 ጨዋታውን ይክፈቱ (Play)", web_app: { url: webAppUrl } }],
        [{ text: "💰 ሂሳብ" }, { text: "📥 ገቢ ለማድረግ" }],
        [{ text: "📤 ወጪ ለማድረግ" }, { text: "🔗 ጋብዝ & አግኝ" }],
        [{ text: "💎 VIP ክፍል" }, { text: "⭐ Special Promoter" }],
        [{ text: "🆘 እርዳታ" }, { text: "📜 ደንቦች" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    };
  }

  // DEPOSIT FLOW: Step 1 (Game selection)
  async cmdDepositStep1(chatId, user) {
    this.userState.set(chatId, { step: "deposit_target" });
    const text = `📥 <b>ገንዘብ ማስገቢያ (Deposit Fund)</b>\n\nእባክዎ የሚፈልጉትን የጨዋታ አይነት ይምረጡ:`;
    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎮 ዋናው ጨዋታ (Main Game)", callback_data: "dep_target:main" },
            { text: "💎 VIP ክፍል (VIP Room)", callback_data: "dep_target:vip" }
          ],
          [{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  // DEPOSIT FLOW: Step 2 (Amount selection)
  async cmdDepositStep2_Amount(chatId, target = "🎮 Main Game") {
    this.userState.set(chatId, { step: "deposit_amount", target });
    const text = `💸 <b>ገቢ የሚደረገው መጠን (Deposit Amount)</b>\n🎯 Target: <b>${target}</b>\n\nእባክዎ ገቢ ማድረግ የሚፈልጉትን የብር መጠን ይምረጡ ወይም እዚህ ይጻፉ:`;
    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
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
        ]
      }
    });
  }

  // DEPOSIT FLOW: Step 3 (Payment Method selection)
  async cmdDepositStep3_Method(chatId, target = "🎮 Main Game", amount = 100) {
    this.userState.set(chatId, { step: "deposit_method", target, amount });
    const text = `💳 <b>የክፍያ ዘዴ ይምረጡ (Select Payment Method)</b>\n💰 መጠን: <b>${amount} ETB</b>\n🎯 Target: <b>${target}</b>\n\nገንዘብ ገቢ (Deposit) ለማድረግ የሚፈልጉትን የክፍያ አማራጭ ይምረጡ:`;
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

  // DEPOSIT FLOW: Step 4 (Transfer Instructions)
  async cmdDepositStep4_Instruction(chatId, user, method = "TeleBirr") {
    const currentState = this.userState.get(chatId) || {};
    const target = currentState.target || "🎮 Main Game";
    const amount = currentState.amount || 100;
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
      `1️⃣ <b>${amount} ETB</b> በ ${method} ወደዚህ ቁጥር ይላኩ:\n` +
      `👉 <code>${receiverPhone}</code> (<b>${receiverName}</b>)\n\n` +
      `2️⃣ ክፍያውን ከፈጸሙ በኋላ ከባንክ የሚደርስዎትን <b>Txn ID</b> ኮፒ ያድርጉ።\n\n` +
      `3️⃣ የደረሰዎትን <b>Transaction ID</b> (ወይም ሙሉውን SMS) እዚህ ጋር ጽፈው ይላኩ/ይለጥፉ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ ከፍያለሁ / አረጋግጥ (Confirm)", callback_data: "dep_confirm" }],
          [{ text: "❌ አቋርጥ (Cancel)", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  // DEPOSIT FLOW: Step 5 (Complete & Record Transaction)
  async cmdDepositComplete(chatId, user, inputMessage) {
    const currentState = this.userState.get(chatId) || {};
    const target = currentState.target || "🎮 Main Game";
    const method = currentState.method || "TeleBirr";
    let amount = currentState.amount || 100;
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
    if (user && this.pool) {
      try {
        const wallet = target.toLowerCase().includes("vip") ? "vip" : "main";
        const wCol = wallet === "vip" ? "vip_balance" : "main_balance";
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
            wallet,
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
        `🎯 Target: <b>${target}</b>\n\n` +
        `🎉 <b>ገንዘቡ ወደ ዋሌትዎ ገብቷል!</b> አሁኑኑ ጨዋታውን ለመጀመር ከታች ያለውን <b>"🎮 ጨዋታውን ጀምር (Start Playing)"</b> ይጫኑ ወይም <b>/start</b> ይበሉ!`
      : `✅ <b>የገቢ ጥያቄዎ በተሳካ ሁኔታ ተልኳል!</b>\n\n` +
        `💰 መጠን: <b>${amount} ETB</b>\n` +
        `💳 ዘዴ: <b>${method}</b>\n` +
        `🔢 Txn ID: <b>${txnId}</b>\n` +
        `🎯 Target: <b>${target}</b>\n\n` +
        `⏳ <i>አድሚን ክፍያውን እንዳረጋገጠ በደቂቃዎች ውስጥ ወደ ሂሳብዎ ይገባል!</i>`;

    await this.sendMessage(chatId, confirmationText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎮 ጨዋታውን ጀምር (Start Playing)", web_app: { url: playUrl } }],
          [{ text: "💰 ሂሳብ ይመልከቱ (Balance)", callback_data: "cmd_balance" }]
        ]
      }
    });
  }

  // WITHDRAW FLOW: Step 1 (Method selection & balance check)
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
    const text = `📤 <b>ወጪ ለማድረግ (Withdraw Fund)</b>\n\n` +
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

  // WITHDRAW FLOW: Step 2 (Amount selection)
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

  // WITHDRAW FLOW: Step 3 (Recipient Account prompt)
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

  // WITHDRAW FLOW: Step 4 (Execute & Save to DB)
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

      const tx = await client.query(
        `INSERT INTO transactions (user_id, type, wallet, amount, balance_before, balance_after, status, method, reference, provider)
         VALUES ($1, 'withdrawal', 'main', $2, $3, $4, 'pending', $5, $6, $7) RETURNING id`,
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

  async cmdCancel(chatId) {
    this.userState.delete(chatId);
    const text = `❌ <b>ተሰርዟል (Operation Cancelled)</b>\n\nወደ ዋናው ሜኑ ተመልሰዋል።`;
    await this.sendMessage(chatId, text, { reply_markup: this.getMainKeyboard() });
  }

  async cmdBalance(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ መጀመሪያ /start በማድረግ ይመዝገቡ።");
      return;
    }
    const bal = (await this.pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
    const mainBal = Number(bal?.main_balance || 0).toFixed(2);
    const vipBal = Number(bal?.vip_balance || 0).toFixed(2);

    const text = `💰 <b>የእርስዎ የዋሌት መረጃ</b>\n\n` +
      `👤 ተጠቃሚ: <b>${user.name}</b>\n` +
      `💵 <b>ዋና ሂሳብ (Main):</b> <b>${mainBal} ETB</b>\n` +
      `💎 <b>VIP ሂሳብ:</b> <b>${vipBal} ETB</b>\n\n` +
      `ምን ማድረግ ይፈልጋሉ?`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📥 ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" },
            { text: "📤 ወጪ አድርግ (Withdraw)", callback_data: "cmd_withdraw" }
          ],
          [
            { text: "🎮 አሁኑኑ ተጫወት (Play)", callback_data: "cmd_play" },
            { text: "💎 VIP ክፍል", callback_data: "cmd_vip" }
          ],
          [
            { text: "🔄 አድስ (Refresh)", callback_data: "cmd_balance" }
          ]
        ]
      }
    });
  }

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
        `ትኬት ቆርጠው በሙሉ ዕድል ለመጫወት እባክዎ መጀመሪያ ሂሳብዎን ይሙሉ:`;
      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 አሁኑኑ Deposit አድርግ (ገቢ)", callback_data: "cmd_deposit" }],
            [{ text: "🎮 ጨዋታውን በ WebApp ክፈት", web_app: { url: webAppUrl } }]
          ]
        }
      });
      return;
    }

    const text = `🎉 <b>ሁሉ ቢንጎ ለመጫወት ዝግጁ ነዎት!</b>\n\n` +
      `👤 ተጫዋች: <b>${user ? user.name : "ተጫዋች"}</b>\n` +
      `💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n` +
      `🎟 የመግቢያ ክፍያ: <b>10.00 ETB</b>\n\n` +
      `በ WebApp ውብ ገፅታ ለመጫወት ከታች ያለውን ይጫኑ ወይም እዚሁ ትኬት ይቁረጡ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎮 በ WebApp ክፈት (Open Game)", web_app: { url: webAppUrl } }],
          [
            { text: "🎟 እዚሁ ትኬት ቁረጥ (10 ETB)", callback_data: "cmd_buy" },
            { text: "📊 የጨዋታ ሁኔታ (Status)", callback_data: "cmd_status" }
          ]
        ]
      }
    });
  }

  async cmdVIPRoom(chatId, user) {
    const webAppUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    let vipBalance = "0.00";
    try {
      const row = (await this.pool.query("SELECT vip_balance FROM wallets WHERE user_id = $1", [user?.id || 0])).rows[0];
      vipBalance = Number(row?.vip_balance || 0).toFixed(2);
    } catch (e) {}

    const text = `💎 <b>VIP ክፍል (VIP Room)</b>\n\n` +
      `🔥 ከፍተኛ ዕድል • 50 ETB ውርድ • ከፍተኛ 2 ካርዶች\n` +
      `🎴 50 ልዩ ካርዶች — ለልዩ VIP ብቻ\n\n` +
      `💰 VIP ሂሳብ: <b>${vipBalance} ETB</b>\n` +
      `🏆 ጠቅላላ ያሸነፉት: <b>0.00 ETB</b>\n\n` +
      `አሁኑኑ ይግቡ ወይም ሂሳብዎን ይሙሉ:`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💎 VIP ክፍል በ WebApp ክፈት", web_app: { url: `${webAppUrl}?view=vip` } }],
          [{ text: "📥 ወደ VIP ሂሳብ አስገባ (Deposit)", callback_data: "dep_target:vip" }],
          [{ text: "⬅️ ወደ ዋና ሜኑ", callback_data: "cmd_cancel" }]
        ]
      }
    });
  }

  async cmdReferralInfo(chatId, user) {
    const botUrl = `https://t.me/${this.botUsername}?start=ref_${user?.id || ""}`;
    const text = `🔗 <b>ጋብዝ & አግኝ (Refer & Earn)</b>\n\n` +
      `ጓደኞችዎን ይጋብዙና ተጨማሪ ገቢ ያግኙ!\n\n` +
      `የእርስዎ መጋበዣ ሊንክ:\n<code>${botUrl}</code>\n\n` +
      `ጓደኛዎ በዚህ ሊንክ ተመዝግቦ ሲጫወት ኮሚሽን ያገኛሉ!`;
    await this.sendMessage(chatId, text, { reply_markup: this.getMainKeyboard() });
  }

  async cmdPromoterInfo(chatId, user) {
    const text = `⭐ <b>Special Promoter ፕሮግራም</b>\n\n` +
      `የ Habesha Bingo ልዩ ፕሮሞተር በመሆን በየቀኑ ከፍተኛ ገቢ ማግኘት ይችላሉ!\n\n` +
      `ለበለጠ መረጃ እና ምዝገባ የአድሚን ስልክ: <b>0919307468</b> ያነጋግሩ።`;
    await this.sendMessage(chatId, text, { reply_markup: this.getMainKeyboard() });
  }

  async cmdRules(chatId) {
    const text = `📜 <b>የቢንጎ ጨዋታ ህጎች እና ደንቦች</b>\n\n` +
      `1. እያንዳንዱ ተጫዋች 5x5 የቢንጎ ካርድ ይቆርጣል።\n` +
      `2. ሲስተሙ በየተራ ቁጥሮችን ይጠራል።\n` +
      `3. 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ የሞላ የመጀመሪያው ተጫዋች አሸናፊ ይሆናል።\n` +
      `4. መስመር እንደሞላዎት ወዲያውኑ <b>/bingo</b> ይበሉ!\n` +
      `5. የውሸት ቢንጎ ማለት ጨዋታውን ያቋርጥብዎታል፤ እባክዎ በትክክል ያረጋግጡ።`;
    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎮 ጨዋታ ጀምር (Play)", callback_data: "cmd_play" }],
          [{ text: "💰 ሂሳብ ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" }]
        ]
      }
    });
  }

  async cmdLanguage(chatId, user) {
    const text = `🌐 <b>Change the language from Amharic to English!</b>\n\nእባክዎ የሚፈልጉትን ቋንቋ ይምረጡ / Please choose your language:`;
    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🇪🇹 አማርኛ (Amharic)", callback_data: "lang_am" },
            { text: "🇬🇧 English", callback_data: "lang_en" }
          ]
        ]
      }
    });
  }

  async handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    const from = msg.from;
    const user = await this.getOrCreateTelegramUser(from);
    const state = this.userState.get(chatId);
    const norm = text.toLowerCase();

    // 0. Support message mode
    if (state?.step === "support") {
      this.userState.delete(chatId);
      await this.sendMessage(
        chatId,
        `✅ <b>መልእክትዎ ለ Admin: adissu ደርሷል!</b>\nመልእክት: "<i>${text.slice(0, 100)}</i>"\n\nበቅርቡ ምላሽ ይሰጥዎታል። እናመሰግናለን!`,
        { reply_markup: this.getMainKeyboard() }
      );
      if (this.groupId) {
        this.broadcastToGroup(`🆘 <b>የእርዳታ ጥያቄ (ከ @${from.username || from.first_name || chatId}):</b>\n"${text}"`).catch(()=>{});
      }
      return;
    }

    // 0.1 Start / Play commands typed as text
    if (norm === "start" || norm === "/start" || norm === "ጀምር" || norm === "play" || norm === "/play") {
      await this.cmdStart(chatId, from, user, msg.chat.type === "group" || msg.chat.type === "supergroup");
      return;
    }

    // 1. Cancel
    if (norm.includes("አቋርጥ") || norm === "cancel" || norm.includes("ተሰርዟል")) {
      await this.cmdCancel(chatId);
      return;
    }

    // 1.1 Language
    if (norm.includes("language") || norm.includes("ቋንቋ") || norm.includes("english") || norm.includes("አማርኛ")) {
      await this.cmdLanguage(chatId, user);
      return;
    }

    // 2. Main Menu keyboard clicks
    if (norm.includes("ገቢ ለማድረግ") || norm.includes("📥 ገቢ") || norm === "deposit" || norm === "ገቢ") {
      await this.cmdDepositStep1(chatId, user);
      return;
    }
    if (norm.includes("ወጪ ለማድረግ") || (norm.includes("ወጪ") && !norm.includes("ገቢ")) || norm === "withdraw") {
      await this.cmdWithdrawStep1(chatId, user);
      return;
    }
    if (norm.includes("ይጫወቱ") || norm === "play" || norm.includes("join") || norm.includes("ጨዋታውን ይክፈቱ")) {
      await this.cmdJoinOrPlayPrompt(chatId, user);
      return;
    }
    if (norm.includes("ሂሳብ") || norm.includes("balance") || norm.includes("ቀሪ")) {
      await this.cmdBalance(chatId, user);
      return;
    }
    if (norm.includes("vip") || norm.includes("ቪአይፒ")) {
      await this.cmdVIPRoom(chatId, user);
      return;
    }
    if (norm.includes("ጋብዝ") || norm.includes("አጋር") || norm.includes("referral")) {
      await this.cmdReferralInfo(chatId, user);
      return;
    }
    if (norm.includes("promoter") || norm.includes("ፕሮሞተር")) {
      await this.cmdPromoterInfo(chatId, user);
      return;
    }
    if (norm.includes("እርዳታ") || norm === "help" || norm.includes("ድጋፍ") || norm.includes("support")) {
      await this.cmdSupport(chatId);
      return;
    }
    if (norm.includes("ደንቦች") || norm === "rules" || norm.includes("ህጎች")) {
      await this.cmdRules(chatId);
      return;
    }

    // 3. Ongoing state handling:

    // State: deposit_amount -> user typed a number
    if (state?.step === "deposit_amount") {
      const match = text.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
      const amount = match ? Number(match[1]) : 0;
      if (amount <= 0 || isNaN(amount)) {
        await this.sendMessage(chatId, "⚠️ <b>ትክክለኛ የብር መጠን ያስገቡ</b> (ለምሳሌ፡ 100):", {
          reply_markup: {
            inline_keyboard: [[{ text: "❌ አቋርጥ", callback_data: "cmd_cancel" }]]
          }
        });
        return;
      }
      await this.cmdDepositStep3_Method(chatId, state?.target || "🎮 Main Game", amount);
      return;
    }

    // State: deposit_method -> user typed a method name
    if (state?.step === "deposit_method") {
      const method = norm.includes("cbe") ? "CBE Birr" :
                     (norm.includes("mpesa") || norm.includes("pesa")) ? "MPesa" :
                     (norm.includes("ebirr") || norm.includes("e-birr")) ? "E-Birr" : "TeleBirr";
      await this.cmdDepositStep4_Instruction(chatId, user, method);
      return;
    }

    // State: deposit_confirm -> user typed/pasted Txn ID
    if (state?.step === "deposit_confirm" || text === "1") {
      await this.cmdDepositComplete(chatId, user, text);
      return;
    }

    // State: withdraw_amount -> user typed an amount to withdraw
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

    // State: withdraw_account -> user typed receiver phone/account number
    if (state?.step === "withdraw_account") {
      await this.cmdWithdrawComplete(chatId, user, text);
      return;
    }

    // If user typed a random number and not in state, treat as deposit amount prompt
    const standaloneNum = text.match(/^([0-9]{2,5})$/);
    if (standaloneNum) {
      const amt = Number(standaloneNum[1]);
      if (amt >= 10) {
        await this.cmdDepositStep3_Method(chatId, "🎮 Main Game", amt);
        return;
      }
    }

    // Fallback: Show Main Menu
    await this.sendMessage(
      chatId,
      `👋 <b>እንደምን አደሩ/ዋሉ ${user ? user.name : "ተጫዋች"}!</b>\n\nከታች ያሉትን ቁልፎች በመጠቀም መጫወት፣ ሂሳብ መሙላት ወይም ወጪ ማድረግ ይችላሉ:`,
      { reply_markup: this.getMainKeyboard() }
    );
  }

  async getOrCreateTelegramUser(tgUser) {
    if (!tgUser) return null;
    const tgId = tgUser.id;
    const tgUsername = tgUser.username || "";
    const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || `TG_${tgId}`;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Check if user exists by telegram_id
      const res = await client.query(
        "SELECT u.*, w.main_balance, w.vip_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.telegram_id = $1",
        [tgId]
      );
      if (res.rows.length) {
        await client.query("COMMIT");
        return res.rows[0];
      }

      // Check if temporary phone placeholder
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

      // Create new user for this telegram player
      const dummyPassword = crypto.randomBytes(16).toString("hex");
      const insertUser = await client.query(
        "INSERT INTO users (name, phone, password_hash, role, telegram_id, telegram_username) VALUES ($1, $2, $3, 'PLAYER', $4, $5) RETURNING *",
        [name, placeholderPhone, dummyPassword, tgId, tgUsername]
      );
      const newUser = insertUser.rows[0];
      // New user starts with 0.00 ETB - players must deposit before playing
      await client.query(
        "INSERT INTO wallets (user_id, main_balance) VALUES ($1, 0.00) ON CONFLICT (user_id) DO NOTHING",
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

  async cmdStart(chatId, from, user, isGroup) {
    let balance = 0;
    try {
      if (user?.id) {
        const balRow = (await this.pool.query("SELECT main_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
        balance = Number(balRow?.main_balance ?? user.main_balance ?? 0);
      }
    } catch (e) {
      balance = Number(user?.main_balance || 0);
    }

    const userName = user ? user.name : (from.first_name || "ተጫዋች");
    const playUrl = await this.getWebAppUrl(user);

    if (balance <= 0) {
      const text = `🎉 <b>እንኳን ወደ ሁሉ ቢንጎ (HULU BINGO) በደህና መጡ!</b>\n\n` +
        `👤 ተጫዋች: <b>${userName}</b>\n` +
        `💰 ቀሪ ሂሳብ: <b>0.00 ETB</b>\n\n` +
        `⚠️ <b>ጨዋታ ከመጀመርዎ በፊት እባክዎ መጀመሪያ ሂሳብዎን ይሙሉ (Deposit ያድርጉ)!</b>\n` +
        `ትኬት ለመቁረጥ እና ለመጫወት መጀመሪያ በ TeleBirr፣ CBE Birr፣ MPesa ወይም E-Birr ሂሳብ ያስገቡ።\n\n` +
        `ከታች ያለውን <b>"💰 ሂሳብ ገቢ አድርግ (Deposit Fund)"</b> ይጫኑ ወይም ጨዋታውን ለመክፈት <b>"🎮 ጨዋታውን ይክፈቱ"</b> ይጫኑ:`;

      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 ሂሳብ ገቢ አድርግ (Deposit Fund)", callback_data: "cmd_deposit" }],
            [{ text: "🎮 ጨዋታውን ይክፈቱ (Open Web Game)", web_app: { url: playUrl } }],
            [
              { text: "📤 ወጪ ለማድረግ", callback_data: "cmd_withdraw" },
              { text: "🆘 እርዳታ (Support)", callback_data: "cmd_support" }
            ]
          ]
        }
      });
    } else {
      const text = `🎉 <b>እንኳን ወደ ሁሉ ቢንጎ (HULU BINGO) በደህና መጡ!</b>\n\n` +
        `👤 ተጫዋች: <b>${userName}</b>\n` +
        `💰 ቀሪ ሂሳብ: <b>${balance.toFixed(2)} ETB</b>\n\n` +
        `✅ <b>ሂሳብዎ ዝግጁ ነው!</b> ጨዋታውን ለመጀመር ከታች ያለውን <b>"🎮 ጨዋታውን ጀምር (Start Playing)"</b> ይጫኑ፡`;

      await this.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎮 ጨዋታውን ጀምር (Start Playing)", web_app: { url: playUrl } }],
            [{ text: "💰 ተጨማሪ ገቢ አድርግ (Deposit)", callback_data: "cmd_deposit" }],
            [
              { text: "📤 ወጪ አድርግ (Withdraw)", callback_data: "cmd_withdraw" },
              { text: "🆘 እርዳታ (Support)", callback_data: "cmd_support" }
            ]
          ]
        }
      });
    }

    if (!isGroup) {
      await this.sendMessage(chatId, `📋 ከታች ባለው ሜኑ አማራጮችን መጠቀም ይችላሉ:`, {
        reply_markup: this.getMainKeyboard(playUrl)
      });
    }
  }

  async cmdHelp(chatId, isGroup) {
    const text = `ℹ️ <b>የ HABESHA BINGO ጨዋታ መመሪያዎች</b>\n\n` +
      `1️⃣ <b>ትኬት መቁረጥ:</b> <b>/play</b> ወይም <b>/buy</b> ሲሉ ከሂሳብዎ የመግቢያ ክፍያ ተቀንሶ 5x5 የቢንጎ ካርድ ይሰጥዎታል።\n` +
      `2️⃣ <b>ቁጥሮች መጠራት:</b> ሲስተሙ በየ 5 ሰከንዱ አዳዲስ ቁጥሮችን ይጠራል፤ እዚህ ግሩፕ ላይ በቅጽበት ይለጠፋሉ።\n` +
      `3️⃣ <b>ቢንጎ ማሸነፍ:</b> በካርድዎ ላይ 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ ሲሞሉ ወዲያውኑ <b>/bingo</b> ይበሉ!\n` +
      `4️⃣ <b>ሽልማት:</b> ሲስተሙ ትኬቱን አረጋግጦ አሸናፊውን ሽልማት በቀጥታ ወደ ዋሌትዎ ያስገባል!`;
    await this.sendMessage(chatId, text);
  }

  async cmdSupport(chatId) {
    this.userState.set(chatId, { step: "support" });
    const text = `🆘 <b>ሁሉ ቢንጎ እርዳታ (Support)</b>\n\n` +
      `👤 <b>Admin:</b> adissu\n` +
      `📞 <b>ስልክ:</b> <code>0919307468</code>\n\n` +
      `👇 <b>ወይም እዚሁ ይጻፉ:</b>\n` +
      `መልእክትዎን እዚሁ መጻፍ ይችላሉ፣ ለ አድሚን በቀጥታ ይደርሳል።`;
    await this.sendMessage(chatId, text, {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "መልእክትዎን እዚህ ይጻፉ..."
      }
    });
  }

  async notifyDepositApproved(userId, amount, method) {
    if (!this.pool || !userId) return;
    try {
      const uRes = await this.pool.query(
        "SELECT u.telegram_id, u.name, u.phone, u.role, w.main_balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1",
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
        `🔢 እስካሁን የተጠሩ ቁጥሮች ብዛት: <b>${called.length}</b>\n\n` +
        `ለመቀላቀል <b>/play</b> ይጫኑ!`;

      await this.sendMessage(chatId, text);
    } catch (e) {
      await this.sendMessage(chatId, "⚠️ የጨዋታውን መረጃ ማግኘት አልተቻለም: " + e.message);
    }
  }

  async cmdJoinGame(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ እባክዎ መጀመሪያ /start በማለት አካውንትዎን ያግብሩ።");
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [390711]);

      let g = (await client.query("SELECT * FROM games WHERE status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1 FOR UPDATE")).rows[0];
      if (!g) {
        const createGame = await client.query("INSERT INTO games(name, entry) VALUES('Main Game', 10.00) RETURNING *");
        g = createGame.rows[0];
      }

      if (g.status !== "waiting") {
        await client.query("ROLLBACK");
        await this.sendMessage(chatId, "⚠️ ጨዋታው አስቀድሞ ተጀምሯል! እባክዎ ይህ ዙር እስኪያልቅ ይጠብቁ።");
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
      const entryFee = Number(g.entry);
      if (!walletRow || Number(walletRow.main_balance) < entryFee) {
        await client.query("ROLLBACK");
        await this.sendMessage(
          chatId,
          `❌ <b>ቀሪ ሂሳብዎ በቂ አይደለም!</b>\nየመግቢያ ክፍያ: <b>${entryFee.toFixed(2)} ETB</b>\nየእርስዎ ሂሳብ: <b>${Number(walletRow?.main_balance || 0).toFixed(2)} ETB</b>`
        );
        return;
      }

      // Deduct entry
      const newBal = Math.round((Number(walletRow.main_balance) - entryFee) * 100) / 100;
      await client.query("UPDATE wallets SET main_balance = $1, updated_at = now() WHERE user_id = $2", [newBal, user.id]);
      await client.query(
        "INSERT INTO transactions (user_id, type, wallet, amount, balance_before, balance_after, status, method, reference) VALUES ($1, 'game_entry', 'main', $2, $3, $4, 'completed', 'telegram', $5)",
        [user.id, -entryFee, Number(walletRow.main_balance), newBal, "Telegram Game #" + g.id]
      );

      // Generate Ticket
      const ticketNumbers = this.generateRandomTicket();
      await client.query(
        "INSERT INTO tickets (game_id, user_id, numbers) VALUES ($1, $2, $3)",
        [g.id, user.id, JSON.stringify(ticketNumbers)]
      );

      // Count players & update prize pool
      const pCount = (await client.query("SELECT COUNT(*)::int AS count FROM tickets WHERE game_id = $1", [g.id])).rows[0].count;
      const feePer = pCount > 3 ? 2 : 0;
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
        `🏷 ጨዋታ: <b>#${g.id}</b>\n` +
        `🏆 የሽልማት ፈንድ: <b>${prizePool.toFixed(2)} ETB</b>\n\n` +
        `<b>የእርስዎ የቢንጎ ካርድ ቁጥሮች:</b>\n<pre>${cardGrid}</pre>\n\n` +
        `ቁጥሮች መውጣት ጀምረዋል። መስመር ሲሞሉ ወዲያውኑ <b>/bingo</b> ይበሉ!`
      );

      // Broadcast update to web socket and telegram group
      if (this.io) {
        this.io.to("game:" + g.id).emit("update", {
          ...g,
          players: pCount,
          prize_pool: prizePool
        });
      }

      // Notify the group of a new player joining if this was in private chat
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
      await this.sendMessage(chatId, "ℹ️ ለጨዋታ #" + g.id + " ትኬት አልቆረጡም። ትኬት ለመቁረጥ <b>/play</b> ይጫኑ።");
      return;
    }
    const called = g.called_numbers || [];
    const cardGrid = this.formatCardGrid(t.numbers, called);
    await this.sendMessage(
      chatId,
      `🎟 <b>የእርስዎ የቢንጎ ካርድ (ጨዋታ #${g.id})</b>\n\n` +
      `[ * ምልክት የተጠራውን ቁጥር ያመለክታል ]\n\n` +
      `<pre>${cardGrid}</pre>\n\n` +
      `የተጠሩ ቁጥሮች ብዛት: <b>${called.length}</b>\n` +
      `መስመር ከሞሉ <b>/bingo</b> በማለት ያሸንፉ!`
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
      await client.query(
        "INSERT INTO winners (game_id, user_id, prize_amount, ticket_snapshot) VALUES ($1, $2, $3, $4)",
        [g.id, user.id, prize, JSON.stringify(t.numbers)]
      );

      // Deposit prize
      const wallet = (await client.query("SELECT main_balance FROM wallets WHERE user_id = $1 FOR UPDATE", [user.id])).rows[0];
      const newBal = Math.round((Number(wallet.main_balance) + prize) * 100) / 100;
      await client.query("UPDATE wallets SET main_balance = $1, updated_at = now() WHERE user_id = $2", [newBal, user.id]);
      await client.query(
        "INSERT INTO transactions (user_id, type, wallet, amount, balance_before, balance_after, status, method, reference) VALUES ($1, 'prize', 'main', $2, $3, $4, 'completed', 'telegram', $5)",
        [user.id, prize, Number(wallet.main_balance), newBal, "Bingo Prize Game #" + g.id]
      );

      // Finish game
      await client.query(
        "UPDATE games SET status = 'finished', winner_id = $1, winner_ticket = $2, finished_at = now() WHERE id = $3",
        [user.id, JSON.stringify(t.numbers), g.id]
      );

      await client.query("COMMIT");

      // Notify winner & group
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
    // Broadcast every number or every milestone to avoid Telegram flood limits
    // Telegram rate limits to ~20 msgs per minute in groups. We announce every 3 numbers or important milestones, or formatted update
    if (count % 3 === 0 || count <= 5) {
      const lastThree = calledNumbers.slice(-3).reverse().join(", ");
      await this.broadcastToGroup(
        `🎱 <b>ቁጥር ተጠርቷል: [ ${number} ]</b>\n` +
        `🔢 የቅርብ ቁጥሮች: ${lastThree}\n` +
        `📊 የተጠሩት ብዛት: ${count}/600\n` +
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

  // ==================== HELPERS ====================

  generateRandomTicket() {
    const a = Array.from({ length: 600 }, (_, i) => i + 1);
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return [a.slice(0, 5), a.slice(5, 10), a.slice(10, 15), a.slice(15, 20), a.slice(20, 25)];
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
