import type {
  ComputerUseResumeCheckpoint,
  ComputerUseRunState,
  ComputerUseTaskPlan,
} from '../../../shared/automation/automationTypes';

function cloneRunState(runState: ComputerUseRunState): ComputerUseRunState {
  return {
    currentPhaseIndex: runState.currentPhaseIndex,
    completedPhases: runState.completedPhases.map((item) => ({
      ...item,
      phase: {
        ...item.phase,
        targets: item.phase.targets ? [...item.phase.targets] : undefined,
        navigationPath: item.phase.navigationPath ? [...item.phase.navigationPath] : undefined,
        formValues: item.phase.formValues?.map((field) => ({ ...field })),
      },
      evidence: item.evidence
        ? {
          ...item.evidence,
          activeTexts: item.evidence.activeTexts ? [...item.evidence.activeTexts] : undefined,
          matchedTargets: item.evidence.matchedTargets ? [...item.evidence.matchedTargets] : undefined,
          matchedNavigationPath: item.evidence.matchedNavigationPath ? [...item.evidence.matchedNavigationPath] : undefined,
          visibleActionPurposes: item.evidence.visibleActionPurposes ? [...item.evidence.visibleActionPurposes] : undefined,
        }
        : undefined,
    })),
    downloadResult: runState.downloadResult ? { ...runState.downloadResult } : undefined,
    warnings: runState.warnings ? [...runState.warnings] : undefined,
    browserSession: runState.browserSession
      ? {
        ...runState.browserSession,
        tabs: runState.browserSession.tabs.map((tab) => ({ ...tab })),
      }
      : undefined,
    outputs: runState.outputs ? { ...runState.outputs } : undefined,
  };
}

function cloneTaskPlan(taskPlan: ComputerUseTaskPlan): ComputerUseTaskPlan {
  return {
    ...taskPlan,
    phases: taskPlan.phases.map((phase) => ({
      ...phase,
      targets: phase.targets ? [...phase.targets] : undefined,
      navigationPath: phase.navigationPath ? [...phase.navigationPath] : undefined,
      formValues: phase.formValues?.map((field) => ({ ...field })),
    })),
  };
}

export function createComputerUseResumeCheckpoint(input: {
  goal: string;
  taskPlan?: ComputerUseTaskPlan;
  runState?: ComputerUseRunState;
  phaseIndex?: number;
  lastPageUrl?: string;
  createdAt?: number;
}): ComputerUseResumeCheckpoint | undefined {
  if (!input.taskPlan || !input.runState || input.taskPlan.phases.length === 0) return undefined;

  const requestedPhaseIndex = Number.isFinite(input.phaseIndex)
    ? Number(input.phaseIndex)
    : input.runState.currentPhaseIndex;
  const phaseIndex = Math.max(0, Math.min(requestedPhaseIndex, input.taskPlan.phases.length - 1));

  return {
    goal: input.goal,
    taskPlan: cloneTaskPlan(input.taskPlan),
    phaseIndex,
    runState: cloneRunState({ ...input.runState, currentPhaseIndex: phaseIndex }),
    lastPageUrl: input.lastPageUrl,
    createdAt: input.createdAt ?? Date.now(),
  };
}
