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
  ["injectMinScore", "\u6CE8\u5165\u6700\u4F4E\u76F8\u5173\u5206", "\u4F4E\u4E8E\u8BE5\u5206\u6570\u7684\u8BB0\u5FC6\u4E0D\u6CE8\u5165"],
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
  const invalid = Object.entries(drafts).some(([k, v]) => !k.includes(".") && v !== "" && Number.isNaN(Number(v)));
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
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 16, maxWidth: 680 }, children: [
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 16, maxWidth: 680 }, children: [
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
}

		return module.exports;
	}
});
