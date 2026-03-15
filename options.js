/**
 * options.js（设置页逻辑）
 *
 * 负责读取、校验并保存用户配置到 chrome.storage.sync。
 * 设置保存后，content/background 会通过 onChanged 监听实时生效，无需重装扩展。
 *
 * 关键配置项：
 * - sourceLang / targetLang：源语言和目标语言
 * - engineMode：引擎模式（auto / baidu / google）
 * - maxChars：单次翻译字符上限
 * - showSourceText：是否显示原文预览
 * - panelTheme：翻译面板主题模板
 * - baiduAppId / baiduAppKey：百度 API 凭证（必须成对）
 */
const DEFAULT_SETTINGS = {
  sourceLang: "auto",
  targetLang: "zh-CN",
  maxChars: 2000,
  showSourceText: true,
  engineMode: "auto",
  panelTheme: "classic",
  baiduAppId: "",
  baiduAppKey: "",
};

const THEME_OPTIONS = new Set([
  "classic",
  "glass",
  "brutal",
  "editorial",
  "terminal",
]);
const ENGINE_OPTIONS = new Set(["auto", "baidu", "google"]);
const THEME_ALIASES = {
  ocean: "editorial",
  mono: "terminal",
};

document.addEventListener("DOMContentLoaded", () => {
  // 缓存表单节点，避免重复查询 DOM。
  const form = document.getElementById("settingsForm");
  const statusText = document.getElementById("statusText");
  const sourceLangInput = document.getElementById("sourceLang");
  const targetLangInput = document.getElementById("targetLang");
  const engineModeInput = document.getElementById("engineMode");
  const maxCharsInput = document.getElementById("maxChars");
  const showSourceTextInput = document.getElementById("showSourceText");
  const panelThemeInput = document.getElementById("panelTheme");
  const baiduAppIdInput = document.getElementById("baiduAppId");
  const baiduAppKeyInput = document.getElementById("baiduAppKey");

  // 首次进入设置页：读取已保存配置并回填到输入控件。
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    sourceLangInput.value = stored.sourceLang || DEFAULT_SETTINGS.sourceLang;
    targetLangInput.value = stored.targetLang || DEFAULT_SETTINGS.targetLang;
    engineModeInput.value = normalizeEngineMode(stored.engineMode);
    maxCharsInput.value = Number(stored.maxChars) || DEFAULT_SETTINGS.maxChars;
    showSourceTextInput.checked =
      stored.showSourceText !== undefined
        ? Boolean(stored.showSourceText)
        : DEFAULT_SETTINGS.showSourceText;
    panelThemeInput.value = normalizeTheme(stored.panelTheme);
    baiduAppIdInput.value = stored.baiduAppId || "";
    baiduAppKeyInput.value = stored.baiduAppKey || "";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    // 统一做输入规范化，避免空格、大小写和非法值导致的配置漂移。
    const sourceLang = normalizeLang(sourceLangInput.value, "auto");
    const targetLang = normalizeLang(targetLangInput.value, "zh-CN");
    const engineMode = normalizeEngineMode(engineModeInput.value);
    const maxChars = clampNumber(
      Number(maxCharsInput.value),
      20,
      5000,
      DEFAULT_SETTINGS.maxChars,
    );
    const showSourceText = showSourceTextInput.checked;
    const panelTheme = normalizeTheme(panelThemeInput.value);
    const baiduAppId = normalizeCredential(baiduAppIdInput.value);
    const baiduAppKey = normalizeCredential(baiduAppKeyInput.value);

    if (!targetLang) {
      showStatus(statusText, "目标语言不能为空。", true);
      return;
    }

    // 百度凭证必须成对：只填一项会造成签名失败，因此直接拦截保存。
    // 说明：
    // - 两项都为空：允许保存（auto/google 模式可正常工作）
    // - 两项都有值：允许保存（baidu/auto 模式可使用百度）
    // - 只填一项：拒绝保存并提示修正
    if ((baiduAppId && !baiduAppKey) || (!baiduAppId && baiduAppKey)) {
      showStatus(
        statusText,
        "百度 AppID 和密钥需要同时填写，或者同时留空。",
        true,
      );
      return;
    }

    if (engineMode === "baidu" && (!baiduAppId || !baiduAppKey)) {
      showStatus(
        statusText,
        "引擎模式为仅百度时，必须填写完整的百度 AppID 和密钥。",
        true,
      );
      return;
    }

    // 写入 sync 后，内容脚本与后台脚本会通过 storage.onChanged 自动同步。
    chrome.storage.sync.set(
      {
        sourceLang,
        targetLang,
        engineMode,
        maxChars,
        showSourceText,
        panelTheme,
        baiduAppId,
        baiduAppKey,
      },
      () => {
        if (chrome.runtime.lastError) {
          showStatus(
            statusText,
            `保存失败：${chrome.runtime.lastError.message}`,
            true,
          );
          return;
        }

        maxCharsInput.value = maxChars;
        engineModeInput.value = engineMode;
        panelThemeInput.value = panelTheme;
        showStatus(statusText, "设置已保存。", false);
      },
    );
  });
});

function normalizeLang(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return normalized || fallback;
}

function clampNumber(value, min, max, fallback) {
  if (Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(value), min), max);
}

function normalizeCredential(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeEngineMode(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.engineMode;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || !ENGINE_OPTIONS.has(normalized)) {
    return DEFAULT_SETTINGS.engineMode;
  }

  return normalized;
}

function normalizeTheme(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.panelTheme;
  }

  const normalized = value.trim().toLowerCase();
  const aliasTheme = THEME_ALIASES[normalized] || normalized;

  if (!aliasTheme || !THEME_OPTIONS.has(aliasTheme)) {
    return DEFAULT_SETTINGS.panelTheme;
  }

  return aliasTheme;
}

function showStatus(node, message, isError) {
  node.textContent = message;
  node.classList.remove("error", "success");
  node.classList.add(isError ? "error" : "success");
}
