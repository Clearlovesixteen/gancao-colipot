import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, { 
  addEdge, 
  updateEdge,
  Background, 
  Controls, 
  Connection, 
  Edge, 
  Node, 
  useNodesState, 
  useEdgesState,
  ReactFlowProvider,
  Panel,
  MarkerType,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import CustomNode from './CustomNode';
import { Button, message } from 'antd';
import { LayoutOutlined } from '@ant-design/icons';
import type { AutomationStep } from '../../../shared/automationTypes';
import { createDefaultStep, getBlockDef } from '../../../shared/blockHelpers';

const nodeTypes = {
  custom: CustomNode,
};

interface WorkflowGraphProps {
  steps: AutomationStep[];
  onStepsChange: (steps: AutomationStep[]) => void;
  onSelectStep: (index: number) => void;
  selectedStepIndex: number;
}

const generateInitialGraph = (steps: AutomationStep[]) => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  
  // Start Node
  nodes.push({
    id: 'start',
    type: 'input',
    data: { label: 'Trigger' },
    position: { x: 50, y: 150 },
    style: { 
      background: '#fff', 
      border: '1px solid #d9d9d9', 
      borderRadius: 4, 
      width: 120, 
      padding: 8,
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      fontWeight: 'bold'
    }
  });

  let lastId = 'start';
  
  steps.forEach((step, index) => {
   
    const id = step.id || `step-${Date.now()}-${index}`;
    step.id = id;

    nodes.push({
      id,
      type: 'custom',
      data: { step, index },
      position: { x: 250 + index * 300, y: 150 },
    });

    edges.push({
      id: `e-${lastId}-${id}`,
      source: lastId,
      target: id,
      type: 'default', // Bezier curve
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#888', strokeWidth: 2 }
    });

    lastId = id;
  });

  return { nodes, edges };
};

// 用 BFS/DFS 遍历，构建单链表
const serializeGraphToSteps = (nodes: Node[], edges: Edge[]): AutomationStep[] => {
  const steps: AutomationStep[] = [];
  
  const findNextNodeId = (currentId: string): string | undefined => {
    const edge = edges.find(e => e.source === currentId);
    return edge?.target;
  };

  let currentId = 'start';
  // 防止死循环 (简单环检测)
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const nextId = findNextNodeId(currentId);
    if (!nextId) break;

    const nextNode = nodes.find(n => n.id === nextId);
    if (nextNode && nextNode.data?.step) {
      steps.push({ ...nextNode.data.step, id: nextId }); // 保留 ID
      currentId = nextId;
    } else {
      break;
    }
  }

  return steps;
};

const WorkflowGraphInner: React.FC<WorkflowGraphProps> = ({ steps, onStepsChange, onSelectStep, selectedStepIndex }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { project, getNodes, getEdges } = useReactFlow();

  // 初始化图表
  useEffect(() => {
    if (!isInitialized && steps.length >= 0) {
      const { nodes: initNodes, edges: initEdges } = generateInitialGraph(steps);
      setNodes(initNodes);
      setEdges(initEdges);
      setIsInitialized(true);
    }
  }, [isInitialized]); 


  useEffect(() => {
    if (!isInitialized) return;
    
    // 简单的同步策略：如果 Graph 里的有效步骤数 != steps.length，说明不一致
    const currentNodes = getNodes();
    const currentEdges = getEdges();
    const graphSteps = serializeGraphToSteps(currentNodes, currentEdges);
    
    // 如果外部 steps 变了，且与图计算出的不一致
    const graphIds = new Set(graphSteps.map(s => s.id));
    const stepIds = new Set(steps.map(s => s.id));
    
    let needsSync = false;
    if (graphIds.size !== stepIds.size) {
      needsSync = true;
    } else {
      // 检查是否有 ID 不在 Graph 中
      for (const id of stepIds) {
        if (!graphIds.has(id)) {
          needsSync = true;
          break;
        }
      }
    }

    if (needsSync) {
      // 重新生成图
      const { nodes: newNodes, edges: newEdges } = generateInitialGraph(steps);
      setNodes(newNodes);
      setEdges(newEdges);
    } else {
      // 原地更新 Node Data
      const stepMap = new Map(steps.map(s => [s.id, s]));
      setNodes(nds => nds.map(node => {
        if (node.id === 'start') return node;
        const newStep = stepMap.get(node.id);
        // 如果找到了对应的 step，更新 data
        if (newStep) {
          return { ...node, data: { ...node.data, step: newStep } };
        }
        return node;
      }));
    }
  }, [steps, isInitialized, getNodes, getEdges, setNodes, setEdges]);

  // 当图变化时，尝试同步回 steps
  
  const syncToSteps = useCallback((currentNodes: Node[], currentEdges: Edge[]) => {
    const newSteps = serializeGraphToSteps(currentNodes, currentEdges);
    // 只有当 steps 数量或顺序变化时才触发 onStepsChange，避免循环更新
    // 这里简单比对一下长度，或者直接触发（父组件要注意不要回环导致重绘 Graph）
    // 为了防止父组件重传 steps 导致 Graph 重置，我们在 useEffect 里加了 isInitialized 锁
    onStepsChange(newSteps);
  }, [onStepsChange]);

  // 监听连线变化
  const onConnect = useCallback((params: Connection) => {
    // 自动替换旧的连线
    let newEdges: Edge[] = [];
    setEdges((eds) => {
     
      const filtered = eds.filter(e => e.source !== params.source && e.target !== params.target);
      newEdges = addEdge({ ...params, type: 'default', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#888', strokeWidth: 2 } }, filtered);
      return newEdges;
    });
    
    setTimeout(() => syncToSteps(nodes, newEdges), 0);
  }, [setEdges, syncToSteps, nodes]);

  // 监听连线更新 (拖拽调整)
  const onEdgeUpdate = useCallback((oldEdge: Edge, newConnection: Connection) => {
    setEdges((eds) => {
     
      const filtered = eds.filter(e => 
        e.id !== oldEdge.id && // 不包括自己
        (e.source !== newConnection.source && e.target !== newConnection.target) // 移除冲突
      );
      
     
      const nextEdges = updateEdge(oldEdge, newConnection, filtered);
      
      
      setTimeout(() => syncToSteps(nodes, nextEdges), 0);
      return nextEdges;
    });
  }, [setEdges, syncToSteps, nodes]);

  // 监听边删除
  const onEdgesDelete = useCallback((deleted: Edge[]) => {
     setTimeout(() => {
       setEdges(eds => {
         syncToSteps(nodes, eds);
         return eds;
       });
     }, 0);
  }, [syncToSteps, nodes, setEdges]);

  // 监听节点删除
  const onNodesDelete = useCallback((deleted: Node[]) => {
    setTimeout(() => {
      setNodes(nds => {
        // 同时删除相关边 (ReactFlow 默认会删，但我们需要最新的 edges 来同步)
        setEdges(eds => {
          syncToSteps(nds, eds);
          return eds;
        });
        return nds;
      });
    }, 0);
  }, [syncToSteps, setNodes, setEdges]);


  // 处理拖放
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      if (typeof type === 'undefined' || !type) {
        return;
      }

      const position = project({
        x: event.clientX - (reactFlowWrapper.current?.getBoundingClientRect().left ?? 0),
        y: event.clientY - (reactFlowWrapper.current?.getBoundingClientRect().top ?? 0),
      });

      // 初始化完整数据
      const def = getBlockDef(type as any);
      const defaultStep = createDefaultStep(def);
      const stepWithId = { ...defaultStep, id: `step-${Date.now()}` };

      const newNode: Node = {
        id: stepWithId.id,
        type: 'custom',
        position,
        data: { 
          step: stepWithId, 
          index: nodes.length 
        },
      };

      setNodes((nds) => {
        const nextNodes = nds.concat(newNode);
        return nextNodes;
      });

      // 尝试自动连接：找到最后一个没有出边的节点，连接到新节点
      // 注意：这只是一个简单的启发式策略，假设用户想把新节点加到末尾
      const hasOutgoing = new Set(edges.map(e => e.source));
      // 排除 start 节点如果它已经有出边
      // 实际上我们想要找到最末端的那个节点
      
      // 更严谨的逻辑：
      // 1. 找到所有 currentNodes 中，不在 edges.source 中的节点
      // 2. 如果只有一个（通常是最后一个步骤），就连上去
      // 3. 如果有多个（分支情况），或者没有（不可能，至少有start），取最后一个被添加的？
      
      // 简单起见：取 nodes 列表中最后一个（除了新加的这个），且它不是新加的这个
      const lastNode = nodes[nodes.length - 1];
      
      if (lastNode && !hasOutgoing.has(lastNode.id)) {
        const newEdge: Edge = {
          id: `e-${lastNode.id}-${newNode.id}`,
          source: lastNode.id,
          target: newNode.id,
          type: 'default',
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: '#888', strokeWidth: 2 }
        };
        
        setEdges(eds => {
           const nextEdges = eds.concat(newEdge);
           // 立即同步，这样新节点就会进入 steps 列表，从而可以被选中配置
           setTimeout(() => syncToSteps(nodes.concat(newNode), nextEdges), 0);
           return nextEdges;
        });
      }
    },
    [project, setNodes, nodes, edges, setEdges, syncToSteps]
  );
  
  // 选中同步
  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    
    if (node.id === 'start') return;
    
    // 重新计算当前的 steps 列表，找到该节点的位置
    const currentSteps = serializeGraphToSteps(nodes, edges);
    const idx = currentSteps.findIndex(s => s.id === node.id);
    if (idx !== -1) {
      onSelectStep(idx);
    }
  }, [nodes, edges, onSelectStep]);

  // 外部 selectedStepIndex 变化时高亮
  useEffect(() => {
   
    const currentNodes = getNodes();
    const currentEdges = getEdges();
    
    const currentSteps = serializeGraphToSteps(currentNodes, currentEdges);
    const targetStep = currentSteps[selectedStepIndex];
    
    if (targetStep && targetStep.id) {
       setNodes((nds) => 
        nds.map((node) => {
          const shouldSelect = node.id === targetStep.id;
          if (node.selected !== shouldSelect) {
            return { ...node, selected: shouldSelect };
          }
          return node;
        })
      );
    }
  }, [selectedStepIndex, setNodes, getNodes, getEdges]); 

  // 校验连接 ，防止自环，允许替换现有连接
  const isValidConnection = useCallback((connection: Connection) => {
    
    return connection.source !== connection.target;
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', background: '#f0f2f5' }} ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeUpdate={onEdgeUpdate}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={onNodeClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background gap={20} size={1} />
        <Controls />
        <Panel position="top-right">
           <Button size="small" icon={<LayoutOutlined />} onClick={() => {
             const { nodes: newNodes, edges: newEdges } = generateInitialGraph(serializeGraphToSteps(nodes, edges));
             setNodes(newNodes);
             setEdges(newEdges);
           }}>
             整理布局
           </Button>
        </Panel>
      </ReactFlow>
    </div>
  );
};

const WorkflowGraph: React.FC<WorkflowGraphProps> = (props) => (
  <ReactFlowProvider>
    <WorkflowGraphInner {...props} />
  </ReactFlowProvider>
);

export default WorkflowGraph;
