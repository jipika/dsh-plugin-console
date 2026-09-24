/**
 * dsh-plugin-console 本地改版离线探针（无需浏览器 / 网络 / API Key）。
 *
 * 验证目标（本次改版：把「插件管理 / 插件市场」提升为设置窗口左侧导航的独立分栏）：
 *   1. client.js 能加载，导出 apply / inject 完整；
 *   2. 原有的 settings.plugins.tab#console 仍然存在（不丢功能）；
 *   3. 新增 settings.section#plugin-console，label 可解析为字符串、order 明确；
 *   4. 分栏组件能渲染，根元素用插件自带的 pc_section 外壳（与官方设置分栏同规格）。
 */
import { readFileSync } from "node:fs";

const registrations = [];
const errors = [];
let moduleExports = null;

// ── 宿主环境替身 ────────────────────────────────────────────────────────────
const styleTags = [];
globalThis.document = {
  head: { appendChild: (el) => styleTags.push(el) },
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  querySelector: () => null,
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
// 组件挂载时会拉 /plugin 数据：给一个永不 settle 的 promise，探针只关心结构不关心数据。
globalThis.fetch = () => new Promise(() => {});
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      globalThis.__consoleModuleId = id;
      moduleExports = factory((spec) => {
        if (spec === "react") return makeReact();
        throw new Error("unexpected require: " + spec);
      });
    },
  },
};

function makeReact() {
  const hooks = new Map();
  let cursor = 0;
  const base = {
    createElement: (type, props, ...children) => ({
      __el: true,
      type,
      props: props ?? {},
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }),
    Fragment: "Fragment",
    useState: (init) => {
      const key = cursor++;
      if (!hooks.has(key)) hooks.set(key, typeof init === "function" ? init() : init);
      return [hooks.get(key), (next) => hooks.set(key, typeof next === "function" ? next(hooks.get(key)) : next)];
    },
    useRef: (init) => ({ current: init }),
    useEffect: () => {},          // 不执行副作用：避免真实网络/定时器
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => {
      try { subscribe(() => {}); } catch { /* 订阅失败不影响结构断言 */ }
      return getSnapshot();
    },
  };
  return base;
}

/** 递归展开函数组件，得到可断言的元素树。 */
function resolve(el, depth = 0) {
  if (!el || typeof el !== "object" || !el.__el || depth > 14) return el;
  const out = typeof el.type === "function" ? resolve(el.type(el.props), depth + 1) : el;
  if (Array.isArray(out.children)) out.children = out.children.map((c) => resolve(c, depth + 1)).filter(Boolean);
  return out;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

// ── 1. 加载 ─────────────────────────────────────────────────────────────────
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function(source)();

const results = [];
const check = (ok, label) => results.push({ ok, label });

check(moduleExports !== null, "client.js 可加载并调用 __ModuleLoader__.load");
check(typeof moduleExports?.apply === "function", "导出 apply 为函数");
check(Array.isArray(moduleExports?.inject) && moduleExports.inject.includes("slots"), "导出 inject 含 slots");

// ── 2. apply() → 注册面 ─────────────────────────────────────────────────────
const ctx = {
  slots: {
    inject: (_slot, run) => { try { run(); } catch (e) { errors.push("slots.inject(" + _slot + "): " + e.message); } },
    register: (options, Component) => { registrations.push({ options, Component }); return () => {}; },
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => (key === "tab" ? "插件管理" : "[" + key + "]"),
  },
  effect: (fn) => { try { return fn(); } catch (e) { errors.push("effect: " + e.message); } },
  get: () => undefined,
  inject: () => {},
};
moduleExports.apply(ctx);

const byName = (name) => registrations.filter((r) => r.options.name === name);
const tabs = byName("settings.plugins.tab");
const sections = byName("settings.section");
const labelOf = (entry) => (typeof entry.options.label === "function" ? entry.options.label() : entry.options.label);

check(tabs.length === 1, "原 tab settings.plugins.tab#console 保留（不丢功能）");
check(sections.length === 1, "新增 1 个 settings.section 分栏");
check(sections[0]?.options.id === "plugin-console", "分栏 id = plugin-console");
check(typeof sections[0]?.options.order === "number", "分栏 order = " + (sections[0]?.options.order ?? "(缺失)"));
check(
  typeof labelOf(sections[0] ?? { options: {} }) === "string" && labelOf(sections[0] ?? { options: {} }).length > 0,
  "分栏 label 解析为字符串 = " + labelOf(sections[0] ?? { options: {} }),
);
check(typeof sections[0]?.Component === "function", "分栏组件可渲染");

// ── 3. 渲染 ─────────────────────────────────────────────────────────────────
let treeSummary = null;
let renderError = null;
try {
  const entry = sections[0];
  const face = typeof entry.options.inject === "function" ? entry.options.inject() : {};
  const tree = resolve(entry.Component({ ...face, t: (key) => (key === "tab" ? "插件管理" : "[" + key + "]") }));
  const classNames = [];
  walk(tree, (n) => { if (n.props?.className) classNames.push(String(n.props.className)); });
  treeSummary = { rootClass: tree?.props?.className ?? null, nodeClassCount: classNames.length };
} catch (error) {
  renderError = error;
}

check(renderError === null, "分栏可渲染" + (renderError ? " — " + renderError.message : ""));
check(
  String(treeSummary?.rootClass ?? "").includes("pc_section"),
  "分栏根元素用自带外壳 pc_section（width:100% / max-width:760px）",
);
check(styleTags.length >= 1, "插件样式表已注入 document.head");
check(errors.length === 0, "apply() 期间无异常" + (errors.length ? " — " + errors[0] : ""));

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log("dsh-plugin-console 本地改版探针");
console.log("─".repeat(66));
registrations.forEach((r, i) => {
  console.log(`  注册#${i + 1}  ${r.options.name}#${r.options.id}  order=${r.options.order ?? "-"}  label=${labelOf(r)}`);
});
console.log("─".repeat(66));
for (const { ok, label } of results) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(66));
console.log(`结果: ${results.length - failed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
