/* ===========================
   U-Pal Frontend — app.js
   =========================== */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────
  let currentLang   = 'en';
  let runningLang   = null;   // server-confirmed conversation language; null until first reply
  let isTyping      = false;
  let selectedStars = 0;
  let helpfulVal    = null;
  let langCorrectVal = null;

  // ── UI Strings ─────────────────────────────────────
  const UI = {
    en: {
      placeholder:      'Ask anything about UWTSD...',
      hint:             'U-Pal uses a knowledge base — answers are pre-written for UWTSD.',
      typing:           'U-Pal is typing',
      error:            'Sorry, something went wrong. Please try again!',
      translateBtn:     '🔄 Translate to Welsh',
      translateBack:    '🔄 Translate back to English',
      langToggleLabel:  'CY',
      langToggleTitle:  'Switch to Welsh / Newid i Gymraeg',
      feedbackBtn:      'Feedback',
      langDetected:     '🏴󠁧󠁢󠁷󠁬󠁳󠁿 Welsh detected — switching to Cymraeg',
      googleForms:      '📋 Open full feedback form (Google Forms)'
    },
    cy: {
      placeholder:      'Gofynnwch unrhyw beth am PCYDDS...',
      hint:             "Mae U-Pal yn defnyddio sylfaen wybodaeth — mae atebion wedi'u hysgrifennu ymlaen llaw ar gyfer PCYDDS.",
      typing:           'Mae U-Pal yn teipio',
      error:            "Sori, aeth rhywbeth o'i le. Rhowch gynnig arall arni!",
      translateBtn:     '🔄 Cyfieithwch i Saesneg',
      translateBack:    '🔄 Cyfieithwch yn ôl i Gymraeg',
      langToggleLabel:  'EN',
      langToggleTitle:  'Switch to English / Newid i Saesneg',
      feedbackBtn:      'Adborth',
      langDetected:     '🏴󠁧󠁢󠁷󠁬󠁳󠁿 Cymraeg wedi ei ganfod — yn newid i Gymraeg',
      googleForms:      '📋 Agorwch y ffurflen adborth lawn (Google Forms)'
    }
  };

  // ── DOM Elements ───────────────────────────────────
  const chatMessages   = document.getElementById('chatMessages');
  const userInput      = document.getElementById('userInput');
  const sendBtn        = document.getElementById('sendBtn');
  const quickReplies   = document.getElementById('quickReplies');
  const langToggle     = document.getElementById('langToggle');
  const langLabel      = document.getElementById('langLabel');
  const inputHint      = document.getElementById('inputHint');
  const feedbackBtn    = document.getElementById('feedbackBtn');
  const feedbackBtnLabel = document.getElementById('feedbackBtnLabel');
  const feedbackModal  = document.getElementById('feedbackModal');
  const modalClose     = document.getElementById('modalClose');
  const starRow        = document.getElementById('starRow');
  const helpfulYes     = document.getElementById('helpfulYes');
  const helpfulNo      = document.getElementById('helpfulNo');
  const langYes        = document.getElementById('langYes');
  const langNo         = document.getElementById('langNo');
  const feedbackSubmit = document.getElementById('feedbackSubmit');
  const feedbackThanks = document.getElementById('feedbackThanks');
  const feedbackComments = document.getElementById('feedbackComments');
  const googleFormsLink = document.getElementById('googleFormsLink');

  // ── Language Switcher ──────────────────────────────
  function setLanguage(lang, silent) {
    currentLang = lang;
    const ui = UI[lang];

    langLabel.textContent    = ui.langToggleLabel;
    langToggle.title         = ui.langToggleTitle;
    langToggle.classList.toggle('active-cy', lang === 'cy');

    userInput.placeholder    = ui.placeholder;
    inputHint.textContent    = ui.hint;
    feedbackBtnLabel.textContent = ui.feedbackBtn;
    document.documentElement.lang = lang;

    if (googleFormsLink) googleFormsLink.textContent = ui.googleForms;

    // chips
    document.querySelectorAll('.chip').forEach(chip => {
      const txt = lang === 'cy' ? chip.dataset.langCy : chip.dataset.langEn;
      if (txt) chip.textContent = txt;
    });

    // welcome message
    const welcomeEn = document.querySelector('.welcome-en');
    const welcomeCy = document.querySelector('.welcome-cy');
    if (welcomeEn) welcomeEn.style.display = lang === 'cy' ? 'none' : '';
    if (welcomeCy) welcomeCy.style.display = lang === 'cy' ? ''     : 'none';

    // feedback modal bilingual labels
    toggleModalLang(lang);
  }

  function toggleModalLang(lang) {
    document.querySelectorAll('.fb-en').forEach(el => el.style.display = lang === 'cy' ? 'none' : '');
    document.querySelectorAll('.fb-cy').forEach(el => el.style.display = lang === 'cy' ? ''     : 'none');
    document.querySelectorAll('.modal-title-en, .modal-sub-en').forEach(el => el.style.display = lang === 'cy' ? 'none' : '');
    document.querySelectorAll('.modal-title-cy, .modal-sub-cy').forEach(el => el.style.display = lang === 'cy' ? ''     : 'none');
  }

  langToggle.addEventListener('click', () => {
    setLanguage(currentLang === 'en' ? 'cy' : 'en');
    userInput.focus();
  });

  // ── Auto Welsh Detection Banner ────────────────────
  function showLangDetectedBanner(detectedLang) {
    if (detectedLang === currentLang) return; // already correct
    const banner = document.createElement('div');
    banner.className = 'lang-banner';
    banner.textContent = UI[detectedLang].langDetected;
    chatMessages.appendChild(banner);
    scrollToBottom();
    // Auto-switch after brief delay
    setTimeout(() => {
      setLanguage(detectedLang);
      banner.remove();
    }, 1200);
  }

  // ── Message Rendering ──────────────────────────────
  function linkify(text) {
    return text.replace(
      /(https?:\/\/[^\s]+|[a-zA-Z0-9\-]+\.(ac\.uk|co\.uk|com|org|gov\.uk)[^\s<]*)/g,
      url => {
        const href = url.startsWith('http') ? url : `https://${url}`;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      }
    );
  }

  function appendUserMessage(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message user-message';
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;
    wrapper.appendChild(content);
    chatMessages.appendChild(wrapper);
    scrollToBottom();
  }

  function appendBotMessage(response, altResponse, detectedLang) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message bot-message';

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = 'U';
    wrapper.appendChild(avatar);

    // Content column (bubble + translate button)
    const col = document.createElement('div');
    col.className = 'bot-col';

    // Bubble
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = linkify(response).replace(/\n/g, '<br>');
    col.appendChild(content);

    // Translate button (only if there's an alt response)
    if (altResponse) {
      const translateBtn = document.createElement('button');
      translateBtn.className = 'translate-btn';
      const targetLang = detectedLang === 'cy' ? 'en' : 'cy';
      translateBtn.textContent = UI[currentLang].translateBtn;
      translateBtn.dataset.showing = detectedLang; // which lang is currently shown

      translateBtn.addEventListener('click', () => {
        const showing = translateBtn.dataset.showing;
        if (showing === detectedLang) {
          // Switch to alt
          content.innerHTML = linkify(altResponse).replace(/\n/g, '<br>');
          translateBtn.textContent = currentLang === 'cy'
            ? UI['cy'].translateBack
            : UI['en'].translateBack;
          translateBtn.dataset.showing = targetLang;
        } else {
          // Switch back to original
          content.innerHTML = linkify(response).replace(/\n/g, '<br>');
          translateBtn.textContent = currentLang === 'cy'
            ? UI['cy'].translateBtn
            : UI['en'].translateBtn;
          translateBtn.dataset.showing = detectedLang;
        }
      });

      col.appendChild(translateBtn);
    }

    wrapper.appendChild(col);
    chatMessages.appendChild(wrapper);
    scrollToBottom();
  }

  function showTypingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.className = 'message bot-message';
    wrapper.id = 'typingIndicator';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = 'U';

    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.setAttribute('aria-label', UI[currentLang].typing);
    indicator.innerHTML = '<span></span><span></span><span></span>';

    wrapper.appendChild(avatar);
    wrapper.appendChild(indicator);
    chatMessages.appendChild(wrapper);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Quick replies: hide after first send ──────────
  let quickRepliesHidden = false;
  function hideQuickReplies() {
    if (quickRepliesHidden || !quickReplies) return;
    quickRepliesHidden = true;
    quickReplies.style.transition = 'opacity 0.3s ease';
    quickReplies.style.opacity = '0';
    setTimeout(() => { quickReplies.style.display = 'none'; }, 300);
  }

  // ── Send Message ───────────────────────────────────
  async function sendMessage(text) {
    if (!text.trim() || isTyping) return;
    isTyping = true;

    hideQuickReplies();
    appendUserMessage(text);
    userInput.value = '';
    sendBtn.disabled = true;
    showTypingIndicator();

    try {
      const [data] = await Promise.all([
        fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text.trim(),
            lang: currentLang,
            runningLang: runningLang
          })
        }).then(r => r.json()),
        new Promise(resolve => setTimeout(resolve, 600))
      ]);

      removeTypingIndicator();

      if (data.error) {
        appendBotMessage(UI[currentLang].error, null, currentLang);
      } else {
        // Remember the language the server settled on — this is what
        // keeps short follow-ups like "ok" / "thanks" in Welsh when the
        // conversation is already Welsh.
        if (data.lang === 'en' || data.lang === 'cy') {
          runningLang = data.lang;
        }
        // Auto-detect Welsh from server response
        if (data.lang && data.lang !== currentLang) {
          showLangDetectedBanner(data.lang);
        }
        appendBotMessage(
          data.response    || UI[currentLang].error,
          data.altResponse || null,
          data.lang        || currentLang
        );
      }
    } catch (err) {
      removeTypingIndicator();
      appendBotMessage(UI[currentLang].error, null, currentLang);
      console.error('U-Pal error:', err);
    } finally {
      isTyping = false;
      sendBtn.disabled = false;
      userInput.focus();
    }
  }

  // ── Event Listeners: input ─────────────────────────
  sendBtn.addEventListener('click', () => sendMessage(userInput.value));
  userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(userInput.value);
    }
  });

  if (quickReplies) {
    quickReplies.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const textToSend = currentLang === 'cy'
        ? (chip.dataset.langCy || chip.textContent.trim())
        : (chip.dataset.langEn || chip.textContent.trim());
      sendMessage(textToSend);
    });
  }

  // ── Feedback Modal ─────────────────────────────────
  function openFeedbackModal() {
    // Reset state
    selectedStars  = 0;
    helpfulVal     = null;
    langCorrectVal = null;
    feedbackComments.value = '';
    feedbackThanks.style.display  = 'none';
    feedbackSubmit.style.display  = '';
    document.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
    [helpfulYes, helpfulNo, langYes, langNo].forEach(b => b.classList.remove('selected'));
    toggleModalLang(currentLang);
    feedbackModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeFeedbackModal() {
    feedbackModal.style.display = 'none';
    document.body.style.overflow = '';
  }

  feedbackBtn.addEventListener('click', openFeedbackModal);
  modalClose.addEventListener('click', closeFeedbackModal);
  feedbackModal.addEventListener('click', e => {
    if (e.target === feedbackModal) closeFeedbackModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeFeedbackModal();
  });

  // Stars
  starRow.addEventListener('click', e => {
    const star = e.target.closest('.star');
    if (!star) return;
    selectedStars = Number(star.dataset.value);
    document.querySelectorAll('.star').forEach((s, i) => {
      s.classList.toggle('active', i < selectedStars);
    });
  });

  // Helpful toggle
  helpfulYes.addEventListener('click', () => {
    helpfulVal = true;
    helpfulYes.classList.add('selected');
    helpfulNo.classList.remove('selected');
  });
  helpfulNo.addEventListener('click', () => {
    helpfulVal = false;
    helpfulNo.classList.add('selected');
    helpfulYes.classList.remove('selected');
  });

  // Language correct toggle
  langYes.addEventListener('click', () => {
    langCorrectVal = true;
    langYes.classList.add('selected');
    langNo.classList.remove('selected');
  });
  langNo.addEventListener('click', () => {
    langCorrectVal = false;
    langNo.classList.add('selected');
    langYes.classList.remove('selected');
  });

  // Submit
  feedbackSubmit.addEventListener('click', async () => {
    if (!selectedStars) {
      starRow.style.animation = 'shake 0.3s ease';
      setTimeout(() => { starRow.style.animation = ''; }, 300);
      return;
    }
    feedbackSubmit.disabled = true;
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          satisfaction:    selectedStars,
          helpfulAnswer:   helpfulVal,
          correctLanguage: langCorrectVal,
          comments:        feedbackComments.value.trim()
        })
      });
    } catch (_) {}

    feedbackSubmit.style.display = 'none';
    feedbackThanks.style.display = '';

    // Sync bilingual thank you
    const enThanks = feedbackThanks.querySelector('.fb-en');
    const cyThanks = feedbackThanks.querySelector('.fb-cy');
    if (enThanks) enThanks.style.display = currentLang === 'cy' ? 'none' : '';
    if (cyThanks) cyThanks.style.display = currentLang === 'cy' ? '' : 'none';

    setTimeout(closeFeedbackModal, 2200);
  });

  // ── Init ───────────────────────────────────────────
  setLanguage('en');
  userInput.focus();

}());
