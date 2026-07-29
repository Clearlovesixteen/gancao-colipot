import { AutomationStep } from './automationTypes';
import { BLOCK_DEFINITIONS, BlockDefinition } from './blockDefs';

export function getBlockDef(type: AutomationStep['type']): BlockDefinition {
  return BLOCK_DEFINITIONS.find(d => d.id === type) || BLOCK_DEFINITIONS[0];
}

export function createDefaultStep(def: BlockDefinition): AutomationStep {
  const step: any = { type: def.id };
  def.fields.forEach(f => {
    if (f.defaultValue !== undefined) {
      step[f.name] = f.defaultValue;
    }
  });
  // 特殊默认值处理（如果 schema 没覆盖到的）
  if (def.id === 'wait' && !step.ms) step.ms = 500;
  return step as AutomationStep;
}
