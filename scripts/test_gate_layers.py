"""门禁分层的契约：快层只跑改动真的能影响到的模块。

快层的意义是「提交前几十秒内给出结论」。实测 2026-11-23：快层 98 秒，其中
`go -C app test` 41 秒、`internal/graph` 17 秒，两者合计占六成。它们互不相干：
改一个 `app/*.go` 不会让 backend 的测试变红，反之亦然。

依赖闭包在这里帮不上忙 - 改 `backend/internal/graph/core_store.go` 时
`ci-shard.py --affected` 报出 17 个包，因为它沿 import 反向放大，而这几乎就是全部。
所以分层按**改动落在哪个模块**来选，这是一条可以断言的规则：

- 只改 app/          -> 跑 app，不跑 backend 的测试
- 只改 backend/      -> 跑 backend，不跑 app
- 只改 verification/ -> 跑 verification
- 跨模块或改动不明    -> 全部跑（宁可慢，不可漏）
- 静态门禁（graphcheck、散文预算等）永远跑，它们与语言无关且很快
"""

import unittest

from scripts.gate_layers import modules_to_test


class GateLayerSelection(unittest.TestCase):
    def test_an_app_only_change_does_not_run_the_backend_tests(self):
        self.assertEqual(modules_to_test(["app/chat_pictures.go"]), ["app"])

    def test_a_backend_only_change_does_not_run_the_app_tests(self):
        self.assertEqual(modules_to_test(["backend/internal/graph/core_store.go"]), ["backend"])

    def test_a_verification_only_change_runs_that_module(self):
        self.assertEqual(modules_to_test(["verification/internal/skilldoc/skilldoc.go"]), ["verification"])

    def test_a_change_across_modules_runs_all_of_them(self):
        changed = ["app/main.go", "backend/internal/graph/x.go"]
        self.assertEqual(modules_to_test(changed), ["app", "backend", "verification"])

    def test_an_unknown_path_runs_everything(self):
        # A change we cannot place - a new top-level directory, a script - must not narrow the gate.
        self.assertEqual(modules_to_test(["scripts/check-queue.py"]), ["app", "backend", "verification"])

    def test_an_empty_change_runs_everything(self):
        # Nothing to look at is not evidence that nothing is affected.
        self.assertEqual(modules_to_test([]), ["app", "backend", "verification"])

    def test_the_static_steps_are_not_a_module(self):
        # graphcheck and the prose budget are language-agnostic and always run; they must not
        # be selectable away by narrowing to a module.
        self.assertNotIn("static", modules_to_test(["app/main.go"]))


if __name__ == "__main__":
    unittest.main()


class GateLayerOverride(unittest.TestCase):
    """The gate itself names the modules it should run; a typo must not silently narrow it."""

    def test_an_override_selects_exactly_that_module(self):
        self.assertEqual(modules_to_test([], override=["app"]), ["app"])
        self.assertEqual(modules_to_test(["backend/x.go"], override=["backend"]), ["backend"])

    def test_an_unknown_module_name_widens_rather_than_running_nothing(self):
        # "ap" is a typo; reading it as "run nothing" would turn one keystroke into a gate that
        # tests nothing at all, which is worse than testing everything.
        self.assertEqual(modules_to_test([], override=["ap"]), ["app", "backend", "verification"])
