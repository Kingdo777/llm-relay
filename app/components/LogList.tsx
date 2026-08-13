"use client";
import { useEffect, useState, useCallback } from "react";
import type { LogRow, LlmRow } from "@/lib/types";
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

  // 详情
  const [detail, setDetail] = useState<LogRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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
      if (data.ok) setDetail(data.data);
      else show(data.error || "加载失败", "error");
    } catch (e) {
      show(`加载失败：${(e as Error).message}`, "error");
    } finally {
      setDetailLoading(false);
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

      {(detail || detailLoading) && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>请求详情 #{detail?.id}</h2>
              <button className="btn btn-sm" onClick={() => setDetail(null)}>
                ✕
              </button>
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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
