const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAdminOrOwner } = require("./ai.permissions");
const aiController = require("./ai.controller");

const router = express.Router();

// Rate limiting for AI operations (60 requests per 5 minutes per user/IP)
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: { error: "Too many AI requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false
});

router.use(requireAdminOrOwner);

router.get("/status", aiController.getStatus);
router.get("/quick-stats", aiController.getQuickStats);
router.post("/chat", aiLimiter, aiController.handleChatMessage);
router.post("/confirm", aiLimiter, aiController.handleActionConfirmation);

module.exports = router;

