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
  ["provider", "Provider", "\u5982 opencode-go / deepseek-official"],
  ["model", "\u6A21\u578B", "\u5982 deepseek-v4-flash / deepseek-v4-pro"]
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
function MemorySettingsCard(props) {
  const { scope } = props;
  const [snap, setSnap] = (0, import_react.useState)(() => scope.getSnapshot());
  (0, import_react.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [drafts, setDrafts] = (0, import_react.useState)({});
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [msg, setMsg] = (0, import_react.useState)("");
  const value = snap.value ?? {};
  const features = value.features ?? {};
  const refiner = value.refiner ?? {};
  const writable = snap.writable ?? false;
  const status = snap.status;
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
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { color: "#888", fontSize: 13 }, children: [
      "\u8BB0\u5FC6\u63D2\u4EF6\u8BBE\u7F6E",
      status === "loading" ? "\u52A0\u8F7D\u4E2D\u2026" : "\u4E0D\u53EF\u7528"
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "12px 0" }, children: [
    NUMBER_FIELDS.map(([field, label, hint]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label, hint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        style: inputStyle,
        type: "text",
        value: num(field),
        disabled: !writable,
        onChange: (e) => setNum(field, e.target.value)
      }
    ) }, field)),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 12, fontWeight: 600, fontSize: 13 }, children: "\u529F\u80FD\u5F00\u5173" }),
    FEATURE_FIELDS.map(([field, label, hint]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      CheckboxRow,
      {
        label,
        hint,
        checked: bool("features", field, features),
        onChange: (e) => setBool("features", field, e.target.checked)
      },
      field
    )),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 12, fontWeight: 600, fontSize: 13 }, children: "\u72EC\u7ACB\u63D0\u53D6\u6A21\u578B\uFF08refiner\uFF09" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      CheckboxRow,
      {
        label: "\u542F\u7528 LLM \u63D0\u53D6",
        hint: "\u7528\u72EC\u7ACB\u6A21\u578B\u84B8\u998F\u8BB0\u5FC6\uFF0C\u66FF\u4EE3\u539F\u59CB\u6587\u672C\u5165\u5E93",
        checked: bool("refiner", "enabled", refiner),
        onChange: (e) => setBool("refiner", "enabled", e.target.checked)
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Provider", hint: "\u5982 opencode-go / deepseek-official", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        style: inputStyle,
        type: "text",
        value: drafts["refiner.provider"] ?? refiner.provider ?? "",
        disabled: !writable,
        onChange: (e) => setText("refiner", "provider", e.target.value)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "\u6A21\u578B", hint: "\u5982 deepseek-v4-flash / deepseek-v4-pro", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        style: inputStyle,
        type: "text",
        value: drafts["refiner.model"] ?? refiner.model ?? "",
        disabled: !writable,
        onChange: (e) => setText("refiner", "model", e.target.value)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 12, display: "flex", gap: 8 }, children: [
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
  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register({
      name: "settings.plugin.item",
      id: "dsh-memory",
      order: 30,
      label: () => "\u8BB0\u5FC6\u63D2\u4EF6",
      inject: () => ({ scope })
    }, MemorySettingsCard);
  });
}

		return module.exports;
	}
});
