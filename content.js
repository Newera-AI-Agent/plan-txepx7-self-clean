/**
 * PDATA 质检助手 —— content.js
 * 悬浮球 + 面板 + 审核自动化
 *
 * 工作流程：
 * 1. 通过     ：勾选提交审核模块的「通过」→ 点「提交审核」
 * 2. 不通过   ：读取人工质检检查项中已勾「不通过」的行（编号+备注）
 *                底部自动勾「不通过」+ 备注拼 "A5: xxx；B2: yyy" → 点提交审核
 * 3. 驳回     ：读取打标检查项中已勾「不通过」的行（编号+备注）
 *                点打标模块「驳回」按钮 → 弹窗备注填 "T1: xxx" → 确定
 * 4. 未审核   ：跳过
 */
(() => {
  if (window.top !== window) return;

  // 全局监听：任意页面上，点文本为"审核"的按钮时，在跳转发生前把当前行的 R 编号记下来。
  // 用 localStorage（跨标签页共享，详情页若是新标签打开也能读到），同时记下对应的 URL 数字用于校验。
  document.addEventListener("click", (e) => {
    // 点击元素向上 6 层，找 norm 文本 === "审核" 的元素（不依赖按钮标签类型）
    let el = e.target;
    for (let i = 0; i < 6 && el; i++) {
      if (norm(el.textContent) === "审核") {
        // 向上最多 15 层找包含 R 编号的行容器
        let row = el.parentElement;
        for (let j = 0; j < 15 && row; j++) {
          const m = trim(row.textContent).match(/R\d{8}[a-zA-Z]*\d{3,}/);
          if (m) {
            // 同时抓该行内链接的 URL 数字 ID（如 /review/my-tasks/241176）
            let urlId = "";
            const a = $("a[href*='/review/']", row);
            const um = a && a.href.match(/\/(?:my-tasks|tasks)\/(\d+)/);
            if (um) urlId = um[1];
            try {
              localStorage.setItem("qc_last_record_id", m[0]);
              if (urlId) localStorage.setItem("qc_last_url_id", urlId);
            } catch (err) {}
            break;
          }
          row = row.parentElement;
        }
        break;
      }
      el = el.parentElement;
    }
  }, true);


  // ============ 通用 DOM 工具 ============
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
  // 去除所有空白（antd 两字按钮自动加空格，如"驳 回" → "驳回"）
  const norm = (s) => trim(s).replace(/\s+/g, "");

  // 找到文本精确/包含匹配的元素（取最内层）
  function findTextEl(text, root = document, tag = "*") {
    const nodes = $$(tag, root);
    for (const n of nodes) {
      const t = trim(n.textContent);
      if (t === text || (t.includes(text) && t.length <= text.length + 20)) return n;
    }
    return null;
  }

  // 向上找最近的满足条件的祖先
  function upTo(el, fn, max = 8) {
    let cur = el;
    for (let i = 0; i < max && cur; i++) {
      if (fn(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function setInputValue(el, val) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { return false; }
  }

  function isChecked(input) {
    return input && (input.checked === true || input.getAttribute("aria-checked") === "true");
  }

  // ============ 页面与模块识别 ============
  function isDetailPage() {
    return /\/review\/(my-tasks|tasks)\/\d+/.test(location.pathname);
  }

  // 模块容器：通过标题文本向上找卡片（优先 .panel-card 等卡片类）
  function findModule(titleText) {
    const titleEl = findTextEl(titleText);
    if (!titleEl) return null;
    const card = upTo(titleEl, (n) => {
      const cls = typeof n.className === "string" ? n.className : "";
      return /panel-card|ant-card|\bcard\b/i.test(cls) && n.offsetHeight > 60;
    }, 10);
    if (card) return card;
    return upTo(titleEl, (n) => {
      const h = n.offsetHeight;
      return h > 60 && (n.tagName === "DIV" || n.tagName === "SECTION" || n.tagName === "FORM");
    }, 10);
  }

  // 提交审核模块（按钮区）
  function findSubmitModule() {
    const btn = findButton("提交审核");
    if (btn) return upTo(btn, (n) => n.offsetHeight > 80 && /^DIV$/.test(n.tagName), 8) || btn.parentElement;
    return findModule("提交审核");
  }

  function findButton(text, root = document) {
    const tnorm = norm(text);
    // 1) <button> 元素文本（去空格后）包含 text
    const btns = $$("button", root).filter(b => {
      const t = norm(b.textContent);
      return t.includes(tnorm) && t.length <= tnorm.length + 4;
    });
    if (btns[0]) return btns[0];
    // 2) 叶子元素文本（去空格后）包含 text，向上找最近 button/.ant-btn/.gold-button
    const leafs = $$("span, div, a", root).filter(n => n.children.length <= 2 && norm(n.textContent).includes(tnorm));
    for (const lf of leafs) {
      if (norm(lf.textContent).length > tnorm.length + 4) continue;
      const c = upTo(lf, n => n.tagName === "BUTTON" || /ant-btn|gold-button/.test((n.className || "").toString()), 5);
      if (c) return c;
    }
    return null;
  }

  // ============ 收集检查项 ============
  // 行内「不通过」是否被勾选（兼容原生 radio/checkbox + 自绘组件）
  function rowCheckedState(row) {
    // 原生 input
    const inputs = $$("input[type=radio], input[type=checkbox]", row);
    const checkedInputs = inputs.filter(isChecked);
    for (const inp of checkedInputs) {
      const label = inp.closest("label");
      let ctx = label ? trim(label.textContent) : "";
      if (!ctx) {
        const p = inp.parentElement;
        if (p) ctx = trim(p.textContent);
      }
      if (/不通过|不合格|异常|驳回/.test(ctx)) return true;
      if (inputs.length === 1) return true; // 行里只有这一个勾选
    }
    // 自绘 radio：aria-checked / class / 样式
    const failEls = $$("label, span, div, td, li", row).filter(n =>
      trim(n.textContent) === "不通过" || trim(n.textContent).startsWith("不通过"));
    for (const el of failEls) {
      if (el.getAttribute("aria-checked") === "true") return true;
      if (/checked|selected|active/i.test(el.className || "")) return true;
      const anc = upTo(el, (n) => /checked|selected|active/i.test(n.className || "") ||
        n.getAttribute("aria-checked") === "true", 4);
      if (anc) return true;
    }
    return false;
  }

  // 在模块表格中收集勾选了「不通过」的行：{code, remark}
  // 页面为 Ant Design checkbox：选中标志是 .ant-checkbox-checked class，
  // 而非 input.checked（React 受控，DOM 恒为 false）。以「不通过」文本为锚点。
  function collectCheckedRows(mod, prefixes) {
    if (!mod) return [];
    const out = [];
    const seen = new Set();
    // 锚点：文本精确为「不通过」的 label/span（antd checkbox 的文本）
    const labels = $$("span, label, div, td, li, b", mod).filter(n => {
      const tt = trim(n.textContent);
      return tt === "不通过" || /^不通过$/.test(tt);
    });
    for (const lb of labels) {
      // 1) antd：wrapper 内有 .ant-checkbox-checked
      let checked = false;
      const wrapper = lb.closest(".ant-checkbox-wrapper, label");
      if (wrapper) {
        if ($(".ant-checkbox.ant-checkbox-checked", wrapper)) checked = true;
        const inp = $("input[type=checkbox], input[type=radio]", wrapper);
        if (inp && (inp.checked || inp.getAttribute("aria-checked") === "true")) checked = true;
        if (wrapper.getAttribute("aria-checked") === "true") checked = true;
      } else {
        // 2) 原生/自绘兜底
        const inp = lb.parentElement && $("input[type=checkbox], input[type=radio]", lb.parentElement);
        if (inp && inp.checked) checked = true;
        if (/checked|selected|active/i.test(lb.className || "")) checked = true;
        const anc = upTo(lb, (n) => /checked|selected|active/i.test(n.className || "") ||
          n.getAttribute("aria-checked") === "true", 4);
        if (anc) checked = true;
      }
      // 行容器：向上找最近的 TR 或行级 div（文本短、高度小）
      const row = upTo(lb, (n) => {
        if (n.tagName === "TR") return true;
        const txt = trim(n.textContent);
        if (txt.length > 300 || n.offsetHeight > 300) return false;
        if (n.offsetHeight < 18) return false;
              // 行级容器必须含编号样式文本（如 "A1" 或 "T1"，编号与分组可能粘连）
        return /(?:[ABC]|T)\d{1,2}/.test(txt);
      }, 10);
      if (!row) continue;
      // 从行中提取编号：优先独立单元格，退路是行文本中的编号
      const code = extractCode(row, prefixes);
      if (!code) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      if (!checked) continue;
      // 行备注（选填输入框，排除 radio/checkbox）
      let remark = "";
      const ta = $("textarea", row) ||
        $$("input", row).find(i => !/radio|checkbox/.test(i.type) && /选填|备注|说明/.test(i.placeholder || "")) ||
        $$("input", row).find(i => !/radio|checkbox/.test(i.type));
      if (ta) remark = (ta.value || "").trim();
      out.push({ code, remark });
    }
    return out;
  }

    // 从行容器提取编号：优先匹配单元格级文本（td/th/首个子容器），退路行文本
  function extractCode(row, prefixes) {
    const escapedPrefixes = prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    const reCell = new RegExp("^\\s*([" + escapedPrefixes + "])(\\d{1,2})\\s*$");
    // 1) 独立单元格
    const cells = $$("td, th", row);
    for (const c of cells) {
      const t = trim(c.textContent);
      const m = t.match(reCell);
      if (m) return m[1].toUpperCase() + m[2];
    }
    // 2) 行内第一个匹配的 span/div（短文本）
    const subs = $$("span, div, b, strong, label", row).filter(s => {
      const t = trim(s.textContent);
      return t.length <= 8 && reCell.test(t);
    });
    for (const s of subs) {
      const t = trim(s.textContent);
      const m = t.match(reCell);
      if (m) return m[1].toUpperCase() + m[2];
    }
    // 3) 行文本开头或首次出现
    const txt = trim(row.textContent);
        const mAll = txt.match(new RegExp("\\b([" + escapedPrefixes + "])(\\d{1,2})\\b"));
    if (mAll) return mAll[1].toUpperCase() + mAll[2];
    const mAny = txt.match(new RegExp("([" + escapedPrefixes + "])(\\d{1,2})"));
    if (mAny) return mAny[1].toUpperCase() + mAny[2];
    return null;
  }

  // 诊断：详细 dump 模块结构（用于定位勾选检测失败）
  function diagModuleFull(name, prefixes) {
    const mod = findModule(name);
    const lines = [];
    lines.push("== " + name + " ==");
    if (!mod) { lines.push("✗ 模块未找到"); return lines; }
    lines.push("✓ 模块容器: " + mod.tagName + "." + (mod.className || "") +
      " 宽" + mod.offsetWidth + " 高" + mod.offsetHeight);
    // 新逻辑结果
    const found = collectCheckedRows(mod, prefixes);
    lines.push("【新逻辑】勾选行: " + (found.length ? found.map(i => i.code + "[" + i.remark + "]").join(",") : "无"));
    // 锚点详情：每个「不通过」文本
    const labels = $$("span, label, div, td, li, b", mod).filter(n => {
      const tt = trim(n.textContent);
      return tt === "不通过" || /^不通过$/.test(tt);
    });
    lines.push("「不通过」文本元素 " + labels.length + " 个");
    let shown = 0;
    let noRow = 0;
    for (const lb of labels) {
      if (shown >= 12) break;
      const row = upTo(lb, (n) => {
        if (n.tagName === "TR") return true;
        const txt = trim(n.textContent);
        if (txt.length > 300 || n.offsetHeight > 300) return false;
        if (n.offsetHeight < 18) return false;
                return /(?:[ABC]|T)\d{1,2}/.test(txt);
      }, 10);
      const code = row ? extractCode(row, prefixes) : null;
      // 只展示能定位到编号行的锚点，避免被无编号区域（提交审核区）刷屏
      if (!code) { noRow++; continue; }
      const wrapper = lb.closest(".ant-checkbox-wrapper, label");
      const cbSpan = wrapper && $(".ant-checkbox", wrapper);
      const hasCheckedCls = !!cbSpan && /checked/i.test(cbSpan.className || "");
      const inp = wrapper && $("input[type=checkbox], input[type=radio]", wrapper);
      const inpChecked = !!(inp && (inp.checked || inp.getAttribute("aria-checked") === "true"));
      const wChecked = wrapper && (wrapper.getAttribute("aria-checked") === "true");
      lines.push("行" + code + ": " + lb.tagName + "." + (lb.className || "") +
        " wrapper=" + (wrapper ? "有" : "无") +
        " cbCls=" + (cbSpan ? (cbSpan.className || "") : "-") +
        " checkedCls=" + (hasCheckedCls ? "Y" : "N") +
        " inputChecked=" + (inpChecked ? "Y" : "N") +
        " aria=" + (wChecked ? "Y" : "N") +
        " 行高" + row.offsetHeight);
      if (wrapper) {
        lines.push("  W-HTML: " + wrapper.outerHTML.replace(/\s+/g, " ").slice(0, 220));
      }
      shown++;
    }
    if (noRow) lines.push("（另有 " + noRow + " 个锚点无编号行，已略过）");
    return lines;
  }

  // 弹全屏诊断面板（点击关闭）
  function showDiagPanel() {
    let d = document.getElementById("qc-diag");
    if (d) { d.remove(); return; }
    d = document.createElement("div");
    d.id = "qc-diag";
    d.style.cssText = "position:fixed;right:8px;top:8px;width:480px;max-height:75vh;overflow:auto;background:#0b1120;color:#d7e0f0;font:11px/1.6 'Consolas','Microsoft YaHei',monospace;border:1px solid #3a4a6e;border-radius:8px;padding:12px;z-index:2147484000;white-space:pre-wrap;box-shadow:0 8px 24px rgba(0,0,0,.5);";
    d.addEventListener("click", () => d.remove());
    const sec = document.createElement("div");
    sec.textContent = "[点击此面板关闭]\n\n" +
      diagModuleFull("人工质检检查项", ["A", "B", "C"]).join("\n") +
      "\n\n" + diagModuleFull("打标检查项", ["T"]).join("\n");
    d.appendChild(sec);
    document.documentElement.appendChild(d);
  }

  // 人工质检检查项 A/B/C
  function collectManualChecks() {
    const mod = findModule("人工质检检查项");
    return collectCheckedRows(mod, ["A", "B", "C"]);
  }
  // 打标检查项 T
  function collectTagChecks() {
    const mod = findModule("打标检查项");
    return collectCheckedRows(mod, ["T"]);
  }

  // ============ 检查项数据（人工质检 A/B/C 22 项 + 打标 T 4 项） ============
  const QC_MANUAL_ITEMS = [
    { code: "A1", desc: "出现禁用场景" },
    { code: "A2", desc: "非第一人称" },
    { code: "A3", desc: "画面抖动" },
    { code: "A4", desc: "画面亮度问题", sub: ["画面整体过暗", "画面整体过曝"] },
    { code: "A5", desc: "画面模糊" },
    { code: "A6", desc: "有他人肢体入境" },
    { code: "A7", desc: "出现敏感信息、涉密内容或违规画面" },
    { code: "B1", desc: "任务中途跑题" },
    { code: "B2", desc: "任务时长问题", sub: ["单一任务不足40秒", "单一任务超过12分钟", "长程任务超过20分钟"] },
    { code: "B3", desc: "任务跨房间移动" },
    { code: "B4", desc: "重复动作超8分钟" },
    { code: "B5", desc: "无明确意图" },
    { code: "B6", desc: "无生产价值" },
    { code: "B7", desc: "动作缺乏连贯性,前后逻辑断裂" },
    { code: "B8", desc: "非物理交互" },
    { code: "B9", desc: "存在明显无效动作" },
    { code: "C1", desc: "双手占画幅超70%且单次持续超2秒" },
    { code: "C2", desc: "双手距离过远,看不清精细动作" },
    { code: "C3", desc: "佩戴遮挡物" },
    { code: "CA", desc: "动作过快导致拖影和看不清细节" },
    { code: "C5", desc: "双手静止过长" },
    { code: "C6", desc: "手部超出屏幕" },
  ];
  const QC_TAG_ITEMS = [
    { code: "T1", label: "任务标题", template: (v) => "任务标题是" + v + "，内容是" },
    { code: "T2", label: "分类", template: (v) => "分类是" + v + "，内容是" },
    { code: "T3", label: "环境", template: (v) => "环境是" + v + "，内容是" },
    { code: "T4", label: "场景", template: (v) => "场景是" + v + "，内容是" },
  ];

  // 从详情页信息模块读取字段值（"标签：值"结构，优先兄弟元素，退路父容器）
  function getFieldValue(labelText) {
    const lt = norm(labelText);
    const targets = $$("span, div, label, p, b, td, th").filter(n => {
      if (n.children.length > 2) return false;
      return norm(n.textContent) === lt;
    });
    for (const lb of targets) {
      const sib = lb.nextElementSibling;
      if (sib) {
        const v = trim(sib.textContent);
        if (v && norm(v) !== lt && v.length <= 60) return v;
      }
      const p = lb.parentElement;
      if (p) {
        const rest = trim(p.textContent).replace(lt, "").trim();
        if (rest && rest.length <= 60 && norm(rest) !== lt) return rest;
      }
    }
    return "";
  }

  // ============ 列表页功能（mine 一键审核 / pool 一键认领） ============
  const QC_PAGE = (() => {
    const p = location.pathname;
    if (/\/review\/my-tasks\/\d+/.test(p)) return "detail";
    if (/\/review\/mine/.test(p)) return "mine";
    if (/\/review\/pool/.test(p)) return "pool";
    return "other";
  })();

  // 时长档位（秒）
  const QC_DUR_BANDS = [
    { label: "40秒以下", test: (s) => s < 40 },
    { label: "40秒~3分钟以下", test: (s) => s >= 40 && s < 180 },
    { label: "3分钟~5分钟以下", test: (s) => s >= 180 && s < 300 },
    { label: "5分钟~6分钟以下", test: (s) => s >= 300 && s < 360 },
    { label: "6分钟~10分钟以下", test: (s) => s >= 360 && s < 600 },
    { label: "10分钟~13分钟以下", test: (s) => s >= 600 && s < 780 },
    { label: "13分钟以上", test: (s) => s >= 780 },
  ];

    // ---- API 封装（与页面同认证：apikey + Bearer token） ----
  function qcApiKey() {
    try { const c = window.__SITE_RUNTIME_CONFIG__; if (c && c.supabasePublicKey) return c.supabasePublicKey; } catch (e) {}
    return ""; // Must be provided by window.__SITE_RUNTIME_CONFIG__.supabasePublicKey
  }
  function qcToken() {
    try {
      const a = JSON.parse(localStorage.getItem("sb-noitom-auth-token") || "{}");
      if (a && a.access_token) return a.access_token;
    } catch (e) {}
    return "";
  }
  function qcAccount() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("pdata-qc-access-context-v1:") === 0) {
          const c = JSON.parse(localStorage.getItem(k));
          if (c && c.user && c.user.account) return c.user.account;
        }
      }
    } catch (e) {}
    const t = trim(document.body ? document.body.innerText : "");
    const m = t.match(/qczjy\d{2}_nr|qc[a-z]+\d+_nr/);
    return m ? m[0] : "";
  }
  async function qcCall(path, params, opts) {
    const qs = new URLSearchParams();
    for (const kv of Object.entries(params || {})) {
      if (kv[1] != null && kv[1] !== "") qs.set(kv[0], String(kv[1]));
    }
    const q = qs.toString();
    const url = location.origin + "/api/functions/v1/" + path + (q ? "?" + q : "");
    const headers = { apikey: qcApiKey(), Authorization: "Bearer " + qcToken() };
    let body;
    if (opts && opts.method !== "GET" && opts.body) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let r, d;
    try {
      r = await fetch(url, { method: (opts && opts.method) || "GET", headers, body, signal: ctrl.signal });
      d = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    if (!r.ok || !d || !d.success) throw new Error((d && d.message) || path + " 调用失败");
    return d.data;
  }

  // ---- 解析当前列表行（DOM） ----
  function parseDurText(text) {
    const m = String(text).match(/([\d.]+)m/);
    if (!m) return NaN;
    return Math.round(parseFloat(m[1]) * 60); // X.YYm = X.YY 分钟 → 秒
  }
  function fmtSec(sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    const s = Math.round(sec);
    return Math.floor(s / 60) + "分" + (s % 60 < 10 ? "0" : "") + (s % 60) + "秒";
  }
  function parseListRows() {
    const trs = $$("tbody tr.ant-table-row");
    // antd 表头/表体是独立 table：从行所在表格容器取 header 表头，取不到再回退全局第一个 thead
    const box = trs[0] ? trs[0].closest(".ant-table") : null;
    let ths = [];
    if (box) {
      ths = [...box.querySelectorAll(".ant-table-header thead th, thead th")]
        .filter(th => !th.closest(".ant-table-measure-row") && trim(th.innerText))
        .map(th => trim(th.innerText));
    }
    if (!ths.length) {
      ths = [...document.querySelectorAll("thead th")]
        .filter(th => !th.closest(".ant-table-measure-row") && trim(th.innerText))
        .map(th => trim(th.innerText));
    }
    const gi = (name) => ths.findIndex(h => h.indexOf(name) >= 0);
    const rows = [];
    trs.forEach(tr => {
      const tds = $$("td", tr);
      const getCell = (name) => {
        const i = gi(name);
        return i >= 0 && tds[i] ? trim(tds[i].innerText) : "";
      };
      const key = tr.getAttribute("data-row-key") || "";
      const a = $("a", tr);
      const href = a ? a.getAttribute("href") || "" : "";
      const idm = href.match(/\/(?:my-tasks|tasks)\/(\d+)/) || key.match(/^(\d+)$/) || [];
      const durText = getCell("时长");
      const no = getCell("记录编号");
      const rejectText = getCell("最新驳回");
      const hasClaim = [...tr.querySelectorAll("button, a")].some(b => norm(b.innerText).indexOf("认领") >= 0);
      rows.push({
        id: idm[1] || key || "",
        no: no,
        title: getCell("标题"),
        scene: getCell("场景任务"),
        durText: durText,
        durSec: parseDurText(durText),
        status: getCell("当前状态"),
        reject: rejectText || (hasClaim ? "--" : ""),
        submit: getCell("提交时间"),
        uid: "",
        hasClaim: hasClaim,
        tr: tr,
      });
    });
    return rows;
  }

  // mine 页当前 chip → statusFilters（未审核=1；已审核/全部=空查询含 通过/不通过）
  function mineStatusFilter() {
    const chip = document.querySelector(".pool-status-filter__chip--active");
    const t = chip ? trim(chip.innerText) : "";
    if (t === "未审核") return "1";
    return "";
  }

  // 构建编号→item 映射（兼容"会话_编号"与纯 R 编号两种格式）
  function buildCmap(items) {
    const cmap = {};
    (items || []).forEach(it => {
      const no = String(it.recording_no || it.session_id || "");
      if (no) cmap[no] = it;
      const rm = no.match(/R\d{8}[a-zA-Z]*\d{3,}/);
      if (rm && rm[0] && rm[0] !== no) cmap[rm[0]] = it;
    });
    return cmap;
  }

  // 后台预取 uid 缓存（页面加载后立即拉，用户点按钮时秒开）
  function prefetchUids() {
    const mode = QC_PAGE === "mine" ? "myReview" : "reviewPool";
    const sf = QC_PAGE === "mine" ? mineStatusFilter() : "0";
    if (uidCacheRead(mode + "_sf" + (sf || "all"))) return;
    qcCall("qc-query", { path: "reviewTasks", mode: mode, account: qcAccount(), page: 1, pageSize: 200, statusFilters: sf })
      .then(data => {
        uidCacheWrite(mode + "_sf" + (sf || "all"), buildCmap((data && data.items) || []));
      })
      .catch(() => {});
  }

  // 补充 API 字段（用户ID / 时长秒 / 最新驳回 / 提交时间 / 场景）
  function uidCacheRead(mode) {
    try {
      const k = "qc_uid_cache_v2_" + mode;
      const c = JSON.parse(sessionStorage.getItem(k) || "null");
      if (c && c.ts && Date.now() - c.ts < 300000 && c.map) return c.map;
    } catch (e) {}
    return null;
  }
  function uidCacheWrite(mode, map) {
    try {
      sessionStorage.setItem("qc_uid_cache_v2_" + mode, JSON.stringify({ ts: Date.now(), map: map }));
    } catch (e) {}
  }
  async function enrichRows(rows, mode, statusFilters) {
    const cacheKey = mode + "_sf" + (statusFilters || "all");
    const cached = uidCacheRead(cacheKey);
    let items = null;
    if (cached) {
      items = cached;
    } else {
      try {
        const _data = await qcCall("qc-query", { path: "reviewTasks", mode: mode, account: qcAccount(), page: 1, pageSize: 200, statusFilters: statusFilters || "" });
        items = (_data && _data.items) || [];
        uidCacheWrite(cacheKey, buildCmap(items));
      } catch (e) { items = null; }
    }
    try {
      const map = new Map(Object.entries(cached ? cached : {}));
      if (cached) {
        rows.forEach(r => { const it = map.get(r.no); if (it) fillRow(r, it); });
        return rows;
      }
      Object.entries(buildCmap(items)).forEach(([no, it]) => map.set(no, it));
      rows.forEach(r => {
        const it = map.get(r.no);
        if (it) fillRow(r, it);
      });
    } catch (e) {}
    return rows;
  }
  function fillRow(r, it) {
    if (it.applicant_user_id != null) r.uid = String(it.applicant_user_id);
    if (it.duration_seconds != null) r.durSec = Number(it.duration_seconds);
    if (it.scene) r.scene = it.scene;
    if (it.latest_reject_by) r.reject = it.latest_reject_by + " 人工审核驳回";
    else if (it.latest_reject_by === null || it.latest_reject_by === undefined) r.reject = "--";
    if (it.submit_time) r.submit = String(it.submit_time).replace("T", " ").slice(0, 19);
  }

  // 应用筛选
  function applyFilter(rows, f) {
    return rows.filter(r => {
      if (f.uid && !(String(r.uid).indexOf(f.uid) >= 0 || String(r.title || "").indexOf(f.uid) >= 0)) return false;
      if (f.no && String(r.no).indexOf(f.no) < 0) return false;
      if (f.scene && r.scene !== f.scene) return false;
      if (f.dur != null && !QC_DUR_BANDS[f.dur].test(r.durSec)) return false;
      if (f.reject === "y" && r.reject === "--") return false;
      if (f.reject === "n" && r.reject !== "--") return false;
      if (f.submit && String(r.submit).indexOf(f.submit) < 0) return false;
      return true;
    });
  }

  // ---- 筛选面板（mine/pool 通用） ----
  function openFilterPanel(rows, title, onDone) {
        const f = { uid: "", no: "", scene: null, dur: null, reject: null, submit: "" };
    const scenes = [...new Set(rows.map(r => (r.scene || "").trim()).filter(Boolean))];
    const shell = layerShell(title + "　回车=应用筛选 Esc=取消");
    const body = shell.querySelector(".qc-layer-body");

        function renderFilterPanel() {
      const sceneOpts = scenes.map((sc, i) =>
        `<span data-k="sc${i}" style="cursor:pointer;padding:2px 8px;margin:2px;border-radius:4px;${f.scene === sc ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">${sc}</span>`
      ).join("");
      const durOpts = QC_DUR_BANDS.map((b, i) =>
        `<span data-k="d${i}" style="cursor:pointer;padding:2px 8px;margin:2px;border-radius:4px;${f.dur === i ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">${b.label}</span>`
      ).join("");
      const rejOpts = [
        { k: "ry", label: "人工审核驳回", on: f.reject === "y" },
        { k: "rn", label: "未驳回(--)", on: f.reject === "n" },
        { k: "ra", label: "不限", on: f.reject == null },
      ].map(o =>
        `<span data-k="${o.k}" style="cursor:pointer;padding:2px 8px;margin:2px;border-radius:4px;${o.on ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">${o.label}</span>`
      ).join("");
      body.innerHTML = `
        <div style="display:grid;gap:8px;font-size:13px;">
          <div style="display:flex;align-items:center;gap:8px;"><span style="width:70px;color:#9fb0d0;">用户ID</span><input data-f="uid" value="${f.uid}" placeholder="录制用户ID或标题关键词" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid #3a4a6e;background:#0b1120;color:#e6ebf5;"></div>
          <div style="display:flex;align-items:center;gap:8px;"><span style="width:70px;color:#9fb0d0;">录制编号</span><input data-f="no" value="${f.no}" placeholder="R编号关键字" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid #3a4a6e;background:#0b1120;color:#e6ebf5;"></div>
          <div style="display:flex;align-items:center;gap:8px;"><span style="width:70px;color:#9fb0d0;">场景任务</span><span style="flex:1;display:flex;flex-wrap:wrap;">${sceneOpts || "<span style='color:#556'>（当前列表无场景数据）</span>"}<span data-k="sc-none" style="cursor:pointer;padding:2px 8px;margin:2px;border-radius:4px;${f.scene == null ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">不限</span></span></div>
          <div style="display:flex;align-items:center;gap:8px;"><span style="width:70px;color:#9fb0d0;">时长</span><span style="flex:1;display:flex;flex-wrap:wrap;">${durOpts}<span data-k="da" style="cursor:pointer;padding:2px 8px;margin:2px;border-radius:4px;${f.dur == null ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">不限</span></span></div>
          <div style="display:flex;align-items:center;gap:8px;"><span style="width:70px;color:#9fb0d0;">最新驳回</span><span style="flex:1;display:flex;flex-wrap:wrap;">${rejOpts}</span></div>
          <div style="display:flex;align-items:center;gap:8px;"><span style="width:70px;color:#9fb0d0;">提交时间</span><input data-f="submit" value="${f.submit}" placeholder="按日：2026-10-20" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid #3a4a6e;background:#0b1120;color:#e6ebf5;"></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end;">
          <button data-act="cancel" style="padding:7px 18px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;">取消</button>
          <button data-act="ok" style="padding:7px 18px;border:none;border-radius:6px;background:#34a853;color:#fff;cursor:pointer;">应用筛选</button>
        </div>`;
    }

    const layer = {
      el: shell,
      handleKey(e) {
        if (e.key === "Enter") { closeLayer(); onDone(applyFilter(rows, f)); }
        else if (e.key === "Escape") { closeLayer(); }
      }
    };
    body.addEventListener("input", (e) => {
      const k = e.target.dataset.f;
      if (k) f[k] = e.target.value;
    });
        body.addEventListener("click", (e) => {
      const el = e.target;
      if (el.dataset.act === "ok") { closeLayer(); onDone(applyFilter(rows, f)); }
      else if (el.dataset.act === "cancel") { closeLayer(); }
      else if (el.dataset.k) {
        const k = el.dataset.k;
        if (k.indexOf("sc") === 0) f.scene = k === "sc-none" ? null : scenes[+k.slice(2)];
        else if (k.indexOf("d") === 0) f.dur = k === "da" ? null : +k.slice(1);
        else if (k === "ry") f.reject = "y";
        else if (k === "rn") f.reject = "n";
        else if (k === "ra") f.reject = null;
        renderFilterPanel();
      }
    });
    renderFilterPanel();
    showLayer(layer);
  }

  // ---- 批量操作执行 ----
  async function runBatch(list, actionFn, doneMsg) {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      toast("(" + (i + 1) + "/" + list.length + ") " + (actionFn === qcSubmitOne ? "提交" : "认领") + " " + it.no, 1200);
      try { await actionFn(it); }
      catch (e) { toast("✗ " + it.no + "：" + (e.message || e), 4000); }
    }
    toast(doneMsg, 3000);
    setTimeout(() => location.reload(), 800);
  }
  async function qcSubmitOne(it, result) {
    await qcCall("review-sync", {}, { method: "POST", body: { action: "rpc-submit", taskId: Number(it.id), workflow: "review", result: result, remark: "", checklist: [] } });
  }
  async function qcClaimOne(it) {
    await qcCall("review-sync", {}, { method: "POST", body: { action: "rpc-claim", taskId: Number(it.id), workflow: "review" } });
  }

  // ---- mine 页：一键审核 ----
  function openReviewPanel(mode) {
    let rows = parseListRows();
    if (!rows.length) { toast("当前列表没有可操作的任务"); return; }
    rows = enrichRows(rows, "myReview", mineStatusFilter()).then(r => {
      if (mode === "nopass") r = r.filter(x => x.reject === "--");
      else if (mode === "rejected") r = r.filter(x => x.reject !== "--");
      else if (mode === "filter") { openFilterPanel(r, "一键审核 — 筛选", (matched) => reviewConfirm(matched, "filter")); return; }
      reviewConfirm(r, mode);
    });
  }

  function reviewConfirm(rows, backMode) {
    if (!rows.length) { toast("筛选后没有符合条件的任务"); return; }
    let result = "passed";
    const shell = layerShell("确认一键审核　1=通过 2=不通过 回车=确认 Esc=返回");
    const body = shell.querySelector(".qc-layer-body");
    body.innerHTML = `
      <div id="qc-rev-detail" style="background:#0b1120;border:1px solid #2a3550;border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button data-act="back" style="padding:8px 20px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;">返回</button>
        <button data-act="cancel" style="padding:8px 20px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;">取消</button>
        <button data-act="ok" style="padding:8px 20px;border:none;border-radius:6px;background:#d93025;color:#fff;cursor:pointer;">确认审核</button>
      </div>`;
    function renderDetail() {
      const lines = rows.slice(0, 8).map((r, i) =>
        (i + 1) + ". " + r.no + "　" + r.scene + "　" + fmtSec(r.durSec) + (r.uid ? "　用户ID:" + r.uid : "") + (r.reject && r.reject !== "--" ? "　[驳回]" : "")
      ).join("\n");
      body.querySelector("#qc-rev-detail").textContent =
        "将对 " + rows.length + " 条任务直接提交审核结论（不进入详情页）：\n" + lines + (rows.length > 8 ? "\n…等共 " + rows.length + " 条" : "") +
        "\n\n审核结论：1=通过　2=不通过　当前：" + (result === "passed" ? "通过" : "不通过");
    }
    const layer = {
      el: shell,
      handleKey(e) {
        if (e.key === "1") { result = "passed"; renderDetail(); }
        else if (e.key === "2") { result = "failed"; renderDetail(); }
        else if (e.key === "Enter") { closeLayer(); setStatus("一键审核中…"); runBatch(rows, (it) => qcSubmitOne(it, result), "一键审核完成"); }
        else if (e.key === "Escape") { closeLayer(); }
      }
    };
    body.addEventListener("click", (e) => {
      if (e.target.dataset.act === "ok") { closeLayer(); setStatus("一键审核中…"); runBatch(rows, (it) => qcSubmitOne(it, result), "一键审核完成"); }
      else if (e.target.dataset.act === "back" || e.target.dataset.act === "cancel") { closeLayer(); openReviewPanel(backMode || "all"); }
    });
    renderDetail();
    showLayer(layer);
  }

  // ---- pool 页：一键认领 ----
  function openClaimPanel(mode) {
    if (mode === "loop") { claimLoopConfirm(); return; }
    const rows0 = parseListRows().filter(r => r.hasClaim);
    if (!rows0.length) { toast("当前列表没有可认领的任务（请切到 未认领/全部 标签）"); return; }
    enrichRows(rows0, "reviewPool", "0").then(rows => {
      if (mode === "filter") openFilterPanel(rows, "一键认领 — 筛选", (matched) => claimConfirm(matched, "filter"));
      else claimConfirm(rows, mode);
    });
  }

  function claimConfirm(rows, backMode) {
    if (!rows.length) { toast("筛选后没有可认领的任务"); return; }
    const lines = rows.slice(0, 8).map((r, i) =>
      (i + 1) + ". " + r.no + "　" + r.scene + "　" + fmtSec(r.durSec) + (r.uid ? "　用户ID:" + r.uid : "") + (r.reject && r.reject !== "--" ? "　[驳回]" : "")
    ).join("\n");
    const detail = "将直接认领 " + rows.length + " 条任务：\n" + lines + (rows.length > 8 ? "\n…等共 " + rows.length + " 条" : "");
    confirmAction("确认一键认领　回车=确认 Esc=返回", detail, () => {
      setStatus("一键认领中…");
      runBatch(rows, qcClaimOne, "一键认领完成");
    }, "确认认领", () => openClaimPanel(backMode || "all"));
  }

  // 持续认领（跨页面刷新保持）
  function claimLoopConfirm() {
    const detail = "持续认领模式：\n自动读取未认领任务 → 逐个认领 → 间隔0.5秒刷新列表 → 继续，直到按 Esc 停止。\n\n开始后页面会自动刷新，按 Esc 随时停止。";
    confirmAction("开始持续认领？", detail, () => {
      localStorage.setItem("qc_claim_loop", "1");
      toast("持续认领已开始，按 Esc 停止", 3000);
      location.reload();
    }, "开始认领");
  }
  async function runClaimLoop() {
    toast("持续认领中…按 Esc 停止", 2500);
    try {
      const _d = await qcCall("qc-query", { path: "reviewTasks", mode: "reviewPool", account: qcAccount(), page: 1, pageSize: 100, statusFilters: "0" });
      const items = (_d && _d.items) || [];
      if (items.length) {
        for (const it of items) {
          if (localStorage.getItem("qc_claim_loop") !== "1") break;
          toast("认领 " + it.recording_no, 800);
          try { await qcCall("review-sync", {}, { method: "POST", body: { action: "rpc-claim", taskId: Number(it.task_id), workflow: "review" } }); }
          catch (e) { toast("✗ " + it.recording_no + "：" + (e.message || e), 3000); }
        }
      } else {
        toast("当前无未认领任务，0.5秒后刷新…", 1200);
      }
    } catch (e) {
      toast("持续认领出错：" + (e.message || e), 3000);
    }
    setTimeout(() => {
      if (localStorage.getItem("qc_claim_loop") === "1") location.reload();
    }, 500);
  }

  // ---- 列表页初始化（状态条 + 快捷键） ----
  function initListPage() {
    if (document.getElementById("qc-listbar")) return;
    prefetchUids();
    const bar = document.createElement("div");
    bar.id = "qc-listbar";
    bar.style.cssText = "position:fixed;top:64px;right:12px;background:#141c2e;border:1px solid #2a3550;border-radius:10px;padding:10px 12px;color:#e6ebf5;font:12px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;z-index:2147482000;box-shadow:0 6px 18px rgba(0,0,0,.4);max-width:300px;";
    const mineBtn = (label, k, act) => `<button data-act="${act}" style="display:block;width:100%;margin:3px 0;padding:6px 10px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;text-align:left;">${label}<span style="opacity:.6;float:right;">${k}</span></button>`;
    if (QC_PAGE === "mine") {
      bar.innerHTML = `<div style="font-weight:700;color:#f5c542;margin-bottom:6px;">一键审核</div>
        ${mineBtn("审核全部（当前列表）", "1", "rev-all")}
        ${mineBtn("审核全部·无驳回状态", "2", "rev-nopass")}
        ${mineBtn("审核全部·驳回状态", "3", "rev-rejected")}
        ${mineBtn("筛选后审核", "4", "rev-filter")}
        <div id="qc-liststatus" style="margin-top:6px;color:#9fb0d0;font-size:11px;">就绪</div>`;
      bar.addEventListener("click", (e) => {
        const a = e.target.dataset.act;
        if (a === "rev-all") openReviewPanel("all");
        else if (a === "rev-nopass") openReviewPanel("nopass");
        else if (a === "rev-rejected") openReviewPanel("rejected");
        else if (a === "rev-filter") openReviewPanel("filter");
      });
    } else {
      bar.innerHTML = `<div style="font-weight:700;color:#f5c542;margin-bottom:6px;">一键认领</div>
        ${mineBtn("认领全部（当前未认领）", "1", "claim-all")}
        ${mineBtn("筛选后认领", "2", "claim-filter")}
        ${mineBtn("持续认领（Esc停止）", "3", "claim-loop")}
        <div id="qc-liststatus" style="margin-top:6px;color:#9fb0d0;font-size:11px;">就绪</div>`;
      bar.addEventListener("click", (e) => {
        const a = e.target.dataset.act;
        if (a === "claim-all") openClaimPanel("all");
        else if (a === "claim-filter") openClaimPanel("filter");
        else if (a === "claim-loop") openClaimPanel("loop");
      });
    }
    (document.body || document.documentElement).appendChild(bar);

    // 持续认领模式检测
    if (localStorage.getItem("qc_claim_loop") === "1" && QC_PAGE === "pool") {
      const ls = document.getElementById("qc-liststatus");
      if (ls) ls.textContent = "持续认领运行中…按 Esc 停止";
      runClaimLoop();
    }

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (qcLayer) { qcLayer.handleKey(e); return; }
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (QC_PAGE === "mine") {
        if (e.key === "1") openReviewPanel("all");
        else if (e.key === "2") openReviewPanel("nopass");
        else if (e.key === "3") openReviewPanel("rejected");
        else if (e.key === "4") openReviewPanel("filter");
      } else if (QC_PAGE === "pool") {
        if (e.key === "Escape" && localStorage.getItem("qc_claim_loop") === "1") {
          localStorage.removeItem("qc_claim_loop");
          toast("已停止持续认领，0.5秒后刷新", 2500);
          setTimeout(() => location.reload(), 500);
        } else if (e.key === "1") openClaimPanel("all");
        else if (e.key === "2") openClaimPanel("filter");
        else if (e.key === "3") openClaimPanel("loop");
      }
    });
  }

  // ============ 键盘操作层（覆盖层机制） ============
  let qcLayer = null;

  function showLayer(layer) {
    closeLayer();
    qcLayer = layer;
    document.documentElement.appendChild(layer.el);
  }
  function closeLayer() {
    if (qcLayer) { qcLayer.el.remove(); qcLayer = null; }
  }

  // 覆盖层外壳
  function layerShell(title) {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147485000;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI','Microsoft YaHei',sans-serif;";
    el.innerHTML = `
      <div style="background:#141c2e;border:1px solid #3a4a6e;border-radius:12px;padding:18px;max-width:560px;width:92%;color:#e6ebf5;box-shadow:0 12px 32px rgba(0,0,0,.5);max-height:86vh;display:flex;flex-direction:column;">
        <div style="font-size:15px;font-weight:700;color:#f5c542;margin-bottom:10px;flex:none;">${title}</div>
        <div class="qc-layer-body" style="overflow:auto;flex:1;"></div>
      </div>`;
    return el;
  }

  // ============ 按 2：不通过检查项面板（单选） ============
  let manualState = { filter: "ALL", selected: null };
  function openManualPanel() {
    let filter = manualState.filter;
    let selected = manualState.selected; // {code, desc}
    const sync = () => { manualState.filter = filter; manualState.selected = selected; };
    const shell = layerShell("不通过检查项（单选）　0=全部 A/B/C=筛选 1-9=选择 回车=确认 Esc=取消");
    const body = shell.querySelector(".qc-layer-body");

        function renderManualPanel() {
      const items = QC_MANUAL_ITEMS.filter(i => filter === "ALL" || i.code.startsWith(filter));
      body.innerHTML = items.map((it, idx) => {
        const sel = selected && selected.code === it.code;
        const subHint = it.sub ? "　↳进入二级选择" : "";
        return `<div data-code="${it.code}" style="padding:6px 10px;margin:3px 0;border-radius:6px;cursor:pointer;${sel ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">
          <b style="margin-right:8px;">${idx + 1}</b> ${it.code} ${it.desc}${subHint}${sel ? "　✓" : ""}
        </div>`;
      }).join("");
    }

        function pick(it) {
      if (selected && selected.code === it.code) selected = null;
      else selected = { code: it.code, desc: it.desc };
      sync();
      renderManualPanel();
      if (selected && it.sub) {
        openManualSub(it, (desc) => {
          selected.desc = desc; sync();
          closeLayer(); // 关闭当前层，避免嵌套层级
          openManualPanel(); // 重新显示主面板（恢复勾选状态）
        });
      }
    }

    const layer = {
      el: shell,
      handleKey(e) {
        if (e.key >= "1" && e.key <= "9") {
          const items = QC_MANUAL_ITEMS.filter(i => filter === "ALL" || i.code.startsWith(filter));
          const it = items[+e.key - 1];
          if (it) pick(it);
                } else if (e.key === "a" || e.key === "A") { filter = "A"; sync(); renderManualPanel(); }
        else if (e.key === "b" || e.key === "B") { filter = "B"; sync(); renderManualPanel(); }
        else if (e.key === "c" || e.key === "C") { filter = "C"; sync(); renderManualPanel(); }
        else if (e.key === "0") { filter = "ALL"; sync(); renderManualPanel(); }
        else if (e.key === "Enter") {
          if (!selected) { toast("请先选择一项检查项"); return; }
          finishManual(selected);
        } else if (e.key === "Escape") { closeLayer(); }
      }
    };
        body.addEventListener("click", (e) => {
      const row = e.target.closest("[data-code]");
      if (!row) return;
      const it = QC_MANUAL_ITEMS.find(i => i.code === row.dataset.code);
      if (it) pick(it);
    });
    renderManualPanel();
    showLayer(layer);
  }

  // A4/B2 二级单选
  function openManualSub(it, onPick) {
    const shell = layerShell(it.code + " 请选择（单选）　1-" + it.sub.length + "=选择 Esc=返回");
    const body = shell.querySelector(".qc-layer-body");
    body.innerHTML = it.sub.map((s, idx) =>
      `<div data-i="${idx}" style="padding:8px 10px;margin:3px 0;border-radius:6px;background:#0b1120;border:1px solid #2a3550;cursor:pointer;"><b style="margin-right:8px;">${idx + 1}</b> ${s}</div>`
    ).join("");
    const layer = {
      el: shell,
      handleKey(e) {
        const n = +e.key;
        if (n >= 1 && n <= it.sub.length) { onPick(it.sub[n - 1]); }
        else if (e.key === "Escape") { closeLayer(); openManualPanel(); }
      }
    };
    body.addEventListener("click", (e) => {
      const row = e.target.closest("[data-i]");
      if (!row) return;
      onPick(it.sub[+row.dataset.i]);
    });
    showLayer(layer);
  }

  // 不通过：确认后勾结论+填备注+提交（备注可编辑，支持返回重选）
  function finishManual(sel) {
    const defaultRemark = sel.code + ": " + sel.desc;
    const detail = "记录编号：" + getRecordId() +
      "\n视频时长：" + (getVideoDuration() || "—") +
      "\n\n勾选项：" + sel.code + " " + sel.desc;
    const fields = {
      html: `<div style="margin:10px 0 14px;"><div style="margin-bottom:4px;color:#9fb0d0;font-size:12px;">备注（可直接修改）</div><input id="qc-remark-input" value="${defaultRemark.replace(/"/g, "&quot;")}" style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid #3a4a6e;background:#0b1120;color:#e6ebf5;font-size:13px;box-sizing:border-box;"></div>`
    };
    confirmAction("确认【不通过】并提交？", detail, () => {
      const inp = document.getElementById("qc-remark-input");
      const remark = (inp && inp.value.trim()) ? inp.value.trim() : defaultRemark;
      setStatus("不通过：勾结论+填备注+提交…");
      setConclusion("不通过");
      setSubmitRemark(remark);
      setTimeout(() => {
        if (!submitReview()) setStatus("✗ 未找到提交审核按钮");
        else setStatus("已提交：不通过（" + getRecordId() + "）");
      }, 150);
    }, "确认提交", () => openManualPanel(), fields);
  }

  // ============ 按 3：打标驳回检查项面板（多选） ============
  let tagState = { picked: new Set(), results: {} };
  function openTagPanel() {
    const picked = tagState.picked;
    const shell = layerShell("打标驳回检查项（多选）　1-4=勾选切换 回车=确认 Esc=取消");
    const body = shell.querySelector(".qc-layer-body");

        function renderTagPanel() {
      body.innerHTML = QC_TAG_ITEMS.map((it, idx) => {
        const v = getFieldValue(it.label);
        const on = picked.has(it.code);
        const preview = it.template(v || "？");
        return `<div data-code="${it.code}" style="padding:8px 10px;margin:4px 0;border-radius:6px;cursor:pointer;${on ? "background:#2a6d3f;border:1px solid #34a853;" : "background:#0b1120;border:1px solid #2a3550;"}">
          <b style="margin-right:8px;">${idx + 1}</b> ${on ? "☑" : "☐"} ${it.code}　${preview}<span style="opacity:.6;">…（确认后填写内容）</span>
        </div>`;
      }).join("");
    }

    const layer = {
      el: shell,
      handleKey(e) {
        if (e.key >= "1" && e.key <= "4") {
          const it = QC_TAG_ITEMS[+e.key - 1];
          if (!it) return;
                    if (picked.has(it.code)) picked.delete(it.code); else picked.add(it.code);
          renderTagPanel();
        } else if (e.key === "Enter") {
          if (!picked.size) { toast("请至少勾选一项"); return; }
          closeLayer();
          fillTagContents([...picked]);
        } else if (e.key === "Escape") { closeLayer(); }
      }
    };
        body.addEventListener("click", (e) => {
      const row = e.target.closest("[data-code]");
      if (!row) return;
      const code = row.dataset.code;
      if (picked.has(code)) picked.delete(code); else picked.add(code);
      renderTagPanel();
    });
    renderTagPanel();
    showLayer(layer);
  }

  // 依次为每个勾选项填写"内容"（已填的保留；返回面板后继续不重复填）
  function fillTagContents(codes) {
    const results = tagState.results;
    const todo = codes.filter(c => !results[c]);
    if (!todo.length) { finishReject(codes.map(c => ({ code: c, remark: results[c] || "" }))); return; }
    let i = 0;
    function next() {
      if (i >= todo.length) { finishReject(codes.map(c => ({ code: c, remark: results[c] || "" }))); return; }
      const code = todo[i];
      const it = QC_TAG_ITEMS.find(t => t.code === code);
      const v = getFieldValue(it.label);
      const prefix = it.template(v || "");
      openContentInput(it, prefix, (content) => {
        results[code] = prefix + (content || "");
        i++; next();
      });
    }
    next();
  }

  // 单个内容输入框（回车=确认）
  function openContentInput(it, prefix, onDone) {
    const shell = layerShell(it.code + " — 填写内容　（回车=确认 Esc=取消）");
    const body = shell.querySelector(".qc-layer-body");
    body.innerHTML = `
      <div style="margin-bottom:8px;color:#9fb0d0;word-break:break-all;">${prefix}</div>
      <input type="text" id="qc-content-input" placeholder="在这里填写内容" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid #3a4a6e;background:#0b1120;color:#e6ebf5;font-size:13px;box-sizing:border-box;">
      <div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end;">
        <button data-act="cancel" style="padding:7px 18px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;">取消</button>
        <button data-act="ok" style="padding:7px 18px;border:none;border-radius:6px;background:#34a853;color:#fff;cursor:pointer;">确定</button>
      </div>`;
    const inp = body.querySelector("#qc-content-input");
    inp.focus();
    const layer = {
      el: shell,
      handleKey(e) {
        if (e.key === "Enter") { closeLayer(); onDone(inp.value); }
        else if (e.key === "Escape") { closeLayer(); openTagPanel(); }
      }
    };
    body.addEventListener("click", (e) => {
      if (e.target.dataset.act === "ok") { closeLayer(); onDone(inp.value); }
      else if (e.target.dataset.act === "cancel") { closeLayer(); openTagPanel(); }
    });
    showLayer(layer);
  }

  // 驳回：确认后执行原驳回动作
  function finishReject(results) {
    const remark = results.map(r => r.code + ": " + r.remark).join("；");
    const detail = "记录编号：" + getRecordId() +
      "\n视频时长：" + (getVideoDuration() || "—") +
      "\n\n打标勾选：" + results.map(r => r.code).join(", ") +
      "\n\n弹窗备注：\n" + remark;
    confirmAction("确认【驳回】并提交？", detail, () => {
      doRejectExecute(remark);
    }, "确认驳回", () => openTagPanel());
  }

  // ============ 动作 ============
  // 获取当前任务的记录编号（R开头，如 R20260920runxun0001685）；找不到则用 URL 里的任务 ID
  function getRecordId() {
    // 0) 当前 URL 的任务数字 ID
    const um = location.pathname.match(/\/(?:my-tasks|tasks)\/(\d+)/);
    const curUrlId = um ? um[1] : "";
    // 1) 优先：localStorage 里点"审核"时记下的 R 编号（校验 URL 数字一致，避免串记录）
    try {
      const rid = localStorage.getItem("qc_last_record_id");
      const uid = localStorage.getItem("qc_last_url_id");
      if (rid && (!uid || uid === curUrlId)) return rid;
    } catch (e) {}
        // 2) 在页面所有元素文本里找 R+8位日期+字母+数字 格式
    // 使用 TreeWalker 高效遍历文本节点，避免 querySelectorAll('*') 的性能问题
    const re = /R\d{8}[a-zA-Z]*\d{3,}/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode()) !== null) {
      const t = trim(node.textContent);
      if (t.length > 0 && t.length <= 100) { // 只检查合理长度的文本
        const m = t.match(re);
        if (m) return m[0];
      }
    }
    // 3) fallback：URL 里的任务 ID
    return curUrlId || "未知";
  }

  // 读取视频时长（优先 video 元素真实时长，格式 x分xx秒）
  function getVideoDuration() {
    const v = $("video");
    if (v && isFinite(v.duration) && v.duration > 0) {
      const s = Math.round(v.duration);
      const mm = Math.floor(s / 60);
      const ss = s % 60;
      return mm + "分" + (ss < 10 ? "0" + ss : ss) + "秒";
    }
    // fallback：页面文本找"录制时长"
    const labels = $$("span, div, td, label").filter(n => trim(n.textContent) === "录制时长");
    for (const l of labels) {
      const p = l.parentElement;
      if (p) {
        const t = trim(p.textContent).replace(/录制时长/, "").trim();
        if (t) return t;
      }
    }
    return "";
  }

  function setStatus(msg) {
    const s = document.getElementById("qc-status");
    if (s) s.textContent = msg;
    toast(msg);
  }

  function toast(msg, ms = 3000) {
    let t = document.getElementById("qc-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "qc-toast";
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = "0"; }, ms);
  }

  // 勾选审核结论（通过/不通过）—— 精确文本匹配，避免误点到含两个选项的容器
  function setConclusion(val) {
    const mod = findSubmitModule();
    if (!mod) return false;
    // 1) antd radio/checkbox wrapper，文本精确等于 val
    const wrappers = $$(".ant-radio-wrapper, .ant-checkbox-wrapper, label", mod);
    for (const w of wrappers) {
      const t = trim(w.textContent);
      if (t !== val) continue;
      // 点组件本体（antd 的 .ant-radio / .ant-checkbox）
      const comp = $(".ant-radio, .ant-checkbox", w);
      if (comp) { clickEl(comp); return true; }
      const inp = $("input[type=radio], input[type=checkbox]", w);
      if (inp) { clickEl(inp); return true; }
      clickEl(w); return true;
    }
    // 2) 文本 span 精确匹配，再向上找 wrapper
    const spans = $$("span", mod).filter(n => trim(n.textContent) === val);
    for (const s of spans) {
      const w = s.closest(".ant-radio-wrapper, .ant-checkbox-wrapper, label");
      if (w) {
        const comp = $(".ant-radio, .ant-checkbox", w);
        if (comp) { clickEl(comp); return true; }
        clickEl(w); return true;
      }
    }
    // 3) 退路：input 紧邻的文本 span 精确匹配
    const inputs = $$("input[type=radio], input[type=checkbox]", mod);
    for (const inp of inputs) {
      const p = inp.parentElement;
      if (p && trim(p.textContent) === val) { clickEl(inp); return true; }
      const sib = inp.nextElementSibling || inp.previousElementSibling;
      if (sib && trim(sib.textContent) === val) { clickEl(inp); return true; }
    }
    return false;
  }

  // 填提交区备注
  function setSubmitRemark(val) {
    const mod = findSubmitModule();
    if (!mod) return false;
    const box = $("textarea", mod) ||
                $$("input", mod).find(i => !/radio|checkbox/.test(i.type) && /备注|说明|原因|审核/.test(i.placeholder || "")) ||
                $$("input", mod).find(i => !/radio|checkbox/.test(i.type)) ||
                $("input[type=text]", mod);
    if (!box) return false;
    setInputValue(box, val);
    return true;
  }

  // 提交审核
  function submitReview() {
    const btn = findButton("提交审核");
    return clickEl(btn);
  }

  // 通用确认弹层：点「确认」或按回车才执行 onConfirm；onBack 返回上一级；fields 为附加表单
  function confirmAction(title, detailText, onConfirm, okText = "确认提交", onBack = null, fields = null) {
    const shell = layerShell(title);
    const body = shell.querySelector(".qc-layer-body");
    body.innerHTML = `
      <div style="background:#0b1120;border:1px solid #2a3550;border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;">${detailText}</div>
      ${fields ? fields.html : ""}
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        ${onBack ? `<button data-act="back" style="padding:8px 20px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;font-size:13px;font-weight:600;">返回</button>` : ""}
        <button data-act="cancel" style="padding:8px 20px;border:none;border-radius:6px;background:#2a3550;color:#e6ebf5;cursor:pointer;font-size:13px;font-weight:600;">取消</button>
        <button data-act="ok" style="padding:8px 20px;border:none;border-radius:6px;background:#d93025;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">${okText}</button>
      </div>`;
    const layer = {
      el: shell,
      handleKey(e) {
        if (e.key === "Enter") { closeLayer(); onConfirm(); }
        else if (e.key === "Escape") { if (onBack) onBack(); else { closeLayer(); setStatus("已取消提交，页面内容保留"); } }
      }
    };
    body.addEventListener("click", (e) => {
      if (e.target.dataset.act === "ok") { closeLayer(); onConfirm(); }
      else if (e.target.dataset.act === "back") { closeLayer(); onBack(); }
      else if (e.target.dataset.act === "cancel") { closeLayer(); setStatus("已取消提交，页面内容保留"); }
    });
    showLayer(layer);
  }

  // ---- 通过 ----
  function doPass() {
    setStatus("通过：勾选结论并提交…");
    setConclusion("通过");
    setTimeout(() => {
      if (!submitReview()) setStatus("✗ 未找到提交审核按钮");
      else setStatus("已提交：通过（" + getRecordId() + "）");
    }, 150);
  }

  // ---- 不通过（弹出检查项面板，单选，确认后提交） ----
  function doFail() {
    if (!isDetailPage()) { setStatus("请在任务详情页使用"); return; }
    manualState = { filter: "ALL", selected: null };
    openManualPanel();
  }

  // ---- 驳回（弹出打标面板，多选，确认后执行原动作） ----
  function doReject() {
    if (!isDetailPage()) { setStatus("请在任务详情页使用"); return; }
    tagState = { picked: new Set(), results: {} };
    openTagPanel();
  }

  // 原驳回动作：点驳回按钮 → 弹窗填备注 → 确认 → 点弹窗确定
  function doRejectExecute(remark) {
    setStatus("驳回：点驳回按钮，填弹窗备注…");
    const mod = findModule("打标检查项");
    let btn = null;
    if (mod) {
      btn = $(".gold-button-dangerous, .ant-btn-dangerous", mod) ||
            $$("button", mod).find(b => norm(b.textContent).includes("驳回")) || null;
    }
    if (!btn) btn = findButton("驳回", mod || document);
    if (!btn) btn = findButton("驳回", document);
    if (!btn) {
      let hint = "";
      if (mod) hint = "打标模块按钮：" + $$("button", mod).map(b => JSON.stringify(trim(b.textContent))).join("|");
      setStatus("✗ 未找到驳回按钮。" + hint);
      showDiagPanel();
      return;
    }
    clickEl(btn);
    setTimeout(() => {
      const dlg = findDialog();
      if (!dlg) { setStatus("⚠ 弹窗未出现，请手动填备注：" + remark); return; }
      const box = $("textarea", dlg) || $$("input", dlg).find(i => /备注|说明|原因/.test(i.placeholder || "")) ||
                  $("input[type=text]", dlg) || $("input:not([type])", dlg);
      if (box) setInputValue(box, remark);
      const detail = "记录编号：" + getRecordId() +
        "\n视频时长：" + (getVideoDuration() || "—") +
        "\n\n弹窗备注已填：\n" + remark;
      confirmAction("确认【驳回】并提交？", detail, () => {
        const ok = findButton("确定", dlg) || findButton("确认", dlg) || findButton("提交", dlg) || findButton("OK", dlg);
        if (ok) { clickEl(ok); setStatus("已提交：驳回（" + getRecordId() + "）"); }
        else setStatus("⚠ 请手动点弹窗确定");
      }, "确认驳回");
    }, 400);
  }

  function findDialog() {
    const modals = $$("[role=dialog], .ant-modal, .el-dialog, .modal, .dialog, div[class*=modal], div[class*=dialog]");
    for (const d of modals) {
      if (d.offsetParent !== null || d.getBoundingClientRect().height > 0) return d;
    }
    return null;
  }

  // ---- 跳转 ----
  function gotoSubmit() {
    const mod = findSubmitModule();
    if (mod) mod.scrollIntoView({ behavior: "smooth", block: "center" });
    else {
      const btn = findButton("提交审核");
      if (btn) btn.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  function gotoVideo() {
    const v = $("video");
    if (v) v.scrollIntoView({ behavior: "smooth", block: "center" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ============ UI ============
  function init() {
    if (QC_PAGE === "mine" || QC_PAGE === "pool") { initListPage(); return; }
    if (QC_PAGE !== "detail") return;
    if (document.getElementById("qc-ball")) return;

    const style = document.createElement("style");
    style.textContent = `
      #qc-ball {
        position: fixed;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        margin-right: 16px;
        width: 48px; height: 48px;
        border-radius: 50%;
        background: #1a73e8;
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; font-weight: 700;
        cursor: grab;
        z-index: 2147480000;
        user-select: none;
        box-shadow: 0 4px 12px rgba(0,0,0,.4);
      }
      #qc-ball:hover { background: #1557b0; }
      #qc-ball.qc-open { background: #0d47a1; }
      #qc-ball.qc-dragging { cursor: grabbing; }
      #qc-panel {
        position: fixed;
        width: 240px;
        background: #141c2e;
        border: 1px solid #2a3550;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,.45);
        z-index: 2147480001;
        color: #e6ebf5;
        font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
        user-select: none;
        opacity: 0;
        transform: scale(0.95);
        transform-origin: right center;
        transition: opacity .18s ease, transform .18s ease;
        pointer-events: none;
        display: none;
      }
      #qc-panel.qc-show { opacity: 1; transform: scale(1); pointer-events: auto; }
      #qc-panel .qc-head {
        padding: 10px 12px;
        font-weight: 700; color: #f5c542;
        border-bottom: 1px solid #2a3550;
        display: flex; justify-content: space-between; align-items: center;
      }
      #qc-panel .qc-head .qc-page { font-weight: 400; font-size: 11px; color: #8ea0c0; }
      #qc-panel .qc-status {
        padding: 8px 12px; font-size: 11px; color: #9fb0d0;
        border-bottom: 1px solid #2a3550; min-height: 30px;
      }
      #qc-panel .qc-body { padding: 10px 12px; display: grid; gap: 8px; }
      #qc-panel button {
        width: 100%; padding: 8px 10px;
        border: none; border-radius: 6px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        color: #141c2e;
      }
      #qc-panel .qc-pass   { background: #34a853; color: #fff; }
      #qc-panel .qc-fail   { background: #d93025; color: #fff; }
      #qc-panel .qc-reject { background: #b06020; color: #fff; }
      #qc-panel .qc-nav     { background: #2a3550; color: #e6ebf5; }
      #qc-panel button:hover { filter: brightness(1.1); }
      #qc-panel .qc-kbd { opacity: .6; font-weight: 400; margin-left: 6px; }
      #qc-toast {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        background: #141c2e; color: #e6ebf5;
        padding: 10px 18px; border-radius: 8px;
        border: 1px solid #2a3550; box-shadow: 0 6px 20px rgba(0,0,0,.5);
        font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
        z-index: 2147483000; opacity: 0; transition: opacity .2s;
        pointer-events: none;
      }
    `;
    document.documentElement.appendChild(style);

    const ball = document.createElement("div");
    ball.id = "qc-ball";
    ball.textContent = "质";
    ball.title = "质检助手\n左键点开/收起";

    const panel = document.createElement("div");
    panel.id = "qc-panel";
    panel.innerHTML = `
      <div class="qc-head">质检助手 <span class="qc-page" id="qc-page-tag"></span></div>
      <div class="qc-status" id="qc-status">—</div>
      <div class="qc-body">
        <button class="qc-pass" data-act="pass">✓ 通过并提交<span class="qc-kbd">1</span></button>
        <button class="qc-fail" data-act="fail">✕ 不通过并提交<span class="qc-kbd">2</span></button>
        <button class="qc-reject" data-act="reject">↩ 打标驳回<span class="qc-kbd">3</span></button>
        <button class="qc-nav" data-act="goto-submit">↓ 跳到提交区</button>
        <button class="qc-nav" data-act="goto-video">↑ 回到视频</button>
      </div>
    `;

    const mountRoot = document.body || document.documentElement;
    mountRoot.appendChild(ball);
    mountRoot.appendChild(panel);

    const statusEl = $("#qc-status", panel);
    const tagEl = $("#qc-page-tag", panel);
    function refreshTag() {
      const t = location.pathname;
      if (/\/review\/mine/.test(t)) tagEl.textContent = "列表";
      else if (/\/review\/my-tasks\/\d+/.test(t)) tagEl.textContent = "任务详情";
      else if (/\/review\/tasks\/\d+/.test(t)) tagEl.textContent = "质检详情";
      else tagEl.textContent = "";
    }

    function positionPanel() {
      const r = ball.getBoundingClientRect();
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let left = r.left - pw - 10;
      if (left < 8) left = r.right + 10;
      let top = r.top + r.height / 2 - ph / 2;
      if (top < 8) top = 8;
      if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }

    let open = false;
    function toggle() {
      open = !open;
      if (open) {
        panel.style.display = "block";
        positionPanel();
        requestAnimationFrame(() => panel.classList.add("qc-show"));
        ball.classList.add("qc-open");
      } else {
        panel.classList.remove("qc-show");
        ball.classList.remove("qc-open");
        setTimeout(() => { if (!open) panel.style.display = "none"; }, 180);
      }
    }

    ball.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });

    document.addEventListener("click", (e) => {
      if (open && !panel.contains(e.target) && e.target !== ball) toggle();
    });

    // 拖拽
    let dragging = false, sx = 0, sy = 0, bx = 0, by = 0;
    ball.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = false;
      sx = e.clientX; sy = e.clientY;
      const r = ball.getBoundingClientRect();
      bx = r.left; by = r.top;
      e.preventDefault();
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging = true;
        if (!dragging) return;
        ball.style.right = "auto";
        ball.style.transform = "none";
        ball.style.left = (bx + dx) + "px";
        ball.style.top = (by + dy) + "px";
        if (open) positionPanel();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        ball.classList.remove("qc-dragging");
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    // 按钮绑定
    panel.querySelectorAll("button[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "pass") doPass();
        else if (act === "fail") doFail();
        else if (act === "reject") doReject();
        else if (act === "goto-submit") gotoSubmit();
        else if (act === "goto-video") gotoVideo();
      });
    });

    // 键盘 1/2/3（有操作层时优先交给层）；0 = 弹出诊断面板
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (qcLayer) { qcLayer.handleKey(e); return; }
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "1") doPass();
      else if (e.key === "2") doFail();
      else if (e.key === "3") doReject();
      else if (e.key === "0") showDiagPanel();
    });

    refreshTag();
    setStatus(isDetailPage() ? "就绪：按1/2/3或点按钮" : "此页无需操作");
  }

  // 等页面稳定后启动
  setTimeout(init, 1200);
  setTimeout(() => { if (!document.getElementById("qc-ball") && QC_PAGE === "detail") init(); }, 4000);
})();
