"""CI 工具契约测试：分片、diff 选择、耗时录制、gh 三段拆解。

这里钉住的是 `scripts/ci-shard.py` 与 `scripts/ci-profile.py` 对 CI 的承诺：

- 分片是**划分**：互斥且并集等于全集，任何一个测试名都恰好落在一片里；
- 分片是**确定的**：同一 commit 上跑两遍，结果逐字节相同；
- 分片输出必须是能直接交给 `go test -run` 的 Go 正则：锚定、不用 Go 正则不支持的语法；
- 有耗时数据时按耗时打包均衡（LPT），没有时回落到 sha256 哈希；缺耗时的测试用中位数兜底；
- `--affected` 把改动文件映射成包，再沿 import 反向闭包放大到依赖它的包，跨 module 也要放大；
- `--record` 从 `go test -json` 流里取每个测试的 Elapsed；
- `gh` 的三段拆解（排队 / 准备 / 真正跑）只用 job 与 step 的时间戳，样本固定即可断言。

workflow 与脚本卫生的契约在 `scripts/test_ci_workflow.py`，这里把它一并导进来，
所以一条命令就能跑完两边的全部契约：

    python3 -m unittest scripts.test_ci_tools -v
    python3 -m pytest scripts/test_ci_tools.py
"""

import json
import pathlib
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from ci_test_support import GH_RUN_JOBS_SAMPLE, GO_TEST_JSON_SAMPLE, ROOT, SCRIPTS, load, run_cli
from test_ci_workflow import ScriptHygiene, WorkflowContract

class ShardContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shard = load("ci_shard")

    def module_tests(self, module):
        if not hasattr(ShardContract, "_cache"):
            ShardContract._cache = {}
        if module not in ShardContract._cache:
            ShardContract._cache[module] = self.shard.list_tests(module, ROOT)
        return ShardContract._cache[module]

    def test_list_tests_is_deterministic_and_package_keyed(self):
        first = self.module_tests("app")
        second = self.module_tests("app")
        self.assertEqual(first, second)
        self.assertGreater(sum(len(names) for names in first.values()), 5)
        for package, names in first.items():
            self.assertEqual(names, sorted(names), f"{package} 的测试名没有排序")
            self.assertTrue(all(name.startswith("Test") for name in names), f"{package} 里有非 Test 名字")

    def test_hash_shards_partition_the_whole_set(self):
        for module in ("backend", "app"):
            every = sorted(name for names in self.module_tests(module).values() for name in names)
            for shards in (1, 2, 3, 4, 7):
                assignment = self.shard.assign_hash(every, shards)
                self.assertEqual(sorted(assignment), list(range(shards)))
                flat = [name for index in range(shards) for name in assignment[index]]
                self.assertEqual(sorted(flat), every, f"{module} {shards} 片不是并集")
                self.assertEqual(len(flat), len(set(flat)), f"{module} {shards} 片有重复")

    def test_hash_shards_are_stable_across_runs_and_shard_counts(self):
        every = sorted(name for names in self.module_tests("backend").values() for name in names)
        first = self.shard.assign_hash(every, 4)
        second = self.shard.assign_hash(list(every), 4)
        self.assertEqual(first, second)
        single = self.shard.assign_hash(every, 1)
        self.assertEqual(single[0], every)

    def test_hash_shards_spread_reasonably(self):
        every = sorted(name for names in self.module_tests("backend").values() for name in names)
        assignment = self.shard.assign_hash(every, 4)
        sizes = [len(assignment[index]) for index in range(4)]
        self.assertLessEqual(max(sizes) - min(sizes), max(3, len(every) // 10), f"分片大小 {sizes} 太偏")

    def test_run_regex_is_go_compatible_and_exact(self):
        for module in ("backend", "app"):
            every = sorted(name for names in self.module_tests(module).values() for name in names)
            for shards in (1, 4):
                assignment = self.shard.assign_hash(every, shards)
                for index in range(shards):
                    pattern = self.shard.run_regex(assignment[index])
                    self.assertTrue(pattern.startswith("^"), pattern)
                    self.assertTrue(pattern.endswith("$"), pattern)
                    self.assertNotIn("(?:", pattern, "Go 的 RE2 不支持非捕获组")
                    self.assertNotIn("(?P", pattern)
                    compiled = re.compile(pattern)
                    inside = set(assignment[index])
                    for name in every:
                        self.assertEqual(bool(compiled.match(name)), name in inside, f"{module} {name} 与正则不符")

    def test_run_regex_for_an_empty_shard_never_matches(self):
        pattern = self.shard.run_regex([])
        self.assertIsNone(re.compile(pattern).match("TestAnything"))

    def test_balanced_packing_balances_skewed_durations(self):
        times = {"TestHuge": 40.0, "TestBig": 10.0}
        for index in range(1, 15):
            times[f"TestSmall{index}"] = 1.0
        names = sorted(times)
        assignment = self.shard.assign_balanced(times, names, 4)
        flat = [name for index in range(4) for name in assignment[index]]
        self.assertEqual(sorted(flat), names)
        self.assertEqual(len(flat), len(set(flat)))
        load = {index: sum(times[name] for name in assignment[index]) for index in range(4)}
        self.assertEqual(max(load.values()), 40.0, load)
        hash_load = self._worst_hash_load(times, names, 4)
        self.assertLessEqual(max(load.values()), hash_load, (load, hash_load))

    def _worst_hash_load(self, times, names, shards):
        assignment = self.shard.assign_hash(names, shards)
        return max(sum(times[name] for name in assignment[index]) for index in range(shards))

    def test_balanced_packing_keeps_the_whole_set_and_balances_unknown_tests(self):
        times = {"TestRecorded": 6.0, "TestAlsoRecorded": 2.0}
        names = ["TestRecorded", "TestAlsoRecorded", "TestUnknownA", "TestUnknownB"]
        assignment = self.shard.assign_balanced(times, names, 2)
        flat = [name for index in range(2) for name in assignment[index]]
        self.assertEqual(sorted(flat), sorted(names))
        self.assertEqual(len(flat), len(set(flat)))
        fallback = self.shard.median([6.0, 2.0])
        load = [
            sum(times.get(name, fallback) for name in assignment[index])
            for index in range(2)
        ]
        self.assertLessEqual(abs(load[0] - load[1]), 6.0, load)

    def test_balanced_packing_is_deterministic(self):
        times = {f"Test{index}": float(index % 5) for index in range(20)}
        names = sorted(times)
        self.assertEqual(
            self.shard.assign_balanced(times, names, 3),
            self.shard.assign_balanced(dict(times), list(names), 3),
        )

    def test_cli_shard_prints_a_usable_run_regex(self):
        output = run_cli("ci_shard", "--module", "backend", "--shard", "0/4")
        pattern = output.strip().splitlines()[-1]
        self.assertTrue(pattern.startswith("^") and pattern.endswith("$"), pattern)
        compiled = re.compile(pattern)
        every = sorted(name for names in self.module_tests("backend").values() for name in names)
        matched = [name for name in every if compiled.match(name)]
        self.assertTrue(matched)
        self.assertLess(len(matched), len(every))

    def test_cli_shard_names_match_the_regex_of_that_shard(self):
        regex = run_cli("ci_shard", "--module", "backend", "--shard", "2/4").strip().splitlines()[-1]
        names = [line.strip() for line in run_cli("ci_shard", "--module", "backend", "--shard", "2/4", "--format", "names").splitlines() if line.strip()]
        compiled = re.compile(regex)
        self.assertTrue(names)
        for name in names:
            self.assertTrue(compiled.match(name), name)
        self.assertEqual(len(names), len(set(names)))

    def test_cli_record_from_a_go_test_json_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            stream = pathlib.Path(directory) / "stream.json"
            stream.write_text(GO_TEST_JSON_SAMPLE, encoding="utf-8")
            times = pathlib.Path(directory) / "times.json"
            run_cli("ci_shard", "--module", "app", "--record", str(stream), "--times", str(times))
            recorded = json.loads(times.read_text(encoding="utf-8"))
        module = recorded["modules"]["app"]["packages"]
        self.assertEqual(module["graph/app"]["TestAlpha"], 0.25)
        self.assertEqual(module["graph/app"]["TestBeta"], 1.5)
        self.assertEqual(module["graph/app/gwui/kit"]["TestGamma"], 0.5)
        self.assertEqual(recorded["version"], 1)

    def test_cli_record_drops_tests_that_no_longer_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            stream = pathlib.Path(directory) / "stream.json"
            stream.write_text(GO_TEST_JSON_SAMPLE, encoding="utf-8")
            times = pathlib.Path(directory) / "times.json"
            times.write_text(json.dumps({"version": 1, "modules": {"app": {"packages": {"graph/app": {"TestDeleted": 9.0}}}}}), encoding="utf-8")
            run_cli("ci_shard", "--module", "app", "--record", str(stream), "--times", str(times))
            recorded = json.loads(times.read_text(encoding="utf-8"))
        packages = recorded["modules"]["app"]["packages"]
        self.assertNotIn("TestDeleted", packages.get("graph/app", {}))
        self.assertEqual(packages["graph/app"]["TestAlpha"], 0.25)

    def test_balanced_mode_uses_the_recorded_times_file(self):
        packages = {package: {name: 1.0 for name in names} for package, names in self.module_tests("app").items()}
        with tempfile.TemporaryDirectory() as directory:
            times = pathlib.Path(directory) / "times.json"
            times.write_text(json.dumps({"version": 1, "modules": {"app": {"packages": packages}}}), encoding="utf-8")
            balanced = run_cli("ci_shard", "--module", "app", "--shard", "0/2", "--times", str(times)).strip().splitlines()[-1]
            other = run_cli("ci_shard", "--module", "app", "--shard", "1/2", "--times", str(times)).strip().splitlines()[-1]
        self.assertTrue(balanced.startswith("^"))
        every = sorted(name for names in self.module_tests("app").values() for name in names)
        first = {name for name in every if re.match(balanced, name)}
        second = {name for name in every if re.match(other, name)}
        self.assertEqual(first | second, set(every))
        self.assertEqual(first & second, set())
        self.assertTrue(abs(len(first) - len(second)) <= 1, (len(first), len(second)))


class AffectedContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shard = load("ci_shard")

    def graph(self):
        return {
            "github.com/chenx0414/graph/backend/internal/graph": set(),
            "github.com/chenx0414/graph/backend/internal/gate": set(),
            "github.com/chenx0414/graph/backend/internal/harness": {
                "github.com/chenx0414/graph/backend/internal/graph",
            },
            "github.com/chenx0414/graph/backend/daemon": {
                "github.com/chenx0414/graph/backend/internal/graph",
            },
            "github.com/chenx0414/graph/backend/cmd/graphd": {
                "github.com/chenx0414/graph/backend/daemon",
            },
            "graph/app": {
                "github.com/chenx0414/graph/backend/daemon",
            },
            "graph/app/gwui/kit": set(),
        }

    def test_changed_file_maps_to_its_package_and_dependents(self):
        affected = self.shard.affected_packages(
            ["backend/internal/graph/core_execution.go"], self.graph(), root="/repo",
        )
        self.assertIn("github.com/chenx0414/graph/backend/internal/graph", affected)
        self.assertIn("github.com/chenx0414/graph/backend/internal/harness", affected)
        self.assertIn("github.com/chenx0414/graph/backend/cmd/graphd", affected)
        self.assertIn("graph/app", affected)
        self.assertNotIn("github.com/chenx0414/graph/backend/internal/gate", affected)
        self.assertNotIn("graph/app/gwui/kit", affected)

    def test_unrelated_package_does_not_drag_the_world_in(self):
        affected = self.shard.affected_packages(["app/gwui/kit/button.go"], self.graph(), root="/repo")
        self.assertEqual(affected, ["graph/app/gwui/kit"])

    def test_docs_and_config_changes_affect_nothing(self):
        for changed in ("README.md", "docs/guides/checks.md", ".github/workflows/ci.yml", "graph.config.json"):
            self.assertEqual(self.shard.affected_packages([changed], self.graph(), root="/repo"), [], changed)

    def test_deleted_file_still_maps_to_its_package(self):
        affected = self.shard.affected_packages(["backend/internal/graph/gone.go"], self.graph(), root="/repo")
        self.assertIn("github.com/chenx0414/graph/backend/internal/graph", affected)

    def test_affected_is_sorted_and_unique(self):
        affected = self.shard.affected_packages(
            ["backend/internal/graph/a.go", "backend/internal/graph/b.go", "backend/daemon/x.go"],
            self.graph(), root="/repo",
        )
        self.assertEqual(affected, sorted(set(affected)))

    def test_an_uncomputable_diff_falls_back_to_the_whole_module(self):
        output = run_cli("ci_shard", "--module", "app", "--affected", "no-such-ref-for-the-contract-test")
        packages = [line.strip() for line in output.splitlines() if line.strip()]
        self.assertTrue(packages, "算不出改动范围时必须跑全量，不能什么都不跑")
        self.assertTrue(all(package.startswith("graph/app") for package in packages), packages)

    def test_affected_cli_on_this_repository(self):
        output = run_cli("ci_shard", "--module", "backend", "--affected", "origin/main")
        packages = [line.strip() for line in output.splitlines() if line.strip()]
        self.assertEqual(packages, sorted(set(packages)))
        for package in packages:
            self.assertTrue(package.startswith("github.com/chenx0414/graph/backend/"), package)
        again = run_cli("ci_shard", "--module", "backend", "--affected", "origin/main")
        self.assertEqual(output, again)


class ProfileContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = load("ci_profile")

    def test_segments_split_queue_prepare_and_run(self):
        job = GH_RUN_JOBS_SAMPLE["jobs"][0]
        segments = self.profile.segments(job)
        self.assertEqual(segments["queue"], 25.0)
        self.assertEqual(segments["prepare"], 40.0)
        self.assertEqual(segments["run"], 60.0)
        self.assertEqual(segments["tail"], 20.0)
        self.assertAlmostEqual(segments["total"], 145.0, places=3)
        self.assertAlmostEqual(
            segments["queue"] + segments["prepare"] + segments["run"] + segments["tail"],
            segments["total"], places=3,
        )

    def test_segments_tolerate_a_running_job(self):
        job = dict(GH_RUN_JOBS_SAMPLE["jobs"][1])
        job["completedAt"] = None
        job["steps"] = [step for step in job["steps"] if step["name"] != "Complete job"]
        segments = self.profile.segments(job)
        self.assertEqual(segments["queue"], 10.0)
        self.assertGreater(segments["run"], 0)

    def test_summary_reports_every_job_and_the_three_segments(self):
        summary = self.profile.summary(GH_RUN_JOBS_SAMPLE)
        by_name = {row["name"]: row for row in summary}
        self.assertEqual(set(by_name), {"lint", "test (backend, 1/4)"})
        self.assertEqual(by_name["lint"]["prepare"], 40.0)
        self.assertEqual(by_name["test (backend, 1/4)"]["run"], 180.0)
        self.assertEqual([row["run"] for row in summary], sorted((row["run"] for row in summary), reverse=True))

    def test_cli_prints_a_table_from_a_saved_jobs_file(self):
        with tempfile.TemporaryDirectory() as directory:
            saved = pathlib.Path(directory) / "jobs.json"
            saved.write_text(json.dumps(GH_RUN_JOBS_SAMPLE), encoding="utf-8")
            output = run_cli("ci_profile", str(saved))
        self.assertIn("lint", output)
        self.assertIn("prepare", output)
        self.assertIn("queue", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
