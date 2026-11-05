/**
 * ============================================================================
 * HABESHA AI ADMIN ASSISTANT - CLIENT CONTROLLER
 * Bilingual (EN/AM), Single-Use Token Confirmations, Real Database Operations
 * ============================================================================
 */

(function () {
  'use strict';

  // API Base URL resolution (matches admin.js)
  const configuredApi = window.HABESHA_API || '';
  const API_BASE = configuredApi ? `${configuredApi}/api` : '/api';

  // State
  let currentLanguage = (localStorage.getItem('habesha_lang') || 'am').toLowerCase() === 'en' ? 'en' : 'am';
  let chatHistory = [];
  let isSending = false;
  let activeConfirmation = null;
  let isAuthorized = false;

  // Bilingual strings
  const I18N = {
    en: {
      assistantName: 'HABESHA AI ADMIN',
      subtitle: 'Intelligent Management System',
      ownerShield: '🛡️ Owner Shield Active',
      statusOnline: 'Online',
      placeholder: 'Ask Habesha AI or issue a command...',
      send: 'Send',
      quick: {
        autoApprove: '⚡ Approve All',
        deposits: '💳 Deposits',
        withdrawals: '💸 Withdrawals',
        finances: '📊 Financial Report',
        support: '💬 Auto Support',
        selfHeal: '🛠️ Self-Heal',
        security: '🔍 Security Scan',
        games: '🎲 Active Games',
        users: '👥 Players'
      },
      welcome: '👋 Hello, Administrator! I am your **Habesha AI Admin Assistant**.\n\nI can execute all administrative duties automatically directly on your live database.\n\n⚡ **Quick Commands:**\n• **"Deposits"** — View pending deposits\n• **"Approve all"** — Auto-approve all valid pending deposits\n• **"Withdrawals"** — View pending withdrawals\n• **"Report"** — Financial report & platform revenue\n• **"Support"** — Auto-reply to customer support tickets\n• **"Self-heal"** — Run health check & system repair\n• **"Security"** — Detect fraud & duplicate payments\n\n*How can I assist you today?*',
      confirmTitle: 'Action Confirmation Required',
      confirmBtn: '✅ Confirm Operation',
      cancelBtn: 'Cancel',
      confirmExpired: 'Confirmation token expired.',
      confirmSuccess: 'Operation successfully executed.',
      errorPrefix: 'Error: '
    },
    am: {
      assistantName: 'ሀበሻ AI አስተዳዳሪ',
      subtitle: 'ዘመናዊ የቁጥጥር ረዳት',
      ownerShield: '🛡️ የባለቤት ጥበቃ ነቅቷል',
      statusOnline: 'ዝግጁ',
      placeholder: 'ትዕዛዝ ወይም ጥያቄ እዚህ ይጻፉ...',
      send: 'ላክ',
      quick: {
        autoApprove: '⚡ ሁሉንም አጽድቅ',
        deposits: '💳 ገቢዎች',
        withdrawals: '💸 ወጪዎች',
        finances: '📊 ሪፖርት',
        support: '💬 24/7 ድጋፍ',
        selfHeal: '🛠️ ራስ-ሰር ጥገና',
        security: '🔍 ደህንነት',
        games: '🎲 ጨዋታዎች',
        users: '👥 ተጠቃሚዎች'
      },
      welcome: '👋 ሰላም አስተዳዳሪ! እኔ የ**ሀበሻ ቢንጎ AI አስተዳዳሪ** ነኝ።\n\n⚡ **24/7 AI Autopilot በርቷል፦**\nያለእርስዎ ትዕዛዝ በየ 10 ሰከንዱ አዳዲስ የገቢ ጥያቄዎችን በራስ-ሰር ያጸድቃል፣ የተጫዋቾችን ዋሌት ይጨምራል፣ የደንበኞች ድጋፍ ይመልሳል፣ እና ጨዋታዎችን ያስተዳድራል!\n\n🔹 **ተጨማሪ ፈጣን ትዕዛዞች፦**\n• **"ገቢ"** — የገቢዎች ሁኔታ እና ሪፖርት\n• **"ወጪ"** — የሚጠብቁ የወጪ ጥያቄዎችን ለማየት\n• **"ሪፖርት"** — የዛሬውን ትርፍ እና ገቢ ሪፖርት ለማውጣት\n• **"ድጋፍ"** — የደንበኞች ጥያቄዎችን ሁኔታ ለማየት\n• **"ጥገና"** — የስርዓት ጤና ምርመራ ለማካሄድ\n• **"ደህንነት"** — አጠራጣሪ ክፍያዎችን ለመመርመር\n\n*ምን ላገልግልዎት?*',
      confirmTitle: 'የማረጋገጫ ፈቃድ ያስፈልጋል',
      confirmBtn: '✅ አረጋግጥና ፈጽም',
      cancelBtn: 'ተመለስ',
      confirmExpired: 'የማረጋገጫ ጊዜው አልፏል።',
      confirmSuccess: 'ክንውኑ በተሳካ ሁኔታ ተፈጽሟል።',
      errorPrefix: 'ስህተት: '
    }
  };

  /**
   * Helper: Escape HTML
   */
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Helper: Lightweight Markdown Parser for safe chat formatting
   */
  function parseMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic: *text*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bullet lists
    const lines = html.split('\n');
    let inList = false;
    const formattedLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*[-•]\s+(.*)$/.test(line)) {
        if (!inList) {
          formattedLines.push('<ul>');
          inList = true;
        }
        formattedLines.push(`<li>${line.replace(/^\s*[-•]\s+/, '')}</li>`);
      } else {
        if (inList) {
          formattedLines.push('</ul>');
          inList = false;
        }
        formattedLines.push(line ? `<p>${line}</p>` : '');
      }
    }
    if (inList) formattedLines.push('</ul>');

    return formattedLines.join('');
  }

  /**
   * Helper: Get stored auth token
   */
  function getToken() {
    return sessionStorage.getItem('hulu_token') || localStorage.getItem('hulu_token') || '';
  }

  /**
   * API Fetch wrapper with authentication
   */
  async function callApi(path, options = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  /**
   * Verify if current user is ADMIN or OWNER
   */
  async function checkAdminAuth() {
    const token = getToken();
    if (!token) return false;
    try {
      const status = await callApi('/admin/ai/status');
      if (status && status.ok) {
        isAuthorized = true;
        return true;
      }
    } catch (e) {
      // Not admin or token expired
    }
    return false;
  }

  /**
   * Build the UI DOM elements
   */
  function buildUi() {
    if (document.getElementById('aiAdminDrawer')) return;

    // 1. Floating Launcher Button (Hidden: metayet yelebetim)
    const launcher = document.createElement('button');
    launcher.id = 'aiAdminLauncherBtn';
    launcher.className = 'ai-admin-launcher-btn';
    launcher.style.display = 'none';
    launcher.setAttribute('aria-hidden', 'true');
    launcher.innerHTML = `
      <div class="ai-bot-avatar">🤖</div>
      <span>HABESHA AI</span>
      <span class="ai-status-dot"></span>
    `;
    launcher.addEventListener('click', toggleDrawer);
    document.body.appendChild(launcher);

    // 2. Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'aiAdminBackdrop';
    backdrop.className = 'ai-admin-backdrop';
    backdrop.addEventListener('click', closeDrawer);
    document.body.appendChild(backdrop);

    // 3. AI Assistant Drawer
    const drawer = document.createElement('aside');
    drawer.id = 'aiAdminDrawer';
    drawer.className = 'ai-admin-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = `
      <!-- Header -->
      <header class="ai-admin-header">
        <div class="ai-admin-brand">
          <div class="ai-admin-brand-icon">🤖</div>
          <div class="ai-admin-title-wrap">
            <h3 id="aiTitle">${I18N[currentLanguage].assistantName}</h3>
            <div class="ai-admin-subtitle">
              <span class="ai-shield-badge">${I18N[currentLanguage].ownerShield}</span>
            </div>
          </div>
        </div>
        <div class="ai-admin-controls">
          <button class="ai-ctrl-btn ai-lang-pill" id="aiLangBtn" title="Switch Language">
            ${currentLanguage === 'en' ? 'አማ' : 'EN'}
          </button>
          <button class="ai-ctrl-btn" id="aiCloseBtn" title="Close" aria-label="Close">✕</button>
        </div>
      </header>

      <!-- Quick Actions -->
      <nav class="ai-quick-actions-bar" id="aiQuickBar" aria-label="Quick Prompts"></nav>

      <!-- Messages Scroll Area -->
      <main class="ai-messages-scroll" id="aiMessagesContainer"></main>

      <!-- Footer / Input Form -->
      <footer class="ai-admin-footer">
        <form class="ai-input-form" id="aiInputForm">
          <textarea
            class="ai-textarea"
            id="aiInputText"
            placeholder="${I18N[currentLanguage].placeholder}"
            rows="1"
            autocomplete="off"
            required
          ></textarea>
          <button type="submit" class="ai-send-btn" id="aiSendBtn" title="Send message">
            ➤
          </button>
        </form>
      </footer>
    `;
    document.body.appendChild(drawer);

    // Wire events
    document.getElementById('aiCloseBtn').addEventListener('click', closeDrawer);
    document.getElementById('aiLangBtn').addEventListener('click', toggleLanguage);
    document.getElementById('aiInputForm').addEventListener('submit', handleSubmit);

    const textarea = document.getElementById('aiInputText');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    });

    renderQuickActions();
    renderWelcomeMessage();
  }

  function renderQuickActions() {
    const bar = document.getElementById('aiQuickBar');
    if (!bar) return;
    const texts = I18N[currentLanguage].quick;

    if (currentLanguage === 'am') {
      bar.innerHTML = `
        <button type="button" class="ai-quick-chip" data-cmd="ሁሉንም አጽድቅ" style="background:rgba(245,183,22,0.22);border-color:var(--habesha-gold,#f5b716);color:#f5b716;font-weight:700;">${texts.autoApprove}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ገቢ">${texts.deposits}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ወጪ">${texts.withdrawals}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ሪፖርት">${texts.finances}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ድጋፍ">${texts.support}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ጥገና">${texts.selfHeal}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ደህንነት">${texts.security}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ጨዋታ">${texts.games}</button>
        <button type="button" class="ai-quick-chip" data-cmd="ተጠቃሚ">${texts.users}</button>
      `;
    } else {
      bar.innerHTML = `
        <button type="button" class="ai-quick-chip" data-cmd="Approve all" style="background:rgba(245,183,22,0.22);border-color:var(--habesha-gold,#f5b716);color:#f5b716;font-weight:700;">${texts.autoApprove}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Show pending deposits">${texts.deposits}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Show pending withdrawals">${texts.withdrawals}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Financial report">${texts.finances}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Process support tickets">${texts.support}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Run system self heal">${texts.selfHeal}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Security threats scan">${texts.security}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Active games overview">${texts.games}</button>
        <button type="button" class="ai-quick-chip" data-cmd="Recent users list">${texts.users}</button>
      `;
    }

    bar.querySelectorAll('.ai-quick-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd');
        if (cmd) sendUserMessage(cmd);
      });
    });
  }

  function renderWelcomeMessage() {
    const container = document.getElementById('aiMessagesContainer');
    if (!container) return;
    container.innerHTML = '';
    appendMessage({
      role: 'assistant',
      text: I18N[currentLanguage].welcome,
      time: new Date()
    });
  }

  function toggleLanguage() {
    currentLanguage = currentLanguage === 'en' ? 'am' : 'en';
    try { localStorage.setItem('habesha_lang', currentLanguage); } catch (_) {}
    const langBtn = document.getElementById('aiLangBtn');
    if (langBtn) langBtn.textContent = currentLanguage === 'en' ? 'አማ' : 'EN';
    const title = document.getElementById('aiTitle');
    if (title) title.textContent = I18N[currentLanguage].assistantName;
    const badge = document.querySelector('.ai-shield-badge');
    if (badge) badge.textContent = I18N[currentLanguage].ownerShield;
    const input = document.getElementById('aiInputText');
    if (input) input.placeholder = I18N[currentLanguage].placeholder;
    renderQuickActions();
  }

  function toggleDrawer() {
    const drawer = document.getElementById('aiAdminDrawer');
    const backdrop = document.getElementById('aiAdminBackdrop');
    if (!drawer) return;
    const isOpen = drawer.classList.contains('open');
    if (isOpen) {
      closeDrawer();
    } else {
      drawer.classList.add('open');
      backdrop.classList.add('active');
      document.getElementById('aiInputText')?.focus();
    }
  }

  function closeDrawer() {
    const drawer = document.getElementById('aiAdminDrawer');
    const backdrop = document.getElementById('aiAdminBackdrop');
    if (drawer) drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }

  function appendMessage({ role, text, time, confirmationToken, actionDetails }) {
    const container = document.getElementById('aiMessagesContainer');
    if (!container) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ${role}`;

    const timeStr = (time || new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const avatar = role === 'user' ? '👤' : '🤖';

    let contentHtml = `<div class="ai-msg-bubble">${parseMarkdown(text)}`;

    // If confirmation is required, add the confirmation card
    if (confirmationToken && actionDetails) {
      contentHtml += `
        <div class="ai-confirmation-card" id="card-${confirmationToken}">
          <div class="ai-conf-header">
            ⚠️ <span>${I18N[currentLanguage].confirmTitle}</span>
          </div>
          <div class="ai-conf-desc">
            ${escapeHtml(actionDetails.description || 'Confirm action')}
          </div>
          <div class="ai-conf-meta">
            <span>Action: <strong>${escapeHtml(actionDetails.type || 'EXECUTE')}</strong></span>
            <span>Target ID: <strong>#${escapeHtml(actionDetails.targetId || '-')}</strong></span>
          </div>
          <div class="ai-conf-actions">
            <button type="button" class="ai-btn-confirm" data-token="${confirmationToken}">
              ${I18N[currentLanguage].confirmBtn}
            </button>
            <button type="button" class="ai-btn-cancel" data-token="${confirmationToken}">
              ${I18N[currentLanguage].cancelBtn}
            </button>
          </div>
        </div>
      `;
    }

    contentHtml += `<div class="ai-msg-time">${timeStr}</div></div>`;

    msgDiv.innerHTML = `
      <div class="ai-msg-avatar">${avatar}</div>
      ${contentHtml}
    `;

    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;

    // Attach confirmation handlers
    if (confirmationToken) {
      const confirmBtn = msgDiv.querySelector(`.ai-btn-confirm[data-token="${confirmationToken}"]`);
      const cancelBtn = msgDiv.querySelector(`.ai-btn-cancel[data-token="${confirmationToken}"]`);

      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => handleConfirmAction(confirmationToken));
      }
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          const card = document.getElementById(`card-${confirmationToken}`);
          if (card) {
            card.innerHTML = `<em style="color:#94a3b8;">${currentLanguage === 'am' ? 'ክንውኑ ተሰርዟል።' : 'Action cancelled.'}</em>`;
          }
        });
      }
    }
  }

  function showTypingIndicator() {
    const container = document.getElementById('aiMessagesContainer');
    if (!container) return;
    const typing = document.createElement('div');
    typing.id = 'aiTypingBubble';
    typing.className = 'ai-message assistant';
    typing.innerHTML = `
      <div class="ai-msg-avatar">🤖</div>
      <div class="ai-typing-indicator">
        <div class="ai-typing-dot"></div>
        <div class="ai-typing-dot"></div>
        <div class="ai-typing-dot"></div>
      </div>
    `;
    container.appendChild(typing);
    container.scrollTop = container.scrollHeight;
  }

  function hideTypingIndicator() {
    const typing = document.getElementById('aiTypingBubble');
    if (typing) typing.remove();
  }

  async function handleConfirmAction(token) {
    const card = document.getElementById(`card-${token}`);
    if (card) {
      card.querySelectorAll('button').forEach(b => (b.disabled = true));
    }

    try {
      showTypingIndicator();
      const result = await callApi('/admin/ai/confirm', {
        method: 'POST',
        body: JSON.stringify({ confirmationToken: token })
      });
      hideTypingIndicator();

      if (card) {
        card.innerHTML = `
          <div style="color:#10b981;font-weight:700;font-size:12px;">
            ✅ ${I18N[currentLanguage].confirmSuccess}
          </div>
          <div style="font-size:11.5px;color:#cbd5e1;margin-top:4px;">
            ${escapeHtml(result.result?.message || 'Done')}
          </div>
        `;
      }
    } catch (err) {
      hideTypingIndicator();
      if (card) {
        card.innerHTML = `
          <div style="color:#ef4444;font-weight:700;font-size:12px;">
            ❌ ${I18N[currentLanguage].errorPrefix}${escapeHtml(err.message)}
          </div>
        `;
      }
    }
  }

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('aiInputText');
    if (!input || isSending) return;
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    await sendUserMessage(text);
  }

  async function sendUserMessage(text) {
    if (isSending) return;
    isSending = true;

    const sendBtn = document.getElementById('aiSendBtn');
    if (sendBtn) sendBtn.disabled = true;

    // Display user bubble
    appendMessage({ role: 'user', text, time: new Date() });
    showTypingIndicator();

    try {
      const response = await callApi('/admin/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          history: chatHistory.slice(-8)
        })
      });

      hideTypingIndicator();

      const isAmharicInput = /[\u1200-\u137F]/.test(text);
      const showAmharic = (currentLanguage === 'am' || isAmharicInput) && Boolean(response.replyAmharic);
      const replyText = showAmharic
        ? response.replyAmharic
        : (response.reply || response.replyAmharic || 'No reply received.');

      appendMessage({
        role: 'assistant',
        text: replyText || 'No reply received.',
        time: new Date(),
        confirmationToken: response.confirmationToken,
        actionDetails: response.data?.actionDetails
      });

      // Update in-memory history
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: replyText });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

    } catch (err) {
      hideTypingIndicator();
      appendMessage({
        role: 'assistant',
        text: `⚠️ **${I18N[currentLanguage].errorPrefix}** ${err.message}`,
        time: new Date()
      });
    } finally {
      isSending = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  /**
   * Periodic check: initialize widget once Admin or Owner logs in
   */
  async function init() {
    const ok = await checkAdminAuth();
    if (ok) {
      buildUi();
    }
  }

  // Run on load and listen for auth changes
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Polling check every 5 seconds for auth state changes (e.g. login/logout)
  setInterval(async () => {
    const launcher = document.getElementById('aiAdminLauncherBtn');
    const token = getToken();
    if (token && !launcher) {
      await init();
    } else if (!token && launcher) {
      launcher.remove();
      document.getElementById('aiAdminDrawer')?.remove();
      document.getElementById('aiAdminBackdrop')?.remove();
    }
  }, 5000);

  // Expose toggle globally for topbar navigation buttons
  window.toggleAiAdmin = toggleDrawer;

})();

