"use client";
import { useEffect, useState } from "react";
import type {
  BaseUrlMode,
  LlmInput,
  LlmRow,
  ProtocolSupportResult,
} from "@/lib/types";
import { useToast } from "./Toast";

type ProtocolKey = "openai" | "openaiResponses" | "anthropic";

/** 挂载后才取 origin，避免 SSR/客户端 hydration 不一致 */
function useOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

interface Props {
  /** 编辑时传入现有 LLM，新增时为 null */
  llm: LlmRow | null;
  onClose: () => void;
  onSaved: () => void;
}

export function LlmForm({ llm, onClose, onSaved }: Props) {
  const isEdit = !!llm;
  const { show } = useToast();

  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [urlMode, setUrlMode] = useState<BaseUrlMode>("unified");
  const [baseUrl, setBaseUrl] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [modelName, setModelName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProtocolSupportResult | null>(null);
  const [expandedReasons, setExpandedReasons] = useState<Set<ProtocolKey>>(new Set());

  useEffect(() => {
    if (llm) {
      setName(llm.name);
      setAlias(llm.alias);
      setUrlMode(llm.url_mode);
      setBaseUrl(llm.base_url);
      setOpenaiBaseUrl(llm.openai_base_url);
      setAnthropicBaseUrl(llm.anthropic_base_url);
      setToken(llm.token);
      setModelName(llm.model_name);
      setEnabled(!!llm.enabled);
    } else {
      setName("");
      setAlias("");
      setUrlMode("unified");
      setBaseUrl("");
      setOpenaiBaseUrl("");
      setAnthropicBaseUrl("");
      setToken("");
      setModelName("");
      setEnabled(true);
    }
    setTestResult(null);
  }, [llm]);

  async function save() {
    if (!name || !alias || !token || !modelName) {
      show("name / alias / token / 模型名 均为必填", "error");
      return;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(alias)) {
      show("别名仅允许字母、数字、下划线、连字符、点", "error");
      return;
    }
    const normalizedBaseURL = baseUrl.trim();
    const normalizedOpenAIURL = openaiBaseUrl.trim();
    const normalizedAnthropicURL = anthropicBaseUrl.trim();
    if (urlMode === "unified" && !normalizedBaseURL) {
      show("合一模式下 Base URL 为必填", "error");
      return;
    }
    if (
      urlMode === "separate" &&
      (!normalizedOpenAIURL || !normalizedAnthropicURL)
    ) {
      show("分离模式下两个 Base URL 均为必填", "error");
      return;
    }

    const payload: LlmInput = {
      name,
      alias,
      token,
      model_name: modelName,
      url_mode: urlMode,
      base_url: normalizedBaseURL,
      openai_base_url: normalizedOpenAIURL,
      anthropic_base_url: normalizedAnthropicURL,
      enabled,
    };
    setSaving(true);
    try {
      const url = isEdit ? `/api/llms/${llm!.id}` : "/api/llms";
      const method = isEdit ? "PUT" : "POST";
      const resp = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        show(data.error || "保存失败", "error");
        return;
      }
      show(isEdit ? "已更新" : "已创建", "success");
      onSaved();
    } catch (e) {
      show(`保存失败：${(e as Error).message}`, "error");
    } finally {
      setSaving(false);
    }
  }

  async function testCurrent() {
    if (!isEdit) {
      show("请先保存后再测试", "info");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setExpandedReasons(new Set());
    try {
      const resp = await fetch(
        `/api/llms/${llm!.id}/test`,
        { method: "POST" }
      );
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        show(data.error || "测试失败", "error");
        return;
      }
      const result = data.data as ProtocolSupportResult;
      setTestResult(result);
      show("协议兼容性测试完成", "success");
    } catch (e) {
      show(`测试请求出错：${(e as Error).message}`, "error");
    } finally {
      setTesting(false);
    }
  }

  function toggleReason(key: ProtocolKey) {
    setExpandedReasons((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const relayBase = useOrigin();

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{isEdit ? "编辑 LLM" : "新增 LLM"}</h2>
          <button className="btn btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="drawer-body">
          <div className="field">
            <label>名称 *</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 我的GPT、Claude测试"
            />
            <div className="hint">仅用于展示</div>
          </div>

          <div className="field">
            <label>别名（对外模型名）*</label>
            <input
              className="input"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="如 gpt4、sonnet"
            />
            <div className="hint">
              客户端把 <b>model</b> 填成这个值来选中本 LLM
            </div>
          </div>

          <div className="field">
            <label>真实模型名 *</label>
            <input
              className="input"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="如 gpt-4o、claude-3-5-sonnet-20241022"
            />
            <div className="hint">
              后端真实模型名。客户端传的 model(别名) 会被覆盖为此值
            </div>
          </div>

          <div className="field">
            <label>Token *</label>
            <input
              className="input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="API Key"
            />
            <div className="hint">中转时由本站注入鉴权头，客户端忽略 token</div>
          </div>

          <div
            style={{
              borderTop: `1px solid var(--border)`,
              margin: "18px 0 14px",
              paddingTop: 14,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              后端 Base URL
            </div>
            <div className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              供应商为两套协议提供同一入口时选“合一”；协议入口不同（如 DeepSeek）时选“分离”。
            </div>
          </div>

          <div className="field">
            <label>URL 配置模式</label>
            <div className="segmented url-mode-selector" aria-label="Base URL 配置模式">
              <button
                type="button"
                className={urlMode === "unified" ? "active" : ""}
                onClick={() => {
                  setUrlMode("unified");
                  if (!baseUrl) setBaseUrl(openaiBaseUrl || anthropicBaseUrl);
                }}
              >
                合一
              </button>
              <button
                type="button"
                className={urlMode === "separate" ? "active" : ""}
                onClick={() => {
                  setUrlMode("separate");
                  if (!openaiBaseUrl) setOpenaiBaseUrl(baseUrl);
                  if (!anthropicBaseUrl) setAnthropicBaseUrl(baseUrl);
                }}
              >
                分离
              </button>
            </div>
          </div>

          {urlMode === "unified" ? (
            <div className="field">
              <label>统一 Base URL *</label>
              <input
                className="input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="如 https://api.example.com 或 https://api.example.com/v1"
              />
              <div className="hint">
                OpenAI Chat、Responses 与 Anthropic 都从该地址拼接各自端点。
              </div>
            </div>
          ) : (
            <div className="split-url-fields">
              <div className="field">
                <label>OpenAI Base URL *</label>
                <input
                  className="input"
                  value={openaiBaseUrl}
                  onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                  placeholder="如 https://api.deepseek.com"
                />
                <div className="hint">
                  用于 /v1/chat/completions 与 /v1/responses。
                </div>
              </div>
              <div className="field">
                <label>Anthropic Base URL *</label>
                <input
                  className="input"
                  value={anthropicBaseUrl}
                  onChange={(e) => setAnthropicBaseUrl(e.target.value)}
                  placeholder="如 https://api.deepseek.com/anthropic"
                />
                <div className="hint">用于 /v1/messages。</div>
              </div>
            </div>
          )}

          <div className="field">
            <label>启用</label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>

          {/* 对外中转地址说明 */}
          <div
            className="detail-row"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 12,
              margin: "16px 0",
            }}
          >
            <div className="label" style={{ margin: 0 }}>
              对外中转地址（固定）
            </div>
            {relayBase ? (
              <>
                <div className="value mono" style={{ marginTop: 6 }}>
                  {relayBase}/v1/chat/completions
                  <br />
                  {relayBase}/v1/responses
                  <br />
                  {relayBase}/v1/messages
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  客户端 base 填 <b>{relayBase}</b>，model 填本 LLM
                  的别名
                  <b>{alias ? `「${alias}」` : "「别名」"}</b>，token 随意。
                </div>
              </>
            ) : (
              <div className="hint" style={{ marginTop: 6 }}>
                正在加载地址…
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={() => testCurrent()}
              disabled={testing || !isEdit}
            >
              {testing ? <span className="spinner" /> : null}
              {testing ? "正在测试三种协议…" : "🧪 测试兼容性"}
            </button>
            {((urlMode === "unified" && !baseUrl.trim()) ||
              (urlMode === "separate" &&
                (!openaiBaseUrl.trim() || !anthropicBaseUrl.trim()))) && (
              <span className="muted" style={{ fontSize: 12 }}>
                请先补全当前模式下的 Base URL
              </span>
            )}
          </div>

          {testResult && (
            <div className="protocol-test-row">
              {([
                { key: "openai", label: "OpenAI" },
                { key: "openaiResponses", label: "Responses" },
                { key: "anthropic", label: "Anthropic" },
              ] as const).map(({ key, label }) => (
                <div
                  key={key}
                  className={`test-result ${testResult[key].success ? "ok" : "fail"}`}
                  role={!testResult[key].success ? "button" : undefined}
                  onClick={() => {
                    if (!testResult[key].success) toggleReason(key);
                  }}
                  style={{ cursor: testResult[key].success ? "default" : "pointer" }}
                  title={
                    testResult[key].success
                      ? `${label} 支持`
                      : `${testResult[key].success ? "收起" : "点击查看失败原因"}${expandedReasons.has(key) ? "（再次点击收回）" : ""}`
                  }
                >
                  <div className="title">
                    {label} · {" "}
                    {testResult[key].success ? "✓ 支持" : "✗ 不支持"}
                  </div>
                  {!testResult[key].success && expandedReasons.has(key) && (
                    <pre>{testResult[key].detail || testResult[key].message}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
