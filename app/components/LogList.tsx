"use client";
import { useEffect, useState, useCallback } from "react";
import type { LogRow, LlmRow, ParsedLogContent } from "@/lib/types";
import { ParsedLogContentView } from "./ParsedLogContent";
import { useToast } from "./Toast";

const PAGE_SIZE = 50;

export function LogList() {
  const { show } = useToast();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [llms, setLlms] = useState<LlmRow[]>([]);

  // 筛选
  const [filterLlm, setFilterLlm] = useState<string>(""); // llm id
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 详情
  const [detail, setDetail] = useState<LogRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [parseLoading, setParseLoading] = useState(false);
  const [detailView, setDetailView] = useState<"raw" | "parsed">("raw");

  async function loadLlms() {
    const resp = await fetch("/api/llms");
    const data = await resp.json();
    if (data.ok) setLlms(data.data);
  }

  const load = useCallback(async () => {
    setRows(null);
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    if (filterLlm) params.set("llmId", filterLlm);
    if (filterStatus) params.set("status", filterStatus);
    try {
      const resp = await fetch(`/api/logs?${params}`);
      const data = await resp.json();
      if (data.ok) {
        setRows(data.data);
        setTotal(data.total);
      } else show(data.error || "加载失败", "error");
    } catch (e) {
      show(`加载失败：${(e as Error).message}`, "error");
    }
  }, [page, filterLlm, filterStatus, show]);

  useEffect(() => {
    loadLlms();
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function openDetail(id: number) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const resp = await fetch(`/api/logs/${id}`);
      const data = await resp.json();
      if (data.ok) {
        let latest = data.data as LogRow;
        try {
          const parseResp = await fetch(`/api/logs/${id}/parse`, { method: "POST" });
          const parseData = await parseResp.json();
          if (parseResp.ok && parseData.ok) latest = parseData.data;
        } catch {
          // 自动解析失败时仍展示原始日志详情。
        }
        setDetail(latest);
        setDetailView(latest.parsed_input && latest.parsed_output ? "parsed" : "raw");
      }
      else show(data.error || "加载失败", "error");
    } catch (e) {
      show(`加载失败：${(e as Error).message}`, "error");
    } finally {
      setDetailLoading(false);
    }
  }

  async function parseDetail() {
    if (!detail || parseLoading) return;
    setParseLoading(true);
    try {
      const resp = await fetch(`/api/logs/${detail.id}/parse`, { method: "POST" });
      const data = await resp.json();
      if (data.ok) {
        setDetail(data.data);
        setDetailView("parsed");
      } else show(data.error || "解析失败", "error");
    } catch (e) {
      show(`解析失败：${(e as Error).message}`, "error");
    } finally {
      setParseLoading(false);
    }
  }

  function filterParams() {
    const params = new URLSearchParams();
    if (filterLlm) params.set("llmId", filterLlm);
    if (filterStatus) params.set("status", filterStatus);
    return params;
  }

  async function deleteFilteredLogs() {
    if (deleting) return;
    setDeleting(true);
    try {
      const params = filterParams();
      const resp = await fetch(`/api/logs?${params}`, { method: "DELETE" });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "删除失败");
      setShowDeleteConfirm(false);
      setDetail(null);
      setPage(0);
      setRows([]);
      setTotal(0);
      show(`已删除 ${data.deleted} 条日志`, "success");
    } catch (e) {
      show(`删除失败：${(e as Error).message}`, "error");
    } finally {
      setDeleting(false);
    }
  }

  function fmtTime(s: string) {
    const d = new Date(s);
    return d.toLocaleString("zh-CN", { hour12: false });
  }

  function fmtDuration(ms: number) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function statusBadge(s: string) {
    if (s === "success")
      return <span className="badge badge-success">success</span>;
    if (s === "failed")
      return <span className="badge badge-failed">failed</span>;
    return <span className="badge badge-warn">{s}</span>;
  }

  function prettyJson(s: string | null) {
    if (!s) return <span className="muted">（无）</span>;
    try {
      const obj = JSON.parse(s);
      return <pre className="code-block">{JSON.stringify(obj, null, 2)}</pre>;
    } catch {
      // 非 JSON，原样显示
      return <pre className="code-block">{s}</pre>;
    }
  }

  function parsedContent(raw: string | null): ParsedLogContent | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ParsedLogContent;
    } catch {
      return null;
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>请求日志</h1>
          <div className="sub">
            每次中转请求的输入、输出、耗时与成败记录
          </div>
        </div>
      </div>

      <div className="toolbar">
        <select
          className="select"
          style={{ width: "auto" }}
          value={filterLlm}
          onChange={(e) => {
            setFilterLlm(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部 LLM</option>
          {llms.map((l) => (
            <option key={l.id} value={String(l.id)}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto" }}
          value={filterStatus}
          onChange={(e) => {
            setFilterStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部状态</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
        </select>
        <div className="spacer" />
        <button
          className="btn btn-danger"
          disabled={!rows || total === 0 || deleting}
          onClick={() => setShowDeleteConfirm(true)}
        >
          删除当前筛选日志{total > 0 ? `（${total}）` : ""}
        </button>
        <button className="btn" onClick={load}>
          ↻ 刷新
        </button>
      </div>

      {!rows && <div className="muted">加载中…</div>}

      {rows && rows.length === 0 && (
        <div className="table-wrap">
          <div className="empty">
            <div className="title">还没有日志</div>
            <div>发起一次中转请求后，会在这里看到记录</div>
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>别名</th>
                <th>协议</th>
                <th>模型</th>
                <th>端点</th>
                <th>状态</th>
                <th>流式</th>
                <th>HTTP</th>
                <th>耗时</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => openDetail(r.id)}
                >
                  <td className="mono">{fmtTime(r.created_at)}</td>
                  <td className="mono">{r.llm_alias}</td>
                  <td>
                    <span className="badge badge-muted">{r.protocol}</span>
                  </td>
                  <td className="mono">{r.model_name || "—"}</td>
                  <td className="mono">{r.endpoint || "—"}</td>
                  <td>{statusBadge(r.status)}</td>
                  <td style={{ textAlign: "center" }}>
                    {r.is_stream === 1 ? (
                      <span className="badge badge-warn">流</span>
                    ) : r.is_stream === 0 ? (
                      <span className="badge badge-muted">非流</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono">
                    {r.status_code != null ? r.status_code : "—"}
                  </td>
                  <td className="mono">{fmtDuration(r.duration_ms)}</td>
                  <td>
                    <button className="btn btn-sm">详情</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div
          className="toolbar"
          style={{ justifyContent: "center", marginTop: 16 }}
        >
          <button
            className="btn btn-sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← 上一页
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            第 {page + 1} / {totalPages} 页（共 {total} 条）
          </span>
          <button
            className="btn btn-sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页 →
          </button>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="overlay" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div
            className="drawer"
            style={{ width: 440, height: "auto", minHeight: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <h2>确认清理日志</h2>
              <button
                className="btn btn-sm"
                disabled={deleting}
                onClick={() => setShowDeleteConfirm(false)}
              >
                ✕
              </button>
            </div>
            <div className="drawer-body">
              将永久删除当前筛选条件下的 <b>{total}</b> 条日志。
              {!filterLlm && !filterStatus && (
                <div className="danger-text" style={{ marginTop: 8 }}>
                  当前没有筛选条件，这会清空全部请求日志。
                </div>
              )}
            </div>
            <div className="drawer-foot">
              <button className="btn" disabled={deleting} onClick={() => setShowDeleteConfirm(false)}>
                取消
              </button>
              <button className="btn btn-danger" disabled={deleting} onClick={deleteFilteredLogs}>
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(detail || detailLoading) && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>请求详情 #{detail?.id}</h2>
              <div className="drawer-actions">
                {detail && (
                  <button className="btn btn-sm btn-primary" disabled={parseLoading} onClick={parseDetail}>
                    {parseLoading ? "解析中…" : detail.parsed_input ? "重新解析" : "解析内容"}
                  </button>
                )}
                {detail?.parsed_input && detail.parsed_output && (
                  <div className="segmented" aria-label="详情显示方式">
                    <button className={detailView === "parsed" ? "active" : ""} onClick={() => setDetailView("parsed")}>可读内容</button>
                    <button className={detailView === "raw" ? "active" : ""} onClick={() => setDetailView("raw")}>原始数据</button>
                  </div>
                )}
                <button className="btn btn-sm" aria-label="关闭详情" onClick={() => setDetail(null)}>
                  ✕
                </button>
              </div>
            </div>
            <div className="drawer-body">
              {detailLoading && <div className="muted">加载中…</div>}
              {detail && (
                <>
                  <div className="detail-row">
                    <div className="label">基本信息</div>
                    <div className="value">
                      {statusBadge(detail.status)} ·{" "}
                      别名 <span className="mono">{detail.llm_alias}</span> ·{" "}
                      {detail.protocol} ·{" "}
                      {detail.is_stream === 1 ? "流式" : detail.is_stream === 0 ? "非流式" : "流式未知"} ·{" "}
                      HTTP {detail.status_code ?? "—"} ·{" "}
                      {fmtDuration(detail.duration_ms)} ·{" "}
                      {fmtTime(detail.created_at)}
                    </div>
                  </div>

                  {detail.status !== "success" && detail.error && (
                    <div className="detail-row">
                      <div className="label">失败原因</div>
                      <pre className="code-block" style={{ color: "#f85149" }}>
                        {detail.error}
                      </pre>
                    </div>
                  )}

                  {detail.status === "success" &&
                    detail.error &&
                    detail.error.startsWith("跨格式转换") && (
                      <div className="detail-row">
                        <div className="label">格式转换</div>
                        <div className="value">
                          <span className="badge badge-warn">
                            {detail.error}
                          </span>
                        </div>
                      </div>
                    )}

                  <div className="detail-row">
                    <div className="label">后端 baseURL</div>
                    <div className="value mono">{detail.base_url}</div>
                  </div>

                  <div className="detail-row">
                    <div className="label">端点</div>
                    <div className="value mono">{detail.endpoint}</div>
                  </div>

                  {detail.model_name && (
                    <div className="detail-row">
                      <div className="label">模型名</div>
                      <div className="value mono">{detail.model_name}</div>
                    </div>
                  )}

                  {detailView === "parsed" && detail.parsed_input && detail.parsed_output ? (
                    <>
                      <div className="detail-row">
                        <div className="label">用户输入</div>
                        <ParsedLogContentView content={parsedContent(detail.parsed_input)!} mode="input" />
                      </div>
                      <div className="detail-row">
                        <div className="label">给用户的输出</div>
                        <ParsedLogContentView content={parsedContent(detail.parsed_output)!} mode="output" />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="detail-row">
                        <div className="label">输入（Request Body）</div>
                        {prettyJson(detail.input)}
                      </div>
                      <div className="detail-row">
                        <div className="label">输出（Response）</div>
                        {prettyJson(detail.output)}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
