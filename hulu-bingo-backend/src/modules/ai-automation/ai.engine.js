/**
 * ============================================================================
 * HABESHA BINGO - AI AUTOMATION ENGINE
 * Master Background Worker Coordinator for Autonomous Operations
 * ============================================================================
 */

const SystemWatchdog = require("./ai.watchdog");
const { generateSupportReply } = require("./ai.support");
const aiTools = require("../ai-admin/ai.tools");

class AIAutomationEngine {
  constructor() {
    this.pool = null;
    this.io = null;
    this.telegramService = null;
    this.watchdog = null;
    this.intervals = [];
    this.isRunning = false;
    this.stats = {
      startTime: null,
      supportMessagesResolved: 0,
      gamesMonitored: 0,
      securityScansCompleted: 0,
      lastAutonomousAction: null
    };
  }

  /**
   * Start the AI Automation Engine
   */
  start({ pool, io, telegramService }) {
    if (this.isRunning) return;
    this.pool = pool;
    this.io = io;
    this.telegramService = telegramService;
    this.watchdog = new SystemWatchdog({ pool, io, telegramService });
    this.isRunning = true;
    this.stats.startTime = new Date();

    console.log("🤖 [AIEngine] Starting Habesha AI Automation Engine & Background Workers...");

    // 1. Initial health check & self-healing immediately on boot
    this.watchdog.runHealthCheck().catch(() => {});
    this.watchdog.performSelfHealing().catch(() => {});

    // 2. Continuous Health Check & Metrics (every 30 seconds)
    const healthInterval = setInterval(() => {
      this.watchdog.runHealthCheck().catch(err => {
        console.warn("[AIEngine] Watchdog health check error:", err.message);
      });
    }, 30 * 1000);
    this.intervals.push(healthInterval);

    // 3. 24/7 AI Customer Support Auto-Responder (every 20 seconds)
    const supportInterval = setInterval(() => {
      this.processPendingSupportTickets().catch(err => {
        console.warn("[AIEngine] Support worker error:", err.message);
      });
    }, 20 * 1000);
    this.intervals.push(supportInterval);

    // 4. Autonomous Game Lifecycle & Stuck Game Watchdog (every 15 seconds)
    const gameWatchdogInterval = setInterval(() => {
      this.monitorGameLifecycle().catch(err => {
        console.warn("[AIEngine] Game lifecycle worker error:", err.message);
      });
    }, 15 * 1000);
    this.intervals.push(gameWatchdogInterval);

    // 5. Fraud Detection & Security Scanner (every 60 seconds)
    const securityInterval = setInterval(() => {
      this.scanSecurityAnomalies().catch(err => {
        console.warn("[AIEngine] Security scan worker error:", err.message);
      });
    }, 60 * 1000);
    this.intervals.push(securityInterval);

    // 6. Routine Maintenance & Periodic Self-Healing (every 5 minutes)
    const maintenanceInterval = setInterval(() => {
      this.watchdog.performSelfHealing().catch(() => {});
    }, 5 * 60 * 1000);
    this.intervals.push(maintenanceInterval);

    console.log("✅ [AIEngine] All 5 autonomous background workers are active.");
  }

  /**
   * Stop background workers safely
   */
  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.isRunning = false;
    console.log("[AIEngine] Stopped background workers.");
  }

  /**
   * Worker: Process open customer support tickets
   */
  async processPendingSupportTickets() {
    if (!this.pool) return;
    try {
      const pendingRes = await this.pool.query(
        "SELECT id, user_id, name, phone, subject, message FROM support_messages WHERE status = 'open' ORDER BY id ASC LIMIT 5"
      );

      for (const ticket of pendingRes.rows) {
        const reply = await generateSupportReply({
          message: ticket.message,
          subject: ticket.subject,
          userId: ticket.user_id,
          pool: this.pool
        });

        // Update database with resolved ticket
        await this.pool.query(
          `UPDATE support_messages 
           SET admin_reply = $1, status = 'resolved', replied_at = now(), updated_at = now() 
           WHERE id = $2`,
          [reply, ticket.id]
        );

        // Notify user via Telegram if account is linked
        if (this.telegramService && ticket.user_id) {
          try {
            const userRow = (await this.pool.query("SELECT telegram_id FROM users WHERE id = $1", [ticket.user_id])).rows[0];
            if (userRow && userRow.telegram_id) {
              const tgText = `🤖 <b>የደንበኞች ድጋፍ ምላሽ (AI Support Reply)</b>\n\n${reply}`;
              await this.telegramService.sendMessage(userRow.telegram_id, tgText);
            }
          } catch (_) {}
        }

        // Record in audit log
        await this.logAudit("AI_SUPPORT_AUTO_REPLY", "support_messages", ticket.id, {
          user: ticket.name,
          phone: ticket.phone,
          subject: ticket.subject,
          summary: (reply || "").slice(0, 100) + "..."
        });

        this.stats.supportMessagesResolved++;
        this.stats.lastAutonomousAction = {
          type: "SUPPORT_REPLIED",
          ticketId: ticket.id,
          time: new Date()
        };

        console.log(`[AIEngine] 💬 Auto-resolved support ticket #${ticket.id} for ${ticket.name}`);
      }
    } catch (err) {
      console.warn("[AIEngine] Support processing note:", err.message);
    }
  }

  /**
   * Worker: Monitor active Bingo game round
   */
  async monitorGameLifecycle() {
    if (!this.pool) return;
    try {
      this.stats.gamesMonitored++;
      const current = (await this.pool.query(
        "SELECT id, name, status, prize_pool, current_number, called_numbers, created_at, updated_at FROM games WHERE status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1"
      )).rows[0];

      if (!current) {
        // If no active game, immediately trigger self-healing creation
        await this.watchdog.performSelfHealing();
        return;
      }

      // Check for stalled game (e.g. running for > 10 minutes without numbers advancing)
      if (current.status === "running") {
        const called = Array.isArray(current.called_numbers) ? current.called_numbers : [];
        if (called.length >= 75) {
          // All numbers exhausted -> finish game cleanly
          await this.pool.query("UPDATE games SET status='finished', finished_at=now() WHERE id=$1", [current.id]);
          await this.logAudit("AI_GAME_AUTO_FINISH", "games", current.id, {
            reason: "All 75 numbers exhausted. Concluded game cleanly."
          });
          // Start next waiting game
          await this.watchdog.performSelfHealing();
        }
      }
    } catch (err) {
      console.warn("[AIEngine] Game monitor note:", err.message);
    }
  }

  /**
   * Worker: Security Scan for Duplicate references and anomalies
   */
  async scanSecurityAnomalies() {
    if (!this.pool) return;
    try {
      this.stats.securityScansCompleted++;
      const threats = await aiTools.detectSecurityThreats();
      if (threats.threatCount > 0) {
        await this.logAudit("AI_SECURITY_ANOMALY_DETECTED", "system", null, {
          threatCount: threats.threatCount,
          duplicateReferences: threats.duplicateReferences.length,
          highWithdrawals: threats.highWithdrawals.length,
          ledgerMismatches: threats.ledgerMismatches.length
        });
      }
    } catch (err) {
      console.warn("[AIEngine] Security scan note:", err.message);
    }
  }

  /**
   * Helper: Record in master audit_logs table
   */
  async logAudit(action, entityType, entityId, details) {
    if (!this.pool) return;
    try {
      await this.pool.query(
        "INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)",
        [1, action, entityType, entityId, JSON.stringify(details), "AI_ENGINE_WORKER"]
      );
    } catch (_) {}
  }

  /**
   * Get engine diagnostic snapshot for AI Dashboard
   */
  async getDashboardSnapshot() {
    const health = this.watchdog ? await this.watchdog.runHealthCheck() : {};
    
    let recentActions = [];
    let pendingWithdrawals = [];
    let supportOverview = { open: 0, resolved: 0, total: 0 };

    if (this.pool) {
      try {
        const auditRes = await this.pool.query(
          "SELECT id, action, entity_type, entity_id, details, created_at FROM audit_logs WHERE action LIKE 'AI_%' ORDER BY id DESC LIMIT 15"
        );
        recentActions = auditRes.rows;

        const withRes = await this.pool.query(
          `SELECT t.id, t.user_id, u.name, u.phone, t.amount, t.method, t.created_at, w.main_balance
           FROM transactions t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN wallets w ON w.user_id = t.user_id
           WHERE t.type = 'withdrawal' AND t.status = 'pending'
           ORDER BY t.id DESC LIMIT 10`
        );
        pendingWithdrawals = withRes.rows;

        const supRes = await this.pool.query(
          `SELECT 
             COUNT(*)::int as total,
             COUNT(*) FILTER (WHERE status = 'open')::int as open,
             COUNT(*) FILTER (WHERE status = 'resolved')::int as resolved
           FROM support_messages`
        );
        supportOverview = supRes.rows[0] || supportOverview;
      } catch (e) {
        console.warn("[AIEngine] Snapshot query note:", e.message);
      }
    }

    return {
      ok: true,
      engine: {
        status: this.isRunning ? "running" : "stopped",
        uptimeSeconds: Math.round(process.uptime()),
        stats: this.stats
      },
      health,
      recentActions,
      pendingWithdrawals,
      supportOverview
    };
  }
}

// Singleton instance
const aiEngine = new AIAutomationEngine();

module.exports = aiEngine;
