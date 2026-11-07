package graph

type GraphArchitecture struct {
	Name        string `json:"name"`
	Flow        string `json:"flow"`
	Description string `json:"description"`
}

var GRAPH_ARCHITECTURES = []GraphArchitecture{
	{Name: "顺序执行", Flow: "A → B → C", Description: "每一步使用前一步产物，适合依赖明确的实现与检查流程。"},
	{Name: "条件路由", Flow: "A → B / C", Description: "先判断输入或状态，再把任务交给一条匹配的分支。"},
	{Name: "扇出与汇合", Flow: "A → B,C → D", Description: "独立子任务并行执行，在汇合点统一等待必需结果。"},
	{Name: "流水线", Flow: "A → B → C…", Description: "固定阶段持续传递产物，适合采集、转换、验证等连续工序。"},
	{Name: "主管与工人", Flow: "M ⇄ W1,W2", Description: "主管拆分和协调，工人在各自上下文与工作副本中完成局部任务。"},
	{Name: "评估与优化", Flow: "A ⇄ E", Description: "评估器给出可执行反馈，优化器修改后重新进入验证。"},
	{Name: "对抗式验证", Flow: "W ⇄ R", Description: "审查者主动寻找反例和证据，有效反例会阻塞通过。"},
	{Name: "多视角与评委", Flow: "W → J1,J2 → J", Description: "多个维度独立判断，再由评委按硬性规则汇总结果。"},
}
