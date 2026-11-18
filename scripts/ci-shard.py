"""把 Go 测试按确定性规则切成互斥的若干片，并给出能直接交给 `go test -run` 的正则。

契约：

- `list_tests(module)` 返回 {包: 排好序的 Test 名}，同一 commit 上逐字节可复现。
- `assign_hash(names, n)` 用 sha256(name) % n 分片：没有耗时数据时的确定性回落。
- `assign_balanced(times, names, n)` 用 LPT 按耗时打包均衡；缺耗时的测试取已知耗时的中位数。
- `run_regex(names)` 产出 `^(A|B)$`，锚定、不使用 Go 的 RE2 不支持的语法；空片给 `^$`。
- `record(stream)` 从 `go test -json` 流里取每个测试的 Elapsed，合并进耗时文件并丢掉已删除的测试。
- `affected_packages(changed, graph)` 把改动文件映射成包，再沿 import 反向闭包放大到依赖它的包。

用法：

    python3 scripts/ci-shard.py --module backend --shard 0/4
    python3 scripts/ci-shard.py --module backend --shard 0/4 --format names
    python3 scripts/ci-shard.py --module backend --affected origin/main
    python3 scripts/ci-shard.py --module backend --record /tmp/backend.json
    go -C backend test -json -count=1 ./... | python3 scripts/ci-shard.py --module backend --record -
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

DEFAULT_MODULES = {
    "backend": "github.com/chenx0414/graph/backend",
    "app": "graph/app",
    "verification": "graph/verification",
}
DEFAULT_TIMES = "scripts/ci-test-times.json"
TIMES_VERSION = 1
# 只记够慢的测试：低于这个值的测试用中位数兜底即可，而全量逐条记录会把文件撑过
# 仓库的单文件令牌预算（5000 令牌 = 20000 字节），门禁会拒绝提交。
RECORD_MIN_SECONDS = 0.03


def root_of():
    return pathlib.Path(__file__).resolve().parent.parent


def module_path(module, root):
    """该 module 的 import 前缀：优先读 go.mod，读不到时用已知默认值。"""
    gomod = pathlib.Path(root) / module / "go.mod"
    try:
        for line in gomod.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^module\s+(\S+)$", line.strip())
            if match:
                return match.group(1)
    except OSError:
        pass
    if module not in DEFAULT_MODULES:
        raise SystemExit(f"unknown module {module!r}: expected one of {sorted(DEFAULT_MODULES)}")
    return DEFAULT_MODULES[module]


def run_go(arguments, root):
    result = subprocess.run(
        ["go", *arguments], cwd=str(root), capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"go {' '.join(arguments)} failed ({result.returncode}):\n{result.stderr.strip()}")
    return result.stdout


def test_packages(module, root):
    """有测试文件的包名列表：逐个列，一个包编译不过不会吞掉其它包的测试名。"""
    output = run_go(["-C", module, "list", "-f", "{{.ImportPath}} {{len .TestGoFiles}}", "./..."], root)
    packages = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] not in ("0", ""):
            packages.append(parts[0])
    return packages


def list_tests_bulk(module, root):
    """一次 `go test -list` 拿全 module 的测试名，比逐包列快一个数量级。"""
    output = run_go(["-C", module, "test", "-list", "^Test", "./..."], root)
    packages = {}
    pending = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("ok "):
            parts = line.split()
            if len(parts) >= 2 and pending:
                packages.setdefault(parts[1], []).extend(pending)
            pending = []
        elif line.startswith("?"):
            pending = []
        elif re.match(r"^(Test|Example|Fuzz)[A-Za-z0-9_]*$", line):
            pending.append(line)
    return {package: sorted(set(names)) for package, names in packages.items() if names}


def list_tests(module, root):
    """{包: [Test 名...]}，按包名与测试名排序。

    先用一次全 module 的 `go test -list`（快）；它因为某个包编译不过而整体失败时，
    退回逐包列，把编译不过的包逐个点名后报错——不能静默跳过，否则分片会漏掉它们。
    """
    try:
        return list_tests_bulk(module, root)
    except SystemExit:
        pass
    packages = {}
    broken = []
    for package in test_packages(module, root):
        try:
            output = run_go(["-C", module, "test", "-list", "^Test", package], root)
        except SystemExit as error:
            broken.append(f"{package}: {error}")
            continue
        names = [
            line.strip() for line in output.splitlines()
            if re.match(r"^(Test|Example|Fuzz)[A-Za-z0-9_]*$", line.strip())
        ]
        if names:
            packages[package] = sorted(set(names))
    if broken:
        raise SystemExit("cannot list tests, these packages do not build:\n" + "\n".join(broken))
    return {package: names for package, names in sorted(packages.items())}


def stable_bucket(name, shards):
    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % shards


def assign_hash(names, shards):
    """sha256 哈希分片：互斥、并集等于全集、与分片数无关地确定。"""
    if shards < 1:
        raise SystemExit("--shard 的分母必须 >= 1")
    buckets = {index: [] for index in range(shards)}
    for name in sorted(set(names)):
        buckets[stable_bucket(name, shards)].append(name)
    return buckets


def median(values):
    ordered = sorted(values)
    if not ordered:
        return 1.0
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def assign_balanced(times, names, shards):
    """按耗时打包均衡（LPT）：把最长的先放进当前最空的片。"""
    if shards < 1:
        raise SystemExit("--shard 的分母必须 >= 1")
    recorded = [times[name] for name in names if name in times]
    fallback = median(recorded)
    ordered = sorted(set(names), key=lambda name: (-times.get(name, fallback), name))
    buckets = {index: [] for index in range(shards)}
    load = [0.0] * shards
    for name in ordered:
        target = min(range(shards), key=lambda index: (load[index], index))
        buckets[target].append(name)
        load[target] += times.get(name, fallback)
    return {index: buckets[index] for index in range(shards)}


def run_regex(names):
    """`^(A|B)$`；Go 的 RE2 没有非捕获组，所以只用最朴素的写法。"""
    ordered = sorted(set(names))
    if not ordered:
        return "^$"
    return "^(" + "|".join(re.escape(name) for name in ordered) + ")$"


def flatten(packages):
    return sorted(name for names in packages.values() for name in names)


def times_for_module(times_document, module):
    entry = times_document.get("modules", {}).get(module, {})
    result = {}
    for names in entry.get("packages", {}).values():
        result.update({name: float(value) for name, value in names.items()})
    return result


def load_times(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": TIMES_VERSION, "modules": {}}


def record(stream_text, times_document, module):
    """从 go test -json 流里取耗时；流里跑过的包里已经不存在的测试被丢掉。

    只清理这次真的跑过的包：某个包编译不过时它不会出现在流里，把它的记录一起删掉
    等于把好数据当成过期数据。低于 RECORD_MIN_SECONDS 的测试也不留。
    """
    observed = {}
    for line in stream_text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        name = event.get("Test")
        package = event.get("Package")
        if not name or not package or "/" in name:
            continue
        if event.get("Action") not in ("pass", "fail", "skip"):
            continue
        if event.get("Action") != "pass":
            continue
        elapsed = round(float(event.get("Elapsed", 0.0)), 3)
        if elapsed < RECORD_MIN_SECONDS:
            continue
        observed.setdefault(package, {})[name] = elapsed
    modules = times_document.setdefault("modules", {})
    entry = modules.setdefault(module, {"packages": {}})
    packages = entry.setdefault("packages", {})
    for package, names in observed.items():
        packages.setdefault(package, {}).update(names)
    for package in list(packages):
        for name in list(packages[package]):
            if name in observed.get(package, {}):
                continue
            if package in observed or packages[package][name] < RECORD_MIN_SECONDS:
                del packages[package][name]
        if not packages[package]:
            del packages[package]
    times_document["version"] = TIMES_VERSION
    times_document["minSeconds"] = RECORD_MIN_SECONDS
    return times_document


def import_graph(module, root):
    """{包: {它 import 的包}}，含测试 import；只保留本仓库内的包。"""
    output = run_go(["-C", module, "list", "-json", "./..."], root)
    decoder = json.JSONDecoder()
    graph = {}
    position = 0
    while position < len(output):
        while position < len(output) and output[position] in " \r\n\t":
            position += 1
        if position >= len(output):
            break
        entry, position = decoder.raw_decode(output, position)
        edges = set()
        for key in ("Imports", "TestImports", "XTestImports"):
            edges.update(entry.get(key) or [])
        graph[entry["ImportPath"]] = edges
    return graph


def path_to_import(relative, root):
    """仓库相对路径 → import 路径；非 Go 文件与 module 之外的文件给 None。"""
    parts = pathlib.PurePosixPath(relative).parts
    if not parts:
        return None
    module = parts[0]
    if module not in DEFAULT_MODULES and not (pathlib.Path(root) / module / "go.mod").exists():
        return None
    name = parts[-1]
    if name in ("go.mod", "go.sum"):
        return ("module", module)
    if not name.endswith(".go"):
        return None
    prefix = module_path(module, root)
    directory = pathlib.PurePosixPath(*parts[1:-1])
    if str(directory) in ("", "."):
        return prefix
    return prefix + "/" + str(directory)


def affected_packages(changed, graph, root=None):
    """改动文件 → 直接命中的包 → 依赖它们的包（反向闭包），排序去重。"""
    root = root_of() if root is None else root
    reverse = {package: set() for package in graph}
    for package, imports in graph.items():
        for imported in imports:
            reverse.setdefault(imported, set()).add(package)
    direct = set()
    whole_modules = set()
    for relative in changed:
        mapped = path_to_import(str(relative).replace("\\", "/"), root)
        if mapped is None:
            continue
        if isinstance(mapped, tuple):
            whole_modules.add(mapped[1])
            continue
        if mapped in graph:
            direct.add(mapped)
    for module in whole_modules:
        prefix = module_path(module, root)
        direct.update(package for package in graph if package == prefix or package.startswith(prefix + "/"))
    affected = set(direct)
    queue = list(direct)
    while queue:
        package = queue.pop()
        for dependent in reverse.get(package, ()):
            if dependent not in affected:
                affected.add(dependent)
                queue.append(dependent)
    return sorted(affected)


def changed_files(base, root):
    """改动文件列表；算不出来时返回 None（调用方退回"全量"，不是"什么都不跑"）。"""
    for arguments in (["diff", "--name-only", f"{base}...HEAD"], ["diff", "--name-only", base, "HEAD"]):
        result = subprocess.run(["git", *arguments], cwd=str(root), capture_output=True, text=True, check=False)
        if result.returncode == 0:
            return [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return None


def parse_shard(text):
    match = re.match(r"^(\d+)/(\d+)$", text)
    if not match:
        raise SystemExit(f"--shard wants INDEX/COUNT, got {text!r}")
    index, count = int(match.group(1)), int(match.group(2))
    if count < 1 or index >= count:
        raise SystemExit(f"--shard {text} is outside 0/{count}")
    return index, count


def main(argv):
    parser = argparse.ArgumentParser(description="Deterministic Go test sharding and diff selection.")
    parser.add_argument("--module", required=True, choices=sorted(DEFAULT_MODULES))
    parser.add_argument("--root", default=None)
    parser.add_argument("--shard", default=None)
    parser.add_argument("--format", default="regex", choices=("regex", "names", "json", "packages"))
    parser.add_argument("--times", default=None)
    parser.add_argument("--record", default=None)
    parser.add_argument("--affected", default=None)
    parser.add_argument("--list-tests", action="store_true")
    arguments = parser.parse_args(argv)
    root = pathlib.Path(arguments.root).resolve() if arguments.root else root_of()
    times_path = pathlib.Path(arguments.times) if arguments.times else root / DEFAULT_TIMES

    if arguments.record is not None:
        if arguments.record == "-":
            stream_text = sys.stdin.read()
        else:
            stream_text = pathlib.Path(arguments.record).read_text(encoding="utf-8")
        document = load_times(times_path)
        recorded = record(stream_text, document, arguments.module)
        if arguments.format == "json":
            print(json.dumps(recorded, indent=2, sort_keys=True, ensure_ascii=False))
        else:
            times_path.write_text(json.dumps(recorded, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
            total = sum(len(names) for names in recorded["modules"][arguments.module]["packages"].values())
            print(f"recorded {total} tests of {arguments.module} into {times_path}")
        return 0

    if arguments.affected is not None:
        changed = changed_files(arguments.affected, root)
        prefix = module_path(arguments.module, root)
        if changed is None:
            # 算不出改动范围时跑全量：漏跑测试会被误读成"通过"，多跑只是慢。
            packages = sorted(
                package for package in import_graph(arguments.module, root)
                if package == prefix or package.startswith(prefix + "/")
            )
        else:
            packages = affected_packages(changed, import_graph(arguments.module, root), root)
            packages = [package for package in packages if package == prefix or package.startswith(prefix + "/")]
        if arguments.format == "json":
            print(json.dumps(packages, indent=2))
        else:
            print("\n".join(packages))
        return 0

    if arguments.list_tests:
        packages = list_tests(arguments.module, root)
        if arguments.format == "json":
            print(json.dumps(packages, indent=2, sort_keys=True))
        else:
            print("\n".join(flatten(packages)))
        return 0

    if arguments.shard is None:
        parser.error("one of --shard, --affected, --record or --list-tests is required")
    index, count = parse_shard(arguments.shard)
    packages = list_tests(arguments.module, root)
    names = flatten(packages)
    recorded = times_for_module(load_times(times_path), arguments.module)
    buckets = assign_balanced(recorded, names, count) if recorded else assign_hash(names, count)
    selected = buckets[index]
    if arguments.format == "names":
        print("\n".join(selected))
    elif arguments.format == "packages":
        chosen = set(selected)
        print("\n".join(package for package, names in packages.items() if chosen.intersection(names)))
    elif arguments.format == "json":
        total = sum(recorded.get(name, 0.0) for name in selected)
        print(json.dumps({"index": index, "count": count, "tests": selected, "recorded_seconds": round(total, 3)}, indent=2))
    else:
        print(run_regex(selected))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
