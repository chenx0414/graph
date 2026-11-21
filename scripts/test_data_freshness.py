"""门禁缓存契约：读仓库数据的测试不能被 Go 的测试缓存伪装成通过。

`go test` 只把**本模块内**被测试打开的文件计入缓存键。一个读 `verification/`、`presets/`、
`src/`、`docs/`、`dist/` 的测试，在那些文件变化后仍可能命中旧结果并打印 `ok (cached)`。

实测 2026-11-21：把一条 soft-rule witness 改成不存在的符号，快速层的
`go test -short ./...` 返回 `(cached)` 并判绿。所以：

- 每个**打开 backend 之外文件**的测试包必须在 check-queue.py 里以 `-count=1` 跑；
- 反过来，那份名单不能虚高：点名的包必须真的读 backend 之外的文件，否则每次激活都在白跑。

判定按调用而不是按词邻近：解析 `filepath.Join/Abs(...)` 的参数列表，看参数里有没有
backend 之外的顶层目录名。`filepath.Join("..", "backend", ...)` 留在本模块内，不算。
"""

import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from ci_test_support import ROOT, SCRIPTS

PATH_CALL = re.compile(r"filepath\.(?:Join|Abs)\(")
STRING_LITERAL = re.compile(r'"([^"\\]*)"')


def call_arguments(body, open_paren):
    """The text between the parenthesis at open_paren and its match."""
    depth = 0
    for index in range(open_paren, len(body)):
        if body[index] == "(":
            depth += 1
        elif body[index] == ")":
            depth -= 1
            if depth == 0:
                return body[open_paren + 1 : index]
    return ""


def directories_outside_backend():
    return {
        path.name
        for path in ROOT.iterdir()
        if path.is_dir() and not path.name.startswith(".") and path.name != "backend"
    }


def packages_reading_outside_backend():
    """Backend test packages that build a path naming a directory outside backend/."""
    outside = directories_outside_backend()
    found = set()
    for path in (ROOT / "backend").rglob("*_test.go"):
        body = path.read_text(errors="ignore")
        hit = False
        for match in PATH_CALL.finditer(body):
            for literal in STRING_LITERAL.findall(call_arguments(body, match.end() - 1)):
                if literal in outside:
                    hit = True
                    break
            if hit:
                break
        if hit:
            package = path.parent.relative_to(ROOT / "backend").as_posix()
            found.add("./" + ("." if package == "." else package))
    return found


def gate_source():
    return (SCRIPTS / "check-queue.py").read_text()


def fresh_packages_from_gate():
    """Packages listed on the -count=1 go test step in check-queue.py."""
    source = gate_source()
    match = re.search(
        r'\("go",\s*"-C",\s*"backend",\s*"test",[^)]*"-count=1",([^)]*)\)', source
    )
    if not match:
        return set()
    return set(re.findall(r'"(\./[^"]+)"', match.group(1)))


class DataFreshnessContract(unittest.TestCase):
    def test_every_package_that_reads_repository_data_runs_fresh(self):
        """读 backend 之外数据的包必须绕开缓存，否则数据改动会被判成绿。"""
        missing = sorted(packages_reading_outside_backend() - fresh_packages_from_gate())
        self.assertEqual(
            missing,
            [],
            "these packages build paths into directories outside backend/, so go test can "
            "answer from a stale cache after only that data changed; add them to the "
            "-count=1 step in scripts/check-queue.py: " + ", ".join(missing),
        )

    def test_the_fresh_list_holds_no_extra_package(self):
        """名单不能虚高：点名的包要真的读 backend 之外的数据，否则每次激活都白跑。"""
        extra = sorted(fresh_packages_from_gate() - packages_reading_outside_backend())
        self.assertEqual(
            extra,
            [],
            "these packages run with -count=1 but read nothing outside backend/, so the "
            "gate pays for them on every activation: " + ", ".join(extra),
        )


if __name__ == "__main__":
    unittest.main()
