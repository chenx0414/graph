"""把 GitHub Actions 的一次运行拆成「排队 / 准备 / 真正跑 / 收尾」四段，用于定位慢在哪一段。

契约：

- `segments(job)` 吃 `gh run view --json jobs` 里的一个 job，返回秒数：
  - `queue`：job 被创建到开始跑（runner 排队 + 分配机器）；
  - `prepare`：开始到最后一个 setup 类 step 结束（checkout、setup-go、缓存恢复）；
  - `run`：准备结束到第一个真正干活的 step 结束（测试 / vet / 构建）；
  - `tail`：其余收尾 step 与 job 完成；
  - `total`：job 的总时长，等于四段之和。
- `summary(document)` 对一批 job 逐条给出四段，按 `run` 从大到小排。
- 远端还没有运行记录时用固定样本自测（`scripts/test_ci_tools.py` 里的 `GH_RUN_JOBS_SAMPLE`）。

用法：

    gh run view <run-id> --json jobs > /tmp/jobs.json
    python3 scripts/ci-profile.py /tmp/jobs.json
"""

import json
import re
import subprocess
import sys
from datetime import datetime, timezone

SETUP_STEP = re.compile(r"^(set up job|run actions/(checkout|setup-go|cache)@)", re.IGNORECASE)
CLEANUP_STEP = re.compile(r"^(complete job|post job cleanup|run actions/upload-artifact@)", re.IGNORECASE)
SEGMENT_ORDER = ("queue", "prepare", "run", "tail")


def parse_time(text):
    if not text:
        return None
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def seconds_between(start, end):
    if start is None or end is None:
        return 0.0
    return max(0.0, (end - start).total_seconds())


def is_setup(step):
    return bool(SETUP_STEP.match((step.get("name") or "").strip()))


def is_cleanup(step):
    return bool(CLEANUP_STEP.match((step.get("name") or "").strip()))


def job_steps(job):
    steps = [step for step in job.get("steps") or [] if step.get("startedAt")]
    steps.sort(key=lambda step: parse_time(step["startedAt"]))
    return steps


def last_end(steps, fallback):
    ends = [parse_time(step.get("completedAt")) for step in steps]
    ends = [end for end in ends if end is not None]
    return max(ends) if ends else fallback


def segments(job):
    """一个 job 的四段耗时（秒）。

    job 还没跑完时，`completedAt` 为空：收尾段记 0，其余段用已发生的 step 计算。
    """
    created = parse_time(job.get("createdAt"))
    started = parse_time(job.get("startedAt"))
    completed = parse_time(job.get("completedAt"))
    steps = job_steps(job)
    if started is None:
        return {**{name: 0.0 for name in SEGMENT_ORDER}, "total": 0.0}
    setup_steps = [step for step in steps if is_setup(step)]
    work_steps = [step for step in steps if not is_setup(step) and not is_cleanup(step)]
    prepare_end = last_end(setup_steps, started)
    run_end = last_end(work_steps, prepare_end)
    end = completed or run_end
    queue = seconds_between(created, started) if created is not None else 0.0
    prepare = seconds_between(started, prepare_end)
    run = seconds_between(prepare_end, run_end)
    tail = seconds_between(run_end, end)
    return {
        "queue": round(queue, 3),
        "prepare": round(prepare, 3),
        "run": round(run, 3),
        "tail": round(tail, 3),
        "total": round(queue + prepare + run + tail, 3),
    }


def summary(document):
    rows = []
    for job in document.get("jobs") or []:
        row = {"name": job.get("name") or "?", "conclusion": job.get("conclusion") or "running"}
        row.update(segments(job))
        rows.append(row)
    rows.sort(key=lambda row: (-row["run"], row["name"]))
    return rows


def format_table(rows):
    header = ["job", "queue", "prepare", "run", "tail", "total", "conclusion"]
    table = [header]
    for row in rows:
        table.append([
            row["name"], f"{row['queue']:.0f}s", f"{row['prepare']:.0f}s",
            f"{row['run']:.0f}s", f"{row['tail']:.0f}s", f"{row['total']:.0f}s", row["conclusion"],
        ])
    widths = [max(len(line[index]) for line in table) for index in range(len(header))]
    return "\n".join("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(line)).rstrip() for line in table)


def read_document(source):
    if source == "-":
        return json.load(sys.stdin)
    return json.loads(open(source, encoding="utf-8").read())


def main(argv):
    source = argv[0] if argv else "-"
    document = read_document(source)
    rows = summary(document)
    if not rows:
        print("no jobs in this document; save one with `gh run view <run-id> --json jobs`")
        return 0
    print(format_table(rows))
    totals = {name: sum(row[name] for row in rows) for name in SEGMENT_ORDER}
    grand = sum(totals.values())
    print()
    share = " · ".join(f"{name} {totals[name]:.0f}s ({totals[name] / grand:.0%})" for name in SEGMENT_ORDER) if grand else ""
    print(f"wall sum across jobs: {grand:.0f}s — {share}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
