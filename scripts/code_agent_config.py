#!/usr/bin/env python3
"""CodeAgent LLM 配置入口。

内网只需覆盖本文件。stdout 必须只输出一个 JSON 配置对象；日志请写 stderr。
对象格式例如：

    {
        "access_token": "secret",
        "api_base_url": "https://internal.example/v1",
        "models": ["deepseek-flash", "GLM-5.2"],
    }

空 models 表示未配置，点击管理页按钮时会提示找不到配置。
"""

import json
import sys
from typing import Any


def get_code_agent_config() -> dict[str, Any]:
    """在内网实现并返回 CodeAgent 配置。"""
    return {
        "access_token": "",
        "api_base_url": "",
        "models": [],
    }


if __name__ == "__main__":
    json.dump(get_code_agent_config(), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
