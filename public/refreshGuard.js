export function shouldRefreshFromBackground({view, automationBuilderOpen, aiBuilderOpen, focusedInForm, hasDirtyForm}) {
  return view !== 'ai-instructions' && !view.startsWith('platform-') && !automationBuilderOpen && !aiBuilderOpen
    && !focusedInForm && !hasDirtyForm;
}
