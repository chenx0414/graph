import { useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, type Node, type Edge } from '@xyflow/react';
import { GRAPH_ARCHITECTURES } from '../catalog/architecture-catalog.ts';

const examples: { labels: string[]; links: [number,number,string?][]; notes: string[] }[] = [
  { labels:['实现','检查','交付'],links:[[0,1],[1,2]],notes:['完成实现并提交产物。','检查上一步的实现结果。','汇总已验证的产物。'] },
  { labels:['判断条件','分支 A','分支 B'],links:[[0,1,'条件 A'],[0,2,'条件 B']],notes:['由实际输入决定执行分支。','条件 A 匹配时执行。','条件 B 匹配时执行。'] },
  { labels:['拆分','子任务 A','子任务 B','汇合'],links:[[0,1],[0,2],[1,3],[2,3]],notes:['拆分相互独立的工作。','与另一子任务并行。','使用独立上下文执行。','等待所有必需结果后继续。'] },
  { labels:['采集','转换','验证','输出'],links:[[0,1],[1,2],[2,3]],notes:['输入进入第一阶段。','加工前序产物。','验证转换结果。','交付通过验证的结果。'] },
  { labels:['主管','工人 A','工人 B'],links:[[0,1,'派发'],[0,2,'派发'],[1,0,'汇报'],[2,0,'汇报']],notes:['协调任务、汇总工人结果。','在自己的工作副本中执行。','与其他工人独立执行。'] },
  { labels:['优化器','评估器','通过'],links:[[0,1,'提交'],[1,0,'反馈'],[1,2,'达标']],notes:['依据反馈迭代实现。','检查是否达到验收要求。','满足条件后结束循环。'] },
  { labels:['实现者','审查者','验证通过'],links:[[0,1,'证据'],[1,0,'有效反例'],[1,2,'无阻塞']],notes:['提供实现与验证证据。','主动寻找能证明失败的反例。','阻塞反例处理完毕才可通过。'] },
  { labels:['候选结果','视角 A','视角 B','评委'],links:[[0,1],[0,2],[1,3],[2,3]],notes:['提供待评估的共同输入。','独立评价一个维度。','独立评价另一个维度。','按明确规则汇总评估。'] },
];
export function architectureExample(index: number): { nodes: Node[]; edges: Edge[] } {
  const example=examples[index]!;
  const parallel=[1,2,4,7].includes(index);
  return {nodes:example.labels.map((label,i)=>({id:String(i),data:{label},position: parallel ? {x:i===0?0:i===3?560:280,y:i===1?0:i===2?160:80} : {x:i*240,y:80},style:{width:160,borderRadius:14,padding:18,border:'1px solid #d8dee6',background:i===0?'#eef5ff':'#fff'},sourcePosition:'right' as never,targetPosition:'left' as never})),edges:example.links.map(([source,target,label],i)=>({id:String(i),source:String(source),target:String(target),...(label?{label}:{}),type:'smoothstep',markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:'#7b8ba4'},...(target<source?{style:{stroke:'#6b82ac',strokeDasharray:'5 4'}}:{})}))};
}
export function ArchitectureBoard() {
  const [selected,setSelected]=useState(0);
  const [node,setNode]=useState<number|null>(null);
  const architecture=GRAPH_ARCHITECTURES[selected]!;
  const graph=architectureExample(selected);
  return <div className="architecture-board" data-testid="architecture-library">
    <nav className="architecture-picker" aria-label="架构类型">{GRAPH_ARCHITECTURES.map((item,i)=><button key={item.name} aria-pressed={selected===i} onClick={()=>{setSelected(i);setNode(null);}}><span className="architecture-number">{String(i+1).padStart(2,'0')}</span>{item.name}</button>)}</nav>
    <section className="architecture-stage">
      <header><h2>{architecture.name}</h2><p>{architecture.description}</p></header>
      <div className="architecture-canvas" data-testid="architecture-canvas">
        <ReactFlow key={selected} nodes={graph.nodes} edges={graph.edges} fitView fitViewOptions={{padding:0.35}} minZoom={0.3} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_event,chosen)=>setNode(Number(chosen.id))} proOptions={{hideAttribution:true}}><Background gap={22} size={1}/><Controls showInteractive={false}/></ReactFlow>
      </div>
      <footer aria-live="polite">{node===null ? '点击节点查看职责 · 滚轮缩放，拖动画布' : <><strong>{examples[selected]!.labels[node]}</strong>　{examples[selected]!.notes[node]}</>}</footer>
    </section>
  </div>;
}
