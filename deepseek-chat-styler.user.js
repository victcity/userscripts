// ==UserScript==
// @name         DeepSeek 会话正文样式定制
// @namespace    https://chat.deepseek.com/dsm-chat-styler
// @version      1.1.0
// @description  自定义 chat.deepseek.com 会话正文的宽度、字体、字号、行高、字重、斜体与代码字体，右下角齿轮打开设置面板
// @author       dsm
// @match        https://chat.deepseek.com/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'dsm-chat-styler-style';
  const HOST_ID = 'dsm-chat-styler-host';
  const PREFIX = 'dsmcs:';

  const DEFAULTS = {
    width: 840,          // 正文栏宽，配合 widthUnit（与站点默认一致）
    widthUnit: 'px',     // 'px' | '%'
    fullWidth: false,    // 铺满整个内容区
    fontFamily: '',      // 空 = 跟随站点默认
    customFont: '',      // 手动输入的字体，非空时优先于 fontFamily
    fontSize: 16,        // px
    lineHeight: 1.75,
    fontWeight: 400,
    italic: false,
    boldColorEnabled: false, // 粗体着色开关
    boldColor: '#ff0000',    // 粗体颜色
    codeFont: '',        // 空 = 代码块跟随站点默认
    customCodeFont: '',  // 手动输入的代码字体，非空时优先于 codeFont
  };

  const FONT_PRESETS = [
    ['', '站点默认'],
    ['system-ui, sans-serif', '系统无衬线'],
    ['"Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif', '黑体（Noto Sans / 雅黑 / 苹方）'],
    ['"Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif', '宋体/衬线（Noto Serif / 思源宋体）'],
    ['"仓耳今楷", "TsangerJinKai", "Kaiti SC", "KaiTi", serif', '仓耳今楷'],
    ['"Kaiti SC", "KaiTi", "STKaiti", cursive', '楷体'],
    ['"FangSong", "STFangsong", serif', '仿宋'],
    ['Georgia, "Times New Roman", serif', 'Georgia（西文衬线）'],
    ['Consolas, "Courier New", monospace', '等宽'],
  ];

  const CODE_FONT_PRESETS = [
    ['', '跟随站点默认'],
    ['ui-monospace, Consolas, "Courier New", monospace', '系统等宽'],
    ['"Comic Sans MS", "ComicShannsMono Nerd Font", "Comic Neue", cursive', 'Comic（Sans MS / Shanns Mono）'],
    ['"JetBrains Mono", Consolas, monospace', 'JetBrains Mono'],
    ['"Source Code Pro", monospace', 'Source Code Pro'],
    ['"Noto Sans Mono CJK SC", monospace', 'Noto 等宽 CJK'],
  ];

  // ---------- 存储：优先 GM_*，失败回退 localStorage ----------
  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined || v === null ? fallback : v;
        }
      } catch (e) { /* ignore */ }
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
      } catch (e) { /* ignore */ }
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  let settings = Object.assign({}, DEFAULTS, store.get('settings', {}));

  // ---------- 生成的 CSS ----------
  // 宽度：站点用 .ds-virtual-list-items 上的
  //   padding: calc((100% - var(--message-list-max-width)) / 2)
  // 来限定并居中正文列，覆盖该变量即可，无需改动哈希类名。
  // 字体：.ds-markdown 上有站点自身的字体规则，必须同权重 !important 直接命中。
  function buildCss(s) {
    const width = s.fullWidth ? '100%' : `${s.width}${s.widthUnit === '%' ? '%' : 'px'}`;
    const family = (s.customFont && s.customFont.trim()) ? s.customFont.trim() : s.fontFamily;
    const codeFamily = (s.customCodeFont && s.customCodeFont.trim()) ? s.customCodeFont.trim() : s.codeFont;
    let css = `
.ds-virtual-list-items {
  --message-list-max-width: ${width} !important;
}
`;
    if (family || s.fontSize !== DEFAULTS.fontSize || s.lineHeight !== DEFAULTS.lineHeight ||
        s.fontWeight !== DEFAULTS.fontWeight || s.italic) {
      css += `
.ds-message,
.ds-message .ds-markdown,
.ds-message .ds-markdown :is(p, li, td, th, blockquote, figcaption) {
  ${family ? `font-family: ${family} !important;` : ''}
  font-size: ${s.fontSize}px !important;
  line-height: ${s.lineHeight} !important;
  font-weight: ${s.fontWeight} !important;
  font-style: ${s.italic ? 'italic' : 'normal'} !important;
}
`;
    }
    if (s.boldColorEnabled && s.boldColor) {
      css += `
.ds-message :is(strong, b) {
  color: ${s.boldColor} !important;
}
`;
    }
    if (codeFamily) {
      css += `
.ds-message :is(pre, code, kbd, samp) {
  font-family: ${codeFamily} !important;
}
`;
    }
    return css;
  }

  function applyCss() {
    let tag = document.getElementById(STYLE_ID);
    if (!tag) {
      tag = document.createElement('style');
      tag.id = STYLE_ID;
      document.head.appendChild(tag);
    }
    tag.textContent = buildCss(settings);
  }

  // ---------- 设置面板（挂在 Shadow DOM 里，避免被站点样式污染） ----------
  function esc(t) {
    return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fontOptions(presets, current) {
    return presets.map(([v, label]) =>
      `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`).join('');
  }

  function buildPanel(root) {
    const s = settings;
    root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, "Noto Sans CJK SC", sans-serif; }
  .fab {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
    width: 40px; height: 40px; border-radius: 50%;
    background: #4d6bfe; color: #fff; border: none; cursor: pointer;
    font-size: 19px; line-height: 40px; text-align: center;
    box-shadow: 0 2px 10px rgba(0,0,0,.25); opacity: .45; transition: opacity .15s;
  }
  .fab:hover { opacity: 1; }
  .panel {
    position: fixed; right: 18px; bottom: 66px; z-index: 2147483647;
    width: 320px; max-height: calc(100vh - 100px); overflow-y: auto;
    background: #fff; color: #1a1a1a; border-radius: 12px;
    box-shadow: 0 6px 30px rgba(0,0,0,.22); padding: 14px 16px;
    font-size: 13px; display: none;
  }
  .panel.open { display: block; }
  .panel h3 { margin: 0 0 10px; font-size: 14px; color: #4d6bfe; }
  .row { margin-bottom: 10px; }
  .row label { display: block; margin-bottom: 3px; color: #555; }
  .row .val { float: right; color: #4d6bfe; font-variant-numeric: tabular-nums; }
  .row input[type=range] { width: 100%; accent-color: #4d6bfe; }
  .row select, .row input[type=text] {
    width: 100%; padding: 4px 6px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px;
  }
  .chk { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; cursor: pointer; }
  .chk input { accent-color: #4d6bfe; }
  .btns { display: flex; gap: 8px; margin-top: 12px; }
  .btns button {
    flex: 1; padding: 6px 0; border: 1px solid #ddd; border-radius: 8px;
    background: #f5f6fa; cursor: pointer; font-size: 13px;
  }
  .btns button.primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
  .hint { color: #999; font-size: 11px; margin-top: 8px; line-height: 1.5; }
</style>
<button class="fab" title="正文样式设置">Aa</button>
<div class="panel">
  <h3>DeepSeek 正文样式</h3>
  <div class="row">
    <label>正文宽度 <span class="val" data-out="width"></span></label>
    <div style="display:flex;gap:8px;align-items:center;">
      <input type="range" data-k="width" style="flex:1;min-width:0;">
      <select data-k="widthUnit" style="width:60px;flex:none;"><option value="px">px</option><option value="%">%</option></select>
    </div>
  </div>
  <label class="chk"><input type="checkbox" data-k="fullWidth"> 铺满整个内容区</label>
  <div class="row">
    <label>正文字体</label>
    <select data-k="fontFamily">${fontOptions(FONT_PRESETS, s.fontFamily)}</select>
  </div>
  <div class="row">
    <label>自定义字体（可选，优先于上面的选择）</label>
    <input type="text" data-k="customFont" placeholder='例如 "LXGW WenKai", serif'>
  </div>
  <div class="row">
    <label>字号 <span class="val" data-out="fontSize"></span></label>
    <input type="range" data-k="fontSize" min="12" max="28" step="1">
  </div>
  <div class="row">
    <label>行高 <span class="val" data-out="lineHeight"></span></label>
    <input type="range" data-k="lineHeight" min="1.2" max="2.6" step="0.05">
  </div>
  <div class="row">
    <label>字重</label>
    <select data-k="fontWeight">
      <option value="300">细 300</option>
      <option value="400">常规 400</option>
      <option value="500">中等 500</option>
      <option value="600">半粗 600</option>
      <option value="700">粗体 700</option>
    </select>
  </div>
  <label class="chk"><input type="checkbox" data-k="italic"> 斜体</label>
  <label class="chk"><input type="checkbox" data-k="boldColorEnabled"> 粗体着色
    <input type="color" data-k="boldColor" style="margin-left:auto;width:34px;height:22px;padding:0;border:none;background:none;cursor:pointer;">
  </label>
  <div class="row">
    <label>代码块字体</label>
    <select data-k="codeFont">${fontOptions(CODE_FONT_PRESETS, s.codeFont)}</select>
  </div>
  <div class="row">
    <label>自定义代码字体（可选，优先于上面的选择）</label>
    <input type="text" data-k="customCodeFont" placeholder='例如 "Comic Sans MS", cursive'>
  </div>
  <div class="btns">
    <button data-act="reset">恢复默认</button>
    <button data-act="close" class="primary">完成</button>
  </div>
  <div class="hint">设置会自动保存；正文宽度改变后消息列表仍保持水平居中。当前浏览器缺少某字体时由系统回退。</div>
</div>`;

    const panel = root.querySelector('.panel');
    root.querySelector('.fab').addEventListener('click', () => panel.classList.toggle('open'));

    const WIDTH_RANGE = {
      px: { min: 600, max: 1600, step: 20 },
      '%': { min: 30, max: 100, step: 1 },
    };

    function reflect() {
      for (const el of root.querySelectorAll('[data-k]')) {
        const k = el.dataset.k;
        if (el.type === 'checkbox') el.checked = !!settings[k];
        else if (k === 'width') {
          const r = WIDTH_RANGE[settings.widthUnit] || WIDTH_RANGE.px;
          el.min = r.min; el.max = r.max; el.step = r.step;
          el.value = String(settings.width);
        } else el.value = String(settings[k]);
      }
      root.querySelector('[data-out=width]').textContent =
        settings.fullWidth ? '铺满' : `${settings.width}${settings.widthUnit}`;
      root.querySelector('[data-out=fontSize]').textContent = settings.fontSize + 'px';
      root.querySelector('[data-out=lineHeight]').textContent = Number(settings.lineHeight).toFixed(2);
    }

    root.addEventListener('input', e => {
      const el = e.target.closest('[data-k]');
      if (!el) return;
      const k = el.dataset.k;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range' || k === 'fontWeight') v = Number(el.value);
      else v = el.value;
      if (k === 'widthUnit') {
        const r = WIDTH_RANGE[v] || WIDTH_RANGE.px;
        settings.width = Math.min(r.max, Math.max(r.min, settings.width));
      }
      settings[k] = v;
      store.set('settings', settings);
      reflect();
      applyCss();
    });

    root.addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'reset') {
        settings = Object.assign({}, DEFAULTS);
        store.set('settings', settings);
        reflect();
        applyCss();
      } else if (btn.dataset.act === 'close') {
        panel.classList.remove('open');
      }
    });

    reflect();
  }

  // 面板宿主可能被 SPA 重渲染挤掉，用一个轻量定时器保证常驻
  function ensureHost() {
    if (!document.getElementById(HOST_ID)) {
      if (!document.body) return;
      const host = document.createElement('div');
      host.id = HOST_ID;
      const shadow = host.attachShadow({ mode: 'open' });
      document.body.appendChild(host);
      buildPanel(shadow);
    }
  }

  function init() {
    applyCss();
    ensureHost();
    setInterval(ensureHost, 3000);
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('打开正文样式设置', () => {
          const host = document.getElementById(HOST_ID);
          if (host) host.shadowRoot.querySelector('.panel').classList.add('open');
        });
      } catch (e) { /* ignore */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
