function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase();
}

export function createWorkspaceSwitcher(root, onSelect) {
  const trigger = root.querySelector('.workspace-switcher');
  const avatar = trigger.querySelector('.workspace-avatar');
  const name = trigger.querySelector('#workspace-name');
  const options = root.querySelector('#workspace-options');
  let switching = false;

  function close({restoreFocus = false} = {}) {
    if (options.hidden) return;
    options.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  function open() {
    if (trigger.disabled || switching) return;
    options.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  trigger.addEventListener('click', () => options.hidden ? open() : close());
  root.addEventListener('focusout', event => {
    if (event.relatedTarget && !root.contains(event.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', event => {
    if (!root.contains(event.target)) close();
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !options.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close({restoreFocus:true});
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const choices = Array.from(options.children);
    if (event.target === trigger) {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      open();
      if (!options.hidden) (event.key === 'ArrowDown' ? choices[0] : choices.at(-1))?.focus();
      return;
    }
    const index = choices.indexOf(event.target);
    if (index < 0 || options.hidden) return;
    event.preventDefault();
    const next = {ArrowDown:(index + 1) % choices.length, ArrowUp:(index + choices.length - 1) % choices.length, Home:0, End:choices.length - 1};
    choices[next[event.key]].focus();
  });

  function update(tenants, active) {
    close({restoreFocus:options.contains(document.activeElement)});
    const activeName = active?.name || active?.shortName || '';
    name.textContent = activeName || 'No business workspace';
    avatar.textContent = initials(activeName);
    trigger.title = activeName;
    trigger.disabled = tenants.length < 2;
    options.replaceChildren(...tenants.map(tenant => {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = 'workspace-choice';
      choice.textContent = tenant.name || tenant.shortName;
      const selected = tenant.id === active?.id;
      if (selected) choice.setAttribute('aria-current', 'true');
      choice.addEventListener('click', async () => {
        close({restoreFocus:true});
        if (selected || switching) return;
        switching = true;
        try {
          await onSelect(tenant.id);
        } finally {
          switching = false;
        }
      });
      return choice;
    }));
  }

  return {update, close};
}
