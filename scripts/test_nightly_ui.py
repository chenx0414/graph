"""nightly 的界面门禁：让 verify-graph 的 journey 真的有人跑。

`verification/skills/verify-graph` 有 30 多条 journey，能驱动真窗口、读回 AX、截图，
但 2026-11-26 之前没有任何 CI 或门禁会执行它们：`index.json` 的 verifiedAt 停在
11-17，之后两周的高强度界面改动没有任何断言判死。结果是一个已删除的页面（洞察页，
76327dbf 删的）能在 scenario、ledger 与 Feature Map 里同时存活两周，而所有门禁全绿。

这条契约钉住三件事：

1. nightly 有一条 job 真的执行 `verify-graph verify`；
2. 它跑的是**被点名**的 journey 清单，清单写在 workflow 里，改动会在 diff 里看见；
3. 每一条被执行的 journey 都在 `verification/scenarios/` 里真实存在——写错名字的
   门禁等于没跑，而且不会有人发现。

运行：`python3 -m unittest scripts.test_nightly_ui -v`。
"""

import pathlib
import re

import unittest

try:
    import yaml
except ImportError:
    yaml = None

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "nightly.yml"
SCENARIOS = ROOT / "verification" / "scenarios"


class NightlyUIGate(unittest.TestCase):
    def setUp(self):
        if yaml is None:
            self.skipTest("workflow 契约需要 PyYAML：python3 -m pip install pyyaml")
        self.assertTrue(WORKFLOW.exists(), f"{WORKFLOW} 必须存在")
        self.workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))

    def ui_job(self):
        jobs = self.workflow["jobs"]
        found = [job for job in jobs.values() if any("verify-graph" in str(step.get("run", "")) for step in job["steps"])]
        self.assertEqual(len(found), 1, "nightly 必须恰好有一条 job 跑 verify-graph")
        return found[0]

    def test_nightly_runs_the_journeys(self):
        job = self.ui_job()
        runs = "\n".join(str(step.get("run", "")) for step in job["steps"])
        self.assertIn("verify-graph verify", runs, "nightly 必须真的执行 journey，而不是只装着工具")

    def test_the_journeys_it_runs_are_named_and_exist(self):
        job = self.ui_job()
        runs = "\n".join(str(step.get("run", "")) for step in job["steps"])
        journeys = re.findall(r"--journey\s+([A-Za-z0-9._-]+)", runs)
        self.assertTrue(journeys, "被点名的 journey 清单必须写在 workflow 里，改动了才看得见")
        self.assertNotIn("--all", runs, "nightly 不该跑 --all：红的环境类 journey 会让它长期红，掩盖真回归")
        for journey in journeys:
            self.assertTrue((SCENARIOS / f"{journey}.json").exists(),
                            f"nightly 点名了不存在的 journey {journey}：写错名字的门禁等于没跑")

    def test_it_runs_on_a_machine_that_has_a_window(self):
        # 真窗口 lane 需要 macOS 的辅助功能权限；ubuntu runner 没有窗口服务。
        self.assertEqual(self.ui_job()["runs-on"], "macos-latest")

    def test_a_red_journey_keeps_its_evidence(self):
        job = self.ui_job()
        uploads = [step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/upload-artifact")]
        self.assertTrue(uploads, "红的时候必须留下证据，否则没人能判断是产品坏了还是环境坏了")
        joined = " ".join(str(step.get("with", {}).get("path", "")) for step in uploads)
        self.assertIn("verification/evidence", joined, "证据目录 verification/evidence 必须被上传")

    def test_the_agent_desktop_permission_gap_is_named_not_hidden(self):
        runs = "\n".join(str(step.get("run", "")) for step in self.ui_job()["steps"])
        self.assertIn("doctor", runs,
                      "window lane 需要辅助功能权限：job 必须先跑 doctor，把权限不足与产品失败区分开")


if __name__ == "__main__":
    unittest.main()
