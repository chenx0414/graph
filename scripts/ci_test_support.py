"""CI 契约测试的共用部分：仓库根、两个固定样本、加载脚本与跑 CLI 的助手。

样本是契约的一部分：`GO_TEST_JSON_SAMPLE` 是 `go test -json` 的形状，
`GH_RUN_JOBS_SAMPLE` 是 `gh run view --json jobs` 的形状。用固定样本断言分段与录制，
测试就不依赖真的跑一遍 CI，也不依赖墙钟。
"""

import importlib.util
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"

GO_TEST_JSON_SAMPLE = "\n".join(
    json.dumps(item)
    for item in [
        {"Action": "start", "Package": "graph/app", "Test": "TestAlpha"},
        {"Action": "run", "Package": "graph/app", "Test": "TestAlpha"},
        {"Action": "pass", "Package": "graph/app", "Test": "TestAlpha", "Elapsed": 0.25},
        {"Action": "run", "Package": "graph/app", "Test": "TestBeta"},
        {"Action": "pass", "Package": "graph/app", "Test": "TestBeta", "Elapsed": 1.5},
        {"Action": "pass", "Package": "graph/app", "Elapsed": 2.0},
        {"Action": "run", "Package": "graph/app/gwui/kit", "Test": "TestGamma"},
        {"Action": "pass", "Package": "graph/app/gwui/kit", "Test": "TestGamma", "Elapsed": 0.5},
    ]
)

GH_RUN_JOBS_SAMPLE = {
    "jobs": [
        {
            "name": "lint",
            "conclusion": "success",
            "createdAt": "2026-11-19T00:00:00Z",
            "startedAt": "2026-11-19T00:00:25Z",
            "completedAt": "2026-11-19T00:02:25Z",
            "steps": [
                {"name": "Set up job", "startedAt": "2026-11-19T00:00:25Z", "completedAt": "2026-11-19T00:00:30Z"},
                {"name": "Run actions/checkout@v4", "startedAt": "2026-11-19T00:00:30Z", "completedAt": "2026-11-19T00:00:35Z"},
                {"name": "Run actions/setup-go@v5", "startedAt": "2026-11-19T00:00:35Z", "completedAt": "2026-11-19T00:01:05Z"},
                {"name": "Run go vet ./...", "startedAt": "2026-11-19T00:01:05Z", "completedAt": "2026-11-19T00:02:00Z"},
                {"name": "Run gofmt on the changed files", "startedAt": "2026-11-19T00:02:00Z", "completedAt": "2026-11-19T00:02:05Z"},
                {"name": "Complete job", "startedAt": "2026-11-19T00:02:05Z", "completedAt": "2026-11-19T00:02:25Z"},
            ],
        },
        {
            "name": "test (backend, 1/4)",
            "conclusion": "success",
            "createdAt": "2026-11-19T00:00:00Z",
            "startedAt": "2026-11-19T00:00:10Z",
            "completedAt": "2026-11-19T00:03:40Z",
            "steps": [
                {"name": "Set up job", "startedAt": "2026-11-19T00:00:10Z", "completedAt": "2026-11-19T00:00:15Z"},
                {"name": "Run actions/checkout@v4", "startedAt": "2026-11-19T00:00:15Z", "completedAt": "2026-11-19T00:00:20Z"},
                {"name": "Run go test", "startedAt": "2026-11-19T00:00:20Z", "completedAt": "2026-11-19T00:03:20Z"},
                {"name": "Complete job", "startedAt": "2026-11-19T00:03:20Z", "completedAt": "2026-11-19T00:03:40Z"},
            ],
        },
    ]
}


def load(name):
    path = SCRIPTS / f"{name.replace('_', '-')}.py"
    if not path.exists():
        raise AssertionError(f"契约要求 {path} 存在")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cli(script, *args):
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / f"{script.replace('_', '-')}.py"), *args],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if result.returncode != 0:
        raise AssertionError(f"{script} {' '.join(args)} 失败：{result.stderr.strip()}")
    return result.stdout
