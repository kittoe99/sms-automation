export function shouldRefreshFromBackground({view, automationBuilderOpen, aiBuilderOpen, focusedInForm, hasDirtyForm}) {
  return !['ai-instructions','inbound-ai'].includes(view) && !view.startsWith('platform-') && !automationBuilderOpen && !aiBuilderOpen
    && !focusedInForm && !hasDirtyForm;
}
