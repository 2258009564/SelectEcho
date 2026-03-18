(() => {
  /**
   * content.js（页面注入脚本）
   *
   * 这个文件负责：
   * 1. 监听划词交互，并在合适时机触发翻译。
   * 2. 构造纯文本/结构化选区数据并发送给后台。
   * 3. 渲染可关闭、可复制、可换主题的翻译浮层。
   * 4. 通过请求去重与过期响应丢弃，保证面板状态一致。
   */

  const DEFAULT_SETTINGS = {
    sourceLang: "auto",
    targetLang: "zh-CN",
    maxChars: 2000,
    showSourceText: true,
    panelTheme: "classic",
    engineMode: "auto",
    aiEnabledStream: true,
  };

  const THEMES = new Set([
    "classic",
    "glass",
    "brutal",
    "editorial",
    "terminal",
  ]);
  const THEME_ALIASES = {
    ocean: "editorial",
    mono: "terminal",
  };

  const RICH_ALLOWED_TAGS = new Set([
    "p",
    "br",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "a",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "span",
  ]);

  const RICH_STRUCTURAL_SELECTOR =
    "ul,ol,li,blockquote,pre,code,strong,em,b,i,u,a,h1,h2,h3,h4,h5,h6";
  const RICH_MAX_SEGMENTS = 120;
  const RICH_MAX_HTML_LENGTH = 120000;

  // 前端预过滤：选区不足 2 字符时不发起请求。
  const MIN_SELECTION_LENGTH = 2;
  // 划词触发防抖：吸收连续 mouseup 抖动，减少重复请求。
  const TRIGGER_DEBOUNCE_MS = 220;
  // 可编辑区域默认不触发翻译，避免打字过程被打断。
  const EDITABLE_SELECTOR =
    "input, textarea, [contenteditable]:not([contenteditable='false'])";
  const ENGINE_MODE_OPTIONS = ["auto", "baidu", "google", "ai"];
  const MODIFIER_ONLY_KEYS = new Set([
    "Alt",
    "Control",
    "Meta",
    "Shift",
    "Fn",
    "FnLock",
    "CapsLock",
    "NumLock",
    "ScrollLock",
  ]);

  let settings = { ...DEFAULT_SETTINGS };

  // 浮层节点缓存（面板创建后复用）。
  let panel = null;
  let translationNode = null;
  let sourceNode = null;
  let engineNode = null;
  let engineMenu = null;
  let headerNode = null;
  let stateNode = null;
  let footnoteNode = null;
  let brandNode = null;
  let copyButton = null;

  // 递增请求序号：只接受最后一次请求的响应。
  let requestId = 0;
  let debounceTimer = null;
  // 选区指纹：用于判断是否与上次触发相同。
  let lastSelectionKey = "";
  let lastAnchorRect = null;
  let copyResetTimer = null;
  let activeStreamPort = null;
  let activeStreamRequestId = 0;
  let pendingRequestId = 0;
  let isRequestPending = false;
  let isStreaming = false;
  let isPinnedDuringStream = false;
  let lastMouseAnchorRect = null;
  let lastSelectionSnapshot = null;
  let customPanelPosition = null;
  let isDraggingPanel = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let skipNextMouseUpTranslate = false;
  let isLoadingCapsuleMode = false;

  const LOADING_CAPSULE_TEXT = "翻译中...";

  init();

  function init() {
    loadSettings();

    // 设置页保存后实时同步配置；若面板已存在则立即刷新主题。
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      Object.keys(changes).forEach((key) => {
        settings[key] = changes[key].newValue;
      });

      if (panel) {
        applyPanelTheme();
      }
    });

    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange, true);
    window.addEventListener("scroll", onViewportChange, true);
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        maxChars: Number(stored.maxChars) || DEFAULT_SETTINGS.maxChars,
        panelTheme: normalizeTheme(stored.panelTheme),
      };

      if (panel) {
        applyPanelTheme();
      }
    });
  }

  function onViewportChange() {
    if (!panel || panel.classList.contains("dst-hidden")) {
      return;
    }

    if (isEngineMenuOpen()) {
      closeEngineMenu();
    }

    if (!lastAnchorRect && !customPanelPosition) {
      return;
    }

    positionPanel(lastAnchorRect);
  }

  /**
   * 仅在左键 mouseup 后尝试触发翻译。
   */
  function onMouseUp(event) {
    if (skipNextMouseUpTranslate) {
      skipNextMouseUpTranslate = false;
      return;
    }

    if (event.button !== 0) {
      return;
    }

    if (isDraggingPanel) {
      return;
    }

    if (isEngineMenuOpen() && engineMenu && engineMenu.contains(event.target)) {
      return;
    }

    // 面板内部点击属于交互行为，不重新触发翻译。
    if (panel && panel.contains(event.target)) {
      return;
    }

    // 输入控件中的选区不触发翻译。
    if (isEditableTarget(event.target)) {
      return;
    }

    lastMouseAnchorRect = createPointAnchorRect(event.clientX, event.clientY);

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = window.setTimeout(() => {
      handleSelectionTranslate();
    }, TRIGGER_DEBOUNCE_MS);
  }

  /**
   * 读取并校验选区，决定是展示提示还是发起翻译。
   */
  function handleSelectionTranslate() {
    const selection = readSelection();
    const pointerAnchorRect = cloneAnchorRect(lastMouseAnchorRect);
    lastMouseAnchorRect = null;

    // 无有效选区时收起面板，并清空去重指纹。
    if (!selection.text) {
      if (isStreaming) {
        return;
      }

      lastSelectionKey = "";
      hidePanel();
      return;
    }

    if (selection.text.length < MIN_SELECTION_LENGTH) {
      if (isStreaming) {
        return;
      }

      lastSelectionKey = "";
      hidePanel();
      return;
    }

    // 选区文本 + 近似位置 + 语言配置，组成去重指纹。
    const rectKey = selection.rect
      ? `${Math.round(selection.rect.left)}|${Math.round(selection.rect.top)}`
      : "no-rect";
    const selectionKeyText = normalizeSelectionKeyText(selection.text);
    const selectionKey = `${selectionKeyText}|${rectKey}|${settings.sourceLang}|${settings.targetLang}`;

    // 指纹未变化，说明仍是同一选区，直接跳过。
    if (selectionKey === lastSelectionKey) {
      return;
    }

    if (pointerAnchorRect) {
      selection.rect = pointerAnchorRect;
    }

    lastSelectionKey = selectionKey;
    lastSelectionSnapshot = cloneSelectionSnapshot(selection);
    // 新选区出现时重置手动拖拽定位，优先贴近当前鼠标锚点。
    customPanelPosition = null;

    const maxChars = Number(settings.maxChars) || DEFAULT_SETTINGS.maxChars;
    if (selection.text.length > maxChars) {
      showPanel({
        anchorRect: selection.rect,
        translationText: `选中文本过长，请控制在 ${maxChars} 字符以内。`,
        translationHtml: "",
        sourceText: "",
        engine: "error",
        state: "error",
        footnoteText: "请缩短选区后重试。",
      });
      return;
    }

    const sourcePreview = settings.showSourceText ? selection.text : "";
    const sourceHtml = settings.showSourceText ? selection.sourceRichHtml : "";

    showPanel({
      anchorRect: selection.rect,
      translationText: "翻译中...",
      translationHtml: "",
      sourceText: sourcePreview,
      sourceHtml,
      engine: normalizeEngineMode(settings.engineMode),
      state: "loading",
      footnoteText: "正在调用翻译引擎，按任意键可中断。",
    });

    requestTranslation(selection);
  }

  /**
   * 点击面板外部时收起面板。
   */
  function onMouseDown(event) {
    if (!panel || panel.classList.contains("dst-hidden")) {
      return;
    }

    if (isTranslationPending()) {
      skipNextMouseUpTranslate = true;
      interruptPendingTranslationForUserAction();
      return;
    }

    if (isEngineMenuOpen() && engineMenu && engineMenu.contains(event.target)) {
      return;
    }

    if (panel.contains(event.target)) {
      if (
        isEngineMenuOpen() &&
        !(engineNode && engineNode.contains(event.target))
      ) {
        closeEngineMenu();
      }
      return;
    }

    closeEngineMenu();

    hidePanel();
  }

  /**
   * 非输入区域中：翻译进行中按任意键中断；空闲时 Esc 关闭面板。
   */
  function onKeyDown(event) {
    if (!panel || panel.classList.contains("dst-hidden")) {
      return;
    }

    if (event.key === "Escape" && isEngineMenuOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeEngineMenu();
      return;
    }

    if (isTranslationPending()) {
      if (event.key === "Escape") {
        interruptPendingTranslationForUserAction();
        return;
      }

      // 低优先级策略：翻译中遇到任意按键都立即让路。
      interruptPendingTranslationForUserAction();
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    if (event.key === "Escape") {
      hidePanel();
    }
  }

  /**
   * 读取当前选区的文本、锚点位置和富文本片段。
   */
  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { text: "", rect: null, richPayload: null, sourceRichHtml: "" };
    }

    const range = selection.getRangeAt(0);

    // 即使程序能拿到选区，也再次确认不在可编辑区域内。
    if (isNodeInsideEditable(range.commonAncestorContainer)) {
      return { text: "", rect: null, richPayload: null, sourceRichHtml: "" };
    }

    // 保留换行和段落边界，避免把多段文本压成一行。
    const text = selection.toString().replace(/\r/g, "").trim();
    if (!text) {
      return { text: "", rect: null, richPayload: null, sourceRichHtml: "" };
    }

    const richPayload = buildRichPayload(range);

    return {
      text,
      rect: getSelectionRect(range),
      richPayload,
      sourceRichHtml: buildSourceRichHtml(richPayload),
    };
  }

  function buildRichPayload(range) {
    try {
      const cloned = range.cloneContents();
      const sanitized = sanitizeRichFragment(cloned);
      if (!sanitized || sanitized.childNodes.length === 0) {
        return null;
      }

      const hasStructure = hasStructuralFormatting(sanitized);
      // 缺少结构语义时降级为纯文本，避免无意义的富文本渲染。
      if (!hasStructure) {
        return null;
      }

      const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const { segments, exceeded } = injectRichSegmentPlaceholders(
        sanitized,
        marker,
      );

      if (exceeded || segments.length === 0) {
        return null;
      }

      const wrapper = document.createElement("div");
      wrapper.appendChild(sanitized);
      const htmlTemplate = wrapper.innerHTML;

      if (!htmlTemplate || htmlTemplate.length > RICH_MAX_HTML_LENGTH) {
        return null;
      }

      return {
        htmlTemplate,
        segments,
      };
    } catch (_error) {
      return null;
    }
  }

  function hasStructuralFormatting(fragment) {
    if (!fragment || typeof fragment.querySelector !== "function") {
      return false;
    }

    return Boolean(fragment.querySelector(RICH_STRUCTURAL_SELECTOR));
  }

  function sanitizeRichFragment(fragment) {
    if (!fragment) {
      return null;
    }

    const output = document.createDocumentFragment();
    const children = Array.from(fragment.childNodes);

    for (const child of children) {
      const sanitized = sanitizeRichNode(child);
      if (sanitized) {
        output.appendChild(sanitized);
      }
    }

    return output;
  }

  function sanitizeRichNode(node) {
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue || "").replace(/\r/g, "");

      // pre/code 保留原始空白；其他节点压缩噪声空白，减少译文空行。
      if (node.parentElement?.closest("pre, code")) {
        return document.createTextNode(text);
      }

      if (!text.trim()) {
        return text.includes("\n") ? null : document.createTextNode(" ");
      }

      return document.createTextNode(text.replace(/[\t\f\v ]+/g, " "));
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const tag = node.tagName.toLowerCase();

    // 非白名单标签剥离外壳，仅保留其可翻译子节点。
    if (!RICH_ALLOWED_TAGS.has(tag)) {
      const fragment = document.createDocumentFragment();
      const children = Array.from(node.childNodes);
      for (const child of children) {
        const sanitizedChild = sanitizeRichNode(child);
        if (sanitizedChild) {
          fragment.appendChild(sanitizedChild);
        }
      }
      return fragment;
    }

    const clean = document.createElement(tag);

    if (tag === "a") {
      const href = normalizeSafeHref(node.getAttribute("href"));
      if (href) {
        clean.setAttribute("href", href);
        clean.setAttribute("target", "_blank");
        clean.setAttribute("rel", "noreferrer noopener");
      }
    }

    const children = Array.from(node.childNodes);
    for (const child of children) {
      const sanitizedChild = sanitizeRichNode(child);
      if (sanitizedChild) {
        clean.appendChild(sanitizedChild);
      }
    }

    return clean;
  }

  function normalizeSafeHref(href) {
    if (typeof href !== "string") {
      return "";
    }

    const value = href.trim();
    if (!value) {
      return "";
    }

    if (/^(javascript:|data:|vbscript:)/i.test(value)) {
      return "";
    }

    return value;
  }

  function buildSourceRichHtml(richPayload) {
    if (
      !richPayload ||
      typeof richPayload.htmlTemplate !== "string" ||
      !Array.isArray(richPayload.segments)
    ) {
      return "";
    }

    let sourceHtml = richPayload.htmlTemplate;
    for (const segment of richPayload.segments) {
      if (!segment || typeof segment.id !== "string") {
        continue;
      }

      const segmentText =
        typeof segment.text === "string" ? segment.text.replace(/\r/g, "") : "";
      sourceHtml = sourceHtml.split(segment.id).join(escapeHtml(segmentText));
    }

    return sourceHtml.replace(/\[\[DST_SEG_[^\]]+\]\]/g, "");
  }

  function escapeHtml(text) {
    if (typeof text !== "string") {
      return "";
    }

    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectRichSegmentPlaceholders(root, marker) {
    const segments = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    let current = walker.nextNode();
    while (current) {
      const value = (current.nodeValue || "").replace(/\r/g, "");
      current.nodeValue = value;

      if (value.trim()) {
        if (segments.length >= RICH_MAX_SEGMENTS) {
          return {
            segments: [],
            exceeded: true,
          };
        }

        const id = `[[DST_SEG_${marker}_${segments.length}]]`;
        segments.push({ id, text: value });
        current.nodeValue = id;
      }

      current = walker.nextNode();
    }

    return {
      segments,
      exceeded: false,
    };
  }

  function normalizeSelectionKeyText(value) {
    if (typeof value !== "string") {
      return "";
    }

    return value.replace(/\s+/g, " ").trim();
  }

  function getSelectionRect(range) {
    const directRect = range.getBoundingClientRect();
    if (directRect && (directRect.width > 0 || directRect.height > 0)) {
      return directRect;
    }

    const rectList = range.getClientRects();
    if (rectList.length > 0) {
      return rectList[0];
    }

    return null;
  }

  /**
   * 向后台发起翻译请求，并按响应结果更新面板。
   */
  function requestTranslation(selection) {
    const normalizedSelection = cloneSelectionSnapshot(selection) || selection;
    const { text, rect, richPayload, sourceRichHtml } = normalizedSelection;
    const currentRequest = ++requestId;
    pendingRequestId = currentRequest;
    isRequestPending = true;
    lastSelectionSnapshot = cloneSelectionSnapshot(normalizedSelection);
    const sourcePreview = settings.showSourceText ? text : "";
    const sourceHtml = settings.showSourceText ? sourceRichHtml : "";

    abortActiveStream();

    if (shouldUseStreamingTranslation(richPayload)) {
      startStreamingTranslation({
        requestToken: currentRequest,
        text,
        rect,
        richPayload,
        sourcePreview,
        sourceHtml,
      });
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_TEXT",
        text,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        richPayload,
      },
      (response) => {
        // 仅处理最新请求，过期响应直接丢弃。
        if (currentRequest !== requestId) {
          return;
        }

        isRequestPending = false;
        if (pendingRequestId === currentRequest) {
          pendingRequestId = 0;
        }

        if (chrome.runtime.lastError) {
          // 错误时清空去重指纹，允许用户在同一选区立即重试。
          lastSelectionKey = "";
          showPanel({
            anchorRect: rect,
            translationText: `扩展通信失败：${chrome.runtime.lastError.message}`,
            translationHtml: "",
            sourceText: sourcePreview,
            sourceHtml,
            engine: "error",
            state: "error",
            footnoteText: "请刷新页面后重试。",
          });
          return;
        }

        if (!response || !response.ok) {
          lastSelectionKey = "";
          showPanel({
            anchorRect: rect,
            translationText: response?.error || "翻译失败，请稍后重试。",
            translationHtml: "",
            sourceText: sourcePreview,
            sourceHtml,
            engine: "error",
            state: "error",
            footnoteText: "网络不稳定时可在设置页切换引擎策略。",
          });
          return;
        }

        const data = response.data || {};
        const state = mapPanelState(data.engine);
        const renderPayload = buildTranslationRenderPayload(data);

        showPanel({
          anchorRect: rect,
          translationText: renderPayload.text,
          translationHtml: renderPayload.html,
          sourceText: sourcePreview,
          sourceHtml,
          engine: data.engine,
          state,
          footnoteText: buildFootnoteText(data, state),
        });
      },
    );
  }

  function shouldUseStreamingTranslation(richPayload) {
    return (
      normalizeEngineMode(settings.engineMode) === "ai" &&
      settings.aiEnabledStream !== false &&
      !richPayload
    );
  }

  function startStreamingTranslation({
    requestToken,
    text,
    rect,
    richPayload,
    sourcePreview,
    sourceHtml,
  }) {
    const port = chrome.runtime.connect({ name: "AI_TRANSLATION_STREAM" });
    activeStreamPort = port;
    activeStreamRequestId = requestToken;
    pendingRequestId = requestToken;
    isRequestPending = true;

    port.onMessage.addListener((message) => {
      if (!message || message.requestId !== activeStreamRequestId) {
        return;
      }

      if (requestToken !== requestId) {
        return;
      }

      if (message.type === "translate:start") {
        isStreaming = true;
        showPanel({
          anchorRect: rect,
          translationText: "翻译中...",
          translationHtml: "",
          sourceText: sourcePreview,
          sourceHtml,
          engine: message.engine || "ai",
          state: "loading",
          footnoteText: "翻译进行中，按任意键可中断。",
          pinDuringStream: false,
        });
        return;
      }

      if (message.type === "translate:delta") {
        isStreaming = true;
        showPanel({
          anchorRect: rect,
          translationText: "翻译中...",
          translationHtml: "",
          sourceText: sourcePreview,
          sourceHtml,
          engine: message.engine || "ai",
          state: "loading",
          footnoteText: "翻译进行中，按任意键可中断。",
          pinDuringStream: false,
        });
        return;
      }

      if (message.type === "translate:complete") {
        finishStreamingState();
        isRequestPending = false;
        if (pendingRequestId === requestToken) {
          pendingRequestId = 0;
        }
        const data = message.data || {};
        const state = mapPanelState(data.engine);
        const renderPayload = buildTranslationRenderPayload(data);
        showPanel({
          anchorRect: rect,
          translationText: renderPayload.text,
          translationHtml: renderPayload.html,
          sourceText: sourcePreview,
          sourceHtml,
          engine: data.engine,
          state,
          footnoteText: buildFootnoteText(data, state),
          pinDuringStream: false,
        });
        closeStreamPort(port);
        return;
      }

      if (message.type === "translate:error") {
        finishStreamingState();
        isRequestPending = false;
        if (pendingRequestId === requestToken) {
          pendingRequestId = 0;
        }
        lastSelectionKey = "";
        showPanel({
          anchorRect: rect,
          translationText: message.error || "流式翻译失败，请稍后重试。",
          translationHtml: "",
          sourceText: sourcePreview,
          sourceHtml,
          engine: "error",
          state: "error",
          footnoteText: "可稍后重试，或在设置页调整 AI 接口参数。",
          pinDuringStream: false,
        });
        closeStreamPort(port);
      }
    });

    port.onDisconnect.addListener(() => {
      if (activeStreamPort !== port) {
        return;
      }

      if (isStreaming && requestToken === requestId) {
        finishStreamingState();
      }

      if (pendingRequestId === requestToken) {
        pendingRequestId = 0;
      }
      isRequestPending = false;

      disconnectStreamPort();
    });

    port.postMessage({
      type: "translate:start",
      requestId: requestToken,
      text,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      richPayload,
    });
  }

  function buildTranslationRenderPayload(data) {
    const richHtml =
      typeof data?.richResult?.translatedHtml === "string"
        ? data.richResult.translatedHtml
        : "";

    if (richHtml) {
      return {
        text: normalizePanelText(data.translatedText) || "暂无翻译结果",
        html: richHtml,
      };
    }

    return {
      text: normalizePanelText(data?.translatedText) || "暂无翻译结果",
      html: "",
    };
  }

  /**
   * 懒创建翻译面板 DOM（仅首次调用时执行）。
   */
  function ensurePanel() {
    if (panel) {
      return;
    }

    panel = document.createElement("aside");
    panel.id = "dst-panel";
    panel.className = "dst-hidden";
    panel.dataset.state = "idle";
    panel.dataset.dragging = "false";
    panel.innerHTML = `
      <div class="dst-header">
        <div class="dst-headline">
          <span class="dst-title">SelectEcho</span>
          <span class="dst-state"></span>
        </div>
        <div class="dst-meta">
          <span class="dst-engine"></span>
          <button class="dst-copy" type="button" aria-label="复制译文">复制</button>
          <button class="dst-close" type="button" aria-label="关闭">×</button>
        </div>
      </div>
      <div class="dst-translation" role="status" aria-live="polite"></div>
      <div class="dst-source"></div>
      <div class="dst-footnote"></div>
      <div class="dst-brand">
        <a
          class="dst-brand-link"
          href="https://github.com/2258009564/SelectEcho"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="访问 SelectEcho GitHub 仓库并支持 Star"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49C4 14.09 3.48 13.23 3.32 12.77c-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.52 7.52 0 0 1 8 3.87c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            ></path>
          </svg>
          <span class="dst-brand-text">喜欢的话点个免费 Star 吧</span>
        </a>
      </div>
    `;

    document.documentElement.appendChild(panel);
    ensureEngineMenu();

    translationNode = panel.querySelector(".dst-translation");
    sourceNode = panel.querySelector(".dst-source");
    engineNode = panel.querySelector(".dst-engine");
    headerNode = panel.querySelector(".dst-header");
    stateNode = panel.querySelector(".dst-state");
    footnoteNode = panel.querySelector(".dst-footnote");
    brandNode = panel.querySelector(".dst-brand");
    copyButton = panel.querySelector(".dst-copy");

    const closeButton = panel.querySelector(".dst-close");
    closeButton.addEventListener("click", hidePanel);
    copyButton.addEventListener("click", copyTranslation);

    if (engineNode) {
      engineNode.setAttribute("role", "button");
      engineNode.setAttribute("tabindex", "0");
      engineNode.setAttribute("aria-label", "点击打开翻译引擎菜单");
      engineNode.addEventListener("click", onEngineNodeClick);
      engineNode.addEventListener("keydown", onEngineNodeKeyDown);
    }

    if (headerNode) {
      headerNode.addEventListener("mousedown", onPanelDragStart);
    }

    applyPanelTheme();
  }

  function ensureEngineMenu() {
    if (engineMenu) {
      return;
    }

    engineMenu = document.createElement("div");
    engineMenu.id = "dst-engine-menu";
    engineMenu.hidden = true;
    engineMenu.setAttribute("role", "menu");
    document.documentElement.appendChild(engineMenu);
  }

  /**
   * 更新面板内容、状态与位置，然后显示面板。
   */
  function showPanel({
    anchorRect,
    translationText,
    translationHtml,
    sourceText,
    sourceHtml,
    engine,
    state,
    footnoteText,
    pinDuringStream,
  }) {
    ensurePanel();

    const normalizedState = state || "idle";
    panel.dataset.state = normalizedState;
    panel.dataset.pinned = pinDuringStream ? "true" : "false";
    isPinnedDuringStream = Boolean(pinDuringStream);

    const isLoadingState = normalizedState === "loading";
    setLoadingCapsuleMode(isLoadingState);

    if (isLoadingState) {
      applyTranslationContent(LOADING_CAPSULE_TEXT, "");
      applyEngineLabel("");
      applyStateLabel("");
      applyCopyAvailability(normalizedState);
      applySourceContent("", "");
      if (footnoteNode) {
        footnoteNode.textContent = "";
      }
    } else {
      applyTranslationContent(translationText, translationHtml);
      applyEngineLabel(engine);
      applyStateLabel(normalizedState);
      applyCopyAvailability(normalizedState);
      applySourceContent(sourceText, sourceHtml);

      if (footnoteText) {
        footnoteNode.textContent = footnoteText;
        footnoteNode.style.display = "block";
      } else {
        footnoteNode.textContent = "";
        footnoteNode.style.display = "none";
      }
    }

    if (isLoadingState && footnoteNode) {
      footnoteNode.style.display = "none";
    }

    // 先定位再显示，避免先闪到左上角再跳位。
    lastAnchorRect = anchorRect || lastAnchorRect;
    positionPanel(lastAnchorRect);
    panel.classList.remove("dst-hidden");
  }

  function setLoadingCapsuleMode(enabled) {
    if (!panel || !translationNode) {
      return;
    }

    if (enabled) {
      isLoadingCapsuleMode = true;
      panel.dataset.mode = "loading-capsule";
      closeEngineMenu();
      stopPanelDragging();
      translationNode.classList.remove("is-rich");
      return;
    }

    if (!isLoadingCapsuleMode) {
      return;
    }

    isLoadingCapsuleMode = false;
    panel.dataset.mode = "default";

    if (headerNode) {
      headerNode.style.removeProperty("display");
    }
    if (sourceNode) {
      sourceNode.style.removeProperty("display");
    }
    if (footnoteNode) {
      footnoteNode.style.removeProperty("display");
    }
    if (brandNode) {
      brandNode.style.removeProperty("display");
    }
  }

  function applyTranslationContent(translationText, translationHtml) {
    if (!translationNode) {
      return;
    }

    if (translationHtml) {
      translationNode.innerHTML = translationHtml;
      translationNode.classList.add("is-rich");
      return;
    }

    translationNode.textContent = translationText || "暂无翻译结果";
    translationNode.classList.remove("is-rich");
  }

  function applySourceContent(sourceText, sourceHtml) {
    if (!sourceNode) {
      return;
    }

    const normalizedRichHtml = normalizeSourceRichHtml(sourceHtml);
    if (normalizedRichHtml) {
      sourceNode.innerHTML = `<div class="dst-source-label">原文</div><div class="dst-source-rich">${normalizedRichHtml}</div>`;
      sourceNode.classList.add("is-rich");
      sourceNode.style.display = "block";
      return;
    }

    const plainSource = normalizeSourcePreviewText(sourceText);
    if (plainSource) {
      const preview =
        plainSource.length > 180
          ? `${plainSource.slice(0, 180)}...`
          : plainSource;
      sourceNode.textContent = `原文：${preview}`;
      sourceNode.classList.remove("is-rich");
      sourceNode.style.display = "block";
      return;
    }

    sourceNode.textContent = "";
    sourceNode.classList.remove("is-rich");
    sourceNode.style.display = "none";
  }

  function applyPanelTheme() {
    if (!panel) {
      return;
    }

    const theme = normalizeTheme(settings.panelTheme);
    panel.dataset.theme = theme;
    panel.dataset.layout = getThemeLayout(theme);
  }

  function getThemeLayout(theme) {
    switch (theme) {
      case "classic":
        return "classic";
      case "brutal":
        return "brutal";
      case "editorial":
        return "editorial";
      case "terminal":
        return "terminal";
      default:
        return "glass";
    }
  }

  function normalizeTheme(theme) {
    if (typeof theme !== "string") {
      return DEFAULT_SETTINGS.panelTheme;
    }

    const normalized = theme.trim().toLowerCase();
    const aliasTheme = THEME_ALIASES[normalized] || normalized;

    if (!aliasTheme || !THEMES.has(aliasTheme)) {
      return DEFAULT_SETTINGS.panelTheme;
    }

    return aliasTheme;
  }

  function normalizeEngineMode(value) {
    if (typeof value !== "string") {
      return DEFAULT_SETTINGS.engineMode;
    }

    const normalized = value.trim().toLowerCase();
    if (!ENGINE_MODE_OPTIONS.includes(normalized)) {
      return DEFAULT_SETTINGS.engineMode;
    }

    return normalized;
  }

  function getEngineModeLabel(engineMode) {
    return getEngineLabel(normalizeEngineMode(engineMode));
  }

  function applyEngineLabel(engine) {
    if (!engineNode) {
      return;
    }

    const label = getEngineLabel(engine);
    if (!label) {
      engineNode.textContent = "";
      engineNode.style.display = "none";
      engineNode.title = "";
      return;
    }

    engineNode.textContent = label;
    engineNode.style.display = "inline-flex";
    const currentMode = normalizeEngineMode(settings.engineMode);
    engineNode.dataset.mode = currentMode;
    engineNode.title = `点击切换翻译引擎（当前默认：${getEngineModeLabel(currentMode)}）`;
  }

  function applyStateLabel(state) {
    if (!stateNode) {
      return;
    }

    const label = getStateLabel(state);
    if (!label) {
      stateNode.textContent = "";
      stateNode.style.display = "none";
      return;
    }

    stateNode.textContent = label;
    stateNode.style.display = "inline-flex";
  }

  function applyCopyAvailability(state) {
    if (!copyButton || !translationNode) {
      return;
    }

    const currentText = normalizePanelText(translationNode.textContent);
    const canCopy = state === "success" && Boolean(currentText);
    copyButton.disabled = !canCopy;
    copyButton.textContent = "复制";
  }

  function onEngineNodeClick(event) {
    event.preventDefault();
    event.stopPropagation();
    toggleEngineMenu();
  }

  function onEngineNodeKeyDown(event) {
    if (
      event.key !== "Enter" &&
      event.key !== " " &&
      event.key !== "ArrowDown"
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openEngineMenu();
  }

  function toggleEngineMenu() {
    if (isEngineMenuOpen()) {
      closeEngineMenu();
      return;
    }

    openEngineMenu();
  }

  function isEngineMenuOpen() {
    return Boolean(engineMenu && !engineMenu.hidden);
  }

  function openEngineMenu() {
    ensureEngineMenu();

    if (!engineMenu || !engineNode || panel?.classList.contains("dst-hidden")) {
      return;
    }

    renderEngineMenuOptions();
    engineMenu.hidden = false;
    positionEngineMenu();
  }

  function closeEngineMenu() {
    if (!engineMenu) {
      return;
    }

    engineMenu.hidden = true;
    engineMenu.innerHTML = "";
  }

  function renderEngineMenuOptions() {
    if (!engineMenu) {
      return;
    }

    const currentMode = normalizeEngineMode(settings.engineMode);
    const optionsHtml = ENGINE_MODE_OPTIONS.map((mode) => {
      const label = getEngineModeLabel(mode) || "Auto";
      const selected = mode === currentMode;
      return `<button class="dst-engine-option${selected ? " is-active" : ""}" type="button" data-mode="${mode}" role="menuitemradio" aria-checked="${selected ? "true" : "false"}"><span>${label}</span><span class="dst-engine-check" aria-hidden="true">${selected ? "✓" : ""}</span></button>`;
    }).join("");

    engineMenu.innerHTML = optionsHtml;

    const optionNodes = engineMenu.querySelectorAll(".dst-engine-option");
    optionNodes.forEach((node) => {
      node.addEventListener("click", (event) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const nextMode = target.dataset.mode || "auto";
        closeEngineMenu();
        applyEngineModeAndRetrigger(nextMode);
      });
    });
  }

  function positionEngineMenu() {
    if (!engineMenu || !engineNode) {
      return;
    }

    const margin = 8;
    const nodeRect = engineNode.getBoundingClientRect();
    const menuWidth = Math.max(engineMenu.offsetWidth, 150);
    const menuHeight = Math.max(engineMenu.offsetHeight, 132);

    let left = nodeRect.right - menuWidth;
    let top = nodeRect.bottom + 6;

    if (left < margin) {
      left = margin;
    }

    if (left + menuWidth > window.innerWidth - margin) {
      left = window.innerWidth - menuWidth - margin;
    }

    if (top + menuHeight > window.innerHeight - margin) {
      top = nodeRect.top - menuHeight - 6;
    }

    if (top < margin) {
      top = margin;
    }

    engineMenu.style.left = `${Math.round(left)}px`;
    engineMenu.style.top = `${Math.round(top)}px`;
  }

  function applyEngineModeAndRetrigger(nextMode) {
    const normalizedMode = normalizeEngineMode(nextMode);
    const previousMode = normalizeEngineMode(settings.engineMode);
    const modeLabel = getEngineModeLabel(normalizedMode) || "Auto";

    chrome.storage.sync.set({ engineMode: normalizedMode }, () => {
      if (chrome.runtime.lastError) {
        settings.engineMode = previousMode;

        if (footnoteNode) {
          footnoteNode.textContent = `引擎切换失败：${chrome.runtime.lastError.message}`;
          footnoteNode.style.display = "block";
        }
        return;
      }

      settings.engineMode = normalizedMode;

      const snapshot = cloneSelectionSnapshot(lastSelectionSnapshot);
      if (!snapshot || !snapshot.text) {
        applyEngineLabel(normalizedMode);
        if (footnoteNode) {
          footnoteNode.textContent = `已切换到 ${modeLabel}。`;
          footnoteNode.style.display = "block";
        }
        return;
      }

      cancelPendingTranslation({
        keepPanelVisible: false,
        skipPanelStateUpdate: true,
      });

      const sourcePreview = settings.showSourceText ? snapshot.text : "";
      const sourceHtml = settings.showSourceText ? snapshot.sourceRichHtml : "";

      showPanel({
        anchorRect: snapshot.rect,
        translationText: "翻译中...",
        translationHtml: "",
        sourceText: sourcePreview,
        sourceHtml,
        engine: normalizedMode,
        state: "loading",
        footnoteText: `已切换到 ${modeLabel}，正在重新翻译。`,
        pinDuringStream: false,
      });

      requestTranslation(snapshot);
    });
  }

  function mapPanelState(engine) {
    switch (engine) {
      case "skip":
        return "skip";
      case "error":
        return "error";
      case "loading":
        return "loading";
      default:
        return "success";
    }
  }

  function getStateLabel(state) {
    switch (state) {
      case "loading":
        return "翻译中";
      case "canceled":
        return "已中断";
      case "error":
        return "失败";
      case "skip":
        return "已跳过";
      case "success":
        return "完成";
      default:
        return "";
    }
  }

  function getEngineLabel(engine) {
    switch (engine) {
      case "auto":
        return "Auto";
      case "ai":
        return "AI";
      case "google":
        return "Google";
      case "baidu":
        return "Baidu";
      case "skip":
        return "Skip";
      case "loading":
        return "...";
      case "error":
        return "Error";
      default:
        return "";
    }
  }

  function buildFootnoteText(data, state) {
    if (state === "loading") {
      return "翻译进行中，按任意键可立即中断。";
    }

    if (state === "canceled") {
      return "翻译已中断，可重新划词或点击引擎重试。";
    }

    if (state === "error") {
      return "可稍后重试，或在设置页调整引擎参数。";
    }

    const detectMeta = data?.detectMeta || null;
    const variantText = getVariantText(detectMeta?.variant);
    const ratioText = formatRatio(detectMeta?.chineseRatio);
    const richBadge = data?.richResult?.translatedHtml
      ? "，格式保真：结构模式"
      : "";

    if (state === "skip") {
      return `检测结果：${variantText}，中文占比约 ${ratioText}${richBadge}。`;
    }

    const engineName = getEngineLabel(data?.engine) || "Engine";
    return `引擎：${engineName}，识别：${variantText}，中文占比约 ${ratioText}${richBadge}。`;
  }

  function getVariantText(variant) {
    switch (variant) {
      case "traditional":
        return "繁体中文";
      case "simplified":
        return "简体中文";
      case "non-chinese":
        return "非中文";
      case "unknown-chinese":
        return "中文（未区分简繁）";
      default:
        return "未知";
    }
  }

  function formatRatio(ratio) {
    const safe = Number(ratio);
    if (!Number.isFinite(safe) || safe <= 0) {
      return "0%";
    }

    const value = Math.round(Math.min(Math.max(safe, 0), 1) * 100);
    return `${value}%`;
  }

  async function copyTranslation() {
    if (!copyButton || copyButton.disabled || !translationNode) {
      return;
    }

    const text = normalizePanelText(translationNode.textContent);
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = "已复制";

      if (copyResetTimer) {
        clearTimeout(copyResetTimer);
      }

      copyResetTimer = window.setTimeout(() => {
        if (copyButton) {
          copyButton.textContent = "复制";
        }
      }, 1200);
    } catch (_error) {
      copyButton.textContent = "复制失败";

      if (copyResetTimer) {
        clearTimeout(copyResetTimer);
      }

      copyResetTimer = window.setTimeout(() => {
        if (copyButton) {
          copyButton.textContent = "复制";
        }
      }, 1500);
    }
  }

  function normalizePanelText(text) {
    if (typeof text !== "string") {
      return "";
    }

    return text.trim();
  }

  function normalizeSourcePreviewText(text) {
    if (typeof text !== "string") {
      return "";
    }

    return text.replace(/\r/g, "").replace(/\s+/g, " ").trim();
  }

  function normalizeSourceRichHtml(html) {
    if (typeof html !== "string") {
      return "";
    }

    return html.trim();
  }

  /**
   * 面板定位：
   * 1. 水平以选区中心对齐，并执行左右边界夹紧。
   * 2. 垂直优先放在下方；下方空间不足时翻到上方。
   * 3. 最终位置统一 clamp 到可视区域，避免超出窗口。
   */
  function positionPanel(anchorRect) {
    if (!panel) {
      return;
    }

    panel.style.position = "absolute";
    const margin = 12;
    const fallbackRect = {
      top: window.innerHeight / 2,
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      bottom: window.innerHeight / 2,
      width: 0,
      height: 0,
    };

    const panelRect = panel.getBoundingClientRect();
    const minLeft = window.scrollX + margin;
    const maxLeft =
      window.scrollX + window.innerWidth - panelRect.width - margin;
    const minTop = window.scrollY + margin;
    const maxTop =
      window.scrollY + window.innerHeight - panelRect.height - margin;

    // 用户拖拽后，优先采用手动位置并持续做视口边界修正。
    if (customPanelPosition) {
      const clampedLeft = clamp(customPanelPosition.left, minLeft, maxLeft);
      const clampedTop = clamp(customPanelPosition.top, minTop, maxTop);
      customPanelPosition = {
        left: clampedLeft,
        top: clampedTop,
      };

      panel.style.left = `${Math.round(clampedLeft)}px`;
      panel.style.top = `${Math.round(clampedTop)}px`;
      return;
    }

    const rect = anchorRect || fallbackRect;

    const centerX = rect.left + (rect.width || rect.right - rect.left || 0) / 2;
    let left = window.scrollX + centerX - panelRect.width / 2;
    left = clamp(left, minLeft, maxLeft);

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    let top;
    if (spaceBelow >= panelRect.height + margin || spaceBelow >= spaceAbove) {
      top = window.scrollY + rect.bottom + margin;
    } else {
      top = window.scrollY + rect.top - panelRect.height - margin;
    }

    top = clamp(top, minTop, maxTop);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function clamp(value, min, max) {
    if (max < min) {
      return min;
    }

    return Math.min(Math.max(value, min), max);
  }

  function onPanelDragStart(event) {
    if (event.button !== 0 || !panel || panel.classList.contains("dst-hidden")) {
      return;
    }

    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".dst-copy, .dst-close, .dst-engine, a, button")
    ) {
      return;
    }

    const panelRect = panel.getBoundingClientRect();
    dragOffsetX = event.clientX - panelRect.left;
    dragOffsetY = event.clientY - panelRect.top;
    isDraggingPanel = true;
    panel.dataset.dragging = "true";

    document.addEventListener("mousemove", onPanelDragMove, true);
    document.addEventListener("mouseup", onPanelDragEnd, true);

    event.preventDefault();
    event.stopPropagation();
  }

  function onPanelDragMove(event) {
    if (!isDraggingPanel || !panel) {
      return;
    }

    customPanelPosition = {
      left: window.scrollX + event.clientX - dragOffsetX,
      top: window.scrollY + event.clientY - dragOffsetY,
    };
    positionPanel(lastAnchorRect);
    event.preventDefault();
  }

  function onPanelDragEnd(event) {
    stopPanelDragging();

    if (!event) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  function stopPanelDragging() {
    if (!isDraggingPanel) {
      return;
    }

    isDraggingPanel = false;
    if (panel) {
      panel.dataset.dragging = "false";
    }

    document.removeEventListener("mousemove", onPanelDragMove, true);
    document.removeEventListener("mouseup", onPanelDragEnd, true);
  }

  function createPointAnchorRect(clientX, clientY) {
    const x = Number(clientX);
    const y = Number(clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return {
      top: y,
      left: x,
      right: x,
      bottom: y,
      width: 0,
      height: 0,
    };
  }

  function cloneAnchorRect(rect) {
    if (!rect) {
      return null;
    }

    return {
      top: Number(rect.top) || 0,
      left: Number(rect.left) || 0,
      right: Number(rect.right) || Number(rect.left) || 0,
      bottom: Number(rect.bottom) || Number(rect.top) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0,
    };
  }

  function cloneSelectionSnapshot(selection) {
    if (!selection || typeof selection.text !== "string") {
      return null;
    }

    return {
      text: selection.text,
      rect: cloneAnchorRect(selection.rect),
      richPayload: cloneRichPayload(selection.richPayload),
      sourceRichHtml:
        typeof selection.sourceRichHtml === "string"
          ? selection.sourceRichHtml
          : "",
    };
  }

  function cloneRichPayload(richPayload) {
    if (
      !richPayload ||
      typeof richPayload.htmlTemplate !== "string" ||
      !Array.isArray(richPayload.segments)
    ) {
      return null;
    }

    return {
      htmlTemplate: richPayload.htmlTemplate,
      segments: richPayload.segments.map((segment) => ({
        id: segment?.id || "",
        text: typeof segment?.text === "string" ? segment.text : "",
      })),
    };
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest(EDITABLE_SELECTOR));
  }

  function isNodeInsideEditable(node) {
    if (!node) {
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return isEditableTarget(node.parentElement);
    }

    return isEditableTarget(node);
  }

  function isTranslationPending() {
    return isStreaming || isRequestPending || Boolean(activeStreamPort);
  }

  function isModifierOnlyKey(event) {
    return MODIFIER_ONLY_KEYS.has(event.key);
  }

  function cancelPendingTranslation(options = {}) {
    const keepPanelVisible = options.keepPanelVisible !== false;
    const skipPanelStateUpdate = Boolean(options.skipPanelStateUpdate);
    const footnoteText =
      typeof options.footnoteText === "string"
        ? options.footnoteText
        : "翻译已中断，可重新划词或点击引擎重试。";
    const hasPending = isTranslationPending();

    if (!hasPending) {
      return false;
    }

    abortActiveStream();
    requestId += 1;
    pendingRequestId = 0;
    isRequestPending = false;
    lastSelectionKey = "";
    finishStreamingState();

    if (
      !keepPanelVisible ||
      skipPanelStateUpdate ||
      !panel ||
      panel.classList.contains("dst-hidden")
    ) {
      return true;
    }

    panel.dataset.state = "canceled";
    panel.dataset.pinned = "false";
    applyStateLabel("canceled");
    applyCopyAvailability("canceled");

    if (footnoteNode) {
      footnoteNode.textContent = footnoteText;
      footnoteNode.style.display = "block";
    }

    return true;
  }

  function interruptPendingTranslationForUserAction() {
    closeEngineMenu();

    const canceled = cancelPendingTranslation({
      keepPanelVisible: false,
      skipPanelStateUpdate: true,
    });

    if (!canceled || !panel) {
      return;
    }

    panel.classList.add("dst-hidden");
    panel.dataset.state = "idle";
    panel.dataset.pinned = "false";
    setLoadingCapsuleMode(false);
  }

  /**
   * 隐藏面板并清理本轮交互的临时状态。
   */
  function hidePanel() {
    if (!panel) {
      return;
    }

    closeEngineMenu();

    const canceled = cancelPendingTranslation({
      keepPanelVisible: false,
      skipPanelStateUpdate: true,
    });

    if (!canceled) {
      requestId += 1;
      pendingRequestId = 0;
      isRequestPending = false;
    }

    stopPanelDragging();

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }

    // 关闭后允许同一选区再次触发（例如手动重试）。
    lastSelectionKey = "";
    lastAnchorRect = null;
    lastMouseAnchorRect = null;
    skipNextMouseUpTranslate = false;
    customPanelPosition = null;
    finishStreamingState();
    panel.classList.add("dst-hidden");
    panel.dataset.state = "idle";
    panel.dataset.pinned = "false";
    setLoadingCapsuleMode(false);
  }

  function abortActiveStream() {
    if (!activeStreamPort) {
      return;
    }

    closeStreamPort(activeStreamPort);
    finishStreamingState();
  }

  function closeStreamPort(port) {
    if (!port) {
      disconnectStreamPort();
      return;
    }

    try {
      port.disconnect();
    } catch (_error) {
      // ignore disconnect errors
    }

    if (activeStreamPort === port) {
      disconnectStreamPort();
    }
  }

  function disconnectStreamPort() {
    activeStreamPort = null;
    activeStreamRequestId = 0;
  }

  function finishStreamingState() {
    isStreaming = false;
    isPinnedDuringStream = false;
  }
})();
