/**
 * ============================================================================
 * HABESHA BINGO - 24/7 AI CUSTOMER SUPPORT ENGINE
 * Bilingual (Amharic & English), Context-Aware, Real Database Lookup
 * ============================================================================
 */

const isEthiopic = (text) => /[\u1200-\u137F]/.test(text || "");

/**
 * Knowledge Base for Habesha Bingo
 */
const KB = {
  am: {
    greeting: "ሰላም ክቡር ደንበኛችን! የሀበሻ ቢንጎ 24/7 የደንበኞች ድጋፍ አገልግሎት ነው።",
    depositSteps: 
      "📥 **ገንዘብ ገቢ ለማድረግ (Deposit Steps):**\n" +
      "1. ወደ 'Wallet' ወይም 'ገቢ' ገጽ ይሂዱ።\n" +
      "2. የክፍያ ዘዴ ይምረጡ (TeleBirr ወይም CBE Birr)።\n" +
      "3. የተሰጠውን የሂሳብ ቁጥር በመጠቀም ገንዘቡን ይላኩ (ዝቅተኛው 10 ETB)።\n" +
      "4. ከባንክ የደረሰዎትን የግብይት ማረጋገጫ ቁጥር (TxID / Transaction ID) አስገብተው 'አረጋግጥ' የሚለውን ይጫኑ።\n" +
      "ሂሳብዎ በደቂቃዎች ውስጥ ገቢ ይደረጋል።",
    withdrawSteps:
      "📤 **ገንዘብ ወጪ ለማድረግ (Withdrawal Steps):**\n" +
      "1. ወደ 'Wallet' ገጽ በመሄድ 'ወጪ አድርግ' የሚለውን ይጫኑ።\n" +
      "2. ዝቅተኛው የማውጫ መጠን **100 ETB** ነው።\n" +
      "3. የክፍያ ዘዴዎን (TeleBirr/CBE) እና ትክክለኛ የስልክ/ሂሳብ ቁጥር ያስገቡ።\n" +
      "4. ጥያቄዎ በአስተዳዳሪው ተረጋግጦ በደቂቃዎች ውስጥ ወደ ሂሳብዎ ይተላለፋል።",
    gameRules:
      "🎮 **የሀበሻ ቢንጎ አጨዋወት (How to Play):**\n" +
      "• ከ1 እስከ 600 ያሉ ካርቴላዎችን መምረጥ ይችላሉ።\n" +
      "• የመግቢያ ክፍያ ለዋናው ጨዋታ 10 ETB፣ ለVIP ጨዋታ 50 ETB ነው።\n" +
      "• የቢንጎ ቁጥሮች ከ1 እስከ 75 በራስ-ሰር በቀጥታ ይጣራሉ።\n" +
      "• በመስመር (አግድም፣ ቁመት፣ ሰያፍ) ወይም ሙሉ ካርቴላ ያሟላ ተጫዋች አሸናፊ (BINGO!) ይሆናል!",
    generalHelp:
      "የተለያዩ ጥያቄዎች ካሉዎት ወይም ተጨማሪ እገዛ ከፈለጉ እባክዎ ጥያቄዎን በግልጽ ይጻፉልን። የድጋፍ ቡድናችን 24/7 ዝግጁ ነው።"
  },
  en: {
    greeting: "Hello, valued player! Welcome to Habesha Bingo 24/7 AI Customer Support.",
    depositSteps:
      "📥 **How to Deposit:**\n" +
      "1. Go to the 'Wallet' tab and select 'Deposit'.\n" +
      "2. Choose your payment method (TeleBirr or CBE Birr).\n" +
      "3. Transfer the amount to the provided receiving account (minimum 10 ETB).\n" +
      "4. Enter the Transaction ID (TxID) from your bank SMS and submit.\n" +
      "Your balance will be credited promptly after verification.",
    withdrawSteps:
      "📤 **How to Withdraw:**\n" +
      "1. Go to the 'Wallet' tab and click 'Withdraw'.\n" +
      "2. Minimum withdrawal amount is **100 ETB**.\n" +
      "3. Enter your payment method, recipient account number, and amount.\n" +
      "4. Requests are verified and disbursed promptly to your account.",
    gameRules:
      "🎮 **How to Play Habesha Bingo:**\n" +
      "• Select your preferred cards from Cartelas #1 through #600.\n" +
      "• Entry fee is 10 ETB for the Main Game and 50 ETB for VIP.\n" +
      "• Numbers from 1 to 75 are announced live.\n" +
      "• Complete a pattern (horizontal, vertical, diagonal, or full house) to win BINGO!",
    generalHelp:
      "If you have further questions or require specific assistance, please let us know. Our 24/7 team is here to assist you."
  }
};

/**
 * Generate intelligent context-aware reply for support message
 */
async function generateSupportReply({ message, subject, userId, pool }) {
  const text = (message || "").toLowerCase() + " " + (subject || "").toLowerCase();
  const amharic = isEthiopic(message) || isEthiopic(subject);
  const lang = amharic ? "am" : "en";
  const kb = KB[lang];

  // Optional: User transaction context lookup
  let txContext = null;
  if (pool && userId) {
    try {
      const txRes = await pool.query(
        `SELECT type, amount, status, method, provider_reference, created_at 
         FROM transactions 
         WHERE user_id = $1 
         ORDER BY id DESC LIMIT 3`,
        [userId]
      );
      txContext = txRes.rows;
    } catch (e) {
      // Non-fatal
    }
  }

  // 1. Check for withdrawal FIRST if withdraw keywords are present
  const isWithdraw = /withdraw|ወጪ|ገንዘብ አውጣ|አልደረሰኝም|ማውጣት|ብር ማውጣት/.test(text);
  if (isWithdraw) {
    let recentWithdrawNote = "";
    if (txContext && txContext.length > 0) {
      const pendingWith = txContext.find(t => t.type === "withdrawal" && t.status === "pending");
      const approvedWith = txContext.find(t => t.type === "withdrawal" && (t.status === "approved" || t.status === "completed"));

      if (pendingWith) {
        if (amharic) {
          recentWithdrawNote = `\n\n📌 **የእርስዎ የወጪ ጥያቄ፡** የ ${Math.abs(Number(pendingWith.amount)).toFixed(2)} ETB የወጪ ጥያቄዎ በመሰራት ላይ ነው። በቅርቡ ይለቀቃል።`;
        } else {
          recentWithdrawNote = `\n\n📌 **Pending Withdrawal:** Your withdrawal of ${Math.abs(Number(pendingWith.amount)).toFixed(2)} ETB is in progress and will be disbursed shortly.`;
        }
      } else if (approvedWith) {
        if (amharic) {
          recentWithdrawNote = `\n\n✅ የቅርብ ጊዜ የ ${Math.abs(Number(approvedWith.amount)).toFixed(2)} ETB የወጪ ጥያቄዎ ተጠናቆ ተልኳል።`;
        } else {
          recentWithdrawNote = `\n\n✅ Your recent withdrawal of ${Math.abs(Number(approvedWith.amount)).toFixed(2)} ETB has been processed and sent.`;
        }
      }
    }
    return `${kb.greeting}\n\n${kb.withdrawSteps}${recentWithdrawNote}`;
  }

  // 2. Check for deposit related queries
  const isDeposit = /deposit|ገቢ|ገንዘብ አስገባ|ብር አስገባ|ቴሌብር|telebirr|cbe/.test(text);
  if (isDeposit) {
    let recentDepositNote = "";
    if (txContext && txContext.length > 0) {
      const pendingDep = txContext.find(t => t.type === "deposit" && t.status === "pending");
      const approvedDep = txContext.find(t => t.type === "deposit" && t.status === "approved");

      if (pendingDep) {
        if (amharic) {
          recentDepositNote = `\n\n📌 **የቅርብ ጊዜ ጥያቄዎ፡** የ ${Math.abs(Number(pendingDep.amount)).toFixed(2)} ETB የገቢ ጥያቄዎ በስርዓቱ ተመዝግቧል፤ በአስተዳዳሪው በደቂቃዎች ውስጥ ተረጋግጦ ይገባል።`;
        } else {
          recentDepositNote = `\n\n📌 **Recent Deposit Notice:** Your deposit of ${Math.abs(Number(pendingDep.amount)).toFixed(2)} ETB is recorded and is currently being verified by admin.`;
        }
      } else if (approvedDep) {
        if (amharic) {
          recentDepositNote = `\n\n✅ **የቅርብ ጊዜ ገቢ፡** የ ${Math.abs(Number(approvedDep.amount)).toFixed(2)} ETB ገቢዎ በተሳካ ሁኔታ ጸድቆ ወደ ዋሌትዎ ገብቷል።`;
        } else {
          recentDepositNote = `\n\n✅ **Recent Deposit:** Your deposit of ${Math.abs(Number(approvedDep.amount)).toFixed(2)} ETB was successfully credited.`;
        }
      }
    }
    return `${kb.greeting}\n\n${kb.depositSteps}${recentDepositNote}`;
  }

  // 3. Check for Game / Rules / Cartela
  if (/play|cartela|game|ደንብ|አጨዋወት|ካርቴላ|ቢንጎ|መግቢያ/.test(text)) {
    return `${kb.greeting}\n\n${kb.gameRules}`;
  }

  // 4. Default helpful resolution
  if (amharic) {
    return (
      `${kb.greeting}\n\n` +
      `መልእክትዎን በትክክል ተቀብለናል:\n` +
      `*"${(message || "").slice(0, 150)}..."*\n\n` +
      `ስለ ገቢ፣ ወጪ፣ ወይም ጨዋታ ተጨማሪ መረጃ ከፈለጉ 'ገቢ'፣ 'ወጪ' ወይም 'አጨዋወት' ብለው መጠየቅ ይችላሉ። እንዲሁም የአስተዳዳሪው ቡድን ጉዳዩን በቅርበት እየተመለከተው ነው።\n\n` +
      `እናመሰግናለን!`
    );
  }

  return (
    `${kb.greeting}\n\n` +
    `We have received your message regarding: "${(subject || "General Inquiry")}".\n\n` +
    `Our AI system has logged your inquiry. If you have questions about deposits, withdrawals, or gameplay rules, we are ready to assist. An admin has also been notified.\n\n` +
    `Thank you for playing Habesha Bingo!`
  );
}

module.exports = {
  generateSupportReply,
  KB
};
