const crypto = require("crypto");

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

    // Callbacks provided by server.js
    this.gameEngine = null;
  }

  setGameEngine(engine) {
    this.gameEngine = engine;
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
        
        // Configure Telegram Chat Menu Button as WebApp so it opens directly without confirmation
        const webAppUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
        try {
          await this.apiCall("setChatMenuButton", {
            menu_button: {
              type: "web_app",
              text: "🎮 Play Bingo",
              web_app: { url: webAppUrl }
            }
          });
          console.log(`[Telegram] WebApp menu button configured for ${webAppUrl}`);
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
      // 0. Handle bot added to group or promoted
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
        await this.cmdDepositStep1(chatId);
        break;
      case "/help":
        await this.cmdHelp(chatId, isGroup);
        break;
      case "/game":
      case "/status":
        await this.cmdGameStatus(chatId);
        break;
      case "/balance":
      case "/wallet":
        await this.cmdBalance(chatId, user);
        break;
      case "/card":
      case "/ticket":
        await this.cmdMyCard(chatId, user);
        break;
      case "/play":
      case "/join":
      case "/buy":
        await this.cmdJoinGame(chatId, user);
        break;
      case "/bingo":
      case "/claim":
        await this.cmdClaimBingo(chatId, user);
        break;
      case "/link":
        await this.cmdLinkAccount(chatId, user, parts[1], parts[2]);
        break;
      default:
        // Unknown command
        break;
    }
  }

  async cmdDepositStep1(chatId) {
    const text = `📥 <b>ገንዘብ ማስገቢያ (Deposit Fund)</b>\n\nእባክዎ የሚፈልጉትን የጨዋታ አይነት ይምረጡ:`;
    const replyMarkup = {
      keyboard: [
        [{ text: "🎮 ዋናው ጨዋታ" }, { text: "💎 VIP ክፍል" }],
        [{ text: "አቋርጥ" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    };
    await this.sendMessage(chatId, text, { reply_markup: replyMarkup });
  }

  async cmdDepositStep2(chatId) {
    const text = `💳 <b>የክፍያ ዘዴ ይምረጡ (Select Payment Method)</b>\n\nገንዘብ ገቢ (Deposit) ለማድረግ የሚፈልጉትን የክፍያ አማራጭ ይምረጡ:`;
    const replyMarkup = {
      keyboard: [
        [{ text: "TeleBirr" }, { text: "CBE Birr" }],
        [{ text: "MPesa" }, { text: "E-Birr" }],
        [{ text: "አቋርጥ" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    };
    await this.sendMessage(chatId, text, { reply_markup: replyMarkup });
  }

  async cmdDepositPaymentMethod(chatId, user, method) {
    const webAppUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    const text = `💰 <b>በ ${method} ገንዘብ ማስገባት (Deposit via ${method})</b>\n\n` +
      `👤 ተጠቃሚ: <b>${user ? user.name : "ተጫዋች"}</b>\n` +
      `1️⃣ በ ${method} በኩል ወደ ድርጅቱ ሂሳብ ገንዘቡን ያስተላልፉ።\n` +
      `2️⃣ የተላከውን የገንዘብ መጠን እና የግብይት ቁጥር (Txn Reference) በድረ-ገጹ ላይ በማስገባት ገቢ ያድርጉ።\n\n` +
      `ገቢ (Deposit) ለማድረግ ከታች ያለውን ይጫኑ:`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: `📥 በ ${method} ገንዘብ አስገባ (Deposit Now)`, web_app: { url: `${webAppUrl}?action=deposit&method=${encodeURIComponent(method)}` } }
        ]
      ]
    };

    await this.sendMessage(chatId, text, { reply_markup: inlineKeyboard });
  }

  async cmdCancel(chatId) {
    const text = `❌ <b>ተሰርዟል (Operation Cancelled)</b>\n\nወደ ዋናው ሜኑ ተመልሰዋል።`;
    const replyMarkup = {
      keyboard: [
        [{ text: "🎮 ይጫወቱ" }],
        [{ text: "💰 አሸን" }, { text: "📥 በላኩት" }],
        [{ text: "📤 ወጪ ላኩት" }, { text: "🔗 ጋር & አጋር" }],
        [{ text: "💎 VIP ክፍል" }, { text: "🌟 Special Promoter" }],
        [{ text: "🆘 እርዳታ" }, { text: "📜 ደንቦች" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    };
    await this.sendMessage(chatId, text, { reply_markup: replyMarkup });
  }

  async handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    const from = msg.from;
    const user = await this.getOrCreateTelegramUser(from);

    const norm = text.toLowerCase();
    if (norm.includes("ዋናው ጨዋታ") || norm === "🎮 ዋናው ጨዋታ") {
      await this.cmdDepositStep2(chatId);
    } else if (norm === "telebirr" || norm === "cbe birr" || norm === "mpesa" || norm === "m-pesa" || norm === "e-birr" || norm === "ebirr") {
      const method = norm.includes("cbe") ? "CBE Birr" : norm.includes("mpesa") ? "M-Pesa" : norm.includes("ebirr") || norm.includes("e-birr") ? "E-Birr" : "TeleBirr";
      await this.cmdDepositPaymentMethod(chatId, user, method);
    } else if (norm.includes("አቋርጥ") || norm === "cancel") {
      await this.cmdCancel(chatId);
    } else if (norm.includes("በላኩት") || norm.includes("deposit") || norm.includes("ገቢ")) {
      await this.cmdDepositStep1(chatId);
    } else if (norm.includes("ይጫወቱ") || norm.includes("play")) {
      await this.cmdJoinGame(chatId, user);
    } else if (norm.includes("አሸን") || norm.includes("balance") || norm.includes("ቀሪ")) {
      await this.cmdBalance(chatId, user);
    } else if (norm.includes("vip") || norm.includes("ቪአይፒ")) {
      await this.sendMessage(chatId, "💎 <b>VIP ክፍል</b>\n\nለ VIP ተጫዋቾች የተዘጋጀ ልዩ ክፍል! በቅርቡ ክፍት ይሆናል።");
    }
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
      // Give initial starting balance for fun/demo play (50 ETB)
      await client.query(
        "INSERT INTO wallets (user_id, main_balance) VALUES ($1, 50.00) ON CONFLICT (user_id) DO NOTHING",
        [newUser.id]
      );
      await client.query("COMMIT");
      newUser.main_balance = "50.00";
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
    const webAppUrl = process.env.PUBLIC_APP_URL || "https://habesha-bingo-1-3jdi.onrender.com";
    const text = `🎉 <b>እንኳን ወደ HABESHA BINGO በደህና መጡ!</b>\n\n` +
      `👤 ተጫዋች: <b>${user ? user.name : from.first_name}</b>\n` +
      `💰 ቀሪ ሂሳብ: <b>${user ? Number(user.main_balance || 0).toFixed(2) : "0.00"} ETB</b>\n\n` +
      `ይህ ቦት ከ <b>"Hbesha bingo"</b> ግሩፕ እና ከዋናው ድረ-ገጽ ጋር በቀጥታ የተገናኘ ነው።\n\n` +
      `🔹 <b>/play</b> ወይም <b>/buy</b> - ትኬት ቆርጠው ጨዋታውን ይቀላቀሉ\n` +
      `🔹 <b>/card</b> - የቆረጡትን የቢንጎ ካርድ ቁጥሮች ይመልከቱ\n` +
      `🔹 <b>/game</b> - አሁን እየተካሄደ ያለውን ጨዋታ ይመልከቱ\n` +
      `🔹 <b>/bingo</b> - መስመር ሲሞሉ ቢንጎ ብለው ሽልማቱን ይውሰዱ!\n` +
      `🔹 <b>/balance</b> - የዋሌት ቀሪ ሂሳብዎን ይመልከቱ\n` +
      `🔹 <b>/help</b> - የጨዋታ ህጎች እና መመሪያዎች`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: "🎮 በቴሌግራም በቀጥታ ይጫወቱ (Play Bingo)", web_app: { url: webAppUrl } }
        ]
      ]
    };

    await this.sendMessage(chatId, text, { reply_markup: inlineKeyboard });
  }

  async cmdHelp(chatId, isGroup) {
    const text = `ℹ️ <b>የ HABESHA BINGO ጨዋታ መመሪያዎች</b>\n\n` +
      `1️⃣ <b>ትኬት መቁረጥ:</b> <b>/play</b> ወይም <b>/buy</b> ሲሉ ከሂሳብዎ የመግቢያ ክፍያ ተቀንሶ 5x5 የቢንጎ ካርድ ይሰጥዎታል።\n` +
      `2️⃣ <b>ቁጥሮች መጠራት:</b> ሲስተሙ በየ 5 ሰከንዱ አዳዲስ ቁጥሮችን ይጠራል፤ እዚህ ግሩፕ ላይ በቅጽበት ይለጠፋሉ።\n` +
      `3️⃣ <b>ቢንጎ ማሸነፍ:</b> በካርድዎ ላይ 5 ቁጥሮች በአግድም፣ በቁም ወይም በሰያፍ ሲሞሉ ወዲያውኑ <b>/bingo</b> ይበሉ!\n` +
      `4️⃣ <b>ሽልማት:</b> ሲስተሙ ትኬቱን አረጋግጦ አሸናፊውን ሽልማት በቀጥታ ወደ ዋሌትዎ ያስገባል!`;
    await this.sendMessage(chatId, text);
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

  async cmdBalance(chatId, user) {
    if (!user) {
      await this.sendMessage(chatId, "⚠️ መጀመሪያ /start በማድረግ ይመዝገቡ።");
      return;
    }
    const bal = (await this.pool.query("SELECT main_balance, vip_balance FROM wallets WHERE user_id = $1", [user.id])).rows[0];
    const text = `💰 <b>የእርስዎ የዋሌት ቀሪ ሂሳብ</b>\n\n` +
      `👤 ተጠቃሚ: <b>${user.name}</b>\n` +
      `💵 Main Balance: <b>${Number(bal?.main_balance || 0).toFixed(2)} ETB</b>\n` +
      `⭐ VIP Balance: <b>${Number(bal?.vip_balance || 0).toFixed(2)} ETB</b>\n\n` +
      `ገንዘብ ለማስገባት ወይም ወጪ ለማድረግ ድረ-ገጹን ይጎብኙ!`;
    await this.sendMessage(chatId, text);
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
