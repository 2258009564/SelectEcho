/**
 * options.js（设置页逻辑）
 *
 * 负责读取、校验并保存用户配置到 chrome.storage.sync。
 * 设置保存后，content/background 会通过 onChanged 监听实时生效，无需重装扩展。
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
    label: "自定义 OpenAI 兼容接口",
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
  sourceLang: "auto",
  targetLang: "zh-CN",
  maxChars: 2000,
  showSourceText: true,
  engineMode: "auto",
  panelTheme: "classic",
  baiduAppId: "",
  baiduAppKey: "",
  aiProviderPreset: "openai",
  aiBaseUrl: AI_PROVIDER_PRESETS.openai.baseUrl,
  aiApiKey: "",
  aiModel: AI_PROVIDER_PRESETS.openai.model,
  aiPath: AI_PROVIDER_PRESETS.openai.path,
  aiPromptPreset: "precision-translate",
  aiCustomPrompt: "",
  aiEnabledStream: true,
};

const THEME_OPTIONS = new Set([
  "classic",
  "glass",
  "brutal",
  "editorial",
  "terminal",
]);
const ENGINE_OPTIONS = new Set(["auto", "baidu", "google", "ai"]);
const PRESET_OPTIONS = new Set(Object.keys(AI_PROVIDER_PRESETS));
const AI_PROMPT_OPTIONS = new Set(Object.keys(AI_PROMPT_PRESETS));
const THEME_ALIASES = {
  ocean: "editorial",
  mono: "terminal",
};

document.addEventListener("DOMContentLoaded", () => {
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
  const aiProviderPresetInput = document.getElementById("aiProviderPreset");
  const aiBaseUrlInput = document.getElementById("aiBaseUrl");
  const aiApiKeyInput = document.getElementById("aiApiKey");
  const aiModelInput = document.getElementById("aiModel");
  const aiPathInput = document.getElementById("aiPath");
  const aiPromptPresetInput = document.getElementById("aiPromptPreset");
  const aiCustomPromptInput = document.getElementById("aiCustomPrompt");
  const aiEnabledStreamInput = document.getElementById("aiEnabledStream");

  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    const merged = buildStoredSettings(stored);
    sourceLangInput.value = merged.sourceLang;
    targetLangInput.value = merged.targetLang;
    engineModeInput.value = normalizeEngineMode(merged.engineMode);
    maxCharsInput.value = merged.maxChars;
    showSourceTextInput.checked = Boolean(merged.showSourceText);
    panelThemeInput.value = normalizeTheme(merged.panelTheme);
    baiduAppIdInput.value = merged.baiduAppId;
    baiduAppKeyInput.value = merged.baiduAppKey;
    aiProviderPresetInput.value = merged.aiProviderPreset;
    aiBaseUrlInput.value = merged.aiBaseUrl;
    aiApiKeyInput.value = merged.aiApiKey;
    aiModelInput.value = merged.aiModel;
    aiPathInput.value = merged.aiPath;
    aiPromptPresetInput.value = merged.aiPromptPreset;
    aiCustomPromptInput.value = merged.aiCustomPrompt;
    aiEnabledStreamInput.checked = Boolean(merged.aiEnabledStream);

    updateAiPresetHint(aiProviderPresetInput.value);
    updateAiPromptHint(aiPromptPresetInput.value);
    updateAiFieldAvailability(aiProviderPresetInput.value);
  });

  aiProviderPresetInput.addEventListener("change", () => {
    const preset = normalizeAiPreset(aiProviderPresetInput.value);
    const baseUrl = normalizeUrl(aiBaseUrlInput.value);
    const path = normalizePath(aiPathInput.value);
    const model = normalizeText(aiModelInput.value);
    const nextValues = applyAiPresetValues(
      preset,
      {
        aiBaseUrl: baseUrl,
        aiPath: path,
        aiModel: model,
      },
      true,
    );

    aiBaseUrlInput.value = nextValues.aiBaseUrl;
    aiPathInput.value = nextValues.aiPath;
    aiModelInput.value = nextValues.aiModel;
    updateAiPresetHint(preset);
    updateAiFieldAvailability(preset);
  });

  aiPromptPresetInput.addEventListener("change", () => {
    updateAiPromptHint(aiPromptPresetInput.value);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const sourceLang = normalizeLang(sourceLangInput.value, "auto");
    const targetLang = normalizeLang(targetLangInput.value, "zh-CN");
    const engineMode = normalizeEngineMode(engineModeInput.value);
    const maxChars = clampNumber(
      Number(maxCharsInput.value),
      20,
      12000,
      DEFAULT_SETTINGS.maxChars,
    );
    const showSourceText = showSourceTextInput.checked;
    const panelTheme = normalizeTheme(panelThemeInput.value);
    const baiduAppId = normalizeCredential(baiduAppIdInput.value);
    const baiduAppKey = normalizeCredential(baiduAppKeyInput.value);
    const aiProviderPreset = normalizeAiPreset(aiProviderPresetInput.value);
    const aiApiKey = normalizeCredential(aiApiKeyInput.value);
    const aiPromptPreset = normalizeAiPromptPreset(aiPromptPresetInput.value);
    const aiCustomPrompt = normalizePrompt(aiCustomPromptInput.value);
    const aiEnabledStream = aiEnabledStreamInput.checked;

    const aiPresetValues = applyAiPresetValues(
      aiProviderPreset,
      {
        aiBaseUrl: aiBaseUrlInput.value,
        aiPath: aiPathInput.value,
        aiModel: aiModelInput.value,
      },
      false,
    );
    const aiBaseUrl = normalizeUrl(aiPresetValues.aiBaseUrl);
    const aiPath = normalizePath(aiPresetValues.aiPath);
    const aiModel = normalizeText(aiPresetValues.aiModel);

    if (!targetLang) {
      showStatus(statusText, "目标语言不能为空。", true);
      return;
    }

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

    if (engineMode === "ai") {
      if (!aiBaseUrl || !aiApiKey || !aiModel) {
        showStatus(
          statusText,
          "AI 模式下必须填写 Base URL、API Key 和模型名。",
          true,
        );
        return;
      }

      if (!aiPath) {
        showStatus(statusText, "AI 接口路径不能为空。", true);
        return;
      }

      const permissionResult = await ensureAiHostPermission(aiBaseUrl);
      if (!permissionResult.ok) {
        showStatus(statusText, permissionResult.message, true);
        return;
      }
    }

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
        aiProviderPreset,
        aiBaseUrl,
        aiApiKey,
        aiModel,
        aiPath,
        aiPromptPreset,
        aiCustomPrompt,
        aiEnabledStream,
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
        aiBaseUrlInput.value = aiBaseUrl;
        aiPathInput.value = aiPath;
        aiModelInput.value = aiModel;
        aiPromptPresetInput.value = aiPromptPreset;
        aiCustomPromptInput.value = aiCustomPrompt;
        showStatus(statusText, "设置已保存。", false);
      },
    );
  });
});

function buildStoredSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const aiProviderPreset = normalizeAiPreset(merged.aiProviderPreset);
  const presetValues = applyAiPresetValues(
    aiProviderPreset,
    {
      aiBaseUrl: merged.aiBaseUrl,
      aiPath: merged.aiPath,
      aiModel: merged.aiModel,
    },
    false,
  );

  return {
    ...merged,
    maxChars: Number(merged.maxChars) || DEFAULT_SETTINGS.maxChars,
    panelTheme: normalizeTheme(merged.panelTheme),
    engineMode: normalizeEngineMode(merged.engineMode),
    aiProviderPreset,
    aiBaseUrl: normalizeUrl(presetValues.aiBaseUrl),
    aiApiKey: normalizeCredential(merged.aiApiKey),
    aiModel: normalizeText(presetValues.aiModel),
    aiPath: normalizePath(presetValues.aiPath),
    aiPromptPreset: normalizeAiPromptPreset(merged.aiPromptPreset),
    aiCustomPrompt: normalizePrompt(merged.aiCustomPrompt),
    aiEnabledStream:
      merged.aiEnabledStream !== undefined
        ? Boolean(merged.aiEnabledStream)
        : DEFAULT_SETTINGS.aiEnabledStream,
  };
}

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

function normalizeAiPreset(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.aiProviderPreset;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || !PRESET_OPTIONS.has(normalized)) {
    return DEFAULT_SETTINGS.aiProviderPreset;
  }

  return normalized;
}

function normalizeAiPromptPreset(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.aiPromptPreset;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || !AI_PROMPT_OPTIONS.has(normalized)) {
    return DEFAULT_SETTINGS.aiPromptPreset;
  }

  return normalized;
}

function normalizeUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized);
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch (_error) {
    return normalized;
  }
}

function normalizePath(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.aiPath;
  }

  const normalized = value.trim();
  if (!normalized) {
    return DEFAULT_SETTINGS.aiPath;
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizePrompt(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\r/g, "").trim();
}

function applyAiPresetValues(presetKey, values, forcePresetValues) {
  const preset = AI_PROVIDER_PRESETS[presetKey] || AI_PROVIDER_PRESETS.openai;
  const next = {
    aiBaseUrl: normalizeUrl(values.aiBaseUrl),
    aiPath: normalizePath(values.aiPath),
    aiModel: normalizeText(values.aiModel),
  };

  if (presetKey === "custom") {
    if (!next.aiPath) {
      next.aiPath = preset.path;
    }
    return next;
  }

  if (forcePresetValues || !next.aiBaseUrl) {
    next.aiBaseUrl = preset.baseUrl;
  }

  if (forcePresetValues || !next.aiPath || next.aiPath === DEFAULT_SETTINGS.aiPath) {
    next.aiPath = preset.path;
  }

  if (forcePresetValues || !next.aiModel) {
    next.aiModel = preset.model;
  }

  return next;
}

function updateAiPresetHint(presetKey) {
  const hintNode = document.getElementById("aiPresetHint");
  const preset = AI_PROVIDER_PRESETS[presetKey] || AI_PROVIDER_PRESETS.openai;
  hintNode.textContent =
    presetKey === "custom"
      ? "自定义模式会按你填写的 OpenAI 兼容地址与模型发起请求。"
      : `已选预设：${preset.label}，可直接保存后补充 API Key 使用。`;
}

function updateAiPromptHint(presetKey) {
  const hintNode = document.getElementById("aiPromptHint");
  const preset = AI_PROMPT_PRESETS[presetKey] || AI_PROMPT_PRESETS["precision-translate"];
  hintNode.textContent = `当前预设：${preset.label}。自定义 Prompt 不为空时，会覆盖该预设。`;
}

function updateAiFieldAvailability(presetKey) {
  const aiBaseUrlInput = document.getElementById("aiBaseUrl");
  const aiPathInput = document.getElementById("aiPath");

  const isCustom = presetKey === "custom";
  aiBaseUrlInput.readOnly = !isCustom;
  aiPathInput.readOnly = !isCustom;
}

async function ensureAiHostPermission(baseUrl) {
  const normalized = normalizeUrl(baseUrl);
  if (!normalized) {
    return { ok: false, message: "AI Base URL 无效，请检查后重试。" };
  }

  let origin;
  try {
    origin = new URL(normalized).origin;
  } catch (_error) {
    return { ok: false, message: "AI Base URL 格式无效，请填写完整的 https 地址。" };
  }

  const permission = { origins: [`${origin}/*`] };
  const contains = await callPermissionsApi("contains", permission);
  if (contains) {
    return { ok: true };
  }

  const granted = await callPermissionsApi("request", permission);
  if (!granted) {
    return {
      ok: false,
      message: `未获得 ${origin} 的访问权限，无法保存该 AI 接口。`,
    };
  }

  return { ok: true };
}

function callPermissionsApi(method, permission) {
  return new Promise((resolve) => {
    if (!chrome.permissions || typeof chrome.permissions[method] !== "function") {
      resolve(true);
      return;
    }

    chrome.permissions[method](permission, (result) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }

      resolve(Boolean(result));
    });
  });
}

function showStatus(node, message, isError) {
  node.textContent = message;
  node.classList.remove("error", "success");
  node.classList.add(isError ? "error" : "success");
}
