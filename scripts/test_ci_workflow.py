"""CI workflow 与脚本卫生的契约测试：分片矩阵、并行、超时、缓存、路径过滤、必需汇总检查。

`ci.yml` 的承诺几乎全是 YAML 结构，所以这里读 YAML 断言；PyYAML 不可用时跳过，
不假装通过。脚本卫生那条查的是 `scripts/ci-shard.py` 与 `scripts/ci-profile.py`
只 import 标准库、不写死绝对路径——CI 上它们要在裸 Python 里跑。

运行：`python3 -m unittest scripts.test_ci_workflow -v`。
"""

import pathlib
import re
import sys
import unittest

try:
    import yaml
except ImportError:
    yaml = None

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"


class WorkflowContract(unittest.TestCase):
    """CI YAML 的承诺：分片矩阵、并行、超时、缓存、路径过滤与必需汇总检查。"""

    def setUp(self):
        if yaml is None:
            self.skipTest("workflow 契约需要 PyYAML：python3 -m pip install pyyaml")

    def workflow(self, name):
        path = ROOT / ".github" / "workflows" / name
        self.assertTrue(path.exists(), f"契约要求 {path} 存在")
        return yaml.safe_load(path.read_text(encoding="utf-8"))

    @staticmethod
    def needs(job):
        value = job.get("needs") or []
        return {value} if isinstance(value, str) else set(value)

    def test_ci_runs_on_pull_requests_main_and_manual(self):
        triggers = self.workflow("ci.yml").get("on") or self.workflow("ci.yml").get(True)
        self.assertIn("pull_request", triggers)
        self.assertEqual(triggers["push"]["branches"], ["main"])
        self.assertIn("workflow_dispatch", triggers)

    def test_ci_cancels_superseded_pull_request_runs_but_not_main(self):
        concurrency = self.workflow("ci.yml")["concurrency"]
        self.assertIn("github.workflow", concurrency["group"])
        self.assertIn("github.ref", concurrency["group"])
        self.assertIn("pull_request", concurrency["cancel-in-progress"])
        self.assertNotIn("true", str(concurrency["cancel-in-progress"]).lower().replace("pull_request", ""))

    def test_every_job_has_a_timeout(self):
        for name in ("ci.yml", "nightly.yml"):
            for job_name, job in self.workflow(name)["jobs"].items():
                self.assertIn("timeout-minutes", job, f"{name}:{job_name} 没有超时上限")

    def test_lint_build_and_test_are_parallel_behind_one_judge(self):
        jobs = self.workflow("ci.yml")["jobs"]
        self.assertEqual(self.needs(jobs["lint"]), {"changes"})
        self.assertEqual(self.needs(jobs["build"]), {"changes"})
        self.assertEqual(self.needs(jobs["test"]), {"changes"})
        self.assertEqual(jobs["ci-required"]["if"], "always()")

    def test_the_test_job_is_sharded_by_module(self):
        matrix = self.workflow("ci.yml")["jobs"]["test"]["strategy"]["matrix"]
        self.assertEqual(sorted(matrix["module"]), ["app", "backend"])
        self.assertEqual(matrix["shard"], [0, 1, 2, 3])
        self.assertFalse(self.workflow("ci.yml")["jobs"]["test"]["strategy"].get("fail-fast", True))

    def test_static_gates_run_on_linux_and_the_bundle_on_macos(self):
        jobs = self.workflow("ci.yml")["jobs"]
        self.assertEqual(jobs["lint"]["runs-on"], "ubuntu-latest")
        self.assertEqual(jobs["test"]["runs-on"], "ubuntu-latest")
        runners = [row["os"] for row in jobs["build"]["strategy"]["matrix"]["include"]]
        self.assertIn("macos-latest", runners)
        self.assertIn("ubuntu-latest", runners)

    def test_the_gate_tool_is_built_once_and_reused(self):
        steps = self.workflow("ci.yml")["jobs"]["lint"]["steps"]
        scripts = "\n".join(step.get("run", "") for step in steps)
        self.assertIn("go -C backend build -o", scripts)
        self.assertNotIn("go -C backend run ./cmd/graphcheck", scripts)

    def test_the_test_job_skips_the_slow_layer(self):
        steps = self.workflow("ci.yml")["jobs"]["test"]["steps"]
        runs = [step.get("run", "") for step in steps]
        self.assertTrue(any("-short" in run for run in runs), "快层必须用 -short 跳过慢层用例")
        self.assertTrue(any("ci-shard.py" in run and "--affected" in run for run in runs))

    def test_every_job_that_runs_checks_uploads_artifacts(self):
        judges = {"changes", "ci-required"}
        for name in ("ci.yml", "nightly.yml"):
            for job_name, job in self.workflow(name)["jobs"].items():
                if job_name in judges:
                    continue
                uploads = [step for step in job["steps"] if step.get("uses", "").startswith("actions/upload-artifact")]
                self.assertTrue(uploads, f"{name}:{job_name} 不留产物")

    def test_nightly_runs_the_slow_layer_and_the_full_suite(self):
        jobs = self.workflow("nightly.yml")["jobs"]
        text = yaml.safe_dump(jobs, allow_unicode=True)
        self.assertIn("graphcheck all", text)
        self.assertIn("test -count=1 ./...", text)
        self.assertNotIn("-short", text)
        schedule = (self.workflow("nightly.yml").get("on") or self.workflow("nightly.yml").get(True))["schedule"]
        self.assertTrue(schedule and schedule[0]["cron"])

    def test_path_filtering_happens_in_a_job_not_in_the_trigger(self):
        triggers = self.workflow("ci.yml").get("on") or self.workflow("ci.yml").get(True)
        self.assertNotIn("paths-ignore", triggers.get("pull_request") or {})
        self.assertNotIn("paths", triggers.get("pull_request") or {})
        changes = self.workflow("ci.yml")["jobs"]["changes"]
        self.assertEqual(changes["outputs"]["code"], "${{ steps.scope.outputs.code }}")


class ScriptHygiene(unittest.TestCase):
    def test_ci_scripts_import_only_the_standard_library(self):
        for name in ("ci_shard", "ci_profile"):
            path = SCRIPTS / f"{name.replace('_', '-')}.py"
            self.assertTrue(path.exists(), f"契约要求 {path} 存在")
            source = path.read_text(encoding="utf-8")
            modules = set()
            for line in source.splitlines():
                match = re.match(r"^(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", line)
                if match:
                    modules.add(match.group(1))
            outside = {module for module in modules if module not in sys.stdlib_module_names}
            self.assertEqual(outside, set(), f"{name} 依赖了标准库以外的东西：{outside}")
            self.assertNotIn(str(SCRIPTS), source.replace("__file__", ""), f"{name} 里写死了绝对路径")




if __name__ == "__main__":
    unittest.main(verbosity=2)
