/**
 * ============================================================================
 * HABESHA BINGO - CONTINUOUS HEALTH WATCHDOG & SELF-HEALING ENGINE
 * Monitors DB, Socket.IO, Telegram Bot, Game Loops, and Executes Safe Recoveries
 * ============================================================================
 */

class SystemWatchdog {
  constructor({ pool, io, telegramService }) {
    this.pool = pool;
    this.io = io;
    this.telegramService = telegramService;
    this.metrics = {
      database: { status: "unknown", latencyMs: 0, lastCheck: null },
      socketIo: { status: "unknown", connectedClients: 0, lastCheck: null },
      telegram: { status: "unknown", botUsername: "HbeshabingoBot", mode: "unknown", lastCheck: null },
      gameEngine: { status: "unknown", currentGameId: null, state: "unknown", lastCheck: null },
      memory: { heapUsedMb: 0, rssMb: 0 },
      uptimeSeconds: 0,
      selfHealsExecuted: 0
    };
  }

  /**
   * Run full system diagnostic
   */
  async runHealthCheck() {
    const now = new Date();

    // 1. Database Health
    try {
      const t0 = Date.now();
      await this.pool.query("SELECT 1");
      const latency = Date.now() - t0;
      this.metrics.database = {
        status: latency < 1500 ? "healthy" : "degraded",
        latencyMs: latency,
        lastCheck: now
      };
    } catch (dbErr) {
      this.metrics.database = {
        status: "down",
        error: dbErr.message,
        latencyMs: -1,
        lastCheck: now
      };
    }

    // 2. Socket.IO Health
    try {
      const clientsCount = this.io?.engine?.clientsCount || 0;
      this.metrics.socketIo = {
        status: "healthy",
        connectedClients: clientsCount,
        lastCheck: now
      };
    } catch (sockErr) {
      this.metrics.socketIo = {
        status: "error",
        error: sockErr.message,
        connectedClients: 0,
        lastCheck: now
      };
    }

    // 3. Telegram Bot Health
    try {
      if (this.telegramService) {
        const isPolling = Boolean(this.telegramService.polling);
        const webhookUrl = this.telegramService.publicUrl;
        this.metrics.telegram = {
          status: "healthy",
          botUsername: this.telegramService.botUsername || "HbeshabingoBot",
          mode: isPolling ? "polling" : "webhook",
          lastCheck: now
        };
      } else {
        this.metrics.telegram = { status: "unconfigured", lastCheck: now };
      }
    } catch (tgErr) {
      this.metrics.telegram = { status: "degraded", error: tgErr.message, lastCheck: now };
    }

    // 4. Game Engine Health & Stuck Game Detection
    try {
      const gameRow = (await this.pool.query(
        "SELECT id, name, status, prize_pool, current_number, jsonb_array_length(called_numbers) as called_count, created_at, updated_at FROM games WHERE status IN ('waiting','running') ORDER BY id DESC LIMIT 1"
      )).rows[0];

      if (gameRow) {
        this.metrics.gameEngine = {
          status: "healthy",
          currentGameId: gameRow.id,
          state: gameRow.status,
          prizePool: Number(gameRow.prize_pool || 0),
          calledCount: Number(gameRow.called_count || 0),
          lastCheck: now
        };
      } else {
        this.metrics.gameEngine = {
          status: "idle",
          currentGameId: null,
          state: "none_active",
          lastCheck: now
        };
      }
    } catch (gErr) {
      this.metrics.gameEngine = { status: "error", error: gErr.message, lastCheck: now };
    }

    // 5. Node Process Metrics
    const mem = process.memoryUsage();
    this.metrics.memory = {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024)
    };
    this.metrics.uptimeSeconds = Math.round(process.uptime());

    return this.metrics;
  }

  /**
   * Self-Healing Safe Recovery Check
   */
  async performSelfHealing() {
    const actionsTaken = [];

    // 1. Auto-create game if none is active
    try {
      const activeGame = (await this.pool.query(
        "SELECT id, status FROM games WHERE status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1"
      )).rows[0];

      if (!activeGame) {
        const newGame = (await this.pool.query(
          "INSERT INTO games(name, entry, status, prize_pool, platform_fee, current_number, called_numbers) VALUES('Main Game', 10, 'waiting', 0, 0, NULL, '[]'::jsonb) RETURNING id"
        )).rows[0];

        actionsTaken.push(`Created new active game #${newGame.id} (status: waiting)`);
        await this.logAudit("AI_WATCHDOG_HEAL", "games", newGame.id, {
          reason: "No active game was found in database. Initialized clean waiting round."
        });
      }
    } catch (e) {
      console.warn("[AIWatchdog] Auto-game healing note:", e.message);
    }

    // 2. Clean expired password reset tokens and old unused confirmation tokens
    try {
      const cleanedTokens = await this.pool.query(
        "DELETE FROM password_reset_tokens WHERE expires_at < now() - INTERVAL '1 day'"
      );
      if (cleanedTokens.rowCount > 0) {
        actionsTaken.push(`Cleaned ${cleanedTokens.rowCount} expired password reset tokens`);
      }
    } catch (e) {
      // Table may not have old tokens
    }

    // 3. Verify Telegram bot watchdog
    try {
      if (this.telegramService && typeof this.telegramService.startWatchdog === "function") {
        if (!this.telegramService.watchdogInterval) {
          this.telegramService.startWatchdog();
          actionsTaken.push("Re-anchored Telegram Bot auto-recovery watchdog");
        }
      }
    } catch (_) {}

    if (actionsTaken.length > 0) {
      this.metrics.selfHealsExecuted += actionsTaken.length;
      console.log("[AIWatchdog] 🛡️ Self-healing actions executed:", actionsTaken);
    }

    return { success: true, actions: actionsTaken, timestamp: new Date() };
  }

  async logAudit(action, entityType, entityId, details) {
    try {
      await this.pool.query(
        "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
        [1, action, entityType, entityId, JSON.stringify(details), "127.0.0.1"]
      );
    } catch (_) {}
  }
}

module.exports = SystemWatchdog;

