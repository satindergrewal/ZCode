interface TaskFindNavigationState {
  activeIndex: number;
  navigationRequestId: number;
  query: string;
}

export function createTaskFindNavigationState(): TaskFindNavigationState {
  return {
    activeIndex: -1,
    navigationRequestId: 0,
    query: "",
  };
}

export function changeTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId,
    query,
  };
}

export function navigateTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  // Wraparound on a single hit keeps query/index unchanged, so navigation identity must bump in
  // the state layer itself. Transition all three values together so future edits cannot split
  // them across App setters.
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId + 1,
    query,
  };
}
