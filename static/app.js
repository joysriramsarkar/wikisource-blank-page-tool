'use strict';

(() => {
  const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
  const RECENT_KEY = 'ws-blank-recent-v1';
  const SUMMARY_KEY = 'ws-blank-summary-v1';
  const DEFAULT_SUMMARY = (window.BOOT && window.BOOT.defaultSummary) ||
    'বট: নির্ঘণ্ট অনুযায়ী লেখাবিহীন পাতা চিহ্নিত করা হলো';

  const KIND = {
    create: { label: 'তৈরি হবে', cls: 'create' },
    update: { label: 'লেভেল ০ হবে', cls: 'update' },
    done: { label: 'আগেই লেখাবিহীন', cls: 'done' },
    conflict: { label: 'লেখা আছে', cls: 'conflict' },
    redirect: { label: 'পুনর্নির্দেশ', cls: 'redirect' },
  };

  const FILTERS = [
    { id: 'all', label: 'সব' },
    { id: 'create', label: 'তৈরি হবে' },
    { id: 'update', label: 'লেভেল ০ হবে' },
    { id: 'done', label: 'সম্পন্ন' },
    { id: 'issue', label: 'সমস্যা' },
  ];

  const LOADING_STEPS = [
    ['নির্ঘণ্ট পাতা পড়া হচ্ছে…', 'বইয়ের নির্ঘণ্ট ও pagelist বিশ্লেষণ করা হচ্ছে।'],
    ['স্ক্যান ফাইলের পাতা গোনা হচ্ছে…', 'PDF/DjVu ফাইলের মোট পাতা ও ছবির ঠিকানা আনা হচ্ছে।'],
    ['বিদ্যমান পাতা পরীক্ষা করা হচ্ছে…', 'Page: পাতাগুলোর লেখা ও pagequality লেভেল দেখা হচ্ছে।'],
    ['ফাঁকা পাতার তালিকা সাজানো হচ্ছে…', 'শুধু ফাঁকা ও খালি পাতাগুলো আলাদা করা হচ্ছে।'],
  ];

  const state = {
    status: null,
    analysis: null,
    pageMap: new Map(),
    filter: 'all',
    selected: new Set(),
    viewed: new Set(),
    dryRun: true,
    viewerNum: null,
    viewerList: [],
    save: null,
    loadingTimer: null,
    loadingStep: 0,
    toastTimer: null,
    recent: [],
    lastAnalyzeWiki: null,
    analyzing: false,
    search: {
      timer: null,
      requestId: 0,
      results: [],
      active: -1,
      wiki: null,
      query: '',
      open: false,
    },
    browse: { page: 0, perPage: 48 },
  };

  const el = {};

  document.addEventListener('DOMContentLoaded', init);

  // ------------------------------------------------------------------
  // setup
  // ------------------------------------------------------------------

  function init() {
    cacheElements();
    bindEvents();
    loadRecent();
    setDryRun(state.dryRun);
    renderRecent();
    updateBotLink();
    loadStatus().then(maybeAnalyzeFromUrl);
    el.bookInput.focus();
  }

  function cacheElements() {
    el.searchForm = document.getElementById('search-form');
    el.bookInput = document.getElementById('book-input');
    el.searchPop = document.getElementById('search-pop');
    el.analyzeBtn = document.getElementById('analyze-btn');
    el.loading = document.getElementById('loading');
    el.loadingTitle = document.getElementById('loading-title');
    el.loadingSub = document.getElementById('loading-sub');
    el.results = document.getElementById('results');
    el.errorPanel = document.getElementById('error-panel');
    el.errorText = document.getElementById('error-text');
    el.suggestions = document.getElementById('suggestions');
    el.recentBooks = document.getElementById('recent-books');
    el.pasteLink = document.getElementById('paste-link');

    el.loginChip = document.getElementById('login-chip');
    el.loginText = document.getElementById('login-text');
    el.statusDot = document.getElementById('status-dot');
    el.settingsBtn = document.getElementById('settings-btn');

    el.bookTitle = document.getElementById('book-title');
    el.indexLink = document.getElementById('index-link');
    el.fileLink = document.getElementById('file-link');
    el.bookPagecount = document.getElementById('book-pagecount');
    el.progressText = document.getElementById('progress-text');
    el.progressFill = document.getElementById('progress-fill');
    el.progressNote = document.getElementById('progress-note');
    el.stats = document.getElementById('stats');
    el.warnings = document.getElementById('warnings');
    el.filters = document.getElementById('filters');
    el.gallery = document.getElementById('gallery');
    el.galleryCaption = document.getElementById('gallery-caption');
    el.emptyState = document.getElementById('empty-state');
    el.emptyTitle = document.getElementById('empty-title');
    el.emptyText = document.getElementById('empty-text');
    el.emptyReset = document.getElementById('empty-reset');
    el.selectAll = document.getElementById('select-all');
    el.selectNone = document.getElementById('select-none');
    el.browsePages = document.getElementById('browse-pages');

    el.browserModal = document.getElementById('browser-modal');
    el.browserGrid = document.getElementById('browser-grid');
    el.browserRange = document.getElementById('browser-range');
    el.browserPrev = document.getElementById('browser-prev');
    el.browserNext = document.getElementById('browser-next');
    el.browserSubtitle = document.getElementById('browser-subtitle');
    el.browserJump = document.getElementById('browser-jump');
    el.browserJumpForm = document.getElementById('browser-jump-form');
    el.browserClose = el.browserModal.querySelector('[data-close-browser]');

    el.saveBar = document.getElementById('save-bar');
    el.selectedCount = document.getElementById('selected-count');
    el.saveBarNote = document.getElementById('save-bar-note');
    el.dryRunToggle = document.getElementById('dry-run-toggle');
    el.openSave = document.getElementById('open-save');

    el.viewerModal = document.getElementById('viewer-modal');
    el.viewerKicker = document.getElementById('viewer-kicker');
    el.viewerTitle = document.getElementById('viewer-title');
    el.viewerKind = document.getElementById('viewer-kind');
    el.viewerPrev = document.getElementById('viewer-prev');
    el.viewerNext = document.getElementById('viewer-next');
    el.viewerImageWrap = document.getElementById('viewer-image-wrap');
    el.viewerImage = document.getElementById('viewer-image');
    el.viewerSpinner = document.getElementById('viewer-spinner');
    el.viewerImgError = document.getElementById('viewer-img-error');
    el.viewerLevel = document.getElementById('viewer-level');
    el.viewerLabel = document.getElementById('viewer-label');
    el.viewerPosition = document.getElementById('viewer-position');
    el.viewerWikiLink = document.getElementById('viewer-wiki-link');
    el.viewerToggle = document.getElementById('viewer-toggle');
    el.viewerClose = el.viewerModal.querySelector('[data-close-viewer]');

    el.settingsModal = document.getElementById('settings-modal');
    el.settingsStatus = document.getElementById('settings-status');
    el.settingsWiki = document.getElementById('settings-wiki');
    el.settingsUsername = document.getElementById('settings-username');
    el.settingsPassword = document.getElementById('settings-password');
    el.settingsRemember = document.getElementById('settings-remember');
    el.loginForm = document.getElementById('login-form');
    el.loginSubmit = document.getElementById('login-submit');
    el.logoutBtn = document.getElementById('logout-btn');
    el.botPasswordLink = document.getElementById('bot-password-link');
    el.settingsNote = document.getElementById('settings-note');
    el.settingsClose = el.settingsModal.querySelector('[data-close-settings]');

    el.saveModal = document.getElementById('save-modal');
    el.saveSubtitle = document.getElementById('save-subtitle');
    el.saveSetup = document.getElementById('save-setup');
    el.saveSummary = document.getElementById('save-summary');
    el.saveDryRun = document.getElementById('save-dry-run');
    el.saveSummaryInput = document.getElementById('save-summary-input');
    el.saveLoginBox = document.getElementById('save-login-box');
    el.saveLoginNote = document.getElementById('save-login-note');
    el.saveUsername = document.getElementById('save-username');
    el.savePassword = document.getElementById('save-password');
    el.saveLoginBtn = document.getElementById('save-login-btn');
    el.saveViewWarning = document.getElementById('save-view-warning');
    el.saveCancel = document.getElementById('save-cancel');
    el.saveStart = document.getElementById('save-start');
    el.saveProgress = document.getElementById('save-progress');
    el.saveProgressText = document.getElementById('save-progress-text');
    el.saveProgressSub = document.getElementById('save-progress-sub');
    el.saveProgressFill = document.getElementById('save-progress-fill');
    el.saveResults = document.getElementById('save-results');
    el.saveStop = document.getElementById('save-stop');
    el.saveClose = document.getElementById('save-close');
    el.saveCloseBtn = el.saveModal.querySelector('[data-close-save]');

    el.toast = document.getElementById('toast');
    el.footerVersion = document.getElementById('footer-version');
  }

  function bindEvents() {
    el.searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      hideSearchPop();
      analyze(el.bookInput.value, currentWiki());
    });

    el.bookInput.addEventListener('input', onSearchInput);
    el.bookInput.addEventListener('keydown', onSearchKeydown);
    el.searchPop.addEventListener('click', onSearchPopClick);
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.search-field')) hideSearchPop();
    });

    document.querySelectorAll('[data-example]').forEach((button) => {
      button.addEventListener('click', () => {
        hideSearchPop();
        el.bookInput.value = button.dataset.example || '';
        analyze(el.bookInput.value, currentWiki());
      });
    });

    el.pasteLink.addEventListener('click', pasteFromClipboard);

    el.recentBooks.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-recent-index]');
      if (!chip) return;
      const item = state.recent[Number(chip.dataset.recentIndex)];
      if (!item) return;
      hideSearchPop();
      el.bookInput.value = item.title;
      analyze(item.title, item.wiki || currentWiki());
    });

    el.loginChip.addEventListener('click', () => openSettings());
    el.settingsBtn.addEventListener('click', () => openSettings());

    el.filters.addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      state.filter = button.dataset.filter;
      renderFilters();
      renderGallery();
      updateSaveBar();
    });

    el.selectAll.addEventListener('click', selectAll);
    el.selectNone.addEventListener('click', selectNone);
    el.emptyReset.addEventListener('click', () => {
      state.filter = 'all';
      renderFilters();
      renderGallery();
      updateSaveBar();
    });

    el.gallery.addEventListener('click', onGalleryClick);
    el.gallery.addEventListener('change', onGalleryChange);
    el.gallery.addEventListener('keydown', onGalleryKeydown);

    el.browsePages.addEventListener('click', openBrowser);
    el.browserClose.addEventListener('click', closeBrowser);
    el.browserModal.addEventListener('click', (event) => {
      if (event.target === el.browserModal) closeBrowser();
    });
    el.browserPrev.addEventListener('click', () => {
      state.browse.page = Math.max(0, state.browse.page - 1);
      renderBrowser(true);
    });
    el.browserNext.addEventListener('click', () => {
      state.browse.page += 1;
      renderBrowser(true);
    });
    el.browserJumpForm.addEventListener('submit', onBrowserJump);
    el.browserGrid.addEventListener('click', onBrowserGridClick);
    el.browserGrid.addEventListener('keydown', onBrowserGridKeydown);

    el.dryRunToggle.addEventListener('change', () => {
      setDryRun(el.dryRunToggle.checked);
    });
    el.openSave.addEventListener('click', openSaveModal);

    el.viewerClose.addEventListener('click', closeViewer);
    el.viewerPrev.addEventListener('click', () => navigateViewer(-1));
    el.viewerNext.addEventListener('click', () => navigateViewer(1));
    el.viewerImage.addEventListener('click', () => {
      if (!el.viewerImage.getAttribute('src')) return;
      el.viewerImageWrap.classList.toggle('zoomed');
    });
    el.viewerToggle.addEventListener('click', () => {
      const page = state.pageMap.get(state.viewerNum);
      if (!isActionable(page)) return;
      setSelected(page.num, !state.selected.has(page.num));
      updateViewerToggle();
    });

    el.viewerModal.addEventListener('click', (event) => {
      if (event.target === el.viewerModal) closeViewer();
    });

    el.settingsClose.addEventListener('click', closeSettings);
    el.settingsModal.addEventListener('click', (event) => {
      if (event.target === el.settingsModal) closeSettings();
    });
    el.loginForm.addEventListener('submit', onLoginSubmit);
    el.logoutBtn.addEventListener('click', onLogout);
    el.settingsWiki.addEventListener('input', updateBotLink);

    el.saveCloseBtn.addEventListener('click', closeSaveModal);
    el.saveCancel.addEventListener('click', closeSaveModal);
    el.saveClose.addEventListener('click', closeSaveModal);
    el.saveModal.addEventListener('click', (event) => {
      if (event.target === el.saveModal) closeSaveModal();
    });
    el.saveStart.addEventListener('click', startSave);
    el.saveStop.addEventListener('click', stopSave);
    el.saveDryRun.addEventListener('change', () => {
      setDryRun(el.saveDryRun.checked);
      refreshSaveLogin();
    });
    el.saveLoginBtn.addEventListener('click', onInlineLogin);

    document.addEventListener('keydown', onGlobalKeydown);

    el.footerVersion.textContent = 'v1.0';
  }

  // ------------------------------------------------------------------
  // small helpers
  // ------------------------------------------------------------------

  function bn(value) {
    return String(value == null ? '' : value).replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)]);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function currentWiki() {
    return (state.status && state.status.config && state.status.config.wiki) ||
      (window.BOOT && window.BOOT.config && window.BOOT.config.wiki) ||
      'https://bn.wikisource.org';
  }

  function isActionable(page) {
    return !!page &&
      (page.kind === 'create' || page.kind === 'update') &&
      !page.out_of_range;
  }

  function isLoggedInFor(origin) {
    return !!(state.status && state.status.logged_in &&
      state.status.wiki && origin && state.status.wiki === origin);
  }

  function levelLabel(page) {
    if (page.level == null) return 'লেভেল নেই';
    const name = page.level_name ? ` · ${page.level_name}` : '';
    return `লেভেল ${bn(page.level)}${name}`;
  }

  async function api(path, body, options = {}) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tool-Token': window.TOOL_TOKEN,
      },
      body: JSON.stringify(body || {}),
      signal: options.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      const message = (data && data.error) ||
        `অনুরোধ ব্যর্থ হয়েছে (HTTP ${response.status})।`;
      const problem = new Error(message);
      problem.data = data || {};
      problem.status = response.status;
      throw problem;
    }
    return data;
  }

  // ------------------------------------------------------------------
  // status
  // ------------------------------------------------------------------

  async function loadStatus() {
    el.loginText.textContent = 'সংযোগ হচ্ছে…';
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('status failed');
      state.status = await response.json();
    } catch (error) {
      state.status = {
        logged_in: false,
        user: null,
        wiki: (window.BOOT && window.BOOT.config && window.BOOT.config.wiki) || null,
        config: (window.BOOT && window.BOOT.config) || {},
        auto_error: null,
        has_password: false,
      };
    }
    renderStatus();
    fillSettingsFromStatus();
  }

  function renderStatus() {
    const status = state.status || {};
    if (status.logged_in && status.user) {
      el.loginText.textContent = status.user;
      el.loginChip.classList.add('is-online');
      el.loginChip.classList.remove('is-wrong-wiki');
      if (state.analysis && status.wiki && status.wiki !== state.analysis.wiki.origin) {
        el.loginChip.classList.add('is-wrong-wiki');
        el.loginChip.title = 'অন্য উইকিতে লগইন করা আছে — সেটিংসে এই উইকিতে লগইন করুন।';
      } else {
        el.loginChip.title = `${status.user} — লগইন করা আছে`;
      }
    } else {
      el.loginText.textContent = 'লগইন করুন';
      el.loginChip.classList.remove('is-online', 'is-wrong-wiki');
      el.loginChip.title = 'লগইন ও সেটিংস';
    }
  }

  function fillSettingsFromStatus() {
    const config = (state.status && state.status.config) || {};
    if (!el.settingsWiki.value) el.settingsWiki.value = config.wiki || currentWiki();
    if (!el.settingsUsername.value) el.settingsUsername.value = config.username || '';
    el.settingsRemember.checked = !!config.remember;
    updateBotLink();
  }

  // ------------------------------------------------------------------
  // analyze
  // ------------------------------------------------------------------

  async function analyze(input, wiki) {
    if (state.analyzing) return;
    const value = String(input || '').trim();
    if (!value) {
      showToast('বই বা নির্ঘণ্টের নাম লিখুন।', 'error');
      el.bookInput.focus();
      return;
    }
    state.analyzing = true;
    state.lastAnalyzeWiki = wiki || currentWiki();

    el.results.hidden = true;
    el.errorPanel.hidden = true;
    el.saveBar.hidden = true;
    el.loading.hidden = false;
    startLoadingSteps();
    el.analyzeBtn.disabled = true;
    el.analyzeBtn.innerHTML = '<span>বিশ্লেষণ হচ্ছে…</span>';
    el.loading.scrollIntoView({ behavior: 'smooth', block: 'center' });

    try {
      const data = await api('/api/analyze', {
        input: value,
        wiki: state.lastAnalyzeWiki,
      });
      stopLoadingSteps();
      applyAnalysis(data);
    } catch (error) {
      stopLoadingSteps();
      el.loading.hidden = true;
      showAnalyzeError(error);
    } finally {
      state.analyzing = false;
      el.analyzeBtn.disabled = false;
      el.analyzeBtn.innerHTML = '<span>বিশ্লেষণ করুন</span>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    }
  }

  function applyAnalysis(data) {
    state.analysis = data;
    state.pageMap = new Map(data.pages.map((page) => [page.num, page]));
    state.filter = 'all';
    state.selected = new Set(
      data.pages.filter(isActionable).map((page) => page.num)
    );
    state.viewed = new Set();
    state.browse.page = 0;
    hideSearchPop();
    if (!el.browserModal.hidden) closeBrowser();
    recomputeStats();

    el.loading.hidden = true;
    el.saveBar.hidden = false;
    el.results.hidden = false;
    renderAll();
    rememberRecent(data.index.title, data.wiki.origin);
    updateUrl(data.index.title, data.wiki.origin);
    requestAnimationFrame(() => {
      el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showAnalyzeError(error) {
    el.errorPanel.hidden = false;
    el.errorText.textContent = (error && error.message) ||
      'অজানা সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    const suggestions = (error && error.data && error.data.suggestions) || [];
    el.suggestions.innerHTML = '';
    if (suggestions.length) {
      el.suggestions.hidden = false;
      suggestions.forEach((title) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'suggestion-chip';
        button.textContent = title;
        button.addEventListener('click', () => {
          el.bookInput.value = title;
          analyze(title, state.lastAnalyzeWiki || currentWiki());
        });
        el.suggestions.appendChild(button);
      });
    } else {
      el.suggestions.hidden = true;
    }
    el.errorPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ------------------------------------------------------------------
  // live search (Wikisource Index namespace)
  // ------------------------------------------------------------------

  function isUrlValue(value) {
    return /^https?:\/\//i.test((value || '').trim());
  }

  function shortIndexTitle(title) {
    const value = String(title || '');
    const separator = value.indexOf(':');
    return separator >= 0 ? value.slice(separator + 1) : value;
  }

  function buildWikiSearchUrl(query, wiki) {
    let origin = (wiki || currentWiki()).trim();
    if (!/^https?:\/\//i.test(origin)) origin = 'https://' + origin;
    try {
      origin = new URL(origin).origin;
    } catch (error) {
      origin = 'https://bn.wikisource.org';
    }
    return `${origin}/wiki/Special:Search?search=${encodeURIComponent(query)}&ns102=1`;
  }

  function onSearchInput() {
    const value = el.bookInput.value.trim();
    if (state.search.timer) {
      window.clearTimeout(state.search.timer);
      state.search.timer = null;
    }
    if (value.length < 2 || isUrlValue(value)) {
      hideSearchPop();
      return;
    }
    if (state.search.open && state.search.query === value) return;
    state.search.timer = window.setTimeout(() => {
      state.search.timer = null;
      runSearch(value);
    }, 280);
  }

  async function runSearch(query) {
    const requestId = ++state.search.requestId;
    const wiki = currentWiki();
    state.search.wiki = wiki;
    state.search.query = query;
    state.search.active = -1;
    state.search.open = true;
    showSearchLoading();
    try {
      const data = await api('/api/search', { q: query, wiki });
      if (requestId !== state.search.requestId) return;
      if (el.bookInput.value.trim() !== query) return;
      state.search.results = data.results || [];
      state.search.wiki = data.wiki || wiki;
      state.search.open = true;
      renderSearchPop(data);
    } catch (error) {
      if (requestId !== state.search.requestId) return;
      state.search.results = [];
      state.search.open = true;
      renderSearchError(error.message, query);
    }
  }

  function showSearchLoading() {
    el.searchPop.hidden = false;
    el.bookInput.setAttribute('aria-expanded', 'true');
    el.searchPop.innerHTML =
      '<div class="search-loading"><span class="mini-spinner"></span>' +
      'উইকিসংকলনে খোঁজা হচ্ছে…</div>';
  }

  function renderSearchPop(data) {
    const results = data.results || [];
    const searchUrl = data.search_url || buildWikiSearchUrl(data.query, data.wiki);
    if (!results.length) {
      el.searchPop.innerHTML = `
        <div class="search-pop-empty">
          “${esc(data.query || state.search.query)}” — কোনো নির্ঘণ্ট পাতা পাওয়া যায়নি।<br>
          <a href="${esc(searchUrl)}" target="_blank" rel="noopener">উইকিসংকলনে সার্চ করুন ↗</a>
        </div>`;
      el.searchPop.hidden = false;
      el.bookInput.setAttribute('aria-expanded', 'true');
      return;
    }
    el.searchPop.innerHTML = `
      <div class="search-pop-label">উইকিসংকলনের নির্ঘণ্ট</div>
      ${results.map((result, index) => `
        <button type="button" class="search-result" role="option"
                data-search-index="${index}" aria-selected="false">
          <span class="search-result-title">${esc(shortIndexTitle(result.title))}</span>
          ${result.snippet
            ? `<span class="search-result-snippet">${esc(result.snippet)}</span>`
            : '<span class="search-result-source">বইয়ের নির্ঘণ্ট পাতা</span>'}
        </button>
      `).join('')}
      <div class="search-pop-foot">
        <span>${bn(results.length)}টি ফলাফল</span>
        <a href="${esc(searchUrl)}" target="_blank" rel="noopener">সব ফলাফল ↗</a>
      </div>`;
    el.searchPop.hidden = false;
    el.bookInput.setAttribute('aria-expanded', 'true');
    state.search.open = true;
  }

  function renderSearchError(message, query) {
    el.searchPop.hidden = false;
    el.bookInput.setAttribute('aria-expanded', 'true');
    el.searchPop.innerHTML = `
      <div class="search-pop-empty">
        সার্চ করা যায়নি: ${esc(message || 'অজানা সমস্যা')}<br>
        <a href="${esc(buildWikiSearchUrl(query, state.search.wiki || currentWiki()))}"
           target="_blank" rel="noopener">উইকিসংকলনে সরাসরি সার্চ করুন ↗</a>
      </div>`;
  }

  function hideSearchPop() {
    state.search.requestId += 1;
    if (state.search.timer) {
      window.clearTimeout(state.search.timer);
      state.search.timer = null;
    }
    state.search.open = false;
    state.search.active = -1;
    if (el.searchPop) {
      el.searchPop.hidden = true;
      el.searchPop.innerHTML = '';
      el.bookInput.setAttribute('aria-expanded', 'false');
    }
  }

  function setSearchActive(index) {
    const results = el.searchPop.querySelectorAll('.search-result');
    if (!results.length) return;
    const count = results.length;
    state.search.active = ((index % count) + count) % count;
    results.forEach((button, itemIndex) => {
      const active = itemIndex === state.search.active;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    results[state.search.active].scrollIntoView({ block: 'nearest' });
  }

  function onSearchKeydown(event) {
    if (event.key === 'Escape' && state.search.open) {
      hideSearchPop();
      return;
    }
    if (!state.search.open || !state.search.results.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSearchActive(state.search.active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSearchActive(state.search.active - 1);
    } else if (event.key === 'Enter' && state.search.active >= 0) {
      event.preventDefault();
      chooseSearchResult(state.search.active);
    }
  }

  function onSearchPopClick(event) {
    const button = event.target.closest('[data-search-index]');
    if (!button) return;
    chooseSearchResult(Number(button.dataset.searchIndex));
  }

  function chooseSearchResult(index) {
    const result = state.search.results[index];
    if (!result) return;
    const wiki = state.search.wiki || currentWiki();
    el.bookInput.value = result.title;
    hideSearchPop();
    analyze(result.title, wiki);
  }

  function startLoadingSteps() {
    stopLoadingSteps();
    state.loadingStep = 0;
    setLoadingStep(0);
    state.loadingTimer = window.setInterval(() => {
      state.loadingStep = (state.loadingStep + 1) % LOADING_STEPS.length;
      setLoadingStep(state.loadingStep);
    }, 2400);
  }

  function setLoadingStep(index) {
    const step = LOADING_STEPS[index];
    el.loadingTitle.textContent = step[0];
    el.loadingSub.textContent = step[1];
  }

  function stopLoadingSteps() {
    if (state.loadingTimer) {
      window.clearInterval(state.loadingTimer);
      state.loadingTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  function renderAll() {
    if (!state.analysis) return;
    renderBook();
    renderStats();
    renderWarnings();
    renderFilters();
    renderGallery();
    updateSaveBar();
    renderStatus();
  }

  function renderBook() {
    const analysis = state.analysis;
    const stats = analysis.stats;
    el.bookTitle.textContent = analysis.index.title;
    el.indexLink.href = analysis.index.url;
    el.fileLink.href = analysis.index.file_page_url || analysis.index.url;

    const textNote = stats.text_pages
      ? ` · ${bn(stats.text_pages)}টি বিদ্যমান পাতা লেখাসহ বাদ`
      : '';
    el.bookPagecount.textContent =
      `মোট ${bn(analysis.index.pagecount)}টি স্ক্যান পাতা${textNote}`;

    const total = stats.done + stats.pending + stats.conflict + stats.redirect;
    const percent = total ? Math.round((stats.done / total) * 100) : 0;
    el.progressFill.style.width = `${percent}%`;
    el.progressText.textContent = `${bn(stats.done)} / ${bn(total)} সম্পন্ন`;

    if (!total) {
      el.progressNote.textContent = 'এই বইয়ে কোনো ফাঁকা পাতা পাওয়া যায়নি।';
    } else if (stats.pending) {
      el.progressNote.textContent = `${bn(stats.pending)}টি পাতা এখনো বাকি।`;
    } else if (stats.conflict || stats.redirect) {
      el.progressNote.textContent =
        `${bn(stats.conflict + stats.redirect)}টি পাতা হাতে দেখতে হবে।`;
    } else {
      el.progressNote.textContent = 'সব ফাঁকা পাতা লেখাবিহীন হিসেবে চিহ্নিত।';
    }
  }

  function renderStats() {
    const stats = state.analysis.stats;
    const tiles = [
      { label: 'মোট স্ক্যান', value: stats.pagecount, tone: 'neutral' },
      { label: 'ফাঁকা চিহ্নিত', value: stats.marked_blank, tone: 'accent', note: 'pagelist অনুযায়ী' },
      { label: 'তৈরি হবে', value: stats.create, tone: 'create' },
      { label: 'লেভেল ০ হবে', value: stats.update, tone: 'update' },
      { label: 'আগেই লেখাবিহীন', value: stats.done, tone: 'done' },
      { label: 'লেখা আছে', value: stats.conflict, tone: 'conflict', note: 'বাদ দেওয়া হয়েছে' },
    ];
    el.stats.innerHTML = tiles.map((tile) => `
      <div class="stat tone-${tile.tone}">
        <strong>${bn(tile.value || 0)}</strong>
        <span>${esc(tile.label)}</span>
        ${tile.note ? `<small>${esc(tile.note)}</small>` : ''}
      </div>
    `).join('');
  }

  function renderWarnings() {
    const warnings = (state.analysis && state.analysis.warnings) || [];
    if (!warnings.length) {
      el.warnings.hidden = true;
      el.warnings.innerHTML = '';
      return;
    }
    el.warnings.hidden = false;
    el.warnings.innerHTML = `
      <ul>${warnings.map((warning) => `<li>${esc(bn(warning))}</li>`).join('')}</ul>
    `;
  }

  function pageCounts() {
    const pages = state.analysis ? state.analysis.pages : [];
    return {
      all: pages.length,
      create: pages.filter((page) => page.kind === 'create').length,
      update: pages.filter((page) => page.kind === 'update').length,
      done: pages.filter((page) => page.kind === 'done').length,
      issue: pages.filter((page) => page.kind === 'conflict' || page.kind === 'redirect').length,
    };
  }

  function renderFilters() {
    if (!state.analysis) return;
    const counts = pageCounts();
    el.filters.innerHTML = FILTERS.map((filter) => {
      const count = counts[filter.id] || 0;
      const active = state.filter === filter.id;
      return `
        <button type="button" class="filter ${active ? 'is-active' : ''}"
                data-filter="${filter.id}" role="tab"
                aria-selected="${active ? 'true' : 'false'}">
          ${esc(filter.label)}
          <span class="count">${bn(count)}</span>
        </button>
      `;
    }).join('');
  }

  function filteredPages() {
    if (!state.analysis) return [];
    const pages = state.analysis.pages;
    if (state.filter === 'all') return pages;
    if (state.filter === 'issue') {
      return pages.filter((page) =>
        page.kind === 'conflict' || page.kind === 'redirect');
    }
    return pages.filter((page) => page.kind === state.filter);
  }

  function renderGallery() {
    if (!state.analysis) return;
    const pages = filteredPages();
    const stats = state.analysis.stats;
    const counts = pageCounts();

    const captionParts = [`${bn(pages.length)}টি দেখানো হচ্ছে`];
    if (stats.marked_blank) {
      captionParts.push(`${bn(stats.marked_blank)}টি pagelist-এ ফাঁকা চিহ্নিত`);
    }
    if (stats.text_pages) {
      captionParts.push(`${bn(stats.text_pages)}টি লেখাসহ বাদ`);
    }
    if (stats.redirect) {
      captionParts.push(`${bn(stats.redirect)}টি পুনর্নির্দেশ`);
    }
    el.galleryCaption.textContent = captionParts.join(' · ');

    if (!pages.length) {
      el.gallery.innerHTML = '';
      el.emptyState.hidden = false;
      if (state.filter === 'all') {
        el.emptyTitle.textContent = 'এই বইয়ে কোনো ফাঁকা পাতা পাওয়া যায়নি';
        el.emptyText.textContent =
          'pagelist-এ কোনো ফাঁকা চিহ্ন নেই এবং বিদ্যমান খালি পাতাও পাওয়া যায়নি।';
        el.emptyReset.hidden = true;
      } else {
        el.emptyTitle.textContent = 'এই তালিকায় কোনো পাতা নেই';
        el.emptyText.textContent = 'অন্য ফিল্টার বেছে নিন বা সব পাতা দেখুন।';
        el.emptyReset.hidden = false;
      }
      return;
    }

    el.emptyState.hidden = true;
    el.gallery.innerHTML = pages.map(cardHtml).join('');
  }

  function cardHtml(page) {
    const meta = KIND[page.kind] || KIND.create;
    const selected = state.selected.has(page.num);
    const selectable = isActionable(page);
    const viewed = state.viewed.has(page.num);
    const numeral = page.num_label || bn(page.num);
    const thumb = page.thumb
      ? `<img src="${esc(page.thumb)}" alt="স্ক্যান পৃষ্ঠা ${esc(numeral)}"
              loading="lazy" decoding="async" referrerpolicy="no-referrer"
              onerror="this.classList.add('broken');this.parentElement.parentElement.classList.add('img-broken')">`
      : '<div class="no-thumb">স্ক্যানের ছবি নেই</div>';

    const otherSuffixes = (page.other_titles || [])
      .map((title) => title.split('/').pop())
      .filter(Boolean)
      .join(' · ');

    return `
      <article class="page-card kind-${page.kind} ${selected ? 'is-selected' : ''}"
               data-num="${page.num}" tabindex="0"
               aria-label="স্ক্যান পৃষ্ঠা ${esc(numeral)} — ${esc(meta.label)}"
               title="${esc(page.title)}">
        <div class="thumb-wrap">
          <button type="button" class="thumb-button" aria-label="পৃষ্ঠা ${esc(numeral)} বড় করে দেখুন">
            ${thumb}
          </button>
          <span class="num-badge">পৃষ্ঠা ${esc(numeral)}</span>
          ${selectable ? `
            <label class="pick" title="নির্বাচন করুন">
              <input type="checkbox" data-num="${page.num}" ${selected ? 'checked' : ''}
                     aria-label="পৃষ্ঠা ${esc(numeral)} নির্বাচন করুন">
              <span aria-hidden="true"></span>
            </label>
          ` : `
            <span class="lock-badge" title="এই পাতাটি স্বয়ংক্রিয়ভাবে বদলানো যাবে না">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="10" width="14" height="10" rx="2"/>
                <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>
              </svg>
            </span>
          `}
          ${viewed ? `
            <span class="viewed-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 12s3.5-5.5 9.5-5.5S21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/>
                <circle cx="12" cy="12" r="2.4"/>
              </svg>
              দেখা হয়েছে
            </span>
          ` : ''}
        </div>

        <div class="card-body">
          <div class="status-line">
            <span class="badge ${meta.cls}">${esc(meta.label)}</span>
            <span class="level-chip">${esc(levelLabel(page))}</span>
          </div>
          ${page.label ? `<span class="page-label" title="pagelist লেবেল">${esc(page.label)}</span>` : ''}
          ${page.manual ? '<span class="manual-note">হাতে যোগ করা</span>' : ''}
          <a class="page-title" href="${esc(page.url)}" target="_blank"
             rel="noopener" title="${esc(page.title)}">${esc(page.title)}</a>
          ${page.has_text && page.excerpt
            ? `<p class="excerpt">${esc(page.excerpt)}</p>`
            : ''}
          ${otherSuffixes
            ? `<div class="dup-note">একই পাতার আরও: ${esc(otherSuffixes)}</div>`
            : ''}
          ${page.out_of_range
            ? '<div class="range-note">স্ক্যানের মোট পাতার বাইরে</div>'
            : ''}
        </div>
      </article>
    `;
  }

  function onGalleryClick(event) {
    const card = event.target.closest('.page-card');
    if (!card) return;
    if (event.target.closest('a')) return;
    if (event.target.closest('.pick')) return;
    if (event.target.closest('input')) return;
    openViewer(Number(card.dataset.num));
  }

  function onGalleryChange(event) {
    const input = event.target.closest('.pick input');
    if (!input) return;
    event.stopPropagation();
    setSelected(Number(input.dataset.num), input.checked);
  }

  function onGalleryKeydown(event) {
    const card = event.target.closest('.page-card');
    if (!card || event.target !== card) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openViewer(Number(card.dataset.num));
    }
  }

  // ------------------------------------------------------------------
  // selection
  // ------------------------------------------------------------------

  function setSelected(num, checked) {
    const page = state.pageMap.get(Number(num));
    if (!page || !isActionable(page)) {
      updateCardSelection(num, false);
      return;
    }
    if (checked) state.selected.add(page.num);
    else state.selected.delete(page.num);
    updateCardSelection(page.num, checked);
    updateSaveBar();
    if (state.viewerNum === page.num) updateViewerToggle();
    if (!el.browserModal.hidden) renderBrowser();
  }

  function updateCardSelection(num, checked) {
    const card = el.gallery.querySelector(`.page-card[data-num="${num}"]`);
    if (!card) return;
    card.classList.toggle('is-selected', checked);
    const input = card.querySelector('.pick input');
    if (input) input.checked = checked;
  }

  function selectAll() {
    if (!state.analysis) return;
    state.analysis.pages.forEach((page) => {
      if (isActionable(page)) state.selected.add(page.num);
    });
    renderGallery();
    updateSaveBar();
    showToast(`${bn(state.selected.size)}টি পাতা নির্বাচিত হয়েছে।`, 'success');
  }

  function selectNone() {
    state.selected.clear();
    renderGallery();
    updateSaveBar();
  }

  function updateSaveBar() {
    if (!state.analysis) {
      el.saveBar.hidden = true;
      return;
    }
    el.saveBar.hidden = false;
    const count = state.selected.size;
    el.selectedCount.textContent = count
      ? `${bn(count)}টি পাতা নির্বাচিত`
      : 'কোনো পাতা নির্বাচিত নেই';
    el.openSave.disabled = count === 0;
    el.dryRunToggle.checked = state.dryRun;
    el.saveDryRun.checked = state.dryRun;
    el.openSave.textContent = state.dryRun ? 'যাচাই করুন' : 'প্রুফ করুন';

    if (state.dryRun) {
      el.saveBarNote.textContent = 'পরীক্ষা মোডে কোনো পাতা সেভ হবে না';
    } else if (!isLoggedInFor(state.analysis.wiki.origin)) {
      el.saveBarNote.textContent = 'সেভ করতে এই উইকিতে লগইন করতে হবে';
    } else {
      el.saveBarNote.textContent = 'pagequality লেভেল ০ (লেখাবিহীন) হবে';
    }
  }

  function setDryRun(value) {
    state.dryRun = !!value;
    el.dryRunToggle.checked = state.dryRun;
    el.saveDryRun.checked = state.dryRun;
    updateSaveBar();
    refreshSaveLogin();
  }

  // ------------------------------------------------------------------
  // scan browser (all pages)
  // ------------------------------------------------------------------

  function pageThumb(base, number, width = 500) {
    if (!base) return null;
    return base.replace(/page\d+-\d+px/, `page${number}-${width}px`);
  }

  function openBrowser() {
    if (!state.analysis) return;
    hideSearchPop();
    renderBrowser(true);
    el.browserModal.hidden = false;
    syncBodyLock();
    el.browserClose.focus({ preventScroll: true });
  }

  function closeBrowser() {
    if (el.browserModal.hidden) return;
    el.browserModal.hidden = true;
    syncBodyLock();
  }

  function renderBrowser(resetScroll = false) {
    if (!state.analysis) return;
    const total = Number(state.analysis.index.pagecount) || 0;
    const per = state.browse.perPage;
    const maxPage = Math.max(0, Math.ceil(total / per) - 1);
    state.browse.page = Math.min(Math.max(0, state.browse.page), maxPage);
    const start = state.browse.page * per + 1;
    const end = Math.min(total, (state.browse.page + 1) * per);
    el.browserSubtitle.textContent =
      `মোট ${bn(total)}টি স্ক্যান পাতা · যেকোনো পাতা দেখে ফাঁকা হলে তালিকায় যোগ করুন`;
    el.browserRange.textContent = total
      ? `পৃষ্ঠা ${bn(start)}–${bn(end)} / ${bn(total)}`
      : 'কোনো পাতা নেই';
    el.browserPrev.disabled = state.browse.page <= 0;
    el.browserNext.disabled = state.browse.page >= maxPage;
    el.browserJump.max = String(total || 1);

    const previousScroll = el.browserGrid.scrollTop;
    const cards = [];
    for (let number = start; number <= end; number += 1) {
      cards.push(browserCardHtml(number));
    }
    el.browserGrid.innerHTML = cards.join('');
    el.browserGrid.scrollTop = resetScroll ? 0 : previousScroll;
  }

  function browserCardHtml(number) {
    const analysis = state.analysis;
    const record = state.pageMap.get(number);
    const thumb = pageThumb(analysis.index.thumb_base, number) ||
      (record && record.thumb) || null;
    const numeral = (record && record.num_label) ||
      (analysis.stats.style === 'bn' ? bn(number) : String(number));
    const selected = state.selected.has(number);
    const meta = record ? (KIND[record.kind] || KIND.create) : null;

    let action;
    if (record && isActionable(record)) {
      action = `
        <button type="button" class="button small ${selected ? 'ghost' : 'primary'}"
                data-action="toggle" data-num="${number}">
          ${selected ? 'বাদ দিন' : 'নির্বাচন'}
        </button>`;
    } else if (record) {
      const label = record.kind === 'done'
        ? 'আগেই লেখাবিহীন'
        : record.kind === 'conflict'
          ? 'লেখা আছে'
          : 'তালিকায় আছে';
      action = `<span class="muted">${label}</span>`;
    } else {
      action = `
        <button type="button" class="button small ghost"
                data-action="add" data-num="${number}">যোগ করুন</button>`;
    }

    return `
      <article class="browse-item ${selected ? 'is-selected' : ''}" data-num="${number}"
               title="${esc(record ? record.title : 'স্ক্যান পৃষ্ঠা ' + numeral)}">
        <div class="browse-thumb" data-action="view" data-num="${number}"
             role="button" tabindex="0" aria-label="পৃষ্ঠা ${esc(numeral)} বড় করে দেখুন">
          ${thumb
            ? `<img src="${esc(thumb)}" alt="স্ক্যান পৃষ্ঠা ${esc(numeral)}"
                    loading="lazy" decoding="async" referrerpolicy="no-referrer"
                    onerror="this.classList.add('broken');this.parentElement.classList.add('img-broken')">`
            : '<div class="no-thumb">স্ক্যানের ছবি নেই</div>'}
          <span class="num-badge">পৃষ্ঠা ${esc(numeral)}</span>
          <span class="browse-kind">
            ${record
              ? `<span class="badge ${meta.cls}">${esc(meta.label)}</span>`
              : '<span class="badge unknown">যাচাই বাকি</span>'}
          </span>
        </div>
        <div class="browse-body">
          ${record && record.label
            ? `<span class="browse-label">${esc(record.label)}</span>`
            : ''}
          <div class="browse-actions">${action}</div>
        </div>
      </article>
    `;
  }

  function onBrowserGridClick(event) {
    const card = event.target.closest('.browse-item');
    if (!card) return;
    const number = Number(card.dataset.num);
    const actionEl = event.target.closest('[data-action]');
    const action = actionEl ? actionEl.dataset.action : null;
    if (action === 'add') {
      addFromBrowser(number);
      return;
    }
    if (action === 'toggle') {
      setSelected(number, !state.selected.has(number));
      return;
    }
    openPage(number);
  }

  function onBrowserGridKeydown(event) {
    const thumb = event.target.closest('.browse-thumb');
    if (!thumb) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPage(Number(thumb.dataset.num));
    }
  }

  function onBrowserJump(event) {
    event.preventDefault();
    if (!state.analysis) return;
    const total = Number(state.analysis.index.pagecount) || 0;
    const value = Number.parseInt(el.browserJump.value, 10);
    if (!Number.isFinite(value) || value < 1 || (total && value > total)) {
      showToast('সঠিক পৃষ্ঠা নম্বর দিন।', 'error');
      return;
    }
    state.browse.page = Math.floor((value - 1) / state.browse.perPage);
    renderBrowser(true);
    requestAnimationFrame(() => {
      const card = el.browserGrid.querySelector(`.browse-item[data-num="${value}"]`);
      if (card) card.scrollIntoView({ block: 'center' });
    });
  }

  async function ensurePageRecord(number) {
    const existing = state.pageMap.get(Number(number));
    if (existing) return existing;
    if (!state.analysis) throw new Error('বইটি আগে বিশ্লেষণ করুন।');
    const response = await api('/api/page', {
      origin: state.analysis.wiki.origin,
      index: state.analysis.index.title,
      num: Number(number),
    });
    const page = response.page;
    const current = state.pageMap.get(page.num);
    if (current) {
      Object.assign(current, page);
    } else {
      state.pageMap.set(page.num, page);
      state.analysis.pages.push(page);
      state.analysis.pages.sort((a, b) => a.num - b.num);
    }
    recomputeStats();
    renderBook();
    renderStats();
    renderFilters();
    renderGallery();
    updateSaveBar();
    if (!el.browserModal.hidden) renderBrowser();
    return page;
  }

  async function openPage(number) {
    try {
      await ensurePageRecord(number);
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
    openViewer(number);
  }

  async function addFromBrowser(number) {
    let page;
    try {
      page = await ensurePageRecord(number);
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
    state.filter = 'all';
    renderFilters();
    renderGallery();
    if (isActionable(page)) {
      const label = String(page.label || '').trim();
      const textualLabel = label && !/^[0-9০-৯]+$/.test(label);
      if (page.kind === 'create' && textualLabel) {
        renderBrowser();
        showToast(
          `পৃষ্ঠা ${page.num_label} তালিকায় যোগ হয়েছে, তবে এর লেবেল “${page.label}” — ` +
          'ফাঁকা কি না দেখে নিশ্চিত হয়ে নির্বাচন করুন।'
        );
        return;
      }
      state.selected.add(page.num);
      updateCardSelection(page.num, true);
      updateSaveBar();
      renderBrowser();
      showToast(`পৃষ্ঠা ${page.num_label} তালিকায় যোগ হয়েছে।`, 'success');
      return;
    }
    if (page.kind === 'done') {
      showToast('এই পাতাটি আগেই লেখাবিহীন।');
    } else if (page.kind === 'conflict') {
      showToast('এই পাতায় লেখা আছে; নিরাপত্তার জন্য যোগ করা হলো না।', 'error');
    } else if (page.kind === 'redirect') {
      showToast('এই পাতাটি একটি পুনর্নির্দেশ; যোগ করা যাবে না।', 'error');
    } else {
      showToast('এই পাতাটি এখন যোগ করা যাচ্ছে না।', 'error');
    }
    renderBrowser();
  }

  // ------------------------------------------------------------------
  // viewer
  // ------------------------------------------------------------------

  function openViewer(num) {
    const page = state.pageMap.get(Number(num));
    if (!page) return;
    const allNums = filteredPages().map((item) => item.num);
    state.viewerList = allNums.includes(page.num)
      ? allNums
      : state.analysis.pages.map((item) => item.num);
    state.viewerNum = page.num;

    if (!state.viewed.has(page.num)) {
      state.viewed.add(page.num);
      const card = el.gallery.querySelector(`.page-card[data-num="${page.num}"]`);
      if (card && !card.querySelector('.viewed-badge')) {
        const badge = document.createElement('span');
        badge.className = 'viewed-badge';
        badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M2.5 12s3.5-5.5 9.5-5.5S21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/>' +
          '<circle cx="12" cy="12" r="2.4"/></svg>দেখা হয়েছে';
        card.querySelector('.thumb-wrap').appendChild(badge);
      }
    }

    const index = state.viewerList.indexOf(page.num);
    const numeral = page.num_label || bn(page.num);
    el.viewerKicker.textContent = `স্ক্যান পৃষ্ঠা ${numeral}`;
    el.viewerTitle.textContent = page.title;
    const meta = KIND[page.kind] || KIND.create;
    el.viewerKind.className = `badge ${meta.cls}`;
    el.viewerKind.textContent = meta.label;
    el.viewerLevel.textContent = levelLabel(page);
    el.viewerLabel.textContent = page.label ? `লেবেল: ${page.label}` : '';
    el.viewerPosition.textContent = `${bn(index + 1)} / ${bn(state.viewerList.length)}`;
    el.viewerWikiLink.href = page.url;
    el.viewerPrev.disabled = index <= 0;
    el.viewerNext.disabled = index < 0 || index >= state.viewerList.length - 1;
    updateViewerToggle();

    el.viewerImageWrap.classList.remove('zoomed');
    el.viewerSpinner.hidden = false;
    el.viewerImgError.hidden = true;
    el.viewerImage.style.opacity = '0';
    el.viewerImage.alt = `স্ক্যান পৃষ্ঠা ${numeral}`;
    el.viewerImage.onload = () => {
      el.viewerSpinner.hidden = true;
      el.viewerImgError.hidden = true;
      el.viewerImage.style.opacity = '1';
      preloadNeighbours(index);
    };
    el.viewerImage.onerror = () => {
      if (page.thumb && el.viewerImage.src !== page.thumb) {
        el.viewerImage.src = page.thumb;
        return;
      }
      el.viewerSpinner.hidden = true;
      el.viewerImgError.hidden = false;
      el.viewerImage.style.opacity = '0';
    };
    if (page.full || page.thumb) {
      el.viewerImage.src = page.full || page.thumb;
    } else {
      el.viewerImage.removeAttribute('src');
      el.viewerSpinner.hidden = true;
      el.viewerImgError.hidden = false;
    }

    el.viewerModal.hidden = false;
    syncBodyLock();
    el.viewerClose.focus({ preventScroll: true });
  }

  function preloadNeighbours(index) {
    [index - 1, index + 1].forEach((neighbourIndex) => {
      const num = state.viewerList[neighbourIndex];
      const page = state.pageMap.get(num);
      const url = page && (page.full || page.thumb);
      if (url) {
        const image = new Image();
        image.src = url;
      }
    });
  }

  function updateViewerToggle() {
    const page = state.pageMap.get(state.viewerNum);
    if (!page) return;
    if (isActionable(page)) {
      const selected = state.selected.has(page.num);
      el.viewerToggle.disabled = false;
      el.viewerToggle.textContent = selected ? 'নির্বাচন বাতিল' : 'নির্বাচন করুন';
    } else {
      el.viewerToggle.disabled = true;
      el.viewerToggle.textContent =
        page.kind === 'done' ? 'আগেই লেখাবিহীন' : 'নির্বাচনযোগ্য নয়';
    }
  }

  function navigateViewer(delta) {
    if (el.viewerModal.hidden) return;
    const index = state.viewerList.indexOf(state.viewerNum);
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= state.viewerList.length) return;
    openViewer(state.viewerList[nextIndex]);
  }

  function closeViewer() {
    if (el.viewerModal.hidden) return;
    el.viewerModal.hidden = true;
    el.viewerImage.removeAttribute('src');
    el.viewerImageWrap.classList.remove('zoomed');
    syncBodyLock();
  }

  // ------------------------------------------------------------------
  // settings / login
  // ------------------------------------------------------------------

  function openSettings(wikiOverride) {
    hideSearchPop();
    const wiki = wikiOverride ||
      (state.analysis && state.analysis.wiki.origin) ||
      (state.status && state.status.config && state.status.config.wiki) ||
      currentWiki();
    el.settingsWiki.value = wiki;
    const username = (state.status && state.status.config && state.status.config.username) || '';
    el.settingsUsername.value = username;
    el.settingsPassword.value = '';
    el.settingsRemember.checked = !!(state.status && state.status.config && state.status.config.remember);
    updateBotLink();
    renderSettingsStatus();
    el.settingsModal.hidden = false;
    syncBodyLock();
    window.setTimeout(() => {
      if (!el.settingsUsername.value) el.settingsUsername.focus();
      else el.settingsPassword.focus();
    }, 40);
  }

  function closeSettings() {
    el.settingsModal.hidden = true;
    syncBodyLock();
  }

  function renderSettingsStatus() {
    const status = state.status || {};
    if (status.logged_in && status.user) {
      el.settingsStatus.className = 'settings-status is-online';
      el.settingsStatus.innerHTML =
        `সংযুক্ত: <strong>${esc(status.user)}</strong> · ${esc(status.wiki || '')}`;
      el.logoutBtn.hidden = false;
    } else {
      el.settingsStatus.className = 'settings-status';
      el.settingsStatus.textContent =
        'লগইন নেই — পড়া ও যাচাই লগইন ছাড়াও চলবে; সেভ করতে লগইন লাগবে।';
      el.logoutBtn.hidden = true;
    }

    if (state.analysis && status.logged_in && status.wiki !== state.analysis.wiki.origin) {
      el.settingsStatus.className = 'settings-status is-error';
      el.settingsStatus.innerHTML =
        `<b>${esc(status.wiki)}</b>-এ লগইন করা আছে, কিন্তু বইটি <b>${esc(state.analysis.wiki.origin)}</b>-এ। ` +
        'এই বইয়ের উইকিতে লগইন করুন।';
    }
    if (status.auto_error) {
      el.settingsNote.textContent = 'স্বয়ংক্রিয় লগইন ব্যর্থ: ' + status.auto_error;
    } else {
      el.settingsNote.textContent = '';
    }
  }

  async function onLoginSubmit(event) {
    event.preventDefault();
    const wiki = el.settingsWiki.value.trim();
    const username = el.settingsUsername.value.trim();
    const password = el.settingsPassword.value;
    const remember = el.settingsRemember.checked;
    if (!wiki || !username || !password) {
      showToast('উইকি, ব্যবহারকারীর নাম ও বট পাসওয়ার্ড দিন।', 'error');
      return;
    }
    el.loginSubmit.disabled = true;
    el.loginSubmit.textContent = 'লগইন হচ্ছে…';
    try {
      const status = await api('/api/login', { wiki, username, password, remember });
      state.status = status;
      el.settingsPassword.value = '';
      renderStatus();
      renderSettingsStatus();
      updateSaveBar();
      refreshSaveLogin();
      showToast('লগইন সফল হয়েছে।', 'success');
    } catch (error) {
      el.settingsStatus.className = 'settings-status is-error';
      el.settingsStatus.textContent = error.message;
      showToast(error.message, 'error');
    } finally {
      el.loginSubmit.disabled = false;
      el.loginSubmit.textContent = 'লগইন করুন';
    }
  }

  async function onLogout() {
    el.logoutBtn.disabled = true;
    try {
      const status = await api('/api/logout', {});
      state.status = status;
      renderStatus();
      renderSettingsStatus();
      updateSaveBar();
      refreshSaveLogin();
      showToast('লগআউট হয়েছে।');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      el.logoutBtn.disabled = false;
    }
  }

  function updateBotLink() {
    let value = el.settingsWiki.value.trim() || 'https://bn.wikisource.org';
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    try {
      const url = new URL(value);
      el.botPasswordLink.href = `${url.origin}/wiki/Special:BotPasswords`;
    } catch (error) {
      el.botPasswordLink.href = 'https://bn.wikisource.org/wiki/Special:BotPasswords';
    }
  }

  // ------------------------------------------------------------------
  // save
  // ------------------------------------------------------------------

  function openSaveModal() {
    if (!state.analysis) return;
    hideSearchPop();
    if (!state.selected.size) {
      showToast('আগে অন্তত একটি পাতা নির্বাচন করুন।', 'error');
      return;
    }
    state.selected = new Set(
      [...state.selected].filter((num) => isActionable(state.pageMap.get(num)))
    );
    const pages = [...state.selected]
      .map((num) => state.pageMap.get(num))
      .filter(isActionable);
    if (!pages.length) {
      showToast('নির্বাচিত পাতাগুলো এখন আর সম্পাদনাযোগ্য নয়।', 'error');
      return;
    }

    const createCount = pages.filter((page) => page.kind === 'create').length;
    const updateCount = pages.filter((page) => page.kind === 'update').length;
    el.saveSubtitle.textContent =
      `নির্বাচিত ${bn(pages.length)}টি পাতা pagequality লেভেল ০ (লেখাবিহীন) হবে।`;
    el.saveSummary.innerHTML = `
      <div class="summary-tile">
        <strong>${bn(pages.length)}</strong>
        <span>মোট নির্বাচিত</span>
      </div>
      <div class="summary-tile">
        <strong>${bn(createCount)}</strong>
        <span>নতুন তৈরি হবে</span>
      </div>
      <div class="summary-tile">
        <strong>${bn(updateCount)}</strong>
        <span>লেভেল ০ হবে</span>
      </div>
    `;

    el.saveSummaryInput.value =
      localStorage.getItem(SUMMARY_KEY) || DEFAULT_SUMMARY;
    el.saveDryRun.checked = state.dryRun;

    const unviewed = [...state.selected].filter((num) => !state.viewed.has(num));
    if (unviewed.length) {
      el.saveViewWarning.hidden = false;
      const numbers = unviewed.slice(0, 14)
        .map((num) => {
          const page = state.pageMap.get(num);
          return page ? (page.num_label || bn(num)) : bn(num);
        })
        .join(' · ');
      el.saveViewWarning.innerHTML =
        `<strong>${bn(unviewed.length)}টি পাতা এখনো বড় করে দেখা হয়নি।</strong> ` +
        'স্ক্যান দেখে নিশ্চিত না হয়ে চালালে ভুল পাতা লেখাবিহীন হয়ে যেতে পারে।' +
        (numbers ? `<br><span class="muted">পৃষ্ঠা: ${esc(numbers)}${unviewed.length > 14 ? ' …' : ''}</span>` : '');
    } else {
      el.saveViewWarning.hidden = true;
    }

    el.saveSetup.hidden = false;
    el.saveProgress.hidden = true;
    el.saveResults.innerHTML = '';
    el.saveClose.hidden = true;
    el.saveStop.hidden = false;
    el.saveStop.disabled = false;
    el.saveStop.textContent = 'থামান';
    el.saveStart.disabled = false;
    el.saveStart.textContent = 'চালিয়ে যান';
    setDryRun(el.saveDryRun.checked);
    refreshSaveLogin();

    el.saveModal.hidden = false;
    syncBodyLock();
    el.saveStart.focus({ preventScroll: true });
  }

  function closeSaveModal() {
    if (state.save && state.save.running) {
      showToast('প্রক্রিয়া চলছে — আগে “থামান” চাপুন।', 'error');
      return;
    }
    el.saveModal.hidden = true;
    syncBodyLock();
    if (state.analysis) {
      recomputeStats();
      renderAll();
    }
  }

  function refreshSaveLogin() {
    if (!state.analysis || el.saveModal.hidden) return;
    const dry = el.saveDryRun.checked;
    const origin = state.analysis.wiki.origin;
    const loggedIn = isLoggedInFor(origin);
    el.saveStart.disabled = !dry && !loggedIn;
    el.saveLoginBox.hidden = dry || loggedIn;
    if (dry || loggedIn) return;

    if (state.status && state.status.logged_in) {
      el.saveLoginNote.textContent =
        `${state.status.wiki}-এ লগইন করা আছে, কিন্তু এই বইটি ${origin}-এ। এখানে লগইন করুন।`;
    } else {
      el.saveLoginNote.textContent = 'সেভ করার আগে এই বইয়ের উইকিতে লগইন করুন।';
    }
    if (!el.saveUsername.value) {
      el.saveUsername.value =
        (state.status && state.status.config && state.status.config.username) || '';
    }
  }

  async function onInlineLogin() {
    if (!state.analysis) return;
    const username = el.saveUsername.value.trim();
    const password = el.savePassword.value;
    if (!username || !password) {
      showToast('ব্যবহারকারীর নাম ও বট পাসওয়ার্ড দিন।', 'error');
      return;
    }
    const remember = !!(state.status && state.status.config && state.status.config.remember);
    el.saveLoginBtn.disabled = true;
    el.saveLoginBtn.textContent = 'লগইন হচ্ছে…';
    try {
      const status = await api('/api/login', {
        wiki: state.analysis.wiki.origin,
        username,
        password,
        remember,
      });
      state.status = status;
      el.savePassword.value = '';
      renderStatus();
      refreshSaveLogin();
      updateSaveBar();
      showToast('লগইন সফল হয়েছে।', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      el.saveLoginBtn.disabled = false;
      el.saveLoginBtn.textContent = 'লগইন';
    }
  }

  async function startSave() {
    if (!state.analysis) return;
    if (state.save && state.save.running) return;
    const dry = el.saveDryRun.checked;
    const origin = state.analysis.wiki.origin;
    if (!dry && !isLoggedInFor(origin)) {
      refreshSaveLogin();
      el.saveUsername.focus();
      return;
    }

    const nums = [...state.selected]
      .filter((num) => isActionable(state.pageMap.get(num)))
      .sort((a, b) => a - b);
    if (!nums.length) {
      showToast('নির্বাচিত কোনো পাতা নেই।', 'error');
      return;
    }

    const summary = (el.saveSummaryInput.value || DEFAULT_SUMMARY).trim();
    try {
      localStorage.setItem(SUMMARY_KEY, summary);
    } catch (error) {
      /* ignore */
    }

    state.save = {
      running: true,
      cancelled: false,
      total: nums.length,
      done: 0,
      ok: 0,
      saved: 0,
      dry: 0,
      skipped: 0,
      fail: 0,
      dryRun: dry,
      summary,
    };

    el.saveSetup.hidden = true;
    el.saveProgress.hidden = false;
    el.saveResults.innerHTML = '';
    el.saveClose.hidden = true;
    el.saveStop.hidden = false;
    el.saveStop.disabled = false;
    el.saveProgressSub.textContent = 'শুরু হচ্ছে…';
    el.saveResults.scrollTop = 0;
    updateSaveProgress();

    for (const num of nums) {
      if (state.save.cancelled) break;
      const page = state.pageMap.get(num);
      const numeral = page ? (page.num_label || bn(num)) : bn(num);
      el.saveProgressSub.textContent = `পৃষ্ঠা ${numeral} প্রক্রিয়া করা হচ্ছে…`;

      let result;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 120000);
      try {
        result = await api('/api/save', {
          origin,
          index: state.analysis.index.title,
          num,
          dry_run: dry,
          summary,
        }, { signal: controller.signal });
      } catch (error) {
        const isAbort = error && error.name === 'AbortError';
        const message = isAbort
          ? 'সময় শেষ — সার্ভার সাড়া দেয়নি।'
          : (error.message || 'পাতাটি প্রক্রিয়া করা যায়নি।');
        addResult(num, 'error', message);
        state.save.fail += 1;
        state.save.done += 1;
        updateSaveProgress();
        if (isAbort || !(error.data && error.data.code)) {
          state.save.cancelled = true;
          break;
        }
        if (error.status === 401) {
          state.save.cancelled = true;
          break;
        }
        continue;
      } finally {
        window.clearTimeout(timer);
      }

      handleSaveResult(num, result);
      state.save.done += 1;
      updateSaveProgress();
    }

    finishSave();
  }

  function handleSaveResult(num, result) {
    const page = state.pageMap.get(num);
    const numeral = page ? (page.num_label || bn(num)) : bn(num);

    if (result.stats && state.analysis) {
      state.analysis.stats = result.stats;
    }

    if (result.status === 'saved') {
      state.save.saved += 1;
      state.save.ok += 1;
      markDone(num);
      state.selected.delete(num);
      addResult(num, 'saved', result.message || 'সেভ হয়েছে।');
      updateSaveBar();
      return;
    }

    if (result.status === 'already_done') {
      state.save.ok += 1;
      markDone(num);
      state.selected.delete(num);
      addResult(num, 'saved', result.message || 'আগেই লেখাবিহীন।');
      updateSaveBar();
      return;
    }

    if (result.status === 'dry_run') {
      state.save.dry += 1;
      state.save.ok += 1;
      addResult(num, 'dry', result.message || 'পরীক্ষায় ঠিক আছে।');
      return;
    }

    if (result.status === 'skipped') {
      state.save.skipped += 1;
      state.selected.delete(num);
      if (result.reason === 'has_text') {
        if (page) {
          page.kind = 'conflict';
          page.has_text = true;
          page.excerpt = result.excerpt || page.excerpt || '';
          page.level_name = page.level_name || null;
        }
      }
      addResult(num, 'skipped', result.message || 'বাদ দেওয়া হয়েছে।');
      updateSaveBar();
      return;
    }

    state.save.fail += 1;
    addResult(num, 'error', result.message || 'অজানা সমস্যা।');
  }

  function markDone(num) {
    const page = state.pageMap.get(num);
    if (!page) return;
    page.kind = 'done';
    page.level = 0;
    page.level_name = 'লেখাবিহীন';
    page.has_text = false;
    page.excerpt = '';
    state.viewed.add(num);
  }

  function addResult(num, type, message) {
    const page = state.pageMap.get(num);
    const numeral = page ? (page.num_label || bn(num)) : bn(num);
    const row = document.createElement('div');
    row.className = `result-row ${type}`;
    const icons = { saved: '✓', dry: '✓', skipped: '!', error: '×' };
    row.innerHTML = `
      <span class="result-icon">${icons[type] || '·'}</span>
      <span class="result-page">পৃষ্ঠা ${esc(numeral)}</span>
      <span class="result-msg">${esc(message)}</span>
    `;
    el.saveResults.appendChild(row);
    el.saveResults.scrollTop = el.saveResults.scrollHeight;
  }

  function updateSaveProgress() {
    if (!state.save) return;
    const { done, total } = state.save;
    el.saveProgressText.textContent = `${bn(done)} / ${bn(total)}`;
    el.saveProgressFill.style.width =
      `${total ? Math.round((done / total) * 100) : 0}%`;
  }

  function stopSave() {
    if (!state.save || !state.save.running) return;
    state.save.cancelled = true;
    el.saveStop.disabled = true;
    el.saveStop.textContent = 'থামানো হচ্ছে…';
    el.saveProgressSub.textContent = 'বর্তমান অনুরোধ শেষ হলে থামবে…';
  }

  function finishSave() {
    if (!state.save) return;
    state.save.running = false;
    el.saveStop.hidden = true;
    el.saveClose.hidden = false;

    const save = state.save;
    const summary = document.createElement('div');
    summary.className = 'result-summary';
    let text;

    if (save.dryRun) {
      text = `<strong>পরীক্ষা সম্পন্ন।</strong> ${bn(save.ok)}টি পাতা যাচাই হয়েছে; ` +
        'কোনো কিছু সেভ হয়নি। পরীক্ষা মোড বন্ধ করে আবার চালালে আসল পরিবর্তন সেভ হবে।';
    } else if (save.cancelled) {
      text = `<strong>থামানো হয়েছে।</strong> ${bn(save.done)} / ${bn(save.total)}টি পাতা ` +
        `প্রক্রিয়া হয়েছে; ${bn(save.saved)}টি সেভ হয়েছে।`;
      if (save.fail) {
        text += ` ${bn(save.fail)}টি ব্যর্থ হয়েছে।`;
        summary.classList.add('is-error');
      }
    } else {
      text = `<strong>সম্পন্ন।</strong> ${bn(save.saved)}টি পাতা লেখাবিহীন হিসেবে সেভ হয়েছে।`;
      if (save.skipped) text += ` ${bn(save.skipped)}টি বাদ পড়েছে (লেখা আছে বা পুনর্নির্দেশ)।`;
      if (save.fail) {
        text += ` ${bn(save.fail)}টি ব্যর্থ হয়েছে — আবার চেষ্টা করুন।`;
        summary.classList.add('is-error');
      }
    }
    summary.innerHTML = text;
    el.saveResults.appendChild(summary);
    el.saveResults.scrollTop = el.saveResults.scrollHeight;

    el.saveProgressSub.textContent = save.dryRun
      ? 'পরীক্ষা মোড — কিছু সেভ হয়নি'
      : (save.cancelled ? 'থামানো হয়েছে' : 'কাজ সম্পন্ন');

    recomputeStats();
    renderBook();
    renderStats();
    renderFilters();
    renderGallery();
    updateSaveBar();
  }

  // ------------------------------------------------------------------
  // recent / url
  // ------------------------------------------------------------------

  function loadRecent() {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      state.recent = Array.isArray(stored) ? stored.slice(0, 6) : [];
    } catch (error) {
      state.recent = [];
    }
  }

  function rememberRecent(title, wiki) {
    const item = { title, wiki };
    state.recent = [
      item,
      ...state.recent.filter((entry) =>
        !(entry.title === title && entry.wiki === wiki)),
    ].slice(0, 6);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
    } catch (error) {
      /* ignore */
    }
    renderRecent();
  }

  function renderRecent() {
    if (!state.recent.length) {
      el.recentBooks.hidden = true;
      el.recentBooks.innerHTML = '';
      return;
    }
    el.recentBooks.hidden = false;
    el.recentBooks.innerHTML =
      '<span>সাম্প্রতিক:</span>' +
      state.recent.map((item, index) => {
        const short = item.title.replace(/^[^:]+:/, '');
        return `<button type="button" class="recent-chip" data-recent-index="${index}"
                        title="${esc(item.title)}">${esc(short)}</button>`;
      }).join('');
  }

  function updateUrl(title, wiki) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('index', title);
      url.searchParams.set('wiki', wiki);
      window.history.replaceState(null, '', url.toString());
    } catch (error) {
      /* ignore */
    }
  }

  function maybeAnalyzeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const index = params.get('index');
    if (!index) return;
    const wiki = params.get('wiki') || currentWiki();
    el.bookInput.value = index;
    analyze(index, wiki);
  }

  // ------------------------------------------------------------------
  // misc
  // ------------------------------------------------------------------

  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showToast('এই ব্রাউজারে ক্লিপবোর্ড পড়া যায় না; ম্যানুয়ালি পেস্ট করুন।', 'error');
      return;
    }
    navigator.clipboard.readText()
      .then((text) => {
        if (!text || !text.trim()) {
          showToast('ক্লিপবোর্ড খালি।', 'error');
          return;
        }
        el.bookInput.value = text.trim();
        el.bookInput.dispatchEvent(new Event('input', { bubbles: true }));
        el.bookInput.focus();
      })
      .catch(() => {
        showToast('ক্লিপবোর্ড পড়ার অনুমতি নেই; ম্যানুয়ালি পেস্ট করুন।', 'error');
      });
  }

  function showToast(message, tone = 'info') {
    el.toast.hidden = false;
    el.toast.className = 'toast' +
      (tone === 'error' ? ' is-error' : tone === 'success' ? ' is-success' : '');
    el.toast.textContent = message;
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      el.toast.hidden = true;
    }, tone === 'error' ? 6000 : 4000);
  }

  function syncBodyLock() {
    const anyOpen = [el.viewerModal, el.settingsModal, el.saveModal, el.browserModal]
      .some((modal) => !modal.hidden);
    document.body.classList.toggle('modal-open', anyOpen);
  }

  function onGlobalKeydown(event) {
    if (event.key === 'Escape') {
      if (!el.viewerModal.hidden) {
        closeViewer();
        return;
      }
      if (!el.browserModal.hidden) {
        closeBrowser();
        return;
      }
      if (!el.settingsModal.hidden) {
        closeSettings();
        return;
      }
      if (!el.saveModal.hidden) {
        closeSaveModal();
        return;
      }
    }

    if (el.viewerModal.hidden) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigateViewer(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigateViewer(1);
    }
  }

  function recomputeStats() {
    if (!state.analysis) return;
    const stats = state.analysis.stats;
    const pages = state.analysis.pages;
    stats.create = pages.filter((page) => page.kind === 'create').length;
    stats.update = pages.filter((page) => page.kind === 'update').length;
    stats.done = pages.filter((page) => page.kind === 'done').length;
    stats.conflict = pages.filter((page) => page.kind === 'conflict').length;
    stats.redirect = pages.filter((page) => page.kind === 'redirect').length;
    stats.candidates = pages.length;
    stats.pending = stats.create + stats.update;
  }
})();
