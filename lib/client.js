window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var name = "dsh-memory-client";
var inject = ["slots", "settingsScope", "connection", "remote"];
var NUMBER_FIELDS = [
  ["injectMaxTokens", "\u6CE8\u5165\u6700\u5927 token/\u6B21", "\u6BCF\u6B21\u81EA\u52A8\u6CE8\u5165\u7684 token \u9884\u7B97"],
  ["stepInterval", "\u6B65\u8DDD\u8282\u6D41", "\u6BCF N \u6B65\u505A\u4E00\u6B21\u5168\u91CF\u68C0\u7D22"],
  ["injectMinScore", "\u6CE8\u5165\u6700\u4F4E\u76F8\u5173\u5206", "RRF \u878D\u5408\u91CF\u7EB2\uFF08\u4E09\u8DEF\u5168\u4E2D ~0.049\uFF09\uFF1B\u9ED8\u8BA4 0.015 \u2248 \u81F3\u5C11\u4E00\u8DEF\u6392\u524D 13\uFF0C\u4F4E\u4E8E\u8BE5\u5206\u6570\u7684\u8BB0\u5FC6\u4E0D\u6CE8\u5165"],
  ["maxVersionsPerMemory", "\u7248\u672C\u4E0A\u9650\uFF08\u4E16\u754C\u7EBF\u957F\u5EA6\uFF09", "\u6BCF\u6761\u8BB0\u5FC6\u6700\u591A\u4FDD\u7559\u7684\u7248\u672C\u6570"]
];
var FEATURE_FIELDS = [
  ["autoWrite", "\u81EA\u52A8\u5199\u5165", "turn/end \u81EA\u52A8\u6C89\u6DC0\u8BB0\u5FC6"],
  ["valueGate", "\u4EF7\u503C\u95E8", "\u8FC7\u6EE4\u4F4E\u4EF7\u503C\u566A\u97F3"],
  ["dedupMerge", "\u53BB\u91CD\u5408\u5E76", "\u76F8\u4F3C\u8BB0\u5FC6\u66F4\u65B0\u800C\u975E\u65B0\u5EFA"],
  ["preStepInject", "\u81EA\u52A8\u6CE8\u5165", "pre-step \u6BCF\u6B65\u81EA\u52A8\u6CE8\u5165\u76F8\u5173\u8BB0\u5FC6"],
  ["manageTools", "\u7BA1\u7406\u5DE5\u5177\u96C6", "\u66B4\u9732 memory_* \u5DE5\u5177\u7ED9\u6A21\u578B"],
  ["time", "\u65F6\u95F4\u7EF4\u5EA6", "\u66F4\u65B0\u8FFD\u52A0\u7248\u672C\uFF08\u4E16\u754C\u7EBF\uFF09\uFF0C\u5173\u95ED\u5219\u76F4\u63A5\u8986\u76D6"],
  ["graph", "\u56FE\u8C31\u6784\u5EFA", "\u5B9E\u4F53\u8282\u70B9 + \u5171\u73B0\u8FB9"]
];
var REFINER_FIELDS = [
  ["enabled", "\u542F\u7528 LLM \u63D0\u53D6", "\u7528\u72EC\u7ACB\u6A21\u578B\u84B8\u998F\u8BB0\u5FC6\uFF0C\u66FF\u4EE3\u539F\u59CB\u6587\u672C\u5165\u5E93"],
  ["provider", "\u4F9B\u5E94\u5546 Provider", "\u5DF2\u914D\u7F6E\u7684 provider \u8DEF\u7531\uFF08\u4E0B\u62C9\u9884\u8BBE\uFF1B\u81EA\u5EFA\u7AEF\u70B9\u53EF\u9009\u81EA\u5B9A\u4E49\uFF09"],
  ["model", "\u6A21\u578B", "\u9009\u5B9A\u4F9B\u5E94\u5546\u7684\u6A21\u578B\u76EE\u5F55\uFF08\u4E0B\u62C9\u9884\u8BBE\uFF1B\u53EF\u81EA\u5B9A\u4E49 id\uFF09"],
  ["apiKeyEnv", "\u72EC\u7ACB\u5BC6\u94A5\u69FD\u5F15\u7528", "\u4EC5\u5F53\u9009\u4E2D\u4F9B\u5E94\u5546\u672A\u58F0\u660E apiKeyEnv \u65F6\u751F\u6548\uFF08\u81EA\u5EFA\u4F9B\u5E94\u5546\u573A\u666F\uFF09\uFF0C\u9ED8\u8BA4 MEMORY_REFINER_API_KEY"]
];
var EMBEDDING_FIELDS = [
  ["provider", "\u5D4C\u5165\u4F9B\u5E94\u5546", "rule\uFF08\u79BB\u7EBF\u54C8\u5E0C\u515C\u5E95\uFF0C256 \u7EF4\uFF09| remote\uFF08OpenAI \u517C\u5BB9 API\uFF0C\u8D28\u91CF\u6700\u9AD8\uFF09| onnx\uFF08\u9884\u7559\uFF09"],
  ["model", "\u5D4C\u5165\u6A21\u578B", "remote \u6A21\u578B\u540D\uFF0C\u5982 Qwen/Qwen3-VL-Embedding-8B\uFF084096 \u7EF4\uFF09"],
  ["baseUrl", "API \u7AEF\u70B9", "OpenAI \u517C\u5BB9 /v1/embeddings \u7AEF\u70B9\uFF0C\u9ED8\u8BA4\u7845\u57FA\u6D41\u52A8"],
  ["apiKeyEnv", "\u5BC6\u94A5\u5F15\u7528\u540D", "\u51ED\u636E\u6587\u4EF6\u952E\u540D\uFF0C\u9ED8\u8BA4 MEMORY_EMBEDDING_API_KEY"],
  ["cacheSize", "\u5D4C\u5165\u7F13\u5B58\u6761\u6570", "embed \u7ED3\u679C LRU \u7F13\u5B58\uFF0864~8192\uFF0C\u9ED8\u8BA4 1024\uFF09"]
];
var RERANKER_FIELDS = [
  ["provider", "\u91CD\u6392\u4F9B\u5E94\u5546", "remote\uFF08/v1/rerank\uFF09| onnx\uFF08\u9884\u7559\uFF09"],
  ["model", "\u91CD\u6392\u6A21\u578B", "\u5982 Qwen/Qwen3-VL-Reranker-8B"],
  ["baseUrl", "API \u7AEF\u70B9", "\u7559\u7A7A = \u8DDF\u968F\u5D4C\u5165\u7AEF\u70B9"],
  ["apiKeyEnv", "\u5BC6\u94A5\u5F15\u7528\u540D", "\u51ED\u636E\u6587\u4EF6\u952E\u540D\uFF0C\u9ED8\u8BA4 MEMORY_RERANK_API_KEY"],
  ["topK", "\u7CBE\u6392\u5019\u9009\u6570", "RRF \u878D\u5408\u540E\u53D6\u524D N \u6761\u91CD\u6392\uFF085~50\uFF0C\u9ED8\u8BA4 20\uFF09"],
  ["minCandidates", "\u6700\u5C11\u5019\u9009", "\u5019\u9009\u4E0D\u8DB3\u4E0D\u89E6\u53D1\u91CD\u6392\uFF082~20\uFF0C\u9ED8\u8BA4 3\uFF09"],
  ["rrfWeight", "RRF \u6743\u91CD", "\u878D\u5408\u5206 = w\xD7RRF + (1-w)\xD7\u91CD\u6392\u5206\uFF080~1\uFF0C\u9ED8\u8BA4 0.7\uFF09"]
];
var GRAPH_VIEW_FIELDS = [
  ["spring", "\u5F39\u7C27\u5F3A\u5EA6", "\u8FDE\u7EBF\u7275\u5F15\u529B\uFF080.02~0.5\uFF0C\u9ED8\u8BA4 0.13\uFF1B\u8D8A\u5927\u56E2\u8D8A\u7D27\uFF09"],
  ["repulsion", "\u65A5\u529B\u500D\u7387", "\u8282\u70B9\u95F4\u65A5\u529B\uFF080.2~2\uFF0C\u9ED8\u8BA4 1\uFF1B\u8D8A\u5927\u8D8A\u677E\u6563\uFF09"],
  ["damping", "\u901F\u5EA6\u963B\u5C3C", "\u8FD0\u52A8\u8870\u51CF\uFF080.05~0.9\uFF0C\u9ED8\u8BA4 0.3\uFF1B\u8D8A\u5927\u8D8A\u7A33\u4F46\u66F4\u6162\u6536\u655B\uFF09"],
  ["gravity", "\u4E2D\u5FC3\u5F15\u529B", "\u5B64\u7ACB\u8282\u70B9\u56DE\u4E2D\u5FC3\u62C9\u529B\uFF080~0.05\uFF0C\u9ED8\u8BA4 0.005\uFF09"]
];
var HOUSEKEEPING_FIELDS = [
  ["interval", "\u5DE1\u68C0\u95F4\u9694\uFF08\u6C89\u6DC0\u6761\u6570\uFF09", "\u6BCF\u6C89\u6DC0 N \u6761\u8BB0\u5FC6\u81EA\u52A8\u5DE1\u68C0\u4E00\u6B21\uFF085~500\uFF0C\u9ED8\u8BA4 20\uFF09"],
  ["maxIntervalHours", "\u65F6\u95F4\u515C\u5E95\uFF08\u5C0F\u65F6\uFF09", "\u8DDD\u4E0A\u6B21\u5DE1\u68C0\u8D85 N \u5C0F\u65F6\u4E5F\u89E6\u53D1\uFF081~720\uFF0C\u9ED8\u8BA4 24\uFF09"],
  ["dedupThreshold", "\u8FD1\u91CD\u590D\u9608\u503C", "\u4F59\u5F26\u76F8\u4F3C\u5EA6 \u2265 \u6B64\u503C\u5224\u4E3A\u8FD1\u91CD\u590D\uFF080.8~0.99\uFF0C\u9ED8\u8BA4 0.92\uFF09"],
  ["agingDays", "\u8001\u5316\u62A5\u544A\u5929\u6570", "\u95F2\u7F6E\u8D85 N \u5929\u7684\u4F4E\u4EF7\u503C\u8BB0\u5FC6\u8FDB\u62A5\u544A\uFF087~365\uFF0C\u9ED8\u8BA4 30\uFF09"]
];
var NUMERIC_SUB = /* @__PURE__ */ new Set(["cacheSize", "topK", "minCandidates", "rrfWeight", "spring", "repulsion", "damping", "gravity", "interval", "maxIntervalHours", "dedupThreshold", "agingDays"]);
function Field({ label, hint, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "block", margin: "8px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 500, fontSize: 13 }, children: label }),
    hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "block", color: "#888", fontSize: 12 }, children: hint }) : null,
    children
  ] });
}
var inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 4,
  padding: "4px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #444",
  background: "#1e1e1e",
  color: "#eee"
};
function CheckboxRow({ label, hint, checked, onChange }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8, margin: "6px 0", fontSize: 13, cursor: "pointer" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked, onChange }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: label }),
    hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#888", fontSize: 12 }, children: [
      "\u2014 ",
      hint
    ] }) : null
  ] });
}
function KeyInput({ api, ref, hint }) {
  const [state, setState] = (0, import_react.useState)({ checking: false, configured: false, writing: false });
  const [draft, setDraft] = (0, import_react.useState)("");
  const check = async () => {
    setState((s) => ({ ...s, checking: true }));
    try {
      const r = await api.credentials.describe({ refs: [ref] });
      setState((s) => ({
        ...s,
        configured: Boolean(r?.result?.ok && r.result.value?.credentials?.[ref]?.configured),
        checking: false
      }));
    } catch {
      setState((s) => ({ ...s, checking: false }));
    }
  };
  (0, import_react.useEffect)(() => {
    void check();
  }, [ref]);
  const save = async () => {
    if (!draft) return;
    setState((s) => ({ ...s, writing: true }));
    try {
      await api.credentials.set({ ref, value: draft });
      setDraft("");
      await check();
    } catch (err) {
      console.warn("[dsh-memory-client] \u5BC6\u94A5\u4FDD\u5B58\u5931\u8D25: " + err.message);
    } finally {
      setState((s) => ({ ...s, writing: false }));
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8, padding: 10, border: "1px solid #3a3a3a", borderRadius: 8, background: "#1a1a1a" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 500 }, children: "API \u5BC6\u94A5" }),
      state.checking ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#888", fontSize: 12 }, children: "\u68C0\u67E5\u4E2D\u2026" }) : state.configured ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#4caf50", fontSize: 12 }, children: [
        "\u25CF \u5DF2\u914D\u7F6E\uFF08",
        ref,
        "\uFF09"
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#e67e22", fontSize: 12 }, children: [
        "\u25CB \u672A\u914D\u7F6E\uFF08",
        ref,
        "\uFF09"
      ] })
    ] }),
    hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { color: "#888", fontSize: 12, margin: "6px 0" }, children: hint }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: { ...inputStyle, marginTop: 0, flex: 1 },
          type: "password",
          placeholder: `\u7C98\u8D34\u5BC6\u94A5\u5230 ${ref}\uFF08\u7559\u7A7A\u4E0D\u6539\uFF09`,
          value: draft,
          onChange: (e) => setDraft(e.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          onClick: save,
          disabled: !draft || state.writing,
          style: { padding: "4px 14px", borderRadius: 6, border: "1px solid #555", background: "#2a2a2a", color: "#eee", cursor: draft ? "pointer" : "default" },
          children: state.writing ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u5BC6\u94A5"
        }
      )
    ] })
  ] });
}
function MemorySettingsSection({ scope, api, llmScope }) {
  const [snap, setSnap] = (0, import_react.useState)(() => scope.getSnapshot());
  (0, import_react.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [llmSnap, setLlmSnap] = (0, import_react.useState)(() => llmScope.getSnapshot());
  (0, import_react.useEffect)(() => llmScope.subscribe(() => setLlmSnap(llmScope.getSnapshot())), [llmScope]);
  const [drafts, setDrafts] = (0, import_react.useState)({});
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [msg, setMsg] = (0, import_react.useState)("");
  const [providers, setProviders] = (0, import_react.useState)([]);
  const [modelGroups, setModelGroups] = (0, import_react.useState)([]);
  (0, import_react.useEffect)(() => {
    let alive = true;
    api.llm.providers({}).then((r) => {
      if (alive && r?.result?.ok) setProviders(r.result.value.providers ?? []);
    }).catch(() => {
    });
    api.llm.models({}).then((r) => {
      if (alive && r?.result?.ok) setModelGroups(r.result.value.groups ?? []);
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [api]);
  const [keyState, setKeyState] = (0, import_react.useState)({ ref: "", configured: false, checking: false, writing: false });
  const [keyDraft, setKeyDraft] = (0, import_react.useState)("");
  const value = snap.value ?? {};
  const features = value.features ?? {};
  const refiner = value.refiner ?? {};
  const embedding = value.embedding ?? {};
  const reranker = value.reranker ?? {};
  const graphView = value.graphView ?? {};
  const housekeeping = value.housekeeping ?? {};
  const writable = snap.writable ?? false;
  const status = snap.status;
  const providerValue = drafts["refiner.provider"] ?? refiner.provider ?? "";
  const providerIsPreset = providers.some((p) => p.provider === providerValue);
  const providerModels = modelGroups.find((g) => g.id === providerValue)?.models ?? [];
  const modelValue = drafts["refiner.model"] ?? refiner.model ?? "";
  const modelIsPreset = providerModels.some((m) => m.id === modelValue);
  const providersCfg = llmSnap?.value?.providers ?? {};
  const selectedProfile = providersCfg[providerValue] ?? {};
  const keyRef = () => {
    const declared = typeof selectedProfile?.apiKeyEnv === "string" && selectedProfile.apiKeyEnv !== "";
    const d = drafts["refiner.apiKeyEnv"];
    const fallback = (d !== void 0 && d !== "" ? d : refiner.apiKeyEnv) || "MEMORY_REFINER_API_KEY";
    return declared ? selectedProfile.apiKeyEnv : fallback;
  };
  const checkKey = async () => {
    const ref = keyRef();
    setKeyState((s) => ({ ...s, ref, checking: true }));
    try {
      const response = await api.credentials.describe({ refs: [ref] });
      const configured = Boolean(response?.result?.ok && response.result.value?.credentials?.[ref]?.configured);
      setKeyState((s) => ({ ...s, configured, checking: false }));
    } catch {
      setKeyState((s) => ({ ...s, checking: false }));
    }
  };
  (0, import_react.useEffect)(() => {
    void checkKey();
  }, [drafts["refiner.apiKeyEnv"], refiner.apiKeyEnv, providerValue, llmSnap]);
  const saveKey = async () => {
    if (!keyDraft) return;
    const ref = keyRef();
    setKeyState((s) => ({ ...s, writing: true }));
    try {
      await api.credentials.set({ ref, value: keyDraft });
      setKeyDraft("");
      setMsg(`\u2705 \u5BC6\u94A5\u5DF2\u4FDD\u5B58\u5230\u51ED\u636E\u6587\u4EF6\uFF08${ref}\uFF0C\u4E0D\u56DE\u663E\u4E0D\u843D settings\uFF09`);
      await checkKey();
    } catch (err) {
      setMsg(`\u274C \u5BC6\u94A5\u4FDD\u5B58\u5931\u8D25: ${err.message}`);
    } finally {
      setKeyState((s) => ({ ...s, writing: false }));
    }
  };
  const num = (field) => {
    const raw = drafts[field];
    if (raw !== void 0) return raw;
    return value[field] !== void 0 ? String(value[field]) : "";
  };
  const bool = (group, field, base) => {
    const key = `${group}.${field}`;
    if (drafts[key] !== void 0) return drafts[key];
    return base[field] ?? false;
  };
  const setNum = (field, text) => setDrafts((d) => ({ ...d, [field]: text }));
  const setBool = (group, field, v) => setDrafts((d) => ({ ...d, [`${group}.${field}`]: v }));
  const setText = (group, field, text) => setDrafts((d) => ({ ...d, [`${group}.${field}`]: text }));
  const dirty = Object.keys(drafts).length > 0;
  const invalid = Object.entries(drafts).some(([k, v]) => {
    if (v === "") return false;
    const field = k.includes(".") ? k.split(".")[1] : k;
    const isNumeric = !k.includes(".") || NUMERIC_SUB.has(field);
    return isNumeric && Number.isNaN(Number(v));
  });
  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      for (const [field] of NUMBER_FIELDS) {
        const raw = drafts[field];
        if (raw === void 0) continue;
        if (raw === "") await scope.unset(field);
        else await scope.set(field, Number(raw));
      }
      const featKeys = FEATURE_FIELDS.map(([f]) => f);
      if (featKeys.some((f) => drafts[`features.${f}`] !== void 0)) {
        const next = { ...features };
        for (const [f] of FEATURE_FIELDS) {
          const v = drafts[`features.${f}`];
          if (v !== void 0) next[f] = v;
        }
        await scope.set("features", next);
      }
      {
      }
      const refKeys = REFINER_FIELDS.map(([f]) => f);
      if (refKeys.some((f) => drafts[`refiner.${f}`] !== void 0)) {
        const next = { ...refiner };
        for (const [f] of REFINER_FIELDS) {
          const v = drafts[`refiner.${f}`];
          if (v !== void 0) {
            next[f] = f === "enabled" ? v : String(v);
          }
        }
        await scope.set("refiner", next);
      }
      {
      }
      const embKeys = EMBEDDING_FIELDS.map(([f]) => f);
      if (embKeys.some((f) => drafts[`embedding.${f}`] !== void 0)) {
        const next = { ...embedding };
        for (const [f] of EMBEDDING_FIELDS) {
          const v = drafts[`embedding.${f}`];
          if (v !== void 0) next[f] = NUMERIC_SUB.has(f) ? Number(v) : String(v);
        }
        await scope.set("embedding", next);
      }
      {
      }
      const rkKeys = RERANKER_FIELDS.map(([f]) => f);
      if (rkKeys.some((f) => drafts[`reranker.${f}`] !== void 0)) {
        const next = { ...reranker };
        for (const [f] of RERANKER_FIELDS) {
          const v = drafts[`reranker.${f}`];
          if (v !== void 0) next[f] = NUMERIC_SUB.has(f) ? Number(v) : String(v);
        }
        await scope.set("reranker", next);
      }
      {
      }
      const gvKeys = GRAPH_VIEW_FIELDS.map(([f]) => f);
      if (gvKeys.some((f) => drafts[`graphView.${f}`] !== void 0)) {
        const next = { ...graphView };
        for (const [f] of GRAPH_VIEW_FIELDS) {
          const v = drafts[`graphView.${f}`];
          if (v !== void 0) next[f] = Number(v);
        }
        await scope.set("graphView", next);
      }
      {
      }
      const hkKeys = HOUSEKEEPING_FIELDS.map(([f]) => f);
      if (hkKeys.some((f) => drafts[`housekeeping.${f}`] !== void 0) || drafts["housekeeping.enabled"] !== void 0) {
        const next = { ...housekeeping };
        for (const [f] of HOUSEKEEPING_FIELDS) {
          const v = drafts[`housekeeping.${f}`];
          if (v !== void 0) next[f] = Number(v);
        }
        if (drafts["housekeeping.enabled"] !== void 0) next.enabled = drafts["housekeeping.enabled"];
        await scope.set("housekeeping", next);
      }
      setDrafts({});
      setMsg("\u2705 \u5DF2\u4FDD\u5B58\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548");
    } catch (err) {
      setMsg(`\u274C \u4FDD\u5B58\u5931\u8D25: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };
  const reset = () => {
    setDrafts({});
    setMsg("");
  };
  if (status !== "ready") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 16, maxWidth: 680, overflowY: "auto", maxHeight: "calc(100vh - 24px)", boxSizing: "border-box" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { margin: "0 0 8px", fontSize: 16 }, children: "\u8BB0\u5FC6" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { color: "#888", fontSize: 13 }, children: [
        "\u8BB0\u5FC6\u63D2\u4EF6\u8BBE\u7F6E",
        status === "loading" ? "\u52A0\u8F7D\u4E2D\u2026" : "\u4E0D\u53EF\u7528\uFF08host \u672A\u6CE8\u518C memory \u547D\u540D\u7A7A\u95F4\uFF09"
      ] })
    ] });
  }
  const blockStyle = {
    marginTop: 16,
    padding: 14,
    border: "1px solid #3a3a3a",
    borderRadius: 10,
    background: "#1a1a1a"
  };
  const blockTitle = { margin: "0 0 4px", fontWeight: 600, fontSize: 14 };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 16, maxWidth: 680, overflowY: "auto", maxHeight: "calc(100vh - 24px)", boxSizing: "border-box" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { margin: "0 0 4px", fontSize: 16 }, children: "\u8BB0\u5FC6" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { margin: "0 0 8px", color: "#888", fontSize: 13 }, children: "dsh-memory \u81EA\u52A8\u8BB0\u5FC6\u63D2\u4EF6\u2014\u2014\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF08live\uFF09\uFF0C\u5199\u5165 settings.yaml \u7684 memory \u6BB5\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: blockStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: blockTitle, children: "\u68C0\u7D22\u4E0E\u6CE8\u5165" }),
      NUMBER_FIELDS.map(([field, label, hint]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: inputStyle,
          type: "text",
          value: num(field),
          disabled: !writable,
          onChange: (e) => setNum(field, e.target.value)
        }
      ) }, field))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: blockStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: blockTitle, children: "\u529F\u80FD\u5F00\u5173" }),
      FEATURE_FIELDS.map(([field, label, hint]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        CheckboxRow,
        {
          label,
          hint,
          checked: bool("features", field, features),
          onChange: (e) => setBool("features", field, e.target.checked)
        },
        field
      ))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: blockStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: blockTitle, children: "\u72EC\u7ACB\u63D0\u53D6\u6A21\u578B\uFF08refiner\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        CheckboxRow,
        {
          label: "\u542F\u7528 LLM \u63D0\u53D6",
          hint: "\u7528\u72EC\u7ACB\u6A21\u578B\u84B8\u998F\u8BB0\u5FC6\uFF0C\u66FF\u4EE3\u539F\u59CB\u6587\u672C\u5165\u5E93",
          checked: bool("refiner", "enabled", refiner),
          onChange: (e) => setBool("refiner", "enabled", e.target.checked)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Field, { label: "\u4F9B\u5E94\u5546 Provider", hint: "\u4ECE\u5DF2\u914D\u7F6E\u7684\u4F9B\u5E94\u5546\u9884\u8BBE\u4E2D\u9009\u62E9\uFF08\u81EA\u5EFA\u7AEF\u70B9\u9009\u81EA\u5B9A\u4E49\uFF09", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            style: inputStyle,
            value: providerIsPreset ? providerValue : "__custom__",
            disabled: !writable,
            onChange: (e) => setText("refiner", "provider", e.target.value === "__custom__" ? "" : e.target.value),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u2014 \u672A\u9009\u62E9 \u2014" }),
              providers.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: p.provider, children: [
                p.displayName || p.provider,
                "\uFF08",
                p.provider,
                "\uFF09",
                p.active ? "" : " \xB7 \u672A\u542F\u7528"
              ] }, p.provider)),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "__custom__", children: "\u81EA\u5B9A\u4E49\u2026" })
            ]
          }
        ),
        !providerIsPreset && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            style: { ...inputStyle, marginTop: 6 },
            type: "text",
            placeholder: "\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546\u8DEF\u7531\u540D",
            value: providerValue,
            disabled: !writable,
            onChange: (e) => setText("refiner", "provider", e.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        Field,
        {
          label: "\u6A21\u578B",
          hint: providerModels.length > 0 ? `"${providerValue}" \u7684\u6A21\u578B\u76EE\u5F55\uFF08${providerModels.length} \u4E2A\uFF09` : '\u9009\u62E9\u4F9B\u5E94\u5546\u540E\u663E\u793A\u5176\u6A21\u578B\u76EE\u5F55\uFF08\u81EA\u5B9A\u4E49\u6A21\u578B id \u53EF\u9009"\u81EA\u5B9A\u4E49"\uFF09',
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                style: inputStyle,
                value: modelIsPreset ? modelValue : "__custom__",
                disabled: !writable,
                onChange: (e) => setText("refiner", "model", e.target.value === "__custom__" ? "" : e.target.value),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u2014 \u672A\u9009\u62E9 \u2014" }),
                  providerModels.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: m.id, children: m.name && m.name !== m.id ? `${m.name}\uFF08${m.id}\uFF09` : m.id }, m.id)),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "__custom__", children: "\u81EA\u5B9A\u4E49\u2026" })
                ]
              }
            ),
            !modelIsPreset && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                style: { ...inputStyle, marginTop: 6 },
                type: "text",
                placeholder: "\u81EA\u5B9A\u4E49\u6A21\u578B id",
                value: modelValue,
                disabled: !writable,
                onChange: (e) => setText("refiner", "model", e.target.value)
              }
            )
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "\u5BC6\u94A5\u5F15\u7528\u540D\uFF08apiKeyEnv\uFF09", hint: "\u51ED\u636E\u6587\u4EF6\u952E\u540D\uFF0C\u81EA\u5EFA\u4F9B\u5E94\u5546\u65F6\u4E0E\u6A21\u578B\u8BBE\u7F6E\u7684 apiKeyEnv \u4E00\u81F4", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: inputStyle,
          type: "text",
          value: drafts["refiner.apiKeyEnv"] ?? refiner.apiKeyEnv ?? "MEMORY_REFINER_API_KEY",
          disabled: !writable,
          onChange: (e) => setText("refiner", "apiKeyEnv", e.target.value)
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8, padding: 10, border: "1px solid #3a3a3a", borderRadius: 8, background: "#1a1a1a" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 500 }, children: "API \u5BC6\u94A5" }),
          keyState.checking ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#888", fontSize: 12 }, children: "\u68C0\u67E5\u4E2D\u2026" }) : keyState.configured ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#4caf50", fontSize: 12 }, children: [
            "\u25CF \u5DF2\u914D\u7F6E\uFF08",
            keyState.ref,
            "\uFF09"
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#e67e22", fontSize: 12 }, children: [
            "\u25CB \u672A\u914D\u7F6E\uFF08",
            keyState.ref,
            "\uFF09"
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { color: "#888", fontSize: 12, margin: "6px 0" }, children: [
          selectedProfile?.apiKeyEnv ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            "\u5BC6\u94A5\u5F15\u7528",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u81EA\u52A8\u8DDF\u968F\u4F9B\u5E94\u5546" }),
            "\uFF1A",
            providerValue,
            " \u2192 ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: selectedProfile.apiKeyEnv }),
            "\uFF08host \u8C03\u7528\u65F6\u6309\u6B64\u5F15\u7528\u89E3\u6790\uFF09"
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            "\u8BE5\u4F9B\u5E94\u5546\u672A\u58F0\u660E\u5BC6\u94A5\u5F15\u7528\uFF0C\u4F7F\u7528\u72EC\u7ACB\u5BC6\u94A5\u69FD ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: keyRef() }),
            "\uFF08\u81EA\u5EFA\u7AEF\u70B9\u573A\u666F\uFF09"
          ] }),
          " ",
          "\u5BC6\u94A5\u4EC5\u5199\u5165 ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "~/.dsh/.credentials.yaml" }),
          "\uFF08\u79C1\u6709\u6587\u4EF6\uFF09\uFF0C\u4E0D\u8FDB\u5165\u8BBE\u7F6E\u6587\u6863\u3001\u4E0D\u8FDB\u5165\u8BB0\u5FC6\u5E93\u3001\u4E0D\u5728\u754C\u9762\u56DE\u663E\u3002"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              style: { ...inputStyle, marginTop: 0, flex: 1 },
              type: "password",
              placeholder: `\u7C98\u8D34\u5BC6\u94A5\u5230 ${keyRef()}\uFF08\u7559\u7A7A\u4E0D\u6539\uFF09`,
              value: keyDraft,
              onChange: (e) => setKeyDraft(e.target.value)
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              onClick: saveKey,
              disabled: !keyDraft || keyState.writing,
              style: { padding: "4px 14px", borderRadius: 6, border: "1px solid #555", background: "#2a2a2a", color: "#eee", cursor: keyDraft ? "pointer" : "default" },
              children: keyState.writing ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u5BC6\u94A5"
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { color: "#777", fontSize: 12, margin: "6px 0 0" }, children: [
          "\u6362\u4F9B\u5E94\u5546\u540E\u6B64\u5904\u81EA\u52A8\u5207\u6362\u5230\u65B0\u4F9B\u5E94\u5546\u7684\u5BC6\u94A5\u5F15\u7528\uFF08\u5DF2\u914D\u7F6E\u5219\u663E\u793A \u25CF\uFF09\uFF1B\u81EA\u5EFA\u72EC\u7ACB\u4F9B\u5E94\u5546\uFF1A\u5728\u300C\u8BBE\u7F6E \u2192 \u6A21\u578B\u300D\u6DFB\u52A0 provider\uFF08npm: ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "@ai-sdk/openai-compatible" }),
          "\uFF09\uFF0CapiKeyEnv \u586B ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "MEMORY_REFINER_API_KEY" }),
          "\uFF0CbaseURL \u586B\u4F60\u7684\u7AEF\u70B9\u3002"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: blockStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: blockTitle, children: "\u5D4C\u5165\u4E0E\u91CD\u6392\u6A21\u578B" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { margin: "0 0 4px", color: "#888", fontSize: 12 }, children: "\u5D4C\u5165\u51B3\u5B9A\u5411\u91CF\u8DEF\u8D28\u91CF\uFF08remote \u5931\u8D25\u81EA\u52A8\u964D\u7EA7 rule \u54C8\u5E0C\uFF0C\u6C38\u4E45\u515C\u5E95\uFF09\uFF1B\u91CD\u6392\u5BF9 RRF \u5019\u9009\u7CBE\u6392\uFF08\u5931\u8D25\u964D\u7EA7 RRF \u987A\u5E8F\uFF0C\u96F6\u635F\u5931\uFF09\u3002\u6539\u52A8 live \u751F\u6548\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 500, fontSize: 13, marginTop: 10 }, children: "\u5D4C\u5165\uFF08embedding\uFF09" }),
      EMBEDDING_FIELDS.map(
        ([field, label, hint]) => field === "provider" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            style: inputStyle,
            value: drafts["embedding.provider"] ?? embedding.provider ?? "remote",
            disabled: !writable,
            onChange: (e) => setText("embedding", "provider", e.target.value),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "remote", children: "remote\uFF08OpenAI \u517C\u5BB9 API\uFF0C\u63A8\u8350\uFF09" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "rule", children: "rule\uFF08\u79BB\u7EBF\u54C8\u5E0C\u515C\u5E95\uFF0C256 \u7EF4\uFF09" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "onnx", children: "onnx\uFF08\u672C\u5730\u63A8\u7406\uFF0C\u9884\u7559\uFF09" })
            ]
          }
        ) }, field) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            style: inputStyle,
            type: "text",
            value: drafts[`embedding.${field}`] ?? embedding[field] ?? "",
            disabled: !writable,
            onChange: (e) => setText("embedding", field, e.target.value)
          }
        ) }, field)
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        KeyInput,
        {
          api,
          ref: drafts["embedding.apiKeyEnv"] ?? embedding.apiKeyEnv ?? "MEMORY_EMBEDDING_API_KEY",
          hint: "\u7845\u57FA\u6D41\u52A8\u63A7\u5236\u53F0\u521B\u5EFA\u5BC6\u94A5\uFF1B\u5199\u5165 ~/.dsh/.credentials.yaml\uFF08\u79C1\u6709\u6587\u4EF6\uFF09\uFF0C\u4E0D\u8FDB\u8BBE\u7F6E/\u8BB0\u5FC6\u5E93\u3001\u754C\u9762\u4E0D\u56DE\u663E\u3002"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 500, fontSize: 13, marginTop: 14 }, children: "\u91CD\u6392\uFF08reranker\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        CheckboxRow,
        {
          label: "\u542F\u7528\u91CD\u6392",
          hint: "RRF \u878D\u5408\u540E\u5BF9\u5019\u9009\u7CBE\u6392\uFF08\u9700\u5DF2\u914D\u7F6E\u91CD\u6392\u5BC6\u94A5\uFF09",
          checked: bool("reranker", "enabled", reranker),
          onChange: (e) => setBool("reranker", "enabled", e.target.checked)
        }
      ),
      RERANKER_FIELDS.filter(([f]) => f !== "enabled").map(
        ([field, label, hint]) => field === "provider" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            style: inputStyle,
            value: drafts["reranker.provider"] ?? reranker.provider ?? "remote",
            disabled: !writable,
            onChange: (e) => setText("reranker", "provider", e.target.value),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "remote", children: "remote\uFF08/v1/rerank\uFF09" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "onnx", children: "onnx\uFF08\u672C\u5730\uFF0C\u9884\u7559\uFF09" })
            ]
          }
        ) }, field) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            style: inputStyle,
            type: "text",
            value: drafts[`reranker.${field}`] ?? reranker[field] ?? "",
            disabled: !writable,
            onChange: (e) => setText("reranker", field, e.target.value)
          }
        ) }, field)
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        KeyInput,
        {
          api,
          ref: drafts["reranker.apiKeyEnv"] ?? reranker.apiKeyEnv ?? "MEMORY_RERANK_API_KEY",
          hint: "\u4E0E\u5D4C\u5165\u53EF\u5171\u7528\u540C\u4E00\u5BC6\u94A5\uFF1B\u5199\u5165\u51ED\u636E\u6587\u4EF6\uFF0C\u4E0D\u8FDB\u8BBE\u7F6E/\u8BB0\u5FC6\u5E93\u3001\u754C\u9762\u4E0D\u56DE\u663E\u3002"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: blockStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: blockTitle, children: "\u8BB0\u5FC6\u56FE\u8C31\uFF08\u529B\u5BFC\u5411\u624B\u611F\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { margin: "0 0 4px", color: "#888", fontSize: 12 }, children: "\u6253\u5F00\u300C\u8BB0\u5FC6\u56FE\u8C31\u300D\u9762\u677F\u65F6\u8BFB\u53D6\uFF1B\u6539\u52A8\u540E\u91CD\u5F00\u9762\u677F\u751F\u6548\u3002" }),
      GRAPH_VIEW_FIELDS.map(([field, label, hint]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: inputStyle,
          type: "text",
          value: drafts[`graphView.${field}`] ?? graphView[field] ?? "",
          disabled: !writable,
          onChange: (e) => setText("graphView", field, e.target.value)
        }
      ) }, field))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: blockStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: blockTitle, children: "\u8BB0\u5FC6\u7BA1\u5BB6\uFF08\u81EA\u52A8\u5DE1\u68C0\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { margin: "0 0 4px", color: "#888", fontSize: 12 }, children: "\u81EA\u52A8\u68C0\u67E5\u8FD1\u91CD\u590D\u4E0E\u8001\u5316\u8BB0\u5FC6\uFF08\u53EA\u62A5\u544A\u4E0D\u5220\u6570\u636E\uFF0C\u53EF\u8C03 memory_housekeeping \u5904\u7406\uFF09\u3002\u89E6\u53D1\u4E0E\u5BF9\u8BDD\u8F6E\u6570\u89E3\u8026\uFF1A\u6BCF\u6C89\u6DC0 N \u6761\u8BB0\u5FC6 \u6216 \u8DDD\u4E0A\u6B21\u5DE1\u68C0\u8D85 N \u5C0F\u65F6\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        CheckboxRow,
        {
          label: "\u542F\u7528\u81EA\u52A8\u5DE1\u68C0",
          hint: "\u6C89\u6DC0\u8BB0\u5FC6\u65F6\u4F4E\u9891\u68C0\u67E5\uFF08\u53D1\u73B0\u5019\u9009\u5199\u65E5\u5FD7\u63D0\u793A\uFF09",
          checked: bool("housekeeping", "enabled", housekeeping),
          onChange: (e) => setBool("housekeeping", "enabled", e.target.checked)
        }
      ),
      HOUSEKEEPING_FIELDS.map(([field, label, hint]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: inputStyle,
          type: "text",
          value: drafts[`housekeeping.${field}`] ?? housekeeping[field] ?? "",
          disabled: !writable,
          onChange: (e) => setText("housekeeping", field, e.target.value)
        }
      ) }, field))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 16, display: "flex", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          onClick: save,
          disabled: !dirty || invalid || saving || !writable,
          style: { padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "#2a2a2a", color: "#eee", cursor: dirty ? "pointer" : "default" },
          children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          onClick: reset,
          disabled: !dirty,
          style: { padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: dirty ? "pointer" : "default" },
          children: "\u91CD\u7F6E"
        }
      )
    ] }),
    invalid ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { color: "#e67e22", fontSize: 12, margin: "6px 0 0" }, children: "\u26A0 \u6570\u503C\u5B57\u6BB5\u5FC5\u987B\u586B\u6570\u5B57" }) : null,
    msg ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { fontSize: 12, margin: "6px 0 0" }, children: msg }) : null
  ] });
}
var THEME_COLORS = [
  "#5b9bd5",
  "#70ad47",
  "#ffc000",
  "#e07b39",
  "#9e6fc2",
  "#d65c5c",
  "#4db6ac",
  "#a1887f",
  "#7986cb",
  "#f06292",
  "#26a69a",
  "#8d6e63"
];
function ageShade(hex, createdAt, minCreatedAt, now = Date.now()) {
  const span = Math.max(1, now - (minCreatedAt ?? now));
  const ratio = 1 - Math.max(0, Math.min(1, (now - (createdAt ?? now)) / span)) * 0.55;
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const r = Math.round((n >> 16 & 255) * ratio);
  const g = Math.round((n >> 8 & 255) * ratio);
  const b = Math.round((n & 255) * ratio);
  return `rgb(${r},${g},${b})`;
}
var AGE_WINDOWS = [
  ["all", "\u5168\u90E8"],
  ["7d", "\u8FD1 7 \u5929"],
  ["30d", "\u8FD1 30 \u5929"],
  ["90d", "\u8FD1 90 \u5929"],
  ["old", "90 \u5929\u4EE5\u4E0A"]
];
function agoText(ts, now = Date.now()) {
  const d = Math.max(0, Math.floor((now - ts) / (24 * 3600 * 1e3)));
  if (d <= 0) return "\u4ECA\u5929";
  if (d < 30) return `${d} \u5929\u524D`;
  if (d < 365) return `${Math.floor(d / 30)} \u4E2A\u6708\u524D`;
  return `${Math.floor(d / 365)} \u5E74\u524D`;
}
function layoutNodes(data, W, H) {
  const cx = W / 2, cy = H / 2;
  const themes = data.themes.length > 0 ? data.themes : ["(\u672A\u5F52\u7C7B)"];
  const groups = /* @__PURE__ */ new Map();
  for (const n of data.nodes) {
    const t = n.theme || "(\u672A\u5F52\u7C7B)";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(n);
  }
  const positions = /* @__PURE__ */ new Map();
  let idx = 0;
  for (const [theme, members] of groups) {
    const ti = themes.indexOf(theme);
    const base = ti >= 0 ? ti / themes.length * 2 * Math.PI : idx / groups.size * 2 * Math.PI;
    const spread = 2 * Math.PI / themes.length * 0.88;
    const R = 200;
    members.forEach((n, i) => {
      const ang = members.length === 1 ? base : base - spread / 2 + spread * i / (members.length - 1);
      const r = R + i % 4 * 24;
      positions.set(n.id, [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
    });
    idx++;
  }
  return { positions, groups };
}
var ObsidianGraph = (0, import_react.memo)(function ObsidianGraph2({ data, onSelect, selectedRef, drawRef, physics }) {
  const canvasRef = (0, import_react.useRef)(null);
  const hoverRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const P = physics ?? { spring: 0.13, repulsion: 1, damping: 0.3, gravity: 5e-3 };
    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width) * dpr;
      canvas.height = Math.max(1, rect.height) * dpr;
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const W = () => canvas.width / dpr, H = () => canvas.height / dpr;
    const colorOf = (theme) => {
      const i = data.themes.indexOf(theme);
      return i >= 0 ? THEME_COLORS[i % THEME_COLORS.length] : "#888";
    };
    const degree = /* @__PURE__ */ new Map();
    for (const e of data.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const init = layoutNodes(data, W(), H());
    const now = Date.now();
    const minCreated = Math.min(...data.nodes.map((n) => n.createdAt ?? now), now);
    const nodes = data.nodes.map((n) => {
      const p = init.positions.get(n.id) ?? [W() / 2 + (Math.random() - 0.5) * 60, H() / 2 + (Math.random() - 0.5) * 60];
      return { ...n, x: p[0], y: p[1], vx: 0, vy: 0, degree: degree.get(n.id) ?? 0, color: ageShade(colorOf(n.theme), n.createdAt, minCreated, now) };
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const edges = data.edges.map((e) => ({ ...e, a: nodeById.get(e.from), b: nodeById.get(e.to) })).filter((e) => e.a && e.b);
    const neighbors = /* @__PURE__ */ new Map();
    for (const e of edges) {
      if (!neighbors.has(e.a.id)) neighbors.set(e.a.id, /* @__PURE__ */ new Set());
      neighbors.get(e.a.id).add(e.b.id);
      if (!neighbors.has(e.b.id)) neighbors.set(e.b.id, /* @__PURE__ */ new Set());
      neighbors.get(e.b.id).add(e.a.id);
    }
    let alpha = 0.7, raf = 0;
    const k = Math.sqrt(W() * H() / Math.max(nodes.length, 1));
    const maxDeg = Math.max(...nodes.map((n) => n.degree), 1);
    let dragNode = null;
    const transform = { x: 0, y: 0, k: 1 };
    const heat = (a) => {
      alpha = Math.max(alpha, a);
    };
    const step = () => {
      alpha += (0 - alpha) * 0.028;
      if (dragNode) alpha = Math.max(alpha, 0.15);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-6) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          if (d >= 2.2 * k) continue;
          const dd = Math.max(d, 22);
          const f = Math.min(k * k / dd, k * 0.6) * alpha * P.repulsion * (dragNode ? 0.45 : 1);
          a.vx += dx / d * f;
          a.vy += dy / d * f;
          b.vx -= dx / d * f;
          b.vy -= dy / d * f;
        }
      }
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const degFactor = 1 + 0.5 * Math.sqrt((e.a.degree + e.b.degree) / 2 / maxDeg);
        const target = k * 1.15 * degFactor;
        const f = (d - target) * P.spring * alpha;
        e.a.vx += dx / d * f;
        e.a.vy += dy / d * f;
        e.b.vx -= dx / d * f;
        e.b.vy -= dy / d * f;
      }
      const damp = dragNode ? 0.11 : P.damping;
      for (const n of nodes) {
        if (n === dragNode) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx += (W() / 2 - n.x) * P.gravity * alpha;
        n.vy += (H() / 2 - n.y) * P.gravity * alpha;
        n.vx *= damp;
        n.vy *= damp;
        n.x += n.vx * 1.5;
        n.y += n.vy * 1.5;
      }
    };
    let fitted = false;
    const fitToView = () => {
      if (nodes.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      const pad = 70;
      const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
      const kFit = Math.min((W() - pad * 2) / bw, (H() - pad * 2) / bh, 1.5);
      transform.k = Math.max(0.28, kFit);
      transform.x = (W() - bw * transform.k) / 2 - minX * transform.k;
      transform.y = (H() - bh * transform.k) / 2 - minY * transform.k;
      fitted = true;
    };
    const draw = () => {
      ctx.clearRect(0, 0, W(), H());
      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      const grid = 44;
      const gx0 = Math.floor(-transform.x / transform.k / grid) * grid;
      const gy0 = Math.floor(-transform.y / transform.k / grid) * grid;
      const gx1 = gx0 + W() / transform.k + grid;
      const gy1 = gy0 + H() / transform.k + grid;
      for (let wx = gx0; wx <= gx1; wx += grid) {
        for (let wy = gy0; wy <= gy1; wy += grid) {
          ctx.fillRect(wx, wy, 1.4, 1.4);
        }
      }
      const selId = selectedRef.current;
      const hovId = hoverRef.current;
      const focusId = selId || hovId;
      for (const e of edges) {
        const on = !focusId || e.a.id === focusId || e.b.id === focusId;
        ctx.globalAlpha = focusId ? on ? 0.9 : 0.1 : 0.45;
        ctx.strokeStyle = e.type === "similarTo" ? "#5b9bd5" : "#e07b39";
        ctx.lineWidth = (e.type === "similarTo" ? 0.7 : 1.3) / transform.k;
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      }
      for (const n of nodes) {
        const isFocus = n.id === focusId;
        const isNbr = focusId && neighbors.get(focusId)?.has(n.id);
        ctx.globalAlpha = focusId ? isFocus || isNbr ? 1 : 0.2 : 1;
        ctx.beginPath();
        const r = (4 + Math.min(n.degree, 14) * 0.55) / Math.sqrt(transform.k);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();
        if (n.versions > 1) {
          const rings = Math.min(n.versions - 1, 3);
          const step2 = 3.2 / Math.sqrt(transform.k);
          for (let ri = 0; ri < rings; ri++) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + 3 + ri * step2, 0, Math.PI * 2);
            ctx.strokeStyle = "#ffd54f";
            ctx.lineWidth = 1.3 / Math.sqrt(transform.k);
            ctx.stroke();
          }
        }
        if (isFocus) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5 / transform.k;
          ctx.stroke();
          const tag = `${agoText(n.createdAt)}${(n.versions ?? 1) > 1 ? ` \xB7 \u66F4\u65B0 ${(n.versions ?? 1) - 1} \u6B21` : ""}`;
          ctx.font = 10 / transform.k + "px sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = "#ddd";
          ctx.fillText(tag, n.x, n.y - r - 10 / transform.k);
        }
        if (transform.k > 0.65 || isFocus) {
          ctx.globalAlpha = isFocus || !focusId ? 1 : 0.3;
          ctx.fillStyle = "#ccc";
          ctx.font = 10 / transform.k + "px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(n.label.slice(0, 9), n.x, n.y + r + 11 / transform.k);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    };
    drawRef.current = draw;
    const loop = () => {
      step();
      if (!fitted && !dragNode && (alpha < 0.06 || nodes.every((n) => Math.abs(n.vx) < 0.02))) fitToView();
      draw();
      if (alpha > 8e-3 || dragNode) raf = requestAnimationFrame(loop);
      else raf = 0;
    };
    raf = requestAnimationFrame(loop);
    const hitTest = (mx, my) => {
      const wx = (mx - transform.x) / transform.k, wy = (my - transform.y) / transform.k;
      let best = null, bestD = 14 * 14 / (transform.k * transform.k);
      for (const n of nodes) {
        const dx = n.x - wx, dy = n.y - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) {
          bestD = d2;
          best = n;
        }
      }
      return best;
    };
    let panStart = null, downPos = null, moved = false;
    const getPos = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    };
    const onDown = (ev) => {
      downPos = [ev.clientX, ev.clientY];
      moved = false;
      const [mx, my] = getPos(ev);
      const n = hitTest(mx, my);
      if (n) {
        dragNode = n;
        heat(0.35);
        if (!raf) raf = requestAnimationFrame(loop);
      } else panStart = { x: ev.clientX, y: ev.clientY, tx: transform.x, ty: transform.y };
    };
    const onMove = (ev) => {
      if (downPos && (Math.abs(ev.clientX - downPos[0]) > 4 || Math.abs(ev.clientY - downPos[1]) > 4)) moved = true;
      const [mx, my] = getPos(ev);
      if (dragNode) {
        dragNode.x = (mx - transform.x) / transform.k;
        dragNode.y = (my - transform.y) / transform.k;
        if (!raf) raf = requestAnimationFrame(loop);
      } else if (panStart) {
        transform.x = panStart.tx + (ev.clientX - panStart.x);
        transform.y = panStart.ty + (ev.clientY - panStart.y);
        if (!raf) {
          draw();
        }
      } else {
        const n = hitTest(mx, my);
        if ((n?.id ?? null) !== hoverRef.current) {
          hoverRef.current = n?.id ?? null;
          if (!raf) {
            raf = requestAnimationFrame(() => {
              draw();
              raf = 0;
            });
          }
        }
      }
    };
    const onUp = () => {
      dragNode = null;
      panStart = null;
      downPos = null;
    };
    const onClick = (ev) => {
      if (moved) return;
      const [mx, my] = getPos(ev);
      const n = hitTest(mx, my);
      onSelect(n ?? null);
    };
    const onWheel = (ev) => {
      ev.preventDefault();
      const [mx, my] = getPos(ev);
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nk = Math.min(4, Math.max(0.25, transform.k * factor));
      transform.x = mx - (mx - transform.x) / transform.k * nk;
      transform.y = my - (my - transform.y) / transform.k * nk;
      transform.k = nk;
      draw();
    };
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      drawRef.current = null;
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [data, onSelect, selectedRef, drawRef, physics]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("canvas", { ref: canvasRef, style: { width: "100%", height: "100%", display: "block", cursor: "grab" } });
});
var DetailPanel = (0, import_react.memo)(function DetailPanel2({ selected, data }) {
  const { colorOf, adj, nodeById } = (0, import_react.useMemo)(() => {
    const co = (theme) => {
      const i = data.themes.indexOf(theme);
      return i >= 0 ? THEME_COLORS[i % THEME_COLORS.length] : "#888";
    };
    const nodeById2 = new Map(data.nodes.map((n) => [n.id, n]));
    const a = /* @__PURE__ */ new Map();
    for (const e of data.edges) {
      if (!a.has(e.from)) a.set(e.from, []);
      a.get(e.from).push({ other: e.to, type: e.type, weight: e.weight });
      if (!a.has(e.to)) a.set(e.to, []);
      a.get(e.to).push({ other: e.from, type: e.type, weight: e.weight });
    }
    return { colorOf: co, adj: a, nodeById: nodeById2 };
  }, [data]);
  if (!selected) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { width: 280, borderLeft: "1px solid #333", padding: 14, overflowY: "auto", background: "#161616" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: { margin: "0 0 8px", color: colorOf(selected.theme) }, children: selected.theme || "(\u672A\u5F52\u7C7B)" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { fontSize: 12, color: "#888", margin: "0 0 10px" }, children: [
      selected.type,
      " \xB7 ",
      selected.layer,
      " \xB7 strength ",
      selected.strength,
      " \xB7 ",
      new Date(selected.createdAt).toLocaleString("zh-CN", { hour12: false })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { fontSize: 12, margin: "0 0 10px" }, children: [
      (selected.versions ?? 1) > 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#ffd54f" }, children: [
        "\u25C9 \u66F4\u65B0\u8FC7 ",
        (selected.versions ?? 1) - 1,
        " \u6B21\uFF08\u4E16\u754C\u7EBF\u4FDD\u7559\u6700\u8FD1 ",
        selected.versions ?? 1,
        " \u6BB5\uFF09"
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#777" }, children: "\u25CB \u672A\u66F4\u65B0\u8FC7\uFF08\u5355\u7248\u672C\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#888" }, children: [
        " \xB7 \u521B\u5EFA\u4E8E ",
        agoText(selected.createdAt)
      ] }),
      selected.updatedAt && selected.updatedAt !== selected.createdAt ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#888" }, children: [
        " \xB7 \u6700\u540E\u66F4\u65B0 ",
        agoText(selected.updatedAt)
      ] }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }, children: selected.content }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h5", { style: { margin: "14px 0 6px", fontSize: 12, color: "#aaa" }, children: "\u5173\u8054\u8BB0\u5FC6" }),
    (adj.get(selected.id) ?? []).length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { fontSize: 12, color: "#777" }, children: "\u6682\u65E0\u5173\u8054" }) : (adj.get(selected.id) ?? []).map((a, i) => {
      const other = nodeById.get(a.other);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 12, margin: "4px 0", color: "#bbb" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: a.type === "similarTo" ? "#5b9bd5" : "#e07b39" }, children: [
          "[",
          a.type,
          "]"
        ] }),
        a.type === "similarTo" ? " \u76F8\u4F3C " + a.weight.toFixed(2) + " " : " ",
        other ? other.label.slice(0, 12) : a.other
      ] }, i);
    })
  ] });
});
function MemoryGraphView({ scope }) {
  const [data, setData] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)("");
  const [selected, setSelected] = (0, import_react.useState)(null);
  const selectedRef = (0, import_react.useRef)(null);
  const drawRef = (0, import_react.useRef)(null);
  const [gv, setGv] = (0, import_react.useState)(() => {
    try {
      return scope?.getSnapshot()?.value?.graphView ?? {};
    } catch {
      return {};
    }
  });
  (0, import_react.useEffect)(() => {
    if (!scope) return;
    const sub = scope.subscribe(() => {
      try {
        setGv(scope.getSnapshot()?.value?.graphView ?? {});
      } catch {
      }
    });
    return sub;
  }, [scope]);
  const physics = (0, import_react.useMemo)(() => ({
    spring: Number(gv.spring) || 0.13,
    repulsion: Number(gv.repulsion) || 1,
    damping: Number(gv.damping) || 0.3,
    gravity: Number(gv.gravity) || 5e-3
    // || 而非 ??：Number(undefined)=NaN，NaN??x 仍是 NaN 会击穿力导向
  }), [gv.spring, gv.repulsion, gv.damping, gv.gravity]);
  const load = (0, import_react.useCallback)(() => {
    setError("");
    fetch("/dsh-memory/graph").then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(setData).catch((e) => setError(String(e?.message ?? e)));
  }, []);
  (0, import_react.useEffect)(load, [load]);
  (0, import_react.useEffect)(() => {
    selectedRef.current = selected?.id ?? null;
    drawRef.current?.();
  }, [selected]);
  const [ageWindow, setAgeWindow] = (0, import_react.useState)("all");
  const filtered = (0, import_react.useMemo)(() => {
    if (!data) return data;
    if (ageWindow === "all") return data;
    const now = Date.now();
    const cutoffOld = now - 90 * 24 * 3600 * 1e3;
    const inWindow = (ts) => {
      if (ageWindow === "old") return (ts ?? 0) < cutoffOld;
      const days = Number(ageWindow.replace("d", ""));
      return (ts ?? 0) >= now - days * 24 * 3600 * 1e3;
    };
    const ids = new Set(data.nodes.filter((n) => inWindow(n.createdAt)).map((n) => n.id));
    const nodes = data.nodes.filter((n) => ids.has(n.id));
    return {
      ...data,
      nodes,
      edges: data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      themes: [...new Set(nodes.map((n) => n.theme).filter(Boolean))]
      // 筛选后主题数口径一致
    };
  }, [data, ageWindow]);
  const updatedCount = (filtered?.nodes ?? []).filter((n) => (n.versions ?? 1) > 1).length;
  if (error) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 24 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { margin: "0 0 12px" }, children: "\u8BB0\u5FC6\u56FE\u8C31" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { color: "#e07b39" }, children: [
        "\u52A0\u8F7D\u5931\u8D25\uFF1A",
        error
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: load, style: { padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer" }, children: "\u91CD\u8BD5" })
    ] });
  }
  if (!data) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { padding: 24, color: "#888" }, children: "\u52A0\u8F7D\u8BB0\u5FC6\u56FE\u8C31\u4E2D\u2026" });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", height: "100%", minHeight: 560, gap: 0 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, minWidth: 0, position: "relative", minHeight: 560 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { position: "absolute", top: 10, left: 14, fontSize: 12, color: "#aaa", zIndex: 2, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          "\u8BB0\u5FC6 ",
          filtered.nodes.length,
          " \xB7 \u66F4\u65B0\u8FC7 ",
          updatedCount,
          " \xB7 \u4E3B\u9898 ",
          filtered.themes.length,
          " \xB7 \u5173\u7CFB ",
          filtered.edges.length
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "select",
          {
            value: ageWindow,
            onChange: (e) => setAgeWindow(e.target.value),
            style: { padding: "1px 6px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc" },
            title: "\u6309\u521B\u5EFA\u65F6\u95F4\u7B5B\u9009\u8BB0\u5FC6\uFF08\u65F6\u95F4\u7EF4\u5EA6\uFF09",
            children: AGE_WINDOWS.map(([v, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: v, children: label }, v))
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: load, style: { padding: "1px 10px", borderRadius: 5, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer", fontSize: 12 }, children: "\u5237\u65B0" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ObsidianGraph, { data: filtered, onSelect: setSelected, selectedRef, drawRef, physics }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { position: "absolute", right: 14, bottom: 10, fontSize: 11, color: "#777", zIndex: 2 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#5b9bd5" }, children: "\u2014 similarTo \u8BED\u4E49\u76F8\u4F3C" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 10, color: "#e07b39" }, children: "\u2192 before \u65F6\u95F4\u6F14\u5316" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 10, color: "#ffd54f" }, children: "\u25CE \u5916\u73AF = \u66F4\u65B0\u8FC7\uFF08\u73AF\u6570 = \u66F4\u65B0\u6B21\u6570\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 10 }, children: "\u8272\u6D45\u65B0 \xB7 \u8272\u6DF1\u65E7" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 10 }, children: "\u62D6\u8282\u70B9 \xB7 \u5E73\u79FB \xB7 \u7F29\u653E \xB7 \u70B9\u51FB\u770B\u8BE6\u60C5" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailPanel, { selected, data: filtered })
  ] });
}
function MemoryGraphLauncher({ wide, scope }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        title: "\u8BB0\u5FC6\u56FE\u8C31",
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 8px",
          borderRadius: 6,
          border: "none",
          background: open ? "rgba(91,155,213,0.18)" : "transparent",
          color: "#ccc",
          cursor: "pointer",
          fontSize: 12
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "3", cy: "3", r: "1.8", fill: "#5b9bd5" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "11", cy: "3", r: "1.8", fill: "#e07b39" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "7", cy: "11", r: "1.8", fill: "#70ad47" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("line", { x1: "3.8", y1: "4.2", x2: "9.8", y2: "4.2", stroke: "#777", strokeWidth: "0.8" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("line", { x1: "3.6", y1: "4.6", x2: "6.4", y2: "9.6", stroke: "#777", strokeWidth: "0.8" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("line", { x1: "10.4", y1: "4.6", x2: "7.6", y2: "9.6", stroke: "#777", strokeWidth: "0.8" })
          ] }),
          wide ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u8BB0\u5FC6\u56FE\u8C31" }) : null
        ]
      }
    ),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: {
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      background: "rgba(16, 16, 18, 0.72)",
      backdropFilter: "blur(22px) saturate(1.2)",
      WebkitBackdropFilter: "blur(22px) saturate(1.2)",
      display: "flex",
      flexDirection: "column"
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", alignItems: "center", padding: "44px 16px 10px", flex: "none" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 15, fontWeight: 600, color: "#ddd", letterSpacing: 0.5 }, children: "\u8BB0\u5FC6\u56FE\u8C31" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, minHeight: 0, position: "relative" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MemoryGraphView, { scope }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            onClick: () => setOpen(false),
            title: "\u5173\u95ED\u56FE\u8C31\uFF08Esc\uFF09",
            style: {
              position: "absolute",
              left: 16,
              bottom: 16,
              zIndex: 10,
              padding: "8px 22px",
              borderRadius: 10,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.22)",
              background: "rgba(255,255,255,0.08)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              color: "#eee",
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: 0.5,
              boxShadow: "0 2px 12px rgba(0,0,0,0.35)"
            },
            children: "\u9000\u51FA\u56FE\u8C31\uFF08Esc\uFF09"
          }
        )
      ] })
    ] }) : null
  ] });
}
function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: "memory" });
  const llmScope = ctx.settingsScope.bind({ namespace: "llm-pi-ai" });
  const { api } = ctx.get("connection");
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "memory",
    order: 25,
    label: () => "\u8BB0\u5FC6",
    inject: () => ({ scope, api, llmScope })
  }, MemorySettingsSection));
  try {
    ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
      name: "sidebar.footer.action",
      id: "memory-graph",
      order: 10,
      inject: () => ({ scope })
    }, MemoryGraphLauncher));
  } catch (err) {
    console.warn("[dsh-memory-client] \u4FA7\u8FB9\u680F\u56FE\u8C31\u5165\u53E3\u6CE8\u518C\u5931\u8D25: " + (err?.message ?? err));
  }
}

		return module.exports;
	}
});
