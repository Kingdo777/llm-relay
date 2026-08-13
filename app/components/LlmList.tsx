"use client";
import { useEffect, useState } from "react";
import type { LlmRow, LlmInput, TestResult, Protocol } from "@/lib/types";
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

  const [testStates, setTestStates] = useState<
    Record<string, { testing: boolean; result: TestResult | null }>
  >({});
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

  async function testOne(l: LlmRow, protocol: Protocol) {
    const key = `${l.id}-${protocol}`;
    setTestStates((s) => ({ ...s, [key]: { testing: true, result: null } }));
    try {
      const resp = await fetch(
        `/api/llms/${l.id}/test?protocol=${protocol}`,
        { method: "POST" }
      );
      const data = await resp.json();
      const result: TestResult = data.ok
        ? (data.data as TestResult)
        : { success: false, message: data.error || "测试失败" };
      setTestStates((s) => ({
        ...s,
        [key]: { testing: false, result },
      }));
      show(
        result.success
          ? `「${l.name}」${protocol} 测试通过`
          : `「${l.name}」${protocol} 测试失败`,
        result.success ? "success" : "error"
      );
    } catch (e) {
      setTestStates((s) => ({
        ...s,
        [key]: {
          testing: false,
          result: { success: false, message: (e as Error).message },
        },
      }));
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
            每条 LLM 通过别名（作为对外模型名）路由，分 OpenAI / Anthropic 两个 baseURL
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
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>别名（model）</th>
                <th>真实模型名</th>
                <th>OpenAI baseURL</th>
                <th>Anthropic baseURL</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => {
                const oaiState = testStates[`${l.id}-openai`];
                const antState = testStates[`${l.id}-anthropic`];
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
                    <td className="mono" style={{ maxWidth: 200 }}>
                      {l.openai_base_url ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          <div
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={l.openai_base_url}
                          >
                            {l.openai_base_url}
                          </div>
                          <div className="row-actions">
                            <button
                              className="btn btn-sm"
                              onClick={() => testOne(l, "openai")}
                              disabled={oaiState?.testing}
                            >
                              {oaiState?.testing ? (
                                <span className="spinner" />
                              ) : (
                                <span>🧪</span>
                              )}
                              <span>测</span>
                            </button>
                          </div>
                          {oaiState?.result && (
                            <div
                              className={`test-result ${
                                oaiState.result.success ? "ok" : "fail"
                              }`}
                              style={{ marginTop: 0 }}
                            >
                              <div className="title">
                                {oaiState.result.success ? "✓" : "✗"}{" "}
                                {oaiState.result.message}
                              </div>
                              {oaiState.result.detail && (
                                <pre>{oaiState.result.detail}</pre>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono" style={{ maxWidth: 200 }}>
                      {l.anthropic_base_url ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          <div
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={l.anthropic_base_url}
                          >
                            {l.anthropic_base_url}
                          </div>
                          <div className="row-actions">
                            <button
                              className="btn btn-sm"
                              onClick={() => testOne(l, "anthropic")}
                              disabled={antState?.testing}
                            >
                              {antState?.testing ? (
                                <span className="spinner" />
                              ) : (
                                <span>🧪</span>
                              )}
                              <span>测</span>
                            </button>
                          </div>
                          {antState?.result && (
                            <div
                              className={`test-result ${
                                antState.result.success ? "ok" : "fail"
                              }`}
                              style={{ marginTop: 0 }}
                            >
                              <div className="title">
                                {antState.result.success ? "✓" : "✗"}{" "}
                                {antState.result.message}
                              </div>
                              {antState.result.detail && (
                                <pre>{antState.result.detail}</pre>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
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
