"use client";
import { useEffect, useState } from "react";
import type { LlmRow, LlmInput, ProtocolSupportResult } from "@/lib/types";
import { LlmForm } from "./LlmForm";
import { CopyButton } from "./CopyButton";
import { useToast } from "./Toast";

/** 挂载后才取 origin，避免 SSR/客户端 hydration 不一致 */
function useOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

export function LlmList() {
  const { show } = useToast();
  const [list, setList] = useState<LlmRow[] | null>(null);
  const [editing, setEditing] = useState<LlmRow | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<LlmRow | null>(null);

  async function load() {
    try {
      const resp = await fetch("/api/llms");
      const data = await resp.json();
      if (data.ok) setList(data.data);
      else show(data.error || "加载失败", "error");
    } catch (e) {
      show(`加载失败：${(e as Error).message}`, "error");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditing(null);
    setShowForm(true);
  }
  function openEdit(l: LlmRow) {
    setEditing(l);
    setShowForm(true);
  }

  async function toggle(l: LlmRow, enabled: boolean) {
    try {
      const resp = await fetch(`/api/llms/${l.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: l.name,
          alias: l.alias,
          token: l.token,
          model_name: l.model_name,
          url_mode: l.url_mode,
          base_url: l.base_url,
          openai_base_url: l.openai_base_url,
          anthropic_base_url: l.anthropic_base_url,
          enabled,
        }),
      });
      const data = await resp.json();
      if (data.ok) load();
      else show(data.error || "更新失败", "error");
    } catch (e) {
      show(`更新失败：${(e as Error).message}`, "error");
    }
  }

  async function testOne(l: LlmRow) {
    setTestingIds((current) => new Set(current).add(l.id));
    try {
      const resp = await fetch(`/api/llms/${l.id}/test`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "测试失败");
      const result = data.data as ProtocolSupportResult;
      const fmt = (r: { success: boolean }) => (r.success ? "支持" : "不支持");
      show(`「${l.name}」兼容性：OpenAI ${fmt(result.openai)}，Responses ${fmt(result.openaiResponses)}，Anthropic ${fmt(result.anthropic)}`, "success");
      await load();
    } catch (e) {
      show(`测试失败：${(e as Error).message}`, "error");
    } finally {
      setTestingIds((current) => {
        const next = new Set(current);
        next.delete(l.id);
        return next;
      });
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const l = pendingDelete;
    try {
      const resp = await fetch(`/api/llms/${l.id}`, { method: "DELETE" });
      const data = await resp.json();
      if (data.ok) {
        show("已删除", "success");
        setPendingDelete(null);
        load();
      } else show(data.error || "删除失败", "error");
    } catch (e) {
      show(`删除失败：${(e as Error).message}`, "error");
    }
  }

  /** 复制一个 LLM 的副本：内容相同，name 加(副本)，alias 自动找不冲突的后缀 */
  async function duplicate(l: LlmRow) {
    const tryCreate = async (alias: string): Promise<boolean> => {
      const payload: LlmInput = {
        name: `${l.name}（副本）`,
        alias,
        token: l.token,
        model_name: l.model_name,
        url_mode: l.url_mode,
        base_url: l.base_url,
        openai_base_url: l.openai_base_url,
        anthropic_base_url: l.anthropic_base_url,
        enabled: !!l.enabled,
      };
      try {
        const resp = await fetch("/api/llms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (resp.ok && data.ok) {
          show(`已创建副本「${data.data.name}」，别名 ${data.data.alias}`, "success");
          load();
          return true;
        }
        if (resp.status === 409) return false; // 别名冲突，换一个再试
        show(data.error || "复制失败", "error");
        return true; // 其它错误不再重试
      } catch (e) {
        show(`复制失败：${(e as Error).message}`, "error");
        return true;
      }
    };

    // 依次尝试 {alias}-copy、{alias}-copy2、{alias}-copy3 ...
    // 别名校验允许字母数字下划线连字符点，-copy 符合
    for (let i = 1; i <= 20; i++) {
      const suffix = i === 1 ? "-copy" : `-copy${i}`;
      const alias = `${l.alias}${suffix}`;
      if (await tryCreate(alias)) return;
    }
    show("别名副本冲突次数过多，请手动编辑后复制", "error");
  }

  const relayBase = useOrigin();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>LLM 管理</h1>
          <div className="sub">
            Base URL 可合一或按 OpenAI / Anthropic 分离，relay 按请求协议直连对应入口
          </div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          + 新增 LLM
        </button>
      </div>

      {/* 固定的对外中转地址 */}
      <div
        className="table-wrap"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 14,
          marginBottom: 18,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          对外中转地址（客户端用）
        </div>
        {relayBase ? (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12, minWidth: 70 }}>
                OpenAI:
              </span>
              <span className="url-cell" style={{ flex: 1 }}>
                <span
                  className="url-text"
                  title={`${relayBase}/v1/chat/completions`}
                >
                  {relayBase}/v1/chat/completions
                </span>
                <CopyButton
                  value={`${relayBase}/v1/chat/completions`}
                  iconOnly
                />
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12, minWidth: 70 }}>
                Responses:
              </span>
              <span className="url-cell" style={{ flex: 1 }}>
                <span
                  className="url-text"
                  title={`${relayBase}/v1/responses`}
                >
                  {relayBase}/v1/responses
                </span>
                <CopyButton
                  value={`${relayBase}/v1/responses`}
                  iconOnly
                />
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12, minWidth: 70 }}>
                Anthropic:
              </span>
              <span className="url-cell" style={{ flex: 1 }}>
                <span
                  className="url-text"
                  title={`${relayBase}/v1/messages`}
                >
                  {relayBase}/v1/messages
                </span>
                <CopyButton
                  value={`${relayBase}/v1/messages`}
                  iconOnly
                />
              </span>
            </div>
            <div className="hint" style={{ marginTop: 2 }}>
              客户端 base 填 <b>{relayBase}</b>，model 填对应 LLM
              的别名，token 随意。
            </div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            正在加载地址…
          </div>
        )}
      </div>

      {!list && <div className="muted">加载中…</div>}

      {list && list.length === 0 && (
        <div className="table-wrap">
          <div className="empty">
            <div className="title">还没有配置任何 LLM</div>
            <div>点击右上角「新增 LLM」开始</div>
          </div>
        </div>
      )}

      {list && list.length > 0 && (
        <div className="table-wrap llm-table-wrap">
          <table className="llm-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>别名（model）</th>
                <th>真实模型名</th>
                <th>Base URL 配置</th>
                <th>协议兼容性</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => {
                const testing = testingIds.has(l.id);
                const supportLabel = (value: 0 | 1 | null) => value === null ? "未测试" : value ? "支持" : "不支持";
                return (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="mono">
                      <span className="url-cell">
                        <span className="url-text" title={l.alias}>
                          {l.alias}
                        </span>
                        <CopyButton value={l.alias} iconOnly />
                      </span>
                    </td>
                    <td className="mono">{l.model_name}</td>
                    <td className="mono" style={{ maxWidth: 260 }}>
                      <div className="llm-url-stack">
                        {l.url_mode === "unified" ? (
                          <span className="url-cell">
                            <span className="url-text" title={l.base_url}>{l.base_url}</span>
                            <CopyButton value={l.base_url} iconOnly />
                          </span>
                        ) : (
                          <>
                            <span className="url-cell">
                              <span className="url-kind">OAI</span>
                              <span className="url-text" title={l.openai_base_url}>{l.openai_base_url}</span>
                              <CopyButton value={l.openai_base_url} iconOnly />
                            </span>
                            <span className="url-cell">
                              <span className="url-kind">ANT</span>
                              <span className="url-text" title={l.anthropic_base_url}>{l.anthropic_base_url}</span>
                              <CopyButton value={l.anthropic_base_url} iconOnly />
                            </span>
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="protocol-supports">
                        <span className={`protocol-badge ${l.openai_supported === null ? "unknown" : l.openai_supported ? "supported" : "unsupported"}`}>
                          OpenAI · {supportLabel(l.openai_supported)}
                        </span>
                        <span className={`protocol-badge ${l.openai_responses_supported === null ? "unknown" : l.openai_responses_supported ? "supported" : "unsupported"}`}>
                          Responses · {supportLabel(l.openai_responses_supported)}
                        </span>
                        <span className={`protocol-badge ${l.anthropic_supported === null ? "unknown" : l.anthropic_supported ? "supported" : "unsupported"}`}>
                          Anthropic · {supportLabel(l.anthropic_supported)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={!!l.enabled}
                          onChange={(e) => toggle(l, e.target.checked)}
                        />
                        <span className="slider" />
                      </label>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => testOne(l)}
                          disabled={testing}
                        >
                          {testing ? <span className="spinner" /> : null}
                          {testing ? "测试中…" : "测试兼容性"}
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => openEdit(l)}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => duplicate(l)}
                          title="基于此 LLM 创建一个副本"
                        >
                          复制
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setPendingDelete(l)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <LlmForm
          llm={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {pendingDelete && (
        <div className="overlay" onClick={() => setPendingDelete(null)}>
          <div
            className="drawer"
            style={{ width: 420, height: "auto", minHeight: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <h2>确认删除</h2>
              <button
                className="btn btn-sm"
                onClick={() => setPendingDelete(null)}
              >
                ✕
              </button>
            </div>
            <div className="drawer-body">
              确定删除 LLM「<b>{pendingDelete.name}</b>」（别名{" "}
              <b>{pendingDelete.alias}</b>）？
              <br />
              <span className="muted">
                相关请求日志会保留（llm_id 置空），不会被一并删除。
              </span>
            </div>
            <div className="drawer-foot">
              <button className="btn" onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button className="btn btn-danger" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
