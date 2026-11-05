const crypto = require("crypto");
const pool = require("../../../db");

// In-memory confirmation token store with automatic expiry
// Structure: Map<tokenString, { action, payload, adminId, expiresAt, createdAt }>
const tokenStore = new Map();

// Cleanup expired tokens every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokenStore.entries()) {
    if (data.expiresAt <= now) {
      tokenStore.delete(token);
    }
  }
}, 60 * 1000);

/**
 * Verifies that the authenticated user is either an ADMIN or an OWNER.
 * Rejects ordinary players immediately.
 */
function requireAdminOrOwner(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const role = String(req.user.role || "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    return res.status(403).json({ error: "Access denied: Administrator or Owner privileges required" });
  }

  next();
}

/**
 * Checks if a given user ID belongs to an OWNER account.
 * Used to shield Owner from AI or Admin modifications.
 */
async function isOwnerAccount(targetUserId) {
  if (!targetUserId) return false;
  try {
    const res = await pool.query("SELECT role FROM users WHERE id = $1", [targetUserId]);
    if (!res.rows[0]) return false;
    return String(res.rows[0].role).toUpperCase() === "OWNER";
  } catch (err) {
    console.error("[AIPermissions] Error checking owner status:", err.message);
    return true; // Fail-safe: assume protected on DB error
  }
}

/**
 * Asserts that target user is not an OWNER.
 * Throws an explicit error if target is an Owner.
 */
async function assertNotOwner(targetUserId) {
  const isOwner = await isOwnerAccount(targetUserId);
  if (isOwner) {
    throw new Error("SECURITY_VIOLATION: Owner accounts are protected and cannot be modified, restricted, or deleted by AI or Admin.");
  }
}

/**
 * Generates an expiring (5 min), single-use confirmation token for sensitive operations.
 */
function createConfirmationToken({ action, payload, adminId, expiresInSeconds = 300 }) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + (expiresInSeconds * 1000);

  tokenStore.set(token, {
    action,
    payload,
    adminId,
    expiresAt,
    createdAt: Date.now()
  });

  return {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInSeconds
  };
}

/**
 * Validates and atomically consumes a single-use confirmation token.
 */
function consumeConfirmationToken(token, adminId) {
  if (!token || typeof token !== "string") {
    throw new Error("INVALID_TOKEN: Missing or invalid confirmation token.");
  }

  const data = tokenStore.get(token);
  if (!data) {
    throw new Error("TOKEN_NOT_FOUND: The confirmation token does not exist or has already been used.");
  }

  if (data.expiresAt < Date.now()) {
    tokenStore.delete(token);
    throw new Error("TOKEN_EXPIRED: The confirmation token has expired. Please re-issue the command.");
  }

  if (Number(data.adminId) !== Number(adminId)) {
    throw new Error("UNAUTHORIZED_ACTOR: Only the administrator who initiated this action may confirm it.");
  }

  // Atomically delete token to enforce single-use
  tokenStore.delete(token);

  return {
    action: data.action,
    payload: data.payload
  };
}

module.exports = {
  requireAdminOrOwner,
  isOwnerAccount,
  assertNotOwner,
  createConfirmationToken,
  consumeConfirmationToken
};
