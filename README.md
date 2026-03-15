# SelectEcho

SelectEcho 是一个面向 Chrome/Edge（Manifest V3）的划词翻译扩展：左键选中文本，松开即显示译文。

## 目录

- [功能亮点](#功能亮点)
- [支持环境](#支持环境)
- [安装方式](#安装方式)
- [下载方式（点击 ZIP）](#下载方式点击-zip)
- [快速配置（我到底该填什么）](#快速配置我到底该填什么)
- [使用说明](#使用说明)
- [配置项参考](#配置项参考)
- [工作原理](#工作原理)
- [权限说明](#权限说明)
- [隐私与安全](#隐私与安全)
- [项目文件树](#项目文件树)
- [开发与部署说明](#开发与部署说明)
- [自动生成 Release ZIP（无需手写 Release）](#自动生成-release-zip无需手写-release)
- [版本记录](#版本记录)
- [贡献指南（独立文档）](#贡献指南独立文档)
- [许可证](#许可证)

## 功能亮点

- 左键 `mouseup` 触发翻译，内置防抖和重复选区去重。
- 输入区域保护：`input`、`textarea`、`contenteditable` 中默认不触发。
- 简体中文自动跳过，繁体中文继续翻译为简体，避免“中文翻中文”。
- 支持 5 套翻译框模板：`classic` / `glass` / `brutal` / `editorial` / `terminal`。
- 新增 AI 精翻：支持 OpenAI 兼容接口、DeepSeek、智谱 Flash 免费模型等预设。
- 结构保真翻译：尽量保留段落、列表、强调、代码与换行。
- 翻译状态可视化：`翻译中` / `完成` / `已跳过` / `失败`。
- 面板支持边界自适应，避免超出可视区域。
- AI 长文本流式输出时，面板会临时固定，避免翻译过程中消失。

## 支持环境

| 环境                         | 支持情况               |
| ---------------------------- | ---------------------- |
| Chrome (Manifest V3)         | 支持                   |
| Microsoft Edge (Manifest V3) | 支持                   |
| Firefox                      | 暂不支持（需额外适配） |
| Safari                       | 暂不支持               |

推荐在最新稳定版 Chrome / Edge 下使用。

## 安装方式

### 开发者模式加载

1. 打开扩展管理页。
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择当前项目目录。
5. 打开任意网页，按一次 `Ctrl + R` 刷新后测试。

说明：Chrome/Edge 开发者模式通常加载目录而非直接安装 zip。

## 下载方式（点击 ZIP）

- 最新代码包（main 分支）：[点击下载 main.zip](https://github.com/2258009564/SelectEcho/archive/refs/heads/main.zip)
- 稳定版本下载页（Release）：[点击进入 Releases](https://github.com/2258009564/SelectEcho/releases)
- 最新稳定版直链（发布后可直接下载）：<https://github.com/2258009564/SelectEcho/releases/latest/download/SelectEcho.zip>

## 快速配置（我到底该填什么）

你只需要先决定“引擎模式”：自动、仅百度、仅 Google、AI 精翻。

场景 A：先不申请百度，先跑通功能

- 引擎模式：`auto`
- 百度 AppID：留空
- 百度密钥：留空
- 结果：自动走 Google 通道（超时约 3 秒会给出中文提示）

场景 B：希望固定走百度

- 引擎模式：`baidu`
- 填写完整百度 `AppID` 与 `密钥`
- 两项必须同时填写，否则保存会提示错误

场景 C：你有百度凭证，但暂时想强制 Google

- 引擎模式：`google`
- 百度凭证可保留，运行时会被忽略

场景 D：希望用 AI 做更可靠的精翻

- 引擎模式：`ai`
- 选择预设：`OpenAI` / `DeepSeek` / `智谱 Flash 免费`
- 填写对应 `API Key`
- 长文本可开启流式输出，面板会在翻译期间临时固定

百度翻译开放平台：<https://fanyi-api.baidu.com/>

## 使用说明

1. 在普通 `http/https` 网页中，鼠标左键划词。
2. 松开鼠标后，选区附近出现翻译面板。
3. 查看译文、源文（可选）和引擎标签。
4. 按 `Esc` 或点右上角 `×` 关闭面板。
5. 点击“复制”按钮可复制当前译文。

## 配置项参考

| 配置项                          | 类型/可选值                                               | 默认值    | 说明               |
| ------------------------------- | --------------------------------------------------------- | --------- | ------------------ |
| 源语言代码 (`sourceLang`)       | `auto` 或语言代码                                         | `auto`    | 推荐保持 `auto`    |
| 目标语言代码 (`targetLang`)     | 语言代码                                                  | `zh-CN`   | 默认翻译成简体中文 |
| 翻译引擎模式 (`engineMode`)     | `auto` / `baidu` / `google` / `ai`                        | `auto`    | 支持 AI 精翻       |
| 单次最大字符数 (`maxChars`)     | `20-5000`                                                 | `2000`    | 超过限制会直接提示 |
| 显示原文预览 (`showSourceText`) | `true` / `false`                                          | `true`    | 关闭可减少面板高度 |
| 翻译框模板 (`panelTheme`)       | `classic` / `glass` / `brutal` / `editorial` / `terminal` | `classic` | 仅影响展示样式     |
| 百度 AppID (`baiduAppId`)       | 字符串                                                    | 空        | 与密钥配套使用     |
| 百度密钥 (`baiduAppKey`)        | 字符串                                                    | 空        | 与 AppID 配套使用  |
| AI 预设 (`aiProviderPreset`)    | `openai` / `deepseek` / `zhipu-flash-free` / `custom`     | `openai`  | OpenAI 兼容接口    |
| AI Base URL (`aiBaseUrl`)       | HTTPS 地址                                                | 预设值    | 自定义接口可修改   |
| AI 模型 (`aiModel`)             | 字符串                                                    | 预设值    | 可覆盖预设模型名   |
| AI 路径 (`aiPath`)              | URL Path                                                  | 预设值    | 默认为 Chat Completions |
| AI Prompt 预设 (`aiPromptPreset`) | `precision-translate`                                   | 预设值    | 内置高保真精翻 Prompt |
| AI 自定义 Prompt (`aiCustomPrompt`) | 多行文本                                               | 空        | 不为空时覆盖内置预设 |
| AI 流式 (`aiEnabledStream`)     | `true` / `false`                                          | `true`    | 仅纯文本走流式     |

## 工作原理

### 1) 引擎策略

- `engineMode = auto`：有百度凭证走百度，否则走 Google
- `engineMode = baidu`：固定百度；凭证不完整会直接报错
- `engineMode = google`：固定 Google；忽略百度凭证
- `engineMode = ai`：固定走 OpenAI 兼容 AI 接口

接口仅使用：

- 百度：`https://fanyi-api.baidu.com/api/trans/vip/translate`
- Google：`https://translate.googleapis.com/translate_a/single`
- AI：预设或自定义 `Chat Completions` 兼容接口
- Prompt：内置 `高保真精翻` 预设，也支持用户填写自定义 Prompt 覆盖

### 2) 中文识别与跳过逻辑

- 优先调用 `chrome.i18n.detectLanguage`。
- 若识别不明确，使用“简繁特征字 + 中文占比”做兜底。
- 当目标语言是 `zh-CN` 时：
  - 简体中文：跳过翻译
  - 繁体中文：继续翻译
  - 模糊场景：优先继续翻译，避免错过繁体内容

### 3) 触发保护

- 仅左键 `mouseup` 且选区变化时触发。
- 输入区域默认不触发。
- 去空白后文本长度小于 2 时直接跳过。

### 4) 结构保真翻译

- 先抽取结构，再分段翻译，最后回填结构展示。
- 对复杂结构自动降级为纯文本，优先保证可读与稳定。
- AI 流式首版仅覆盖纯文本；富文本保留最终态回填。

## 权限说明

| 权限                                 | 用途                                     | 是否必需            |
| ------------------------------------ | ---------------------------------------- | ------------------- |
| `storage`                            | 保存语言、主题、引擎模式、百度凭证等配置 | 必需                |
| `https://translate.googleapis.com/*` | 调用 Google 翻译接口                     | 按需（Google 路径） |
| `https://fanyi-api.baidu.com/*`      | 调用百度翻译接口                         | 按需（百度路径）    |
| AI 预设域名权限                      | 调用 OpenAI / DeepSeek / 智谱接口        | 按需（AI 路径）     |
| 可选自定义域名权限                   | 调用自定义 OpenAI 兼容接口               | 仅自定义 AI 时申请  |

本扩展不申请历史记录、标签管理、下载管理等高敏感权限。

## 隐私与安全

- 不做用户行为追踪。
- 不上传统计埋点。
- 本地仅保存配置项，不保存“翻译历史数据库”。
- 翻译文本只发送到你选择的翻译服务（百度或 Google）。

如果你要用于企业环境，建议先审阅源码并在内网做白名单策略。

## 项目文件树

```text
SelectEcho/
├─ .gitignore
├─ CONTRIBUTING.md
├─ background.js
├─ content.css
├─ content.js
├─ LICENSE
├─ manifest.json
├─ options.css
├─ options.html
├─ options.js
└─ README.md
```

文件职责说明：

- `manifest.json`：扩展清单与权限声明
- `background.js`：翻译调度、引擎选择、语言判断、错误处理
- `content.js`：划词事件监听、请求发送、面板渲染
- `content.css`：面板样式与模板主题
- `options.html` / `options.css` / `options.js`：设置页 UI 与配置逻辑

## 开发与部署说明

### 本地开发调试

1. 修改代码。
2. 打开扩展管理页，点击扩展卡片“刷新”。
3. 刷新目标网页重新测试。

### 发布前检查清单

1. 核对 `manifest.json` 的版本号。
2. 检查权限与 README 一致。
3. 准备截图（设置页 + 翻译面板 + 错误提示）。
4. 自测三种引擎模式：`auto`、`baidu`、`google`。

## 自动生成 Release ZIP（无需手写 Release）

仓库已支持“推送标签自动发版”：

- 触发条件：推送 `v*` 版本标签（例如 `v1.0.1`）
- 自动动作：创建 Release、自动生成 Release Notes、上传 `SelectEcho.zip`

你只需要执行：

```bash
git tag v1.0.1
git push origin v1.0.1
```

执行后可通过以下地址直接下载最新稳定版 ZIP：

<https://github.com/2258009564/SelectEcho/releases/latest/download/SelectEcho.zip>

## 版本记录

### v1.0.0

- 增加 5 套翻译框模板。
- 优化繁简中文判断与跳过策略。
- 保持严格二选一引擎策略，错误提示更明确。

后续建议：新增 `CHANGELOG.md` 管理更细粒度变更。

## 贡献指南（独立文档）

贡献流程、代码规范、PR 检查清单已拆分到独立文档：

- [CONTRIBUTING.md](CONTRIBUTING.md)

## 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
