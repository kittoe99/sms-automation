export function shouldRefreshFromBackground({view, automationBuilderOpen, aiBuilderOpen, focusedInForm, hasDirtyForm}) {
  return view !== 'ai-instructions' && !automationBuilderOpen && !aiBuilderOpen
    && !focusedInForm && !hasDirtyForm;
}

