# Graph 原生设计范例

供 main agent 选择结构。以下 JSON 是完整 graph 定义，传给 graph_create({definition})；它们用于文本协作，不指定 Git targetBranch。正式契约见 [管理入口](agent/graph-v2.md) 与 [规格](specs/graph-rebuild-v2.md)。示例有定义校验和实际路由验收，不代表已交付具体项目功能。

## 构建步骤

1. 选择独立任务、返工路由或复用子图的形状。替换示例中的 worker@1/reviewer@1 为能力库已发布的精确配方版本，在 task/acceptance 中写明任务及交付要求。
2. 完整校验定义再创建；创建后向公开输入 graph_send({graphId,input,value}) 或节点具名输入投递。创建本身不执行 agent。
3. Agent 发布稳定产物，再调用 submit({outputs:{result:{enable:true,value}}})。未提交的输出等价于 enable:false；业务不通过使用 enable:true、passed:false。
4. main 读取公开结果并处理运行问题，工作清空后提出 complete；空闲只表示当前排空。自动完成需要明确完成出口。

main 在 graph 外部，可以拥有多个 graph。聊天与接口投递共用节点串行队列，沿用聊天历史。接口具名，概览只画一个入口与出口；判断及路由交由模块。

## 接线时检查

- 需要先审计划再开工时，把 reviewer 的通过输出经路由接到 worker；planner 同时连 reviewer 和 worker 表示并行开始，不表示等待审查。需要计划返工时显式把不通过输出接回 planner。
- 多份报告需要合成一次 synth 输入时，在 synth 前使用 `once` 汇合模块和 `requiredInputs`，输出映射包含各份报告引用。三个 reviewer 直接连 synth 会触发三次执行；第一次缺报告也会按 synth 的必需输出要求验收，不能用 prompt 把它变成隐含汇合。
- 返工路由传递 `enable:true`、`passed:false`。重开汇合保留旧输入，只等待下一条投递；main 应决定复用哪些旧结论并核对它们实际审查的 commit，不能把重开理解为自动收齐一整轮新报告。
- `workspace.command` 在 graph 集成目录检查。worker 的 submit 不等于 Git 已集成；检查要在 main 完成显式集成后投递，不能直接挂在尚未集成的 worker 输出上。
- `submit` 是实际发送，不用于试探协议；合法的 probe 也会启动下游并消耗本次有效提交。使用完整 `outputs` 参数，并以 `accepted:true` 回执确认成功，成功后不要继续猜形状重发。

## 独立任务

两个 agent 分别接收一次输入，通过公开输出交回 main。main 可以连续投递 api 与 risks；实际并发服从运行名额。

```json
{
  "schemaVersion": 2,
  "name": "独立调研",
  "protocols": {"data": {"type": "object"}},
  "nodes": {
    "research-api": {
      "recipe": "worker@1",
      "task": "调研目标项目的一手 API 文档，发布笔记，通过 result 提交结论与稳定产物引用。",
      "inputs": {"job": {"protocol": "data", "version": 1}},
      "outputs": {"result": {"protocol": "data", "version": 1}},
      "submission": {"required": ["result"]}
    },
    "research-risks": {
      "recipe": "worker@1",
      "task": "检查目标项目的限制，发布风险笔记，通过 result 提交结论与稳定产物引用。",
      "inputs": {"job": {"protocol": "data", "version": 1}},
      "outputs": {"result": {"protocol": "data", "version": 1}},
      "submission": {"required": ["result"]}
    }
  },
  "modules": {},
  "edges": {},
  "inputs": {
    "api": {"to": "research-api.job", "protocol": "data", "version": 1},
    "risks": {"to": "research-risks.job", "protocol": "data", "version": 1}
  },
  "outputs": {
    "api": {"from": "research-api.result", "protocol": "data", "version": 1},
    "risks": {"from": "research-risks.result", "protocol": "data", "version": 1}
  }
}
```

## 返工路由

worker 输出交给 reviewer；reviewer 报告结论，route 按 passed 判断返工或输出。each 每次有效输入都判断。返工 value 携带理由与精确产物引用，连接两端使用相同协议 ID 和版本。

```json
{
  "schemaVersion": 2,
  "name": "撰写与审查",
  "protocols": {
    "data": {"type": "object"},
    "review": {
      "type": "object",
      "required": ["passed", "reason"],
      "properties": {
        "passed": {"type": "boolean"},
        "reason": {"type": "string"},
        "artifactId": {"type": "string"},
        "version": {"type": "integer"},
        "commit": {"type": "string"}
      }
    }
  },
  "nodes": {
    "worker": {
      "recipe": "worker@1",
      "task": "按 job 撰写或修订方案，发布稳定版本，通过 result 提交产物 ID、版本和工作摘要。",
      "inputs": {"job": {"protocol": "data", "version": 1}},
      "outputs": {"result": {"protocol": "data", "version": 1}},
      "submission": {"required": ["result"]}
    },
    "reviewer": {
      "recipe": "reviewer@1",
      "task": "读取 job 的精确产物版本，发布审查报告，通过 result 提交 passed、reason 和审查产物引用。",
      "inputs": {"job": {"protocol": "data", "version": 1}},
      "outputs": {"result": {"protocol": "review", "version": 1}},
      "submission": {"required": ["result"]}
    }
  },
  "modules": {
    "route": {
      "type": "router",
      "trigger": "each",
      "inputs": {"review": {"protocol": "review", "version": 1}},
      "outputs": {"rework": {"protocol": "data", "version": 1}, "approved": {"protocol": "review", "version": 1}},
      "rules": [
        {"when": "review.passed == false", "emit": {"rework": "$review"}},
        {"when": "review.passed == true", "emit": {"approved": "$review"}}
      ]
    }
  },
  "edges": {
    "review": {"from": "worker.result", "to": "reviewer.job", "enabled": true},
    "decision": {"from": "reviewer.result", "to": "route.review", "enabled": true},
    "rework": {"from": "route.rework", "to": "worker.job", "enabled": true}
  },
  "inputs": {"job": {"to": "worker.job", "protocol": "data", "version": 1}},
  "outputs": {"result": {"from": "route.approved", "protocol": "review", "version": 1}}
}
```

## 子图复用与一次汇合

两个实例共享定义，各自拥有会话、队列和路由状态；产物空间属于顶层 graph。公开接口明确映射，子图不增加 agent 执行或隐含等待。join 收齐通过后只触发一次；显式 reopen 或 control 投递保留输入，等待下一条投递再判断。

```json
{
  "schemaVersion": 2,
  "name": "两条独立子图与一次汇合",
  "protocols": {
    "data": {"type": "object"},
    "review": {
      "type": "object",
      "required": ["passed", "reason"],
      "properties": {
        "passed": {"type": "boolean"},
        "reason": {"type": "string"},
        "artifactId": {"type": "string"},
        "version": {"type": "integer"},
        "commit": {"type": "string"}
      }
    }
  },
  "nodes": {},
  "templates": {
    "draft-review": {
      "version": 1,
      "definition": {
        "schemaVersion": 2,
        "name": "撰写与审查",
        "protocols": {
          "data": {"type": "object"},
          "review": {
            "type": "object",
            "required": ["passed", "reason"],
            "properties": {
              "passed": {"type": "boolean"},
              "reason": {"type": "string"},
              "artifactId": {"type": "string"},
              "version": {"type": "integer"},
              "commit": {"type": "string"}
            }
          }
        },
        "nodes": {
          "worker": {
            "recipe": "worker@1",
            "task": "按 job 撰写或修订方案，发布稳定版本，通过 result 提交产物 ID、版本和工作摘要。",
            "inputs": {"job": {"protocol": "data", "version": 1}},
            "outputs": {"result": {"protocol": "data", "version": 1}},
            "submission": {"required": ["result"]}
          },
          "reviewer": {
            "recipe": "reviewer@1",
            "task": "读取 job 的精确产物版本，发布审查报告，通过 result 提交 passed、reason 和审查产物引用。",
            "inputs": {"job": {"protocol": "data", "version": 1}},
            "outputs": {"result": {"protocol": "review", "version": 1}},
            "submission": {"required": ["result"]}
          }
        },
        "modules": {
          "route": {
            "type": "router",
            "trigger": "each",
            "inputs": {"review": {"protocol": "review", "version": 1}},
            "outputs": {"rework": {"protocol": "data", "version": 1}, "approved": {"protocol": "review", "version": 1}},
            "rules": [
              {"when": "review.passed == false", "emit": {"rework": "$review"}},
              {"when": "review.passed == true", "emit": {"approved": "$review"}}
            ]
          }
        },
        "edges": {
          "review": {"from": "worker.result", "to": "reviewer.job", "enabled": true},
          "decision": {"from": "reviewer.result", "to": "route.review", "enabled": true},
          "rework": {"from": "route.rework", "to": "worker.job", "enabled": true}
        },
        "inputs": {"job": {"to": "worker.job", "protocol": "data", "version": 1}},
        "outputs": {"result": {"from": "route.approved", "protocol": "review", "version": 1}}
      }
    }
  },
  "instances": {"first": {"template": "draft-review", "version": 1}, "second": {"template": "draft-review", "version": 1}},
  "modules": {
    "join": {
      "type": "router",
      "trigger": "once",
      "requiredInputs": ["first", "second"],
      "control": {"reopen": "control"},
      "inputs": {
        "first": {"protocol": "review", "version": 1},
        "second": {"protocol": "review", "version": 1},
        "control": {"protocol": "data", "version": 1}
      },
      "outputs": {"summary": {"protocol": "data", "version": 1}},
      "rules": [{"when": "first.passed == true && second.passed == true", "emit": {"summary": {"first": "$first", "second": "$second"}}}]
    }
  },
  "edges": {
    "first-reviewed": {"from": "first.result", "to": "join.first", "enabled": true},
    "second-reviewed": {"from": "second.result", "to": "join.second", "enabled": true}
  },
  "inputs": {"first": {"to": "first.job", "protocol": "data", "version": 1}, "second": {"to": "second.job", "protocol": "data", "version": 1}},
  "outputs": {"result": {"from": "join.summary", "protocol": "data", "version": 1}}
}
```

## 产物与 Git 交付

通过 submit 传递 artifactId 和精确 version；读取稳定的已发布内容。修改产生新版本，默认 agent 只修订自己的产物，main 可协调所有产物。必需文件可声明 deliverable，文件缺失导致交付失败；额外产物由 agent 调用 artifact_publish。

代码任务使用 targetBranch 与独立 worktree，代码产物记录完整 commit；worktree 路径只用于访问。正式草稿使用 propose_graph，外层 acceptance 与 definition.acceptance 对齐，decisions 显式给出。Git 交付必须声明宿主 operation 检查与独立审查，验收绑定当前干净 commit；需要用户验收时另加 human 条件。路由保留旧通过不产生新 commit 的审查证据。

运行中使用 graph_patch 的 baseRevision 和局部 patch，配置从下一次执行生效。禁用边只阻止后续投递，已入队输入继续执行。删除节点需明确 retire 并先处理待执行、运行中及失败待处理工作。检查配置冻结、未知用量处理及自定义模块隔离见管理入口。
