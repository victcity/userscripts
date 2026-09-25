# 自用油猴脚本集合

个人在用的 Tampermonkey（油猴）用户脚本仓库。

## 脚本列表

### DeepSeek 会话正文样式定制

适用于 [chat.deepseek.com](https://chat.deepseek.com/) 的会话正文样式定制脚本，可自定义正文的宽度、字体、字号、行高、字重、斜体、粗体颜色与代码块字体。

#### 功能

- **正文宽度**：600–1600px 或 30%–100% 百分比（px / % 一键切换），也可铺满整个内容区；调整后消息列表仍保持水平居中
- **正文字体**：内置 系统无衬线、黑体、宋体/衬线、仓耳今楷、楷体、仿宋、Georgia、等宽 等预设，支持手动输入自定义字体（自定义优先于预设）
- **字号**：12–28px
- **行高**：1.2–2.6
- **字重**：300–700
- **斜体**：开关
- **粗体着色**：为正文中的 `**粗体**`（`strong`/`b`）自定义颜色
- **代码块字体**：内置 系统等宽、Comic、JetBrains Mono、Source Code Pro 等预设，支持手动输入自定义字体
- 所有设置即时生效并自动保存（`GM_setValue`，异常环境回退 `localStorage`），跨刷新持久

#### 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展；
2. 安装本脚本，任选其一：
   - 直接点击 [`deepseek-chat-styler.user.js`](./deepseek-chat-styler.user.js) 的原始文件链接（Raw），Tampermonkey 会自动弹出安装页；
   - 或打开 Tampermonkey 面板 →「添加新脚本」，粘贴文件全部内容并保存。

#### 使用

打开 [chat.deepseek.com](https://chat.deepseek.com/)，点击页面右下角 **Aa** 悬浮按钮打开设置面板，调整即时生效；也可通过 Tampermonkey 菜单中的「打开正文样式设置」进入。点击「恢复默认」可一键还原。

#### 实现说明

- DeepSeek 正文的列宽由消息列表容器（`.ds-virtual-list-items`）上的 CSS 变量 `--message-list-max-width` 配合 `calc((100% - var(--message-list-max-width)) / 2)` 控制限宽与居中，脚本直接覆盖该变量实现任意宽度，因此不依赖构建哈希类名，站点发版不易失效；
- 字体规则直接命中 `.ds-message` / `.ds-markdown` 并以 `!important` 覆盖站点自带样式（仅靠继承会被 `.ds-markdown` 自身规则压住）；
- 设置面板挂在 Shadow DOM 中，不受站点样式污染；面板被 SPA 重渲染挤掉时会自动重建。

## 更新日志

### v1.1.0（2026-09-25）

- 宽度支持百分比单位（px / % 切换，切换时自动夹取到合法区间）
- 新增「粗体着色」开关与自定义颜色
- 新增「自定义代码字体」输入框；预设新增 仓耳今楷、Comic

### v1.0.0（2026-09-25）

- 首个版本：正文宽度（铺满/像素）、字体、字号、行高、字重、斜体、代码块字体；悬浮按钮 + 设置面板；GM 存储与 localStorage 回退。
