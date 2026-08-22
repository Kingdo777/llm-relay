"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardStats } from "@/lib/types";
import { useToast } from "./Toast";

const REFRESH_INTERVAL_MS = 30_000;
const TREND_RANGES = [
  { minutes: 24 * 60, label: "24 小时" },
  { minutes: 12 * 60, label: "12 小时" },
  { minutes: 6 * 60, label: "6 小时" },
  { minutes: 60, label: "1 小时" },
  { minutes: 10, label: "10 分钟" },
] as const;

const BUCKET_SIZES = [
  { minutes: 1, label: "1 分钟" },
  { minutes: 10, label: "10 分钟" },
  { minutes: 30, label: "30 分钟" },
  { minutes: 60, label: "1 小时" },
] as const;

function number(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits,
  }).format(value);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function tokenWan(value: number): string {
  if (value > 0 && value < 1_000) return "<0.1万";
  return `${number(value / 10_000, 1)}万`;
}

function duration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`;
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function timeTooltipLabel(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dailyDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function dailyAxisLabel(value: string): string {
  return dailyDate(value).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

function dailyTooltipLabel(value: string): string {
  return dailyDate(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

interface LineSeries {
  label: string;
  color: string;
  values: number[];
  formatValue?: (value: number) => string;
}

function InteractiveLineChart({
  labels,
  series,
  ariaLabel,
  formatTooltipLabel,
  formatAxisLabel,
  formatYAxis = compactNumber,
  rightAxis,
}: {
  labels: string[];
  series: LineSeries[];
  ariaLabel: string;
  formatTooltipLabel: (label: string) => string;
  formatAxisLabel: (label: string) => string;
  formatYAxis?: (value: number) => string;
  rightAxis?: { multiplier: number; format: (value: number) => string; label: string };
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [chartSize, setChartSize] = useState({ width: 520, height: 260 });
  const { width, height } = chartSize;
  const left = 68;
  const right = rightAxis ? 68 : 12;
  const top = 10;
  const bottom = 30;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const max = Math.max(1, ...series.flatMap((line) => line.values));
  const rightMax = rightAxis ? max * rightAxis.multiplier : 0;
  const pointAt = (values: number[], index: number) => {
    const x = left + (index / Math.max(1, values.length - 1)) * chartWidth;
    const y = top + chartHeight - (values[index] / max) * chartHeight;
    return { x, y };
  };
  const chartTop = top;
  const chartBottom = top + chartHeight;
  const clampY = (y: number) => Math.max(chartTop, Math.min(chartBottom, y));
  const smoothPath = (values: number[]) => {
    if (values.length === 0) return "";
    if (values.length === 1) {
      const p = pointAt(values, 0);
      return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    const pts = values.map((_, i) => pointAt(values, i));
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? pts[i + 1];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  };
  const axisIndexes = Array.from(
    new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])
  ).filter((index) => labels[index]);
  const hoveredX = hoveredIndex === null
    ? null
    : left + (hoveredIndex / Math.max(1, labels.length - 1)) * chartWidth;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateSize = ({ width: nextWidth, height: nextHeight }: DOMRectReadOnly) => {
      const rounded = {
        width: Math.max(1, Math.round(nextWidth)),
        height: Math.max(1, Math.round(nextHeight)),
      };
      setChartSize((current) =>
        current.width === rounded.width && current.height === rounded.height
          ? current
          : rounded
      );
    };

    updateSize(stage.getBoundingClientRect());
    const observer = new ResizeObserver(([entry]) => updateSize(entry.contentRect));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  function updateHover(event: React.PointerEvent<SVGSVGElement>) {
    if (labels.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const viewBoxX = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = Math.max(0, Math.min(1, (viewBoxX - left) / chartWidth));
    setHoveredIndex(Math.round(ratio * (labels.length - 1)));
  }

  return (
    <div className="interactive-line-chart" role="img" aria-label={ariaLabel}>
      <div className="chart-legend">
        {series.map((line) => (
          <span key={line.label}>
            <i style={{ background: line.color }} />
            {line.label}
          </span>
        ))}
      </div>
      <div className="line-chart-stage" ref={stageRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          onPointerMove={updateHover}
          onPointerLeave={() => setHoveredIndex(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = top + ratio * chartHeight;
            const label = max * (1 - ratio);
            const rightLabel = rightAxis ? rightMax * (1 - ratio) : 0;
            return (
              <g key={ratio}>
                <line className="chart-grid-line" x1={left} x2={width - right} y1={y} y2={y} />
                <text className="chart-axis-label" x={left - 8} y={y + 4} textAnchor="end">
                  {formatYAxis(label)}
                </text>
                {rightAxis && (
                  <text className="chart-axis-label" x={width - right + 8} y={y + 4} textAnchor="start">
                    {rightAxis.format(rightLabel)}
                  </text>
                )}
              </g>
            );
          })}
          {series.map((line) => (
            <path
              key={line.label}
              d={smoothPath(line.values)}
              fill="none"
              stroke={line.color}
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hoveredIndex !== null && hoveredX !== null && (
            <g className="chart-hover-guide">
              <line x1={hoveredX} x2={hoveredX} y1={top} y2={top + chartHeight} />
              {series.map((line) => {
                const value = line.values[hoveredIndex] ?? 0;
                const y = top + chartHeight - (value / max) * chartHeight;
                return (
                  <circle
                    key={line.label}
                    cx={hoveredX}
                    cy={y}
                    r="4"
                    fill={line.color}
                    stroke="var(--bg)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>
          )}
          {axisIndexes.map((index) => {
            const x = left + (index / Math.max(1, labels.length - 1)) * chartWidth;
            return (
              <text
                key={index}
                className="chart-axis-label"
                x={x}
                y={height - 9}
                textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}
              >
                {formatAxisLabel(labels[index])}
              </text>
            );
          })}
        </svg>
        {hoveredIndex !== null && hoveredX !== null && labels[hoveredIndex] && (
          <div
            className={`chart-tooltip ${hoveredIndex > labels.length * 0.68 ? "align-right" : ""}`}
            style={{ left: `${(hoveredX / width) * 100}%` }}
          >
            <strong>{formatTooltipLabel(labels[hoveredIndex])}</strong>
            {series.map((line) => {
              const value = line.values[hoveredIndex] ?? 0;
              const totalValue = rightAxis ? value * rightAxis.multiplier : null;
              return (
                <span key={line.label}>
                  <i style={{ background: line.color }} />
                  {line.label}
                  <b>{line.formatValue ? line.formatValue(value) : number(value)}</b>
                  {totalValue !== null && (
                    <small> 总量 {rightAxis!.format(totalValue)}</small>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function StatsDashboard() {
  const { show } = useToast();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState("overview");
  const [trendRangeMinutes, setTrendRangeMinutes] = useState<number>(24 * 60);
  const [bucketMinutes, setBucketMinutes] = useState<number>(1);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch(`/api/stats?bucket=${bucketMinutes}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || "统计加载失败");
      setStats(json.data as DashboardStats);
    } catch (error) {
      show(`统计加载失败：${(error as Error).message}`, "error");
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, [show, bucketMinutes]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const modelSeriesById = useMemo(
    () => new Map((stats?.model_series ?? []).map((series) => [series.llm_id, series.points])),
    [stats]
  );
  const modelDailyTokensById = useMemo(
    () => new Map((stats?.model_daily_tokens ?? []).map((series) => [series.llm_id, series.points])),
    [stats]
  );
  const selectedModel = useMemo(
    () =>
      scope === "overview"
        ? null
        : stats?.models.find((model) => model.llm_id === Number(scope)) ?? null,
    [scope, stats]
  );
  const activeSummary = selectedModel ?? stats?.summary ?? null;
  const activeSeries = selectedModel
    ? modelSeriesById.get(selectedModel.llm_id) ?? []
    : stats?.series ?? [];
  const visibleSeries = activeSeries.slice(-trendRangeMinutes);
  const activeDailyTokens = selectedModel
    ? modelDailyTokensById.get(selectedModel.llm_id) ?? []
    : stats?.daily_tokens ?? [];
  const seriesBucketMinutes = stats?.series_bucket_minutes ?? 1;
  const perMinute = (value: number) => value / seriesBucketMinutes;

  const trendRangeLabel = TREND_RANGES.find(
    (range) => range.minutes === trendRangeMinutes
  )?.label ?? `${trendRangeMinutes} 分钟`;
  const bucketLabel = BUCKET_SIZES.find((bs) => bs.minutes === bucketMinutes)?.label ?? `${bucketMinutes} 分钟`;
  const showRightAxis = bucketMinutes > 1;

  const visibleRequests = visibleSeries.reduce((sum, point) => sum + point.requests, 0);
  const visibleTokens = visibleSeries.reduce((sum, point) => sum + point.tokens, 0);
  const fourteenDayTokens = activeDailyTokens.reduce((sum, point) => sum + point.total_tokens, 0);
  const isOverview = selectedModel === null;
  const hasMissingUsage = !!activeSummary &&
    activeSummary.successful_requests > 0 &&
    activeSummary.token_coverage < 99.5;

  useEffect(() => {
    if (
      stats &&
      scope !== "overview" &&
      !stats.models.some((model) => model.llm_id === Number(scope))
    ) {
      setScope("overview");
    }
  }, [scope, stats]);

  return (
    <>
      <div className="page-head stats-head">
        <div>
          <div className="eyebrow">OBSERVABILITY / LAST 24 HOURS</div>
          <h1>模型运行看板</h1>
          <div className="sub">吞吐、稳定性与响应速度统一观察</div>
        </div>
        <div className="stats-actions">
          {stats && (
            <span className="muted">
              更新于 {new Date(stats.generated_at).toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
          )}
          <button className="btn" onClick={() => load()} disabled={refreshing}>
            {refreshing ? <span className="spinner" /> : null}
            {refreshing ? "刷新中" : "刷新"}
          </button>
        </div>
      </div>

      {!stats && <div className="dashboard-loading">正在汇总近 24 小时数据…</div>}

      {stats && activeSummary && (
        <>
          <div className="dashboard-scope-bar">
            <label htmlFor="stats-scope">查看范围</label>
            <select
              id="stats-scope"
              className="select"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="overview">总览（全部模型）</option>
              {stats.models.map((model) => (
                <option key={model.llm_id} value={String(model.llm_id)}>
                  {model.name} · {model.alias}
                </option>
              ))}
            </select>
            <div className="scope-meta">
              {isOverview
                ? `${stats.models.length} 个模型合并统计`
                : `${selectedModel!.alias} → ${selectedModel!.model_name}`}
            </div>
          </div>
          <div className="dashboard-section-title">
            <div>
              <h2>{isOverview ? "全局总览" : selectedModel!.name}</h2>
              <p>
                {isOverview
                  ? "所有模型合并后的近 24 小时运行情况"
                  : "该模型独立的近 24 小时运行情况"}
              </p>
            </div>
          </div>
          <section className="metric-grid" aria-label="24 小时汇总指标">
            <div className="metric-card accent-card">
              <span>当前 RPM</span>
              <strong>{compactNumber(activeSummary.current_rpm)}</strong>
              <small>滚动 60 秒 · 峰值 {compactNumber(activeSummary.peak_rpm)}</small>
            </div>
            <div className="metric-card violet-card">
              <span>当前 TPM</span>
              <strong>{compactNumber(activeSummary.current_tpm)}</strong>
              <small>滚动 60 秒 · 峰值 {compactNumber(activeSummary.peak_tpm)}</small>
            </div>
            <div className="metric-card">
              <span>24h 请求</span>
              <strong>{compactNumber(activeSummary.requests)}</strong>
              <small>{number(activeSummary.average_rpm, 2)} RPM 均值</small>
            </div>
            <div className="metric-card">
              <span>成功率</span>
              <strong className={activeSummary.success_rate < 95 ? "metric-danger" : "metric-success"}>
                {number(activeSummary.success_rate, 2)}%
              </strong>
              <small>{compactNumber(activeSummary.successful_requests)} 成功 · {compactNumber(activeSummary.failed_requests)} 失败</small>
            </div>
            <div className="metric-card">
              <span>平均首字节</span>
              <strong>{duration(activeSummary.average_first_byte_ms)}</strong>
              <small>流式响应体感速度</small>
            </div>
            <div className="metric-card">
              <span>P95 完整耗时</span>
              <strong>{duration(activeSummary.p95_duration_ms)}</strong>
              <small>平均 {duration(activeSummary.average_duration_ms)}</small>
            </div>
          </section>

          {hasMissingUsage && (
            <div className="stats-notice">
              Token 覆盖率为 {number(activeSummary.token_coverage, 1)}%。部分旧日志或上游响应没有返回 usage，TPM 会低于实际值；新 OpenAI 流式请求已自动请求 usage 事件。
            </div>
          )}

          <div className="trend-range-bar">
            <div className="trend-range-copy">
              <strong>RPM / TPM 时间范围</strong>
              <span>当前 {bucketLabel} 一个数据点</span>
            </div>
            <div className="trend-controls">
              <div className="trend-control-group">
                <span className="trend-control-label">聚合粒度</span>
                <div className="segmented" aria-label="趋势图聚合粒度">
                  {BUCKET_SIZES.map((bs) => (
                    <button
                      key={bs.minutes}
                      type="button"
                      className={bucketMinutes === bs.minutes ? "active" : ""}
                      aria-pressed={bucketMinutes === bs.minutes}
                      onClick={() => setBucketMinutes(bs.minutes)}
                    >
                      {bs.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="trend-control-group">
                <span className="trend-control-label">时间范围</span>
                <div className="segmented" aria-label="趋势图时间范围">
                  {TREND_RANGES.map((range) => (
                    <button
                      key={range.minutes}
                      type="button"
                      className={trendRangeMinutes === range.minutes ? "active" : ""}
                      aria-pressed={trendRangeMinutes === range.minutes}
                      onClick={() => setTrendRangeMinutes(range.minutes)}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <section className="dashboard-chart-grid" aria-label="运行趋势图">
            <article className="chart-panel compact-chart-panel">
              <div className="panel-head">
                <div>
                  <h2>RPM / 请求趋势</h2>
                  <p>近 {trendRangeLabel} · 每 {bucketLabel}</p>
                </div>
                <div className="panel-total">
                  合计 <b>{compactNumber(visibleRequests)}</b>
                </div>
              </div>
              <InteractiveLineChart
                labels={visibleSeries.map((point) => point.bucket)}
                series={[
                  {
                    label: "成功",
                    color: "#3fb950",
                    values: visibleSeries.map((point) => perMinute(point.successful_requests)),
                    formatValue: (value) => number(value, 1),
                  },
                  {
                    label: "失败",
                    color: "#f85149",
                    values: visibleSeries.map((point) => perMinute(point.failed_requests)),
                    formatValue: (value) => number(value, 1),
                  },
                ]}
                ariaLabel={`近 ${trendRangeLabel} 每 ${bucketLabel} RPM 成功和失败折线图`}
                formatTooltipLabel={timeTooltipLabel}
                formatAxisLabel={timeLabel}
                rightAxis={showRightAxis ? { multiplier: seriesBucketMinutes, format: (v) => number(v, 0), label: "总量" } : undefined}
              />
            </article>

            <article className="chart-panel compact-chart-panel">
              <div className="panel-head">
                <div>
                  <h2>TPM / Token 吞吐</h2>
                  <p>近 {trendRangeLabel} · 每 {bucketLabel} Token</p>
                </div>
                <div className="panel-total">
                  合计 <b>{tokenWan(visibleTokens)}</b>
                </div>
              </div>
              <InteractiveLineChart
                labels={visibleSeries.map((point) => point.bucket)}
                series={[
                  {
                    label: "Token",
                    color: "#a371f7",
                    values: visibleSeries.map((point) => perMinute(point.tokens)),
                    formatValue: tokenWan,
                  },
                ]}
                ariaLabel={`近 ${trendRangeLabel} 每 ${bucketLabel} TPM 折线图`}
                formatTooltipLabel={timeTooltipLabel}
                formatAxisLabel={timeLabel}
                formatYAxis={tokenWan}
                rightAxis={showRightAxis ? { multiplier: seriesBucketMinutes, format: tokenWan, label: "总量" } : undefined}
              />
            </article>

            <article className="chart-panel compact-chart-panel">
              <div className="panel-head">
                <div>
                  <h2>每日 Token 消耗</h2>
                  <p>最近 14 个自然日</p>
                </div>
                <div className="panel-total">
                  合计 <b>{tokenWan(fourteenDayTokens)}</b>
                </div>
              </div>
              <InteractiveLineChart
                labels={activeDailyTokens.map((point) => point.date)}
                series={[
                  {
                    label: "总量",
                    color: "#58a6ff",
                    values: activeDailyTokens.map((point) => point.total_tokens),
                    formatValue: tokenWan,
                  },
                  {
                    label: "输入",
                    color: "#a371f7",
                    values: activeDailyTokens.map((point) => point.input_tokens),
                    formatValue: tokenWan,
                  },
                  {
                    label: "输出",
                    color: "#d29922",
                    values: activeDailyTokens.map((point) => point.output_tokens),
                    formatValue: tokenWan,
                  },
                ]}
                ariaLabel="最近 14 天每日 Token 消耗折线图"
                formatTooltipLabel={dailyTooltipLabel}
                formatAxisLabel={dailyAxisLabel}
                formatYAxis={tokenWan}
                rightAxis={showRightAxis ? { multiplier: seriesBucketMinutes, format: tokenWan, label: "总量" } : undefined}
              />
            </article>
          </section>

          {isOverview && (
            <section className="models-panel">
            <div className="panel-head">
              <div>
                <h2>按模型拆分</h2>
                <p>当前 = 滚动 60 秒；峰值 = 近 24 小时单个自然分钟</p>
              </div>
              <span className="model-count">{stats.models.length} 个模型</span>
            </div>
            {stats.models.length === 0 ? (
              <div className="empty">
                <div className="title">还没有模型配置</div>
                <div>先在 LLM 管理中添加模型，运行数据会出现在这里。</div>
              </div>
            ) : (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>RPM<br /><small>当前 / 峰值</small></th>
                      <th>TPM<br /><small>当前 / 峰值</small></th>
                      <th>请求<br /><small>总数 · 成功 / 失败</small></th>
                      <th>Token<br /><small>输入 / 输出</small></th>
                      <th>成功率</th>
                      <th>响应耗时<br /><small>平均 / P95</small></th>
                      <th>首字节</th>
                      <th>输出速度</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.models.map((model) => (
                      <tr key={model.llm_id}>
                        <td>
                          <div className="model-identity">
                            <strong>{model.name}</strong>
                            <span>{model.alias} → {model.model_name}</span>
                          </div>
                        </td>
                        <td className="mono stat-pair">
                          <b>{compactNumber(model.current_rpm)}</b>
                          <span>/ {compactNumber(model.peak_rpm)}</span>
                        </td>
                        <td className="mono stat-pair">
                          <b>{compactNumber(model.current_tpm)}</b>
                          <span>/ {compactNumber(model.peak_tpm)}</span>
                        </td>
                        <td>
                          <b>{compactNumber(model.requests)}</b>
                          <div className="success-failure-counts">
                            <span>{compactNumber(model.successful_requests)} 成功</span>
                            <span>{compactNumber(model.failed_requests)} 失败</span>
                          </div>
                        </td>
                        <td>
                          <b>{compactNumber(model.total_tokens)}</b>
                          <div className="muted table-subline">
                            {compactNumber(model.input_tokens)} / {compactNumber(model.output_tokens)}
                          </div>
                          {model.successful_requests > 0 && model.token_coverage < 99.5 && (
                            <div className="coverage-label">覆盖 {number(model.token_coverage, 0)}%</div>
                          )}
                        </td>
                        <td>
                          <span className={`rate-pill ${model.success_rate < 95 ? "bad" : "good"}`}>
                            {number(model.success_rate, 1)}%
                          </span>
                        </td>
                        <td className="mono stat-pair">
                          <b>{duration(model.average_duration_ms)}</b>
                          <span>/ {duration(model.p95_duration_ms)}</span>
                        </td>
                        <td className="mono">{duration(model.average_first_byte_ms)}</td>
                        <td className="mono">
                          {model.output_tokens_per_second === null
                            ? "—"
                            : `${number(model.output_tokens_per_second, 1)} tok/s`}
                        </td>
                        <td>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setScope(String(model.llm_id));
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                          >
                            查看图表
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            </section>
          )}
        </>
      )}
    </>
  );
}
