# 🔀 LLM 中转站

一个单体 LLM 请求中转代理，带配置、日志与统计看板。支持 OpenAI（Chat Completions / Responses）与 Anthropic 三种端点格式的同格式透传，以及可选的双向协议转换路由（含 SSE 流式）；中转时自动注入鉴权头并覆盖模型名。

## 功能

- **统计看板** (`/stats`)
  - 近 24 小时按模型展示当前/峰值 RPM、TPM、输入/输出 Token、成功/失败数与成功率
  - 可从下拉列表切换“总览”或任一模型，复用同一套指标与图表；总览保留按模型拆分列表
  - RPM 与 TPM 按分钟展示，可切换近 24 小时、12 小时、6 小时、1 小时或 10 分钟；另提供最近 14 天每日 Token 消耗
  - 平均/P95 完整耗时、首字节时间与输出 Token 速度
- **LLM 管理** (`/llms`)
  - 增删改查 LLM 配置：别名、Base URL 模式、Token、模型名、启用开关
  - 可通过运行时 Python 脚本批量添加或更新 CodeAgent 配置
  - Base URL 可选择三种协议共用的“合一”模式，或 OpenAI / Anthropic 各自输入的“分离”模式
  - 路由模式可选关闭、Anthropic→OpenAI、OpenAI（Chat/Responses）→Anthropic
  - **兼容性测试**：一次探测 OpenAI 与 Anthropic 工具协议并持久化支持状态
  - 每条 LLM 旁显示中转地址，带**一键复制 icon**
- **请求日志** (`/logs`)
  - 每次中转请求的详情：输入、输出、Token、首字节/完整耗时、HTTP 状态码、成功与否、失败原因
  - 展示上游返回的 Prompt Cache 命中 Token 与缓存命中率
  - 可按 LLM、状态筛选，分页
  - 日志明细与轻量统计数据独立存储；清理日志不会删除统计看板历史
- **核心中转**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`
  - 客户端无需自带鉴权，token 由中转站注入
  - 默认同格式透传；可按 LLM 开启 A→O 或 O→A 格式转换路由
  - SSE 流式转换支持文本和自定义 Function 工具调用
- **模型列表**：`GET /v1/models`
  - OpenAI 客户端获得 OpenAI Models API 格式
  - Anthropic SDK 通过标准 Anthropic 请求头自动获得 Anthropic Models API 格式

## 中转地址形态

中转地址**固定**：

```
http://<host>:<port>/v1/chat/completions   # OpenAI Chat Completions 协议入口
http://<host>:<port>/v1/responses           # OpenAI Responses 协议入口
http://<host>:<port>/v1/messages            # Anthropic 协议入口
```

客户端把 **base url 填成 `http://<host>:<port>`**，SDK 会自动拼出上面的路径。
**model 填成目标 LLM 的别名**（在管理页配置时指定），token 随意填或忽略。

每个 LLM 可选择 Base URL 配置模式：

- **合一**：OpenAI Chat、Responses 与 Anthropic 共用一个 Base URL。
- **分离**：OpenAI Chat / Responses 共用 OpenAI Base URL，Anthropic 使用 Anthropic Base URL。例如 DeepSeek 可分别配置 `https://api.deepseek.com` 与 `https://api.deepseek.com/anthropic`。

地址末尾带或不带 `/v1` 均可，relay 会避免重复拼接。

协议路由按每个 LLM 独立配置：

- **关闭**：保持同协议透传。
- **A → O**：Anthropic Messages 转为 OpenAI Chat Completions，请求和响应双向转换。
- **O → A**：OpenAI Chat 与 Responses 转为 Anthropic Messages，响应分别转回原客户端格式。
- 支持文本、自定义 Function 工具及 SSE；无法无损映射的托管工具、会话状态、
  Anthropic `cache_control` 等字段会明确返回错误，不会静默丢弃。
- Responses 走 O → A 时必须显式传 `store: false`，因为 Anthropic 没有 Responses
  服务端存储与 `previous_response_id` 语义。

中转逻辑：
1. 请求路径末段决定协议（`chat/completions`→OpenAI Chat，`responses`→OpenAI Responses，`messages`→Anthropic）
2. 请求体里的 `model`（= 别名）决定路由到哪个 LLM
3. 按该 LLM 的路由模式选择目标协议与 Base URL，必要时转换请求/响应格式，再注入目标协议鉴权头并覆盖真实模型名

示例（配了别名 `gpt4` 的 LLM）：

```
curl http://localhost:3001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt4","messages":[{"role":"user","content":"你好"}]}'
# 中转站把 model 覆盖为该 LLM 配置的真实模型名，转发到 OpenAI Base URL
```

多个 LLM 用同一个固定地址，靠 model(别名) 区分。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- better-sqlite3（本地 SQLite，零配置）
- 原生 CSS（深色主题，无 UI 库）

## 本地运行

需要 Node.js 22；CodeAgent 脚本同步还需要 `python3`（可用
`CODE_AGENT_PYTHON` 指定其他 Python 可执行文件）。

```bash
npm ci             # 严格按 package-lock.json 安装依赖
npm run dev        # 开发模式，默认 http://localhost:3001
npm run build      # 生产构建
npm run start      # 生产启动
./start.sh          # 后台启动；自动检查端口和构建产物
```

## CodeAgent 配置脚本

内网只需覆盖 `scripts/code_agent_config.py`。服务端在页面探测和每次点击时
直接执行该文件，因此覆盖后无需重新构建或重启。

脚本 stdout 必须只包含一个 JSON 配置对象；诊断日志请写 stderr：

```json
{
  "access_token": "secret",
  "appid": "your-app-id",
  "api_base_url": "https://internal.example/v1",
  "models": ["module", "m2"]
}
```

- LLM 管理页始终显示“添加 CodeAgent”按钮；占位脚本返回空 `models` 时，点击会提示找不到配置。
- CodeAgent 使用脚本返回的合一 `api_base_url`，仅支持 OpenAI Chat / Responses，
  不支持 Anthropic。
- CodeAgent 请求使用 `x-auth-token: access_token` 与 `app-id: appid`，不发送 Bearer 鉴权。
- 服务端还会固定注入 `x-innercc-request-kind: main_conversation`。
- `module` 会生成名称/别名 `CodeAgent-module`，真实模型名仍为 `module`。
- 模型 ID 含 `/`、`:` 等 alias 禁用字符时，会生成稳定的安全 alias；真实模型名不变。
- 首次同步会新增，后续同步按生成的 alias 覆盖更新；本次未返回的旧模型不会删除。
- 这是独立的覆盖同步流程，不改变“导入配置”遇到同 alias 时跳过的既有行为。
- 容器部署时可将内网脚本只读挂载到
  `/app/scripts/code_agent_config.py`，避免重建容器后丢失覆盖文件。

## 容器镜像

```bash
docker build -t registry.cn-hangzhou.aliyuncs.com/kingdo/nvwa-llm-relay:latest .
docker run -d --name nvwa-llm-relay -p 3001:3001 -v llm-relay-data:/data registry.cn-hangzhou.aliyuncs.com/kingdo/nvwa-llm-relay:latest
```

NVWA 节点安装器会把容器内固定端口 `3001` 映射到节点上的动态空闲端口。
`GET /api/models` 仅返回已启用模型的安全元数据和 alias，不返回上游 Token；
任务使用 alias 访问同一节点上的 relay。

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
    stats/route.ts           # GET 近 24 小时统计
  v1/chat/completions/route.ts  # OpenAI Chat Completions 协议中转入口（固定地址）
  v1/responses/route.ts          # OpenAI Responses 协议中转入口（固定地址）
  v1/messages/route.ts           # Anthropic 协议中转入口（固定地址）
  components/               # 前端组件
  llms/page.tsx             # 页面一
  logs/page.tsx             # 页面二
  stats/page.tsx            # 统计看板
lib/
  db.ts                     # SQLite 单例 + CRUD
  proxy.ts                  # 中转逻辑（透传 + SSE + 日志）
  format.ts                 # 协议判断 / 鉴权头注入 / model 覆盖
  usage.ts                  # OpenAI / Anthropic usage 提取
  test-llm.ts               # 测试连接
  types.ts
scripts/
  code_agent_config.py      # CodeAgent 运行时配置脚本（默认 models 为空）
```

## 说明

- Token 明文存储于本地 SQLite，适合个人/内网使用。
- 中转站会自动解压上游响应（去掉 `content-encoding`），便于记录与转发。
- 流式响应（SSE）会完整转发给客户端；日志仅保留前 20 万字符并标注原始长度，
  Token 用量与错误事件采用增量解析，避免长连接持续占用内存。
- Token 统计以供应商返回的 usage 为准；上游不返回 usage 时不做字符数估算。OpenAI Chat 流式请求会自动启用 `stream_options.include_usage`。
- 删除 LLM 后历史日志保留（`llm_id` 置空），不影响审计。
