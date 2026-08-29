"use client";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { LlmRow, LlmInput, ProtocolSupportResult } from "@/lib/types";
import { LlmForm } from "./LlmForm";
import { CopyButton } from "./CopyButton";
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

export function LlmList() {
  const { show } = useToast();
  const [list, setList] = useState<LlmRow[] | null>(null);
  const [editing, setEditing] = useState<LlmRow | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [provisioningCodeAgent, setProvisioningCodeAgent] = useState(false);

  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());
  const [testResults, setTestResults] = useState<Record<number, ProtocolSupportResult>>({});
  const [expandedFailure, setExpandedFailure] = useState<Record<number, Set<ProtocolKey>>>({});
  const [pendingDelete, setPendingDelete] = useState<LlmRow | null>(null);
  const [transferring, setTransferring] = useState<"import" | "export" | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  async function load(quiet = false) {
    try {
      const resp = await fetch("/api/llms");
      const data = await resp.json();
      if (data.ok) setList(data.data);
      else if (!quiet) show(data.error || "加载失败", "error");
    } catch (e) {
      if (!quiet) show(`加载失败：${(e as Error).message}`, "error");
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

  async function provisionCodeAgent() {
    setProvisioningCodeAgent(true);
    try {
      const resp = await fetch("/api/llms/code-agent", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        show(data.error || "CodeAgent 配置同步失败", "error");
        return;
      }
      show(
        `CodeAgent 配置同步完成：新增 ${data.data?.created ?? 0} 个，更新 ${data.data?.updated ?? 0} 个`,
        "success"
      );
      await load();
    } catch (error) {
      show(`CodeAgent 配置同步失败：${(error as Error).message}`, "error");
    } finally {
      setProvisioningCodeAgent(false);
    }
  }

  async function exportConfig() {
    setTransferring("export");
    try {
      const resp = await fetch("/api/llms/import-export");
      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || "导出失败");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `llm-relay-config-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      show(`已导出 ${list?.length ?? 0} 个 LLM 配置`, "success");
    } catch (error) {
      show(`导出失败：${(error as Error).message}`, "error");
    } finally {
      setTransferring(null);
    }
  }

  async function importConfig(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      show("导入文件不能超过 2 MB", "error");
      return;
    }

    setTransferring("import");
    try {
      const resp = await fetch("/api/llms/import-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await file.text(),
      });
      const responseText = await resp.text();
      if (!responseText.trim()) {
        await load(true);
        return;
      }

      let data: {
        ok?: boolean;
        error?: string;
        data?: { created: number; skipped: number };
      };
      try {
        data = JSON.parse(responseText) as typeof data;
      } catch {
        throw new Error(`导入接口返回无效或不完整的 JSON（HTTP ${resp.status}）`);
      }
      if (!resp.ok || !data.ok) throw new Error(data.error || "导入失败");
      if (!data.data) throw new Error("导入接口响应缺少 data 字段");
      show(
        `导入完成：新增 ${data.data.created} 个，跳过 ${data.data.skipped} 个重复配置`,
        "success"
      );
      await load();
    } catch (error) {
      show(`导入失败：${(error as Error).message}`, "error");
    } finally {
      setTransferring(null);
    }
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
      setTestResults((prev) => ({ ...prev, [l.id]: result }));
      setExpandedFailure((prev) => ({ ...prev, [l.id]: new Set() }));
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

  function isSupportedFromDb(l: LlmRow, key: ProtocolKey): boolean | null {
    if (key === "openai") return l.openai_supported === 1 ? true : l.openai_supported === 0 ? false : null;
    if (key === "openaiResponses") return l.openai_responses_supported === 1 ? true : l.openai_responses_supported === 0 ? false : null;
    return l.anthropic_supported === 1 ? true : l.anthropic_supported === 0 ? false : null;
  }

  function getProtocolState(
    l: LlmRow,
    key: ProtocolKey
  ):
    | { label: string; cls: "supported" | "unsupported" | "unknown"; success: boolean | null; detail: string | null }
  {
    const result = testResults[l.id]?.[key];
    if (result) {
      return {
        label: result.success ? "支持" : "不支持",
        cls: result.success ? "supported" : "unsupported",
        success: result.success,
        detail: result.success ? null : (result.detail || result.message || "无详细信息"),
      };
    }
    const support = isSupportedFromDb(l, key);
    return {
      label: support === null ? "未测试" : support ? "支持" : "不支持",
      cls: support === null ? "unknown" : support ? "supported" : "unsupported",
      success: support,
      detail: support === false
        ? "当前兼容性结果为“不支持”，请先点击“测试兼容性”获取最新失败原因。"
        : null,
    };
  }

  function toggleFailureReason(id: number, key: ProtocolKey) {
    setExpandedFailure((prev) => {
      const current = new Set(prev[id] ?? []);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      return { ...prev, [id]: current };
    });
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
        app_id: l.app_id,
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
            {relayBase ? (
              <>
                客户端 base 填 <b>{relayBase}</b>，model 填对应 LLM
                的别名，token 随意。
              </>
            ) : (
              "正在加载客户端地址…"
            )}
          </div>
          <div className="sub import-export-warning">
            导出文件包含上游 Token，请妥善保管
          </div>
        </div>
        <div className="page-head-actions">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={importConfig}
          />
          <button
            className="btn"
            onClick={() => importInputRef.current?.click()}
            disabled={transferring !== null}
          >
            {transferring === "import" ? "导入中…" : "导入配置"}
          </button>
          <button
            className="btn"
            onClick={exportConfig}
            disabled={transferring !== null || list === null}
          >
            {transferring === "export" ? "导出中…" : "导出配置"}
          </button>
          <button
            className="btn"
            onClick={provisionCodeAgent}
            disabled={provisioningCodeAgent}
            title="请确保节点已安装并授权 CodeAgent"
          >
            {provisioningCodeAgent ? <span className="spinner" /> : null}
            {provisioningCodeAgent ? "同步中…" : "+ 添加 CodeAgent"}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            + 新增 LLM
          </button>
        </div>
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
                return (
                  <tr key={l.id}>
                    <td className="llm-name-cell">
                      <span className="llm-truncated-text" title={l.name}>
                        {l.name}
                      </span>
                    </td>
                    <td className="mono llm-alias-cell">
                      <span className="url-cell llm-alias-value">
                        <span className="url-text" title={l.alias}>
                          {l.alias}
                        </span>
                        <CopyButton value={l.alias} iconOnly />
                      </span>
                    </td>
                    <td className="mono llm-model-cell">
                      <span
                        className="llm-truncated-text"
                        title={l.model_name}
                      >
                        {l.model_name}
                      </span>
                    </td>
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
                      {(() => {
                        const protocols = ([
                          { label: "OpenAI", key: "openai" as ProtocolKey },
                          { label: "Responses", key: "openaiResponses" as ProtocolKey },
                          { label: "Anthropic", key: "anthropic" as ProtocolKey },
                        ] as const).map((protocol) => {
                          const state = getProtocolState(l, protocol.key);
                          return {
                            ...protocol,
                            labelText: `${protocol.label} · ${state.label}`,
                            cls: state.cls,
                            detail: state.detail,
                            success: state.success,
                            isOpen: expandedFailure[l.id]?.has(protocol.key) ?? false,
                            hasFailure: state.success === false && !!state.detail,
                          };
                        });
                        const activeFailures = protocols.filter((item) => item.hasFailure && item.isOpen);
                        return (
                          <>
                            <div className="protocol-supports">
                              {protocols.map((item) => (
                                <span
                                  key={`${l.id}-${item.key}`}
                                  className={`protocol-badge ${item.cls} ${item.hasFailure ? "clickable-badge" : ""}`}
                                  onClick={() => {
                                    if (item.hasFailure) toggleFailureReason(l.id, item.key);
                                  }}
                                  role={item.hasFailure ? "button" : undefined}
                                  title={
                                    item.hasFailure
                                      ? item.isOpen
                                        ? "点击收起失败原因"
                                        : "点击展开失败原因"
                                      : item.labelText
                                  }
                                  style={{ cursor: item.hasFailure ? "pointer" : "default" }}
                                >
                                  {item.labelText}
                                </span>
                              ))}
                            </div>
                            {activeFailures.length > 0 && (
                              <div className="protocol-failure-stack">
                                {activeFailures.map((item) => (
                                  <pre
                                    key={`${l.id}-${item.key}-detail`}
                                    className="protocol-failure-detail"
                                  >
                                    {`${item.labelText}\n${item.detail}`}
                                  </pre>
                                ))}
                              </div>
                            )}
                          </>
                        );
                      })()}
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
