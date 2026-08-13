# 🔀 LLM 中转站

一个单体 LLM 请求中转代理，带两个管理页面。支持 OpenAI 与 Anthropic 两种协议的**同格式透传**（含 SSE 流式），中转时自动注入鉴权头并覆盖模型名。

## 功能

- **页面一：LLM 管理** (`/llms`)
  - 增删改查 LLM 配置：别名、Base URL、Token、模型名、协议、启用开关
  - **测试**：发一个 `hi`，失败时显示具体原因
  - 每条 LLM 旁显示中转地址，带**一键复制 icon**
- **页面二：请求日志** (`/logs`)
  - 每次中转请求的详情：输入、输出、耗时、HTTP 状态码、成功与否、失败原因
  - 可按 LLM、状态筛选，分页
- **核心中转**：`/api/relay/{别名}/{...上游路径}`
  - 客户端无需自带鉴权，token 由中转站注入
  - 同格式透传：OpenAI→OpenAI、Anthropic→Anthropic
  - 完整支持 SSE 流式，边透传边记录到日志

## 中转地址形态

中转地址**固定**：

```
http://<host>:<port>/v1/chat/completions   # OpenAI 协议入口
http://<host>:<port>/v1/messages            # Anthropic 协议入口
```

客户端把 **base url 填成 `http://<host>:<port>`**，SDK 会自动拼出上面的路径。
**model 填成目标 LLM 的别名**（在管理页配置时指定），token 随意填或忽略。

每个 LLM 配置时分两个 baseURL 字段（至少填一个）：
- **OpenAI baseURL**：OpenAI 协议时用此地址转发（注入 `Authorization: Bearer`）
- **Anthropic baseURL**：Anthropic 协议时用此地址转发（注入 `x-api-key`）

中转逻辑：
1. 请求路径末段决定协议（`chat/completions`→OpenAI，`messages`→Anthropic）
2. 请求体里的 `model`（= 别名）决定路由到哪个 LLM
3. 按协议取该 LLM 对应的 baseURL，注入鉴权头，把 model 覆盖为真实模型名，转发

示例（配了别名 `gpt4` 的 LLM）：

```
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt4","messages":[{"role":"user","content":"你好"}]}'
# 中转站把 model 覆盖为该 LLM 配置的真实模型名，转发到其 OpenAI baseURL
```

多个 LLM 用同一个固定地址，靠 model(别名) 区分。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- better-sqlite3（本地 SQLite，零配置）
- 原生 CSS（深色主题，无 UI 库）

## 本地运行

```bash
npm install        # 安装依赖
npm run dev        # 开发模式，默认 http://localhost:3000
npm run build      # 生产构建
npm run start      # 生产启动
```

数据文件默认存放在项目根目录 `data/relay.db`，可通过环境变量 `DATA_DIR` 覆盖。

## 目录结构

```
app/
  api/
    llms/route.ts            # GET 列表 / POST 新增
    llms/[id]/route.ts       # GET / PUT / DELETE 单个
    llms/[id]/test/route.ts  # POST 测试连接
    logs/route.ts            # GET 日志列表（分页/筛选）
    logs/[id]/route.ts       # GET 单条详情
    v1/chat/completions/route.ts  # OpenAI 协议中转入口（固定地址）
    v1/messages/route.ts          # Anthropic 协议中转入口（固定地址）
  components/               # 前端组件
  llms/page.tsx             # 页面一
  logs/page.tsx             # 页面二
lib/
  db.ts                     # SQLite 单例 + CRUD
  proxy.ts                  # 中转逻辑（透传 + SSE + 日志）
  format.ts                 # 协议判断 / 鉴权头注入 / model 覆盖
  test-llm.ts               # 测试连接
  types.ts
```

## 说明

- Token 明文存储于本地 SQLite，适合个人/内网使用。
- 中转站会自动解压上游响应（去掉 `content-encoding`），便于记录与转发。
- 流式响应（SSE）的输出会被拼接成完整文本存入日志。
- 删除 LLM 后历史日志保留（`llm_id` 置空），不影响审计。
