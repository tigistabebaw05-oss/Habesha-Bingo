require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const assert = require("assert");
const permissions = require("../src/modules/ai-admin/ai.permissions");
const tools = require("../src/modules/ai-admin/ai.tools");
const aiService = require("../src/modules/ai-admin/ai.service");

async function runTests() {
  console.log("=".repeat(60));
  console.log("🧪 TESTING HABESHA AI ADMIN MODULE");
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name} ->`, err.message);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name} ->`, err.message);
      failed++;
    }
  }

  // 1. Permission Tests
  console.log("\n[1/4] Testing Permissions & Owner Shield...");
  test("Confirmation Token lifecycle (Creation & Single-Use Consumption)", () => {
    const { token } = permissions.createConfirmationToken({
      action: "TEST_ACTION",
      payload: { id: 123 },
      adminId: 47,
      expiresInSeconds: 300
    });
    assert(token && token.length === 64, "Token should be 64-char hex string");

    // Consume first time -> should succeed
    const consumed = permissions.consumeConfirmationToken(token, 47);
    assert.strictEqual(consumed.action, "TEST_ACTION");
    assert.strictEqual(consumed.payload.id, 123);

    // Consume second time -> MUST fail (single-use)
    assert.throws(() => {
      permissions.consumeConfirmationToken(token, 47);
    }, /TOKEN_NOT_FOUND/, "Second consumption must throw TOKEN_NOT_FOUND");
  });

  test("Token rejects different admin actor", () => {
    const { token } = permissions.createConfirmationToken({
      action: "SECURE_ACTION",
      payload: {},
      adminId: 47
    });

    assert.throws(() => {
      permissions.consumeConfirmationToken(token, 999); // Wrong admin
    }, /UNAUTHORIZED_ACTOR/, "Should reject different admin");
  });

  // 2. Database Tools Tests
  console.log("\n[2/4] Testing Deterministic Database Tools...");
  await testAsync("tools.getUsersList() queries database without error", async () => {
    const res = await tools.getUsersList({ limit: 5 });
    assert(typeof res.total === "number", "Should return total count");
    assert(Array.isArray(res.users), "Should return users array");
  });

  await testAsync("tools.getPendingDeposits() queries database", async () => {
    const deposits = await tools.getPendingDeposits();
    assert(Array.isArray(deposits), "Should return deposits array");
  });

  await testAsync("tools.getPendingWithdrawals() queries database", async () => {
    const withdrawals = await tools.getPendingWithdrawals();
    assert(Array.isArray(withdrawals), "Should return withdrawals array");
  });

  await testAsync("tools.getFinancialAnalytics() computes correct metrics", async () => {
    const res = await tools.getFinancialAnalytics({ period: "all_time" });
    assert(res.summary, "Should contain summary");
    assert(typeof res.summary.totalDepositsETB === "number", "Deposits should be number");
    assert(typeof res.summary.platformFeeRevenueETB === "number", "Platform fee should be number");
  });

  await testAsync("tools.detectSecurityThreats() runs security audit", async () => {
    const threats = await tools.detectSecurityThreats();
    assert(typeof threats.threatCount === "number", "Threat count should be number");
    assert(Array.isArray(threats.threats), "Threats should be array");
  });

  // 3. AI Service Natural Language Processing
  console.log("\n[3/4] Testing English & Amharic Natural Language Commands...");
  const mockAdmin = { id: 47, name: "adissu", role: "ADMIN" };

  await testAsync("English Command: 'Show all pending deposits'", async () => {
    const res = await aiService.processAdminMessage({
      message: "Show all pending deposits",
      adminUser: mockAdmin
    });
    assert(res && res.reply, "Should return a reply");
    assert(res.data, "Should return data payload");
  });

  await testAsync("Amharic Command: 'ያልተረጋገጡ የገቢ ጥያቄዎችን አሳየኝ'", async () => {
    const res = await aiService.processAdminMessage({
      message: "ያልተረጋገጡ የገቢ ጥያቄዎችን አሳየኝ",
      adminUser: mockAdmin
    });
    assert(res && res.reply, "Should return a reply");
  });

  await testAsync("English Command: 'Generate financial report'", async () => {
    const res = await aiService.processAdminMessage({
      message: "Generate monthly financial report",
      adminUser: mockAdmin
    });
    assert(res.reply.includes("FINANCIAL REPORT"), "Reply should include financial report");
  });

  await testAsync("Amharic Command: 'አጠራጣሪ እንቅስቃሴዎችን መርምር'", async () => {
    const res = await aiService.processAdminMessage({
      message: "አጠራጣሪ እንቅስቃሴዎችን መርምር",
      adminUser: mockAdmin
    });
    assert(res.reply.includes("SECURITY") || res.reply.includes("Audit Complete"), "Should run security scan");
  });

  // 4. Two-Step Action Confirmation Verification
  console.log("\n[4/4] Testing Two-Step Confirmation Workflow...");
  await testAsync("Intent: 'Approve deposit #99999' handles missing tx safely", async () => {
    const res = await aiService.processAdminMessage({
      message: "Approve deposit #99999",
      adminUser: mockAdmin
    });
    assert(res.reply.includes("Cannot Approve") || res.reply.includes("TRANSACTION_NOT_FOUND"), "Should safely report not found");
  });

  console.log("\n" + "=".repeat(60));
  console.log(`🏁 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});

