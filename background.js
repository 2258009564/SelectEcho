/**
 * background.js（后台 Service Worker）
 *
 * 这个文件负责：
 * 1. 接收 content.js 的翻译请求并读取当前配置。
 * 2. 按引擎模式与凭证状态在百度/Google/AI 间做选择。
 * 3. 结合语言检测与特征字判断简繁，决定是否跳过。
 * 4. 统一处理超时、错误提示、结构化翻译、流式响应与缓存。
 */

const AI_PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    path: "/v1/chat/completions",
    model: "gpt-4.1-mini",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    path: "/v1/chat/completions",
    model: "deepseek-chat",
  },
  "zhipu-flash-free": {
    label: "智谱 Flash 免费",
    baseUrl: "https://open.bigmodel.cn",
    path: "/api/paas/v4/chat/completions",
    model: "glm-4-flash",
  },
  custom: {
    label: "Custom AI",
    baseUrl: "",
    path: "/v1/chat/completions",
    model: "",
  },
};

const AI_PROMPT_PRESETS = {
  "precision-translate": {
    label: "高保真精翻",
    prompt:
      "你是专业翻译助手。请忠实翻译用户提供的文本，优先保证准确、自然、术语一致，保留段落、列表、代码块、换行与原始结构，不要添加解释，不要省略内容，不要输出译者说明。",
  },
};

const DEFAULT_SETTINGS = {
  // 源语言；auto 表示交给翻译服务自动识别。
  sourceLang: "auto",
  // 目标语言；默认翻译为简体中文。
  targetLang: "zh-CN",
  // 单次请求可翻译的最大字符数。
  maxChars: 2000,
  // 是否展示原文预览（由 content.js 渲染）。
  showSourceText: true,
  // 引擎模式：auto / baidu / google / ai。
  engineMode: "auto",
  // 面板主题配置：后台仅负责存储与透传，不参与样式渲染。
  panelTheme: "classic",
  // 百度翻译凭证（需 AppID/密钥成对）。
  baiduAppId: "",
  baiduAppKey: "",
  // AI 接口预设与自定义参数。
  aiProviderPreset: "openai",
  aiBaseUrl: AI_PROVIDER_PRESETS.openai.baseUrl,
  aiApiKey: "",
  aiModel: AI_PROVIDER_PRESETS.openai.model,
  aiPath: AI_PROVIDER_PRESETS.openai.path,
  aiPromptPreset: "precision-translate",
  aiCustomPrompt: "",
  aiEnabledStream: true,
};

const cache = new Map();
const CACHE_LIMIT = 150;
const activeStreamControllers = new Map();

// Google 通道固定 3 秒超时，避免长时间无响应。
const GOOGLE_TIMEOUT_MS = 3000;
// 百度通道预留更长超时窗口，适配常见网络波动。
const BAIDU_TIMEOUT_MS = 6000;
// AI 通道默认给长文本更长等待时间。
const AI_TIMEOUT_MS = 45000;

const MIN_TEXT_LENGTH = 2;
const MIN_CHINESE_RATIO = 0.3;
const RICH_MAX_SEGMENTS = 120;
const RICH_MAX_HTML_LENGTH = 120000;

// 中文字符范围：用于计算“中文占比”。
const CHINESE_CHAR_REGEXP = /[\u3400-\u9FFF]/g;

// 简繁特征字：当 detectLanguage 结果不稳定时作为辅助信号。
const SIMPLIFIED_MARKER_REGEXP =
  /[这边发后开关里国学门风车书云气线见说听体点]/g;
const TRADITIONAL_MARKER_REGEXP =
  /[這邊發後開關裡國學門風車書雲氣線見說聽體點]/g;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  });
});

// 配置变化后清空缓存，避免旧配置命中旧结果。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  if (Object.keys(changes).length > 0) {
    cache.clear();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "TRANSLATE_TEXT") {
    return;
  }

  translateMessage(message)
    .then((data) => {
      sendResponse({ ok: true, data });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error:
          error instanceof Error ? error.message : "翻译失败，请稍后重试。",
      });
    });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "AI_TRANSLATION_STREAM") {
    return;
  }

  let streamKey = "";

  port.onMessage.addListener((message) => {
    if (!message || message.type !== "translate:start") {
      return;
    }

    streamKey = `${port.sender?.tab?.id || "tab"}:${String(message.requestId || "")}`;
    handleStreamingTranslation(port, message, streamKey).catch((error) => {
      safePostMessage(port, {
        type: "translate:error",
        requestId: message.requestId,
        error:
          error instanceof Error ? error.message : "流式翻译失败，请稍后重试。",
      });
    });
  });

  port.onDisconnect.addListener(() => {
    if (!streamKey) {
      return;
    }

    const controller = activeStreamControllers.get(streamKey);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(streamKey);
    }
  });
});

// 左键点击扩展图标时，直接打开设置页，降低配置入口成本。
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

async function translateMessage(message) {
  const settings = await getSettings();
  const aiSettings = resolveAiSettings(settings);
  const sourceLang = normalizeLanguage(
    message.sourceLang || settings.sourceLang || "auto",
  );
  const targetLang = normalizeLanguage(
    message.targetLang || settings.targetLang || "zh-CN",
  );
  const text = sanitizeText(message.text, { collapseWhitespace: false });
  const compactText = sanitizeText(message.text, { collapseWhitespace: true });
  const richPayload = normalizeRichPayload(message.richPayload);

  if (!text) {
    throw new Error("未检测到可翻译文本。");
  }

  if (compactText.length < MIN_TEXT_LENGTH) {
    return buildSkipResult(
      "选中文本少于2个字符，已跳过翻译。",
      targetLang,
      "too-short",
      {
        variant: "unknown",
        chineseRatio: 0,
        confidence: 1,
      },
    );
  }

  const maxChars = Number(settings.maxChars) || DEFAULT_SETTINGS.maxChars;
  if (compactText.length > maxChars) {
    throw new Error(`选中文本超过 ${maxChars} 字符限制。`);
  }

  const baiduAppId = sanitizeCredential(settings.baiduAppId);
  const baiduAppKey = sanitizeCredential(settings.baiduAppKey);
  const hasBaiduCredential = Boolean(baiduAppId && baiduAppKey);
  const engineMode = normalizeEngineMode(settings.engineMode);
  const selectedEngine = resolveEngineSelection(
    engineMode,
    hasBaiduCredential,
    aiSettings.isConfigured,
  );

  if (selectedEngine === "baidu" && !hasBaiduCredential) {
    throw new Error("当前引擎模式为仅百度，但未填写完整的百度 AppID 和密钥。");
  }

  if (selectedEngine === "ai" && !aiSettings.isConfigured) {
    throw new Error(
      "当前引擎模式为 AI 精翻，但 AI Base URL、API Key 或模型名未配置完整。",
    );
  }

  const languageInfo = await detectLanguageWithFallback(compactText || text);
  const skipDecision = evaluateSkipDecision({
    sourceLang,
    targetLang,
    languageInfo,
  });

  const richCacheKey = richPayload ? createRichCacheKey(richPayload) : "plain";
  const cacheKey = `${selectedEngine}|${sourceLang}|${targetLang}|${skipDecision.variant}|${richCacheKey}|${compactText}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (skipDecision.shouldSkip) {
    const skipResult = buildSkipResult(
      "检测到简体中文，已跳过翻译。",
      targetLang,
      "simplified-zh",
      {
        variant: skipDecision.variant,
        chineseRatio: skipDecision.chineseRatio,
        confidence: skipDecision.confidence,
      },
    );
    saveCache(cacheKey, skipResult);
    return skipResult;
  }

  // 源语言为 auto 且识别为繁体时，改用 zh-TW 提高繁转简稳定性。
  const effectiveSourceLang = resolveEffectiveSourceLang(
    sourceLang,
    skipDecision.variant,
    languageInfo.language,
  );

  const result = richPayload
    ? selectedEngine === "baidu"
      ? await translateRichWithBaiduEngine(
          richPayload,
          effectiveSourceLang,
          targetLang,
          baiduAppId,
          baiduAppKey,
        )
      : selectedEngine === "ai"
        ? await translateRichWithAiEngine(
            richPayload,
            effectiveSourceLang,
            targetLang,
            aiSettings,
          )
        : await translateRichWithGoogleEngine(
            richPayload,
            effectiveSourceLang,
            targetLang,
          )
    : selectedEngine === "baidu"
      ? await translateWithBaiduEngine(
          text,
          effectiveSourceLang,
          targetLang,
          baiduAppId,
          baiduAppKey,
        )
      : selectedEngine === "ai"
        ? await translateWithAiEngine(
            text,
            effectiveSourceLang,
            targetLang,
            aiSettings,
          )
        : await translateWithGoogleEngine(
            text,
            effectiveSourceLang,
            targetLang,
          );

  // 回传识别元信息，前端可据此展示提示并辅助排障。
  result.detectMeta = {
    variant: skipDecision.variant,
    chineseRatio: skipDecision.chineseRatio,
    confidence: skipDecision.confidence,
  };

  saveCache(cacheKey, result);
  return result;
}

function resolveEffectiveSourceLang(sourceLang, variant, detectedLanguage) {
  const normalizedSource = normalizeDetectedLanguage(sourceLang);
  if (normalizedSource !== "auto") {
    return sourceLang;
  }

  if (variant === "traditional") {
    return "zh-TW";
  }

  if (detectedLanguage === "zh-TW") {
    return "zh-TW";
  }

  return sourceLang;
}

function evaluateSkipDecision({ sourceLang, targetLang, languageInfo }) {
  const normalizedTarget = normalizeDetectedLanguage(targetLang);
  if (normalizedTarget !== "zh-CN") {
    return {
      shouldSkip: false,
      reason: "target-not-zh-cn",
      variant: languageInfo.scriptVariant,
      chineseRatio: languageInfo.chineseRatio,
      confidence: languageInfo.confidence,
    };
  }

  const normalizedSource = normalizeDetectedLanguage(sourceLang);

  // 用户显式指定繁体来源时，必须执行翻译，不能跳过。
  if (normalizedSource === "zh-TW") {
    return {
      shouldSkip: false,
      reason: "source-explicit-traditional",
      variant: "traditional",
      chineseRatio: languageInfo.chineseRatio,
      confidence: 1,
    };
  }

  if (languageInfo.chineseRatio <= MIN_CHINESE_RATIO) {
    return {
      shouldSkip: false,
      reason: "not-enough-chinese",
      variant: languageInfo.scriptVariant,
      chineseRatio: languageInfo.chineseRatio,
      confidence: languageInfo.confidence,
    };
  }

  if (languageInfo.scriptVariant === "traditional") {
    return {
      shouldSkip: false,
      reason: "traditional-should-translate",
      variant: "traditional",
      chineseRatio: languageInfo.chineseRatio,
      confidence: languageInfo.confidence,
    };
  }

  // 仅在以下场景允许跳过：
  // 1) 检测结果明确为简体
  // 2) 用户显式选择 zh-CN，且中文占比达到阈值
  if (
    languageInfo.scriptVariant === "simplified" ||
    normalizedSource === "zh-CN"
  ) {
    return {
      shouldSkip: true,
      reason: "simplified-skip",
      variant: "simplified",
      chineseRatio: languageInfo.chineseRatio,
      confidence: Math.max(
        languageInfo.confidence,
        normalizedSource === "zh-CN" ? 1 : 0,
      ),
    };
  }

  // 模糊场景默认继续翻译，优先避免把繁体误判为可跳过。
  return {
    shouldSkip: false,
    reason: "unknown-translate",
    variant: languageInfo.scriptVariant,
    chineseRatio: languageInfo.chineseRatio,
    confidence: languageInfo.confidence,
  };
}

function buildSkipResult(message, targetLang, reason, meta) {
  return {
    translatedText: message,
    detectedSourceLang: "zh-CN",
    targetLang,
    engine: "skip",
    engineLabel: "Skip",
    skipReason: reason,
    detectMeta: meta,
  };
}

function saveCache(key, value) {
  cache.set(key, value);

  if (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function normalizeRichPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (
    typeof payload.htmlTemplate !== "string" ||
    !Array.isArray(payload.segments)
  ) {
    return null;
  }

  const htmlTemplate = payload.htmlTemplate.trim();
  if (!htmlTemplate || htmlTemplate.length > RICH_MAX_HTML_LENGTH) {
    return null;
  }

  const segments = [];
  const seenIds = new Set();

  for (const item of payload.segments) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const id = typeof item.id === "string" ? item.id.trim() : "";
    const text =
      typeof item.text === "string" ? item.text.replace(/\r/g, "") : "";
    if (!id || seenIds.has(id) || !htmlTemplate.includes(id)) {
      continue;
    }

    seenIds.add(id);
    segments.push({ id, text });

    if (segments.length >= RICH_MAX_SEGMENTS) {
      break;
    }
  }

  if (segments.length === 0) {
    return null;
  }

  return {
    htmlTemplate,
    segments,
  };
}

function createRichCacheKey(richPayload) {
  const digest = richPayload.segments
    .slice(0, 20)
    .map((item) => item.id)
    .join("|");

  return `rich:${richPayload.segments.length}:${richPayload.htmlTemplate.length}:${digest}`;
}

async function detectLanguageWithFallback(text) {
  const chineseRatio = calculateChineseRatio(text);

  const markerInfo = detectScriptByMarkers(text);

  if (!chrome?.i18n?.detectLanguage) {
    return {
      available: false,
      rawLanguage: "unknown",
      language: "unknown",
      confidence: markerInfo.confidence,
      chineseRatio,
      scriptVariant: markerInfo.variant,
      simplifiedMarkerCount: markerInfo.simplifiedCount,
      traditionalMarkerCount: markerInfo.traditionalCount,
    };
  }

  return new Promise((resolve) => {
    chrome.i18n.detectLanguage(text, (result) => {
      if (chrome.runtime.lastError) {
        resolve({
          available: false,
          rawLanguage: "unknown",
          language: "unknown",
          confidence: markerInfo.confidence,
          chineseRatio,
          scriptVariant: markerInfo.variant,
          simplifiedMarkerCount: markerInfo.simplifiedCount,
          traditionalMarkerCount: markerInfo.traditionalCount,
        });
        return;
      }

      const candidates = Array.isArray(result?.languages)
        ? result.languages
        : [];
      if (candidates.length === 0) {
        resolve({
          available: false,
          rawLanguage: "unknown",
          language: "unknown",
          confidence: markerInfo.confidence,
          chineseRatio,
          scriptVariant: markerInfo.variant,
          simplifiedMarkerCount: markerInfo.simplifiedCount,
          traditionalMarkerCount: markerInfo.traditionalCount,
        });
        return;
      }

      const best = candidates
        .slice()
        .sort((a, b) => (b.percentage || 0) - (a.percentage || 0))[0];
      const normalized = normalizeDetectedLanguage(best?.language);

      // 语言检测不够明确时，回退到特征字信号判断简繁。
      const scriptVariant = resolveScriptVariantFromSignals({
        normalizedLanguage: normalized,
        markerVariant: markerInfo.variant,
        chineseRatio,
      });

      // 置信度优先采用 detectLanguage，否则采用特征字估计值。
      const confidence =
        Number(best?.percentage) > 0
          ? Number(best.percentage) / 100
          : markerInfo.confidence;

      resolve({
        available: true,
        rawLanguage:
          typeof best?.language === "string" ? best.language : "unknown",
        language: normalized,
        confidence,
        chineseRatio,
        scriptVariant,
        simplifiedMarkerCount: markerInfo.simplifiedCount,
        traditionalMarkerCount: markerInfo.traditionalCount,
      });
    });
  });
}

function resolveScriptVariantFromSignals({
  normalizedLanguage,
  markerVariant,
  chineseRatio,
}) {
  // 语言检测明确给出繁体。
  if (normalizedLanguage === "zh-TW") {
    return "traditional";
  }

  // 语言检测明确给出简体。
  if (normalizedLanguage === "zh-CN") {
    // 若特征字强烈指向繁体，则优先特征字以降低误判。
    if (markerVariant === "traditional") {
      return "traditional";
    }
    return "simplified";
  }

  // 语言检测不明确时，优先使用特征字结果。
  if (markerVariant === "simplified" || markerVariant === "traditional") {
    return markerVariant;
  }

  // 中文占比偏低或缺少特征字时，不强行做简繁定性。
  if (chineseRatio <= MIN_CHINESE_RATIO) {
    return "non-chinese";
  }

  return "unknown-chinese";
}

function detectScriptByMarkers(text) {
  const simplifiedCount = countMatches(text, SIMPLIFIED_MARKER_REGEXP);
  const traditionalCount = countMatches(text, TRADITIONAL_MARKER_REGEXP);

  if (traditionalCount > simplifiedCount && traditionalCount > 0) {
    return {
      variant: "traditional",
      simplifiedCount,
      traditionalCount,
      confidence: Math.min(
        1,
        0.55 + (traditionalCount - simplifiedCount) * 0.1,
      ),
    };
  }

  if (simplifiedCount > traditionalCount && simplifiedCount > 0) {
    return {
      variant: "simplified",
      simplifiedCount,
      traditionalCount,
      confidence: Math.min(
        1,
        0.55 + (simplifiedCount - traditionalCount) * 0.1,
      ),
    };
  }

  return {
    variant: "unknown-chinese",
    simplifiedCount,
    traditionalCount,
    confidence: 0.2,
  };
}

function countMatches(text, pattern) {
  if (typeof text !== "string") {
    return 0;
  }

  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function calculateChineseRatio(text) {
  if (typeof text !== "string") {
    return 0;
  }

  const compact = text.replace(/\s+/g, "");
  if (!compact) {
    return 0;
  }

  const chineseCount = (compact.match(CHINESE_CHAR_REGEXP) || []).length;
  return chineseCount / compact.length;
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      resolve({ ...DEFAULT_SETTINGS, ...items });
    });
  });
}

function normalizeLanguage(langCode) {
  if (typeof langCode !== "string") {
    return "auto";
  }

  const normalized = langCode.trim();
  return normalized || "auto";
}

function normalizeDetectedLanguage(lang) {
  if (typeof lang !== "string") {
    return "unknown";
  }

  const normalized = lang.trim().toLowerCase();
  if (!normalized || normalized === "und") {
    return "unknown";
  }

  // 裸 "zh" 不强行映射到 zh-CN，保留不确定态以降低误判。
  if (normalized === "zh") {
    return "zh-UNCERTAIN";
  }

  if (
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh-sg"
  ) {
    return "zh-CN";
  }

  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "zh-hant"
  ) {
    return "zh-TW";
  }

  if (normalized === "jp") {
    return "ja";
  }

  if (normalized === "kor") {
    return "ko";
  }

  if (normalized === "fra") {
    return "fr";
  }

  if (normalized === "spa") {
    return "es";
  }

  if (normalized === "vie") {
    return "vi";
  }

  if (normalized === "ara") {
    return "ar";
  }

  const [base] = normalized.split(/[-_]/);
  return base || "unknown";
}

function sanitizeCredential(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeAiPreset(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.aiProviderPreset;
  }

  const normalized = value.trim().toLowerCase();
  return AI_PROVIDER_PRESETS[normalized]
    ? normalized
    : DEFAULT_SETTINGS.aiProviderPreset;
}

function normalizeAiBaseUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch (_error) {
    return normalized;
  }
}

function normalizeAiPath(value, fallback = DEFAULT_SETTINGS.aiPath) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeAiPromptPreset(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.aiPromptPreset;
  }

  const normalized = value.trim().toLowerCase();
  return AI_PROMPT_PRESETS[normalized]
    ? normalized
    : DEFAULT_SETTINGS.aiPromptPreset;
}

function normalizeAiPrompt(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\r/g, "").trim();
}

function resolveAiSettings(settings) {
  const presetKey = normalizeAiPreset(settings.aiProviderPreset);
  const preset = AI_PROVIDER_PRESETS[presetKey] || AI_PROVIDER_PRESETS.openai;
  const promptPresetKey = normalizeAiPromptPreset(settings.aiPromptPreset);
  const promptPreset =
    AI_PROMPT_PRESETS[promptPresetKey] ||
    AI_PROMPT_PRESETS[DEFAULT_SETTINGS.aiPromptPreset];
  const customPrompt = normalizeAiPrompt(settings.aiCustomPrompt);
  const baseUrl = normalizeAiBaseUrl(settings.aiBaseUrl || preset.baseUrl);
  const apiKey = sanitizeCredential(settings.aiApiKey);
  const model = sanitizeCredential(settings.aiModel || preset.model);
  const path = normalizeAiPath(settings.aiPath || preset.path, preset.path);

  return {
    presetKey,
    label: preset.label,
    baseUrl,
    apiKey,
    model,
    path,
    promptPresetKey,
    promptPresetLabel: promptPreset.label,
    systemPrompt: customPrompt || promptPreset.prompt,
    customPrompt,
    isStreamingEnabled:
      settings.aiEnabledStream !== undefined
        ? Boolean(settings.aiEnabledStream)
        : DEFAULT_SETTINGS.aiEnabledStream,
    isConfigured: Boolean(baseUrl && apiKey && model && path),
  };
}

function normalizeEngineMode(value) {
  if (typeof value !== "string") {
    return "auto";
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "baidu" ||
    normalized === "google" ||
    normalized === "ai"
  ) {
    return normalized;
  }

  return "auto";
}

function resolveEngineSelection(engineMode, hasBaiduCredential, _hasAiConfig) {
  if (engineMode === "baidu") {
    return "baidu";
  }

  if (engineMode === "google") {
    return "google";
  }

  if (engineMode === "ai") {
    return "ai";
  }

  return hasBaiduCredential ? "baidu" : "google";
}

function sanitizeText(text, options = {}) {
  if (typeof text !== "string") {
    return "";
  }

  const collapseWhitespace = Boolean(options.collapseWhitespace);
  const normalized = text.replace(/\r/g, "");

  if (collapseWhitespace) {
    return normalized.replace(/\s+/g, " ").trim();
  }

  return normalized.trim();
}

async function translateWithGoogle(text, sourceLang, targetLang) {
  const endpoint = new URL(
    "https://translate.googleapis.com/translate_a/single",
  );
  endpoint.searchParams.set("client", "gtx");
  endpoint.searchParams.set("sl", sourceLang);
  endpoint.searchParams.set("tl", targetLang);
  endpoint.searchParams.set("dt", "t");
  endpoint.searchParams.set("q", text);

  const response = await fetchWithTimeout(
    endpoint.toString(),
    { method: "GET" },
    GOOGLE_TIMEOUT_MS,
    "google",
  );
  if (!response.ok) {
    throw createHttpError("google", response.status);
  }

  const payload = await response.json();
  const translatedText = extractTranslatedText(payload);
  if (!translatedText) {
    throw new Error("翻译结果为空，请稍后重试。");
  }

  return {
    translatedText,
    detectedSourceLang:
      typeof payload?.[2] === "string"
        ? normalizeDetectedLanguage(payload[2])
        : normalizeDetectedLanguage(sourceLang),
    targetLang,
  };
}

async function translateWithGoogleEngine(text, sourceLang, targetLang) {
  try {
    const result = await translateWithGoogle(text, sourceLang, targetLang);
    return {
      ...result,
      engine: "google",
      engineLabel: "Google",
    };
  } catch (error) {
    throw new Error(toFriendlyErrorMessage("google", error));
  }
}

async function translateRichWithGoogleEngine(
  richPayload,
  sourceLang,
  targetLang,
) {
  try {
    const result = await translateRichPayload(
      richPayload,
      async (segmentText) =>
        translateWithGoogle(segmentText, sourceLang, targetLang),
      sourceLang,
      targetLang,
    );

    return {
      ...result,
      engine: "google",
      engineLabel: "Google",
    };
  } catch (error) {
    throw new Error(toFriendlyErrorMessage("google", error));
  }
}

async function translateWithBaidu(text, sourceLang, targetLang, appId, appKey) {
  const from = toBaiduLanguage(sourceLang, true);
  const to = toBaiduLanguage(targetLang, false);
  if (!from || !to) {
    throw new Error("语言代码不受支持。请检查源语言和目标语言设置。");
  }

  const endpoint = new URL(
    "https://fanyi-api.baidu.com/api/trans/vip/translate",
  );
  const salt = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const sign = md5Hex(`${appId}${text}${salt}${appKey}`);

  endpoint.searchParams.set("q", text);
  endpoint.searchParams.set("from", from);
  endpoint.searchParams.set("to", to);
  endpoint.searchParams.set("appid", appId);
  endpoint.searchParams.set("salt", salt);
  endpoint.searchParams.set("sign", sign);

  const response = await fetchWithTimeout(
    endpoint.toString(),
    { method: "GET" },
    BAIDU_TIMEOUT_MS,
    "baidu",
  );
  if (!response.ok) {
    throw createHttpError("baidu", response.status);
  }

  const payload = await response.json();
  if (payload?.error_code) {
    throw createBaiduApiError(payload.error_code, payload.error_msg);
  }

  const translatedText = normalizeLineBreaks(
    sanitizeText(
      Array.isArray(payload?.trans_result)
        ? payload.trans_result.map((item) => item?.dst || "").join("\n")
        : "",
    ),
  );
  if (!translatedText) {
    throw new Error("翻译结果为空。请稍后重试。");
  }

  return {
    translatedText,
    detectedSourceLang:
      typeof payload?.from === "string"
        ? normalizeDetectedLanguage(payload.from)
        : normalizeDetectedLanguage(sourceLang),
    targetLang,
  };
}

async function translateWithBaiduEngine(
  text,
  sourceLang,
  targetLang,
  appId,
  appKey,
) {
  try {
    const result = await translateWithBaidu(
      text,
      sourceLang,
      targetLang,
      appId,
      appKey,
    );
    return {
      ...result,
      engine: "baidu",
      engineLabel: "Baidu",
    };
  } catch (error) {
    throw new Error(toFriendlyErrorMessage("baidu", error));
  }
}

async function translateRichWithBaiduEngine(
  richPayload,
  sourceLang,
  targetLang,
  appId,
  appKey,
) {
  try {
    const result = await translateRichPayload(
      richPayload,
      async (segmentText) =>
        translateWithBaidu(segmentText, sourceLang, targetLang, appId, appKey),
      sourceLang,
      targetLang,
    );

    return {
      ...result,
      engine: "baidu",
      engineLabel: "Baidu",
    };
  } catch (error) {
    throw new Error(toFriendlyErrorMessage("baidu", error));
  }
}

async function translateWithAiEngine(text, sourceLang, targetLang, aiSettings) {
  try {
    const result = await translateWithAi(
      text,
      sourceLang,
      targetLang,
      aiSettings,
      false,
    );

    return {
      ...result,
      engine: "ai",
      engineLabel: aiSettings.label,
    };
  } catch (error) {
    throw new Error(toFriendlyErrorMessage("ai", error));
  }
}

async function translateRichWithAiEngine(
  richPayload,
  sourceLang,
  targetLang,
  aiSettings,
) {
  try {
    const result = await translateRichPayload(
      richPayload,
      async (segmentText) =>
        translateWithAi(segmentText, sourceLang, targetLang, aiSettings, false),
      sourceLang,
      targetLang,
    );

    return {
      ...result,
      engine: "ai",
      engineLabel: aiSettings.label,
    };
  } catch (error) {
    throw new Error(toFriendlyErrorMessage("ai", error));
  }
}

async function translateWithAi(
  text,
  sourceLang,
  targetLang,
  aiSettings,
  stream,
  signal,
  onDelta,
) {
  const endpoint = buildAiEndpoint(aiSettings.baseUrl, aiSettings.path);
  const body = {
    model: aiSettings.model,
    stream: Boolean(stream),
    messages: buildAiMessages(
      aiSettings.systemPrompt,
      text,
      sourceLang,
      targetLang,
    ),
  };

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiSettings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    },
    AI_TIMEOUT_MS,
    "ai",
  );

  if (!response.ok) {
    throw await createAiHttpError(response);
  }

  if (stream) {
    return readAiStream(response, sourceLang, targetLang, onDelta);
  }

  const payload = await response.json();
  const translatedText = extractAiTranslatedText(payload);
  if (!translatedText) {
    throw new Error("AI 翻译结果为空，请稍后重试。");
  }

  return {
    translatedText,
    detectedSourceLang: normalizeDetectedLanguage(sourceLang),
    targetLang,
  };
}

function buildAiEndpoint(baseUrl, path) {
  const normalizedBase = normalizeAiBaseUrl(baseUrl);
  const normalizedPath = normalizeAiPath(path);
  return `${normalizedBase}${normalizedPath}`;
}

function buildAiMessages(systemPrompt, text, sourceLang, targetLang) {
  return [
    {
      role: "system",
      content:
        normalizeAiPrompt(systemPrompt) ||
        AI_PROMPT_PRESETS[DEFAULT_SETTINGS.aiPromptPreset].prompt,
    },
    {
      role: "user",
      content: `请将以下文本从 ${sourceLang || "auto"} 翻译到 ${targetLang || "zh-CN"}：\n\n${text}`,
    },
  ];
}

async function readAiStream(response, sourceLang, targetLang, onDelta) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("当前 AI 接口未返回可读取的流式响应。");
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let translatedText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const parsed = parseAiSseChunk(chunk);
      for (const entry of parsed) {
        if (entry === "[DONE]") {
          return {
            translatedText: translatedText.trim(),
            detectedSourceLang: normalizeDetectedLanguage(sourceLang),
            targetLang,
          };
        }

        const deltaText = extractAiDeltaText(entry);
        if (!deltaText) {
          continue;
        }

        translatedText += deltaText;
        if (typeof onDelta === "function") {
          onDelta(deltaText, translatedText);
        }
      }
    }
  }

  const trailingEntries = parseAiSseChunk(buffer);
  for (const entry of trailingEntries) {
    const deltaText = extractAiDeltaText(entry);
    if (!deltaText) {
      continue;
    }

    translatedText += deltaText;
    if (typeof onDelta === "function") {
      onDelta(deltaText, translatedText);
    }
  }

  return {
    translatedText: translatedText.trim(),
    detectedSourceLang: normalizeDetectedLanguage(sourceLang),
    targetLang,
  };
}

function parseAiSseChunk(chunk) {
  if (!chunk || typeof chunk !== "string") {
    return [];
  }

  return chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => {
      if (line === "[DONE]") {
        return line;
      }

      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function extractAiDeltaText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return choices
    .map((choice) => {
      const content = choice?.delta?.content;
      if (typeof content === "string") {
        return content;
      }

      if (Array.isArray(content)) {
        return content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .join("");
      }

      return "";
    })
    .join("");
}

function extractAiTranslatedText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return choices
    .map((choice) => {
      const content = choice?.message?.content;
      if (typeof content === "string") {
        return content;
      }

      if (Array.isArray(content)) {
        return content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .join("");
      }

      return "";
    })
    .join("")
    .trim();
}

async function translateRichPayload(
  richPayload,
  translateSegment,
  sourceLang,
  targetLang,
) {
  const replacements = new Map();
  const plainSegments = [];
  let detectedSourceLang = normalizeDetectedLanguage(sourceLang);

  for (const segment of richPayload.segments) {
    const text =
      typeof segment.text === "string" ? segment.text.replace(/\r/g, "") : "";
    const { leading, core, trailing } = splitWhitespaceEdges(text);
    const normalizedLeading = normalizeEdgeWhitespace(leading);
    const normalizedTrailing = normalizeEdgeWhitespace(trailing);

    if (!core.trim()) {
      const edgeOnly = `${normalizedLeading}${normalizedTrailing}`;
      replacements.set(segment.id, escapeHtml(edgeOnly));
      plainSegments.push(edgeOnly);
      continue;
    }

    const translated = await translateSegment(core);
    const translatedCore = normalizeLineBreaks(
      sanitizeText(translated?.translatedText) || core,
    );
    const merged = `${normalizedLeading}${translatedCore}${normalizedTrailing}`;

    replacements.set(segment.id, escapeHtml(merged));
    plainSegments.push(merged);

    if (translated?.detectedSourceLang) {
      detectedSourceLang = normalizeDetectedLanguage(
        translated.detectedSourceLang,
      );
    }
  }

  let translatedHtml = richPayload.htmlTemplate;
  for (const [id, escapedText] of replacements.entries()) {
    translatedHtml = translatedHtml.split(id).join(escapedText);
  }

  // 极端异常下若仍残留占位符，主动清理以避免泄露内部标记。
  translatedHtml = translatedHtml.replace(/\[\[DST_SEG_[^\]]+\]\]/g, "");

  return {
    translatedText:
      normalizeLineBreaks(sanitizeText(plainSegments.join("\n"))) ||
      "暂无翻译结果",
    detectedSourceLang,
    targetLang,
    richResult: {
      translatedHtml,
      segmentCount: richPayload.segments.length,
    },
  };
}

async function handleStreamingTranslation(port, message, streamKey) {
  const settings = await getSettings();
  const aiSettings = resolveAiSettings(settings);
  const sourceLang = normalizeLanguage(
    message.sourceLang || settings.sourceLang || "auto",
  );
  const targetLang = normalizeLanguage(
    message.targetLang || settings.targetLang || "zh-CN",
  );
  const text = sanitizeText(message.text, { collapseWhitespace: false });
  const compactText = sanitizeText(message.text, { collapseWhitespace: true });

  if (!text) {
    throw new Error("未检测到可翻译文本。");
  }

  if (!aiSettings.isConfigured) {
    throw new Error(
      "AI 精翻配置不完整，请先在设置页填写 AI Base URL、API Key 和模型名。",
    );
  }

  const maxChars = Number(settings.maxChars) || DEFAULT_SETTINGS.maxChars;
  if (compactText.length > maxChars) {
    throw new Error(`选中文本超过 ${maxChars} 字符限制。`);
  }

  const languageInfo = await detectLanguageWithFallback(compactText || text);
  const skipDecision = evaluateSkipDecision({
    sourceLang,
    targetLang,
    languageInfo,
  });

  if (skipDecision.shouldSkip) {
    safePostMessage(port, {
      type: "translate:complete",
      requestId: message.requestId,
      data: buildSkipResult(
        "检测到简体中文，已跳过翻译。",
        targetLang,
        "simplified-zh",
        {
          variant: skipDecision.variant,
          chineseRatio: skipDecision.chineseRatio,
          confidence: skipDecision.confidence,
        },
      ),
    });
    return;
  }

  const effectiveSourceLang = resolveEffectiveSourceLang(
    sourceLang,
    skipDecision.variant,
    languageInfo.language,
  );
  const controller = new AbortController();
  activeStreamControllers.set(streamKey, controller);

  safePostMessage(port, {
    type: "translate:start",
    requestId: message.requestId,
    engine: "ai",
    engineLabel: aiSettings.label,
  });

  try {
    const result = await translateWithAi(
      text,
      effectiveSourceLang,
      targetLang,
      aiSettings,
      true,
      controller.signal,
      (deltaText, finalText) => {
        safePostMessage(port, {
          type: "translate:delta",
          requestId: message.requestId,
          deltaText,
          finalText,
          engine: "ai",
        });
      },
    );

    result.engine = "ai";
    result.engineLabel = aiSettings.label;
    result.detectMeta = {
      variant: skipDecision.variant,
      chineseRatio: skipDecision.chineseRatio,
      confidence: skipDecision.confidence,
    };

    safePostMessage(port, {
      type: "translate:complete",
      requestId: message.requestId,
      data: result,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      safePostMessage(port, {
        type: "translate:error",
        requestId: message.requestId,
        error: "翻译已取消。",
      });
      return;
    }

    throw new Error(toFriendlyErrorMessage("ai", error));
  } finally {
    activeStreamControllers.delete(streamKey);
  }
}

function safePostMessage(port, payload) {
  try {
    port.postMessage(payload);
  } catch (_error) {
    // port 已断开时忽略，避免 service worker 抛出未捕获异常。
  }
}

function splitWhitespaceEdges(text) {
  if (typeof text !== "string") {
    return {
      leading: "",
      core: "",
      trailing: "",
    };
  }

  const leadingMatch = text.match(/^\s*/);
  const trailingMatch = text.match(/\s*$/);
  const leading = leadingMatch ? leadingMatch[0] : "";
  const trailing = trailingMatch ? trailingMatch[0] : "";
  const core = text.slice(leading.length, text.length - trailing.length);

  return {
    leading,
    core,
    trailing,
  };
}

function normalizeEdgeWhitespace(text) {
  if (!text) {
    return "";
  }

  const normalized = String(text).replace(/\r/g, "");
  if (!normalized.trim()) {
    if (normalized.includes("\n")) {
      return "\n";
    }

    return " ";
  }

  return normalizeLineBreaks(normalized);
}

function normalizeLineBreaks(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function toBaiduLanguage(langCode, allowAuto) {
  if (typeof langCode !== "string") {
    return "";
  }

  const normalized = langCode.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "auto") {
    return allowAuto ? "auto" : "";
  }

  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo"
  ) {
    return "cht";
  }

  if (normalized.startsWith("zh")) {
    return "zh";
  }

  const map = {
    en: "en",
    ja: "jp",
    ko: "kor",
    fr: "fra",
    es: "spa",
    de: "de",
    ru: "ru",
    pt: "pt",
    it: "it",
    th: "th",
    ar: "ara",
    vi: "vie",
    nl: "nl",
    pl: "pl",
    el: "el",
    hu: "hu",
    id: "id",
  };

  if (map[normalized]) {
    return map[normalized];
  }

  const [base] = normalized.split(/[-_]/);
  return map[base] || base;
}

function toFriendlyErrorMessage(engine, error) {
  if (error?.code === "ABORTED") {
    return "翻译已取消。";
  }

  if (error?.code === "TIMEOUT") {
    const timeoutSeconds = Math.round((Number(error.timeoutMs) || 0) / 1000);
    if (engine === "google") {
      return `网络请求超时（${timeoutSeconds || 3}秒）。请稍后重试，或填写百度凭证后走百度通道。`;
    }

    if (engine === "ai") {
      return `AI 请求超时（${timeoutSeconds || 45}秒）。长文本可稍后重试，或切换模型后再试。`;
    }

    return `网络请求超时（${timeoutSeconds || 6}秒）。请检查网络后重试。`;
  }

  if (error?.status === 403) {
    if (engine === "baidu") {
      return "接口鉴权失败或配额不足（403）。请检查百度 AppID/密钥和额度。";
    }

    return "访问受限（403）。当前网络无法访问 Google 翻译服务。";
  }

  if (error?.status === 401) {
    return "AI 接口鉴权失败（401）。请检查 API Key 是否正确。";
  }

  if (error?.status === 429) {
    return "AI 请求过于频繁或额度不足（429）。请稍后重试。";
  }

  if (error?.status === 502) {
    return "上游服务暂时不可用（502）。请稍后重试。";
  }

  if (engine === "baidu" && error?.baiduErrorCode) {
    return mapBaiduError(error.baiduErrorCode, error.baiduErrorMessage);
  }

  return getErrorMessage(error);
}

function mapBaiduError(code, fallbackMessage) {
  const codeText = String(code);

  const map = {
    52001: "请求超时，请稍后重试。",
    52002: "系统错误，请稍后重试。",
    52003: "未授权用户，请检查百度 AppID/密钥。",
    54000: "请求参数错误，请检查语言设置或文本内容。",
    54003: "请求频率过快，请稍后重试。",
    54004: "账户余额不足，请充值或更换接口。",
    54005: "请求文本过长，请缩短后重试。",
    58000: "客户端 IP 无效，请在百度控制台检查 IP 白名单。",
    58001: "译文语言方向不支持，请调整源语言和目标语言。",
    58002: "服务当前关闭，请在百度控制台启用。",
    90107: "认证未通过，请确认百度凭证是否正确。",
  };

  if (map[codeText]) {
    return `${map[codeText]}（${codeText}）`;
  }

  return `接口返回错误码 ${codeText}${fallbackMessage ? `：${fallbackMessage}` : ""}`;
}

function createHttpError(engine, status) {
  const error = new Error(`${engine} 响应异常 (${status})`);
  error.engine = engine;
  error.status = Number(status);
  return error;
}

function createBaiduApiError(code, message) {
  const error = new Error(message || "百度接口调用失败");
  error.baiduErrorCode = String(code);
  error.baiduErrorMessage = message || "";
  return error;
}

async function createAiHttpError(response) {
  let message = "";

  try {
    const payload = await response.json();
    message = payload?.error?.message || payload?.message || "";
  } catch (_error) {
    message = "";
  }

  const error = new Error(message || `AI 响应异常 (${response.status})`);
  error.engine = "ai";
  error.status = Number(response.status);
  return error;
}

const MD5_ROTATE = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

const MD5_CONST = Array.from(
  { length: 64 },
  (_, idx) => Math.floor(Math.abs(Math.sin(idx + 1)) * 4294967296) | 0,
);

function md5Hex(input) {
  const data = new TextEncoder().encode(input);
  const words = [];

  for (let i = 0; i < data.length; i += 1) {
    const wordIndex = i >> 2;
    words[wordIndex] = (words[wordIndex] || 0) | (data[i] << ((i % 4) * 8));
  }

  const bitLength = data.length * 8;
  const tailIndex = data.length >> 2;
  words[tailIndex] =
    (words[tailIndex] || 0) | (0x80 << ((data.length % 4) * 8));
  words[(((data.length + 8) >>> 6) << 4) + 14] = bitLength;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let offset = 0; offset < words.length; offset += 16) {
    const startA = a;
    const startB = b;
    const startC = c;
    const startD = d;

    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const currentD = d;
      d = c;
      c = b;

      const blockValue = words[offset + g] || 0;
      const mixed = addUnsigned(a, f, MD5_CONST[i], blockValue);
      b = addUnsigned(b, rotateLeft(mixed, MD5_ROTATE[i]));
      a = currentD;
    }

    a = addUnsigned(a, startA);
    b = addUnsigned(b, startB);
    c = addUnsigned(c, startC);
    d = addUnsigned(d, startD);
  }

  return `${toHexLE(a)}${toHexLE(b)}${toHexLE(c)}${toHexLE(d)}`;
}

function addUnsigned(...values) {
  let result = 0;

  for (const value of values) {
    result = (result + value) | 0;
  }

  return result;
}

function rotateLeft(value, amount) {
  return (value << amount) | (value >>> (32 - amount));
}

function toHexLE(value) {
  let hex = "";

  for (let i = 0; i < 4; i += 1) {
    const byte = (value >>> (i * 8)) & 255;
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

async function fetchWithTimeout(url, options, timeoutMs, engine) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const externalSignal = options?.signal;
  let offExternalAbort = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      timeoutController.abort();
    } else {
      offExternalAbort = () => timeoutController.abort();
      externalSignal.addEventListener("abort", offExternalAbort, {
        once: true,
      });
    }
  }

  try {
    return await fetch(url, { ...options, signal: timeoutController.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) {
        const abortError = new Error("请求已取消。");
        abortError.code = "ABORTED";
        abortError.engine = engine;
        throw abortError;
      }

      const timeoutError = new Error("请求超时。");
      timeoutError.code = "TIMEOUT";
      timeoutError.engine = engine;
      timeoutError.timeoutMs = timeoutMs;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
    if (externalSignal && offExternalAbort) {
      externalSignal.removeEventListener("abort", offExternalAbort);
    }
  }
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "未知错误";
}

function extractTranslatedText(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return "";
  }

  return payload[0]
    .map((item) => (Array.isArray(item) ? item[0] : ""))
    .filter(Boolean)
    .join("")
    .trim();
}
