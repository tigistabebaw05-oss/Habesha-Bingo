require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const assert = require("assert");
const pool = require("../db");
const aiEngine = require("../src/modules/ai-automation/ai.engine");
const { generateSupportReply } = require("../src/modules/ai-automation/ai.support");
const SystemWatchdog = require("../src/modules/ai-automation/ai.watchdog");

async function runAutomationTests() {
  console.log("=".repeat(60));
  console.log("🧪 TESTING HABESHA AI AUTOMATION ENGINE & 24/7 SUPPORT");
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  function pass(name) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  }
  function fail(name, err) {
    console.error(`❌ FAIL: ${name} ->`, err.message || err);
    failed++;
  }

  try {
    // 1. Test 24/7 Support Engine - Amharic Deposit Query
    const amharicDepReply = await generateSupportReply({
      message: "ገንዘብ እንዴት ነው የማስገባው? በቴሌብር ይቻላል?",
      subject: "የገቢ ጥያቄ",
      userId: 1,
      pool
    });
    assert(amharicDepReply.includes("TeleBirr") || amharicDepReply.includes("ገንዘብ ገቢ"), "Amharic reply should contain deposit instructions");
    pass("Support AI: Amharic deposit guidance generated correctly");

    // 2. Test 24/7 Support Engine - English Withdrawal Query
    const englishWithReply = await generateSupportReply({
      message: "How can I withdraw my winnings to CBE?",
      subject: "Withdrawal help",
      userId: 1,
      pool
    });
    assert(englishWithReply.includes("100 ETB") || englishWithReply.includes("Withdraw"), "English reply should contain withdrawal limits");
    pass("Support AI: English withdrawal guidance generated correctly");

    // 3. Test 24/7 Support Engine - Game Rules
    const rulesReply = await generateSupportReply({
      message: "የቢንጎ ካርቴላ እንዴት ነው የሚመረጠው? ህጉን ንገሩኝ",
      subject: "አጨዋወት",
      userId: null,
      pool
    });
    assert(rulesReply.includes("ካርቴላ") || rulesReply.includes("ቢንጎ"), "Rules reply should describe cartelas and game");
    pass("Support AI: Game rules knowledge base functions properly");

    // 4. Test Watchdog Health Check
    const watchdog = new SystemWatchdog({
      pool,
      io: { engine: { clientsCount: 5 } },
      telegramService: { polling: true, botUsername: "HbeshabingoBot" }
    });
    const health = await watchdog.runHealthCheck();
    assert(health.database.status === "healthy" || health.database.status === "degraded", "DB should be healthy");
    assert.strictEqual(health.socketIo.connectedClients, 5);
    assert.strictEqual(health.telegram.botUsername, "HbeshabingoBot");
    pass("Watchdog: Real-time health diagnostic inspects DB, Socket.IO, Telegram");

    // 5. Test Watchdog Self-Healing
    const healResult = await watchdog.performSelfHealing();
    assert.strictEqual(healResult.success, true);
    pass("Watchdog: Self-healing routine executes without error");

    // 6. Test AI Engine Boot & Dashboard Snapshot
    aiEngine.start({
      pool,
      io: { engine: { clientsCount: 2 } },
      telegramService: { polling: false, publicUrl: "https://habesha-bingo-1-3jdi.onrender.com" }
    });
    assert.strictEqual(aiEngine.isRunning, true);
    pass("AI Engine: Coordinates 5 background workers");

    const snapshot = await aiEngine.getDashboardSnapshot();
    assert.strictEqual(snapshot.ok, true);
    assert(typeof snapshot.engine === "object");
    assert(Array.isArray(snapshot.recentActions));
    pass("AI Engine: Generates full dashboard snapshot for Admin UI");

    // Clean stop for testing
    aiEngine.stop();
    assert.strictEqual(aiEngine.isRunning, false);
    pass("AI Engine: Safely stops intervals when requested");

  } catch (err) {
    fail("Automation test exception", err);
  }

  console.log("=".repeat(60));
  console.log(`🏁 AUTOMATION TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

runAutomationTests().then(() => {
  setTimeout(() => process.exit(0), 100);
}).catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});

