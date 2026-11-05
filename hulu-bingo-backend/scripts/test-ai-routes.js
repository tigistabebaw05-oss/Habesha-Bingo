require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const assert = require("assert");
const express = require("express");
const aiAdminRoutes = require("../src/modules/ai-admin/ai.routes");

async function runRouteTests() {
  console.log("=".repeat(60));
  console.log("🧪 TESTING HABESHA AI ADMIN EXPRESS ROUTES & MIDDLEWARE");
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

  // Create isolated express test app
  const app = express();
  app.use(express.json());

  // Mock auth injector for testing role boundary
  let mockUser = null;
  app.use((req, res, next) => {
    if (mockUser) {
      req.user = mockUser;
    }
    next();
  });

  app.use("/api/admin/ai", aiAdminRoutes);

  const http = require("http");
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/admin/ai`;

  try {
    // Test 1: Unauthenticated request (no user on req) -> 401
    mockUser = null;
    const res1 = await fetch(`${baseUrl}/status`);
    assert.strictEqual(res1.status, 401, "Unauthenticated request should return 401");
    pass("Role Guard: Rejects unauthenticated request with 401 Authentication Required");

    // Test 2: Standard Player role -> 403
    mockUser = { id: 101, name: "Normal Player", role: "PLAYER" };
    const res2 = await fetch(`${baseUrl}/status`);
    assert.strictEqual(res2.status, 403, "Player role should return 403");
    pass("Role Guard: Rejects PLAYER role with 403 Access Denied");

    // Test 3: Admin role -> 200
    mockUser = { id: 1, name: "Head Admin", role: "ADMIN" };
    const res3 = await fetch(`${baseUrl}/status`);
    assert.strictEqual(res3.status, 200, "ADMIN role should return 200");
    const data3 = await res3.json();
    assert.strictEqual(data3.ok, true);
    assert.strictEqual(data3.service, "HABESHA AI ADMIN");
    assert.strictEqual(data3.ownerProtectionEnabled, true);
    pass("Role Guard: Authorizes ADMIN role with 200 OK and owner shield active");

    // Test 4: Owner role -> 200
    mockUser = { id: 2, name: "System Owner", role: "OWNER" };
    const res4 = await fetch(`${baseUrl}/status`);
    assert.strictEqual(res4.status, 200, "OWNER role should return 200");
    const data4 = await res4.json();
    assert.strictEqual(data4.ok, true);
    pass("Role Guard: Authorizes OWNER role with 200 OK");

    // Test 5: Quick Stats
    mockUser = { id: 1, name: "Admin", role: "ADMIN" };
    const res5 = await fetch(`${baseUrl}/quick-stats`);
    assert.strictEqual(res5.status, 200);
    const data5 = await res5.json();
    assert(data5.ok === true && typeof data5.stats === "object", "Quick stats should return stats object");
    pass("Endpoint: GET /quick-stats returns live metrics");

    // Test 6: POST /chat English Command
    const res6 = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Show all pending deposits" })
    });
    assert.strictEqual(res6.status, 200);
    const data6 = await res6.json();
    assert(data6.ok === true && typeof data6.reply === "string", "Chat should return valid reply");
    pass("Endpoint: POST /chat handles English commands");

    // Test 7: POST /chat Amharic Command
    const res7 = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "ያልተረጋገጡ የገቢ ጥያቄዎችን አሳየኝ" })
    });
    assert.strictEqual(res7.status, 200);
    const data7 = await res7.json();
    assert(data7.ok === true && Boolean(data7.replyAmharic || data7.reply), "Chat should return Amharic reply");
    pass("Endpoint: POST /chat handles Amharic commands");

    // Test 8: Empty message validation -> 400
    const res8 = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " })
    });
    assert.strictEqual(res8.status, 400);
    pass("Validation: Empty message returns 400 Bad Request");

  } catch (err) {
    fail("Route integration test exception", err);
  } finally {
    server.close();
  }

  console.log("=".repeat(60));
  console.log(`🏁 ROUTE TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

runRouteTests().then(() => {
  setTimeout(() => process.exit(0), 100);
}).catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
