export interface GraphArchitecture {
  name: string;
  flow: string;
  description: string;
}

export const GRAPH_ARCHITECTURES: readonly GraphArchitecture[] = [
  { name: '顺序执行', flow: 'A → B → C', description: '每一步使用前一步产物，适合依赖明确的实现与检查流程。' },
  { name: '条件路由', flow: 'A → B / C', description: '先判断输入或状态，再把任务交给一条匹配的分支。' },
  { name: '扇出与汇合', flow: 'A → B,C → D', description: '独立子任务并行执行，在汇合点统一等待必需结果。' },
  { name: '流水线', flow: 'A → B → C…', description: '固定阶段持续传递产物，适合采集、转换、验证等连续工序。' },
  { name: '主管与工人', flow: 'M ⇄ W1,W2', description: '主管拆分和协调，工人在各自上下文与工作副本中完成局部任务。' },
  { name: '评估与优化', flow: 'A ⇄ E', description: '评估器给出可执行反馈，优化器修改后重新进入验证。' },
  { name: '对抗式验证', flow: 'W ⇄ R', description: '审查者主动寻找反例和证据，有效反例会阻塞通过。' },
  { name: '多视角与评委', flow: 'W → J1,J2 → J', description: '多个维度独立判断，再由评委按硬性规则汇总结果。' },
];
