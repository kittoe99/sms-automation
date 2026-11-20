export async function mountPhraseVocabulary(host, {apiFetch}) {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="vocabulary">
      <div class="vocabulary-toolbar vocabulary-actions">
        <button id="import-library" class="btn ghost" type="button" disabled>Import local library</button>
        <input id="import-file" type="file" accept=".json,application/json" hidden />
        <button id="add-entry" class="btn primary" type="button" disabled>Add entry</button>
      </div>

      <p id="library-feedback" class="vocabulary-error" role="alert" hidden></p>
      <button id="retry-load" class="btn ghost" type="button" hidden>Retry loading</button>
      <p id="library-status" class="vocabulary-sr-only" role="status"></p>

      <div class="vocabulary-layout">
        <aside class="vocabulary-panel vocabulary-sidebar" aria-labelledby="categories-heading">
          <div class="vocabulary-heading">
            <h2 id="categories-heading">Categories</h2>
            <button id="add-category" class="btn ghost" type="button" disabled>Add category</button>
          </div>
          <div id="category-list" class="vocabulary-categories"></div>
        </aside>

        <section class="vocabulary-panel vocabulary-content" aria-labelledby="entries-heading">
          <div class="vocabulary-heading vocabulary-section-heading">
            <h2 id="entries-heading">All entries</h2>
            <div id="category-actions" class="vocabulary-actions" hidden>
              <button id="edit-category" class="btn ghost" type="button">Rename category</button>
              <button id="delete-category" class="btn vocabulary-danger" type="button">Delete category</button>
            </div>
          </div>
          <div class="vocabulary-filters">
            <label>Search <input id="entry-search" type="search" placeholder="Search text, variations, or context" disabled /></label>
            <label><span id="type-filter-label">Entry type</span>
              <select id="type-filter" aria-labelledby="type-filter-label" disabled>
                <option value="">All types</option>
                <option value="phrase">Phrase</option>
                <option value="rebuttal">Rebuttal</option>
                <option value="instruction">Prompt instruction</option>
              </select>
            </label>
          </div>
          <p id="result-count" class="vocabulary-count" aria-live="polite"></p>
          <p id="empty-library" class="vocabulary-empty">Loading the phrase library…</p>
          <ul id="entry-list" class="vocabulary-entries"></ul>
        </section>
      </div>
    </div>

    <dialog id="library-dialog" class="vocabulary-dialog" aria-labelledby="dialog-title">
      <form id="library-form">
        <h2 id="dialog-title"></h2>
        <fieldset id="dialog-fields">
          <label id="category-field" hidden>Category name <input id="category-name" maxlength="100" /></label>
          <div id="entry-fields" hidden>
            <label><span id="entry-category-label">Category</span> <select id="entry-category" aria-labelledby="entry-category-label"></select></label>
            <label><span id="entry-type-label">Entry type</span>
              <select id="entry-type" aria-labelledby="entry-type-label">
                <option value="phrase">Phrase</option>
                <option value="rebuttal">Rebuttal</option>
                <option value="instruction">Prompt instruction</option>
              </select>
            </label>
            <label>Text <textarea id="entry-text" rows="4"></textarea></label>
            <div id="variation-fields" class="vocabulary-variation-fields" role="group" aria-labelledby="variation-label" hidden>
              <div class="vocabulary-variation-heading">
                <span id="variation-label">Variations <span class="vocabulary-optional">(optional)</span></span>
                <button id="add-variation" class="btn ghost" type="button">Add variation</button>
              </div>
              <div id="variation-inputs"></div>
            </div>
            <label>Context <span class="vocabulary-optional">(optional)</span>
              <textarea id="entry-context" rows="2" placeholder="When to use it or which objection it answers"></textarea>
            </label>
          </div>
        </fieldset>
        <p id="delete-message" hidden></p>
        <p id="dialog-feedback" class="vocabulary-error" role="alert" hidden></p>
        <p id="current-value" class="vocabulary-current" hidden></p>
        <div class="vocabulary-actions vocabulary-dialog-actions">
          <button id="cancel-dialog" class="btn ghost" type="button">Cancel</button>
          <button id="confirm-dialog" class="btn primary" type="submit">Save</button>
        </div>
      </form>
    </dialog>
  `;
  host.replaceChildren(root);

  const API = '/api/phrase-vocabulary';
  async function request(path, options = {}) {
    const response = await apiFetch(path, {...options, tenant:false, cache:'no-store'});
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || 'Could not access Phrase Vocabulary.'), {status:response.status});
    return body;
  }
  const types = { phrase: 'Phrase', rebuttal: 'Rebuttal', instruction: 'Prompt instruction' };
  const $ = (id) => root.querySelector('#' + id);
  const dialog = $('library-dialog');
  const form = $('library-form');
  const categorySelect = $('entry-category');

  let library;
  let selectedCategory = '';
  let edit;
  let saving = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function button(label, style, click) {
    const node = element('button', `btn ${style}`, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }

  function copyButton(label, text) {
    let reset;
    const copy = button(label, 'ghost', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copied';
        announce('Text copied.');
        clearTimeout(reset);
        reset = setTimeout(() => { copy.textContent = label; }, 1500);
      } catch {
        message('library-feedback', 'Clipboard access failed. You can select and copy the text.');
      }
    });
    return copy;
  }

  function message(id, text = '') {
    $(id).textContent = text;
    $(id).hidden = !text;
  }

  function announce(text) {
    $('library-status').textContent = text;
  }

  function entryCount(count) {
    return `${count} ${count === 1 ? 'entry' : 'entries'}`;
  }

  function renderCategories(focus = false) {
    const list = $('category-list');
    const all = [{ id: '', name: 'All entries', entries: library.categories.flatMap((category) => category.entries) }];
    list.replaceChildren(...all.concat(library.categories).map((category) => {
      const node = button(category.name, 'vocabulary-category', () => {
        selectedCategory = category.id;
        renderCategories(true);
        renderEntries();
      });
      const selected = category.id === selectedCategory;
      node.setAttribute('aria-pressed', String(selected));
      node.append(element('span', 'vocabulary-category-count', String(category.entries.length)));
      return node;
    }));
    if (focus) list.querySelector('[aria-pressed="true"]')?.focus();
  }

  function renderEntry(category, entry) {
    const row = element('li', 'vocabulary-entry', '');
    const meta = element('div', 'vocabulary-entry-meta', '');
    meta.append(
      element('span', `vocabulary-type vocabulary-type-${entry.type}`, types[entry.type]),
      element('span', 'vocabulary-entry-category', category.name),
    );

    const actions = element('div', 'vocabulary-actions', '');
    actions.append(
      copyButton('Copy text', entry.text),
      button('Edit', 'ghost', () => openEditor('entry', category, entry)),
      button('Delete', 'vocabulary-danger', () => openEditor('delete-entry', category, entry)),
    );
    row.append(meta, element('p', 'vocabulary-entry-text', entry.text));
    if (entry.context) {
      const context = element('p', 'vocabulary-context', '');
      context.append(element('strong', '', 'Context '), entry.context);
      row.append(context);
    }
    if (entry.variations?.length) {
      const count = entry.variations.length;
      const disclosure = element('details', 'vocabulary-variation-disclosure', '');
      const summary = element('summary', '', `${count} ${count === 1 ? 'variation' : 'variations'}`);
      const list = element('ul', 'vocabulary-variations', '');
      list.setAttribute('aria-label', 'Variations');
      for (const text of entry.variations) {
        const item = element('li', 'vocabulary-variation-row', '');
        item.append(element('p', '', text), copyButton('Copy variation', text));
        list.append(item);
      }
      disclosure.append(summary, list);
      row.append(disclosure);
    }
    row.append(actions);
    return row;
  }

  function renderEntries() {
    const category = library.categories.find(({ id }) => id === selectedCategory);
    const query = $('entry-search').value.trim().toLowerCase();
    const type = $('type-filter').value;
    const scope = category ? [category] : library.categories;
    const rows = scope.flatMap((group) => group.entries
      .filter((entry) => (!type || type === entry.type)
        && (!query || [entry.text, entry.context, ...(entry.variations ?? [])]
          .some((value) => value.toLowerCase().includes(query))))
      .map((entry) => renderEntry(group, entry)));

    $('entries-heading').textContent = category?.name ?? 'All entries';
    $('category-actions').hidden = !category;
    $('result-count').textContent = entryCount(rows.length);
    $('entry-list').replaceChildren(...rows);
    let empty = '';
    if (!rows.length) {
      if (!library.categories.length) empty = 'Create a category to start your library.';
      else if (query || type) empty = 'No entries match these filters.';
      else empty = 'Add an entry to start collecting wording and instructions.';
    }
    message('empty-library', empty);
  }

  function render() {
    if (!library.categories.some(({ id }) => id === selectedCategory)) selectedCategory = '';
    $('add-category').disabled = false;
    $('import-library').disabled = library.categories.length !== 0;
    $('add-entry').disabled = library.categories.length === 0;
    $('entry-search').disabled = false;
    $('type-filter').disabled = false;
    renderCategories();
    renderEntries();
  }

  async function load() {
    $('retry-load').hidden = true;
    message('library-feedback');
    message('empty-library', 'Loading the phrase library…');
    try {
      library = await request(API);
      render();
    } catch (error) {
      if (error.name === 'AbortError' || error.status === 401 || error.status === 403) throw error;
      message('empty-library');
      message('library-feedback', error.message);
      $('retry-load').hidden = false;
    }
  }

  function updateCategoryOptions(preferredId) {
    categorySelect.replaceChildren(new Option('Choose a category', ''));
    for (const category of library.categories) categorySelect.add(new Option(category.name, category.id));
    categorySelect.value = library.categories.some(({ id }) => id === preferredId) ? preferredId : '';
  }

  function updateDeleteMessage() {
    const category = library.categories.find(({ id }) => id === edit.categoryId);
    const entry = category?.entries.find(({ id }) => id === edit.entryId);
    if (edit.mode === 'delete-category' && category) {
      message('delete-message', `Delete “${category.name}” and its ${entryCount(category.entries.length)}?`);
    } else if (entry) {
      message('delete-message', `Delete this ${types[entry.type].toLowerCase()}?\n\n${entry.text}`);
    } else {
      message('delete-message', 'This item was removed in another session.');
    }
  }

  function variationValues() {
    return Array.from($('variation-inputs').querySelectorAll('textarea'), (input) => input.value.trim()).filter(Boolean);
  }

  function updateVariationFields() {
    const isPhrase = $('entry-type').value === 'phrase';
    $('variation-fields').hidden = !isPhrase && !variationValues().length;
    $('add-variation').hidden = !isPhrase;
  }

  function addVariationInput(text = '') {
    const row = element('div', 'vocabulary-variation-row', '');
    const input = element('textarea', '', '');
    input.rows = 2;
    input.value = text;
    input.setAttribute('aria-label', 'Variation wording');
    const remove = button('Remove variation', 'vocabulary-danger', () => {
      const neighbor = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      updateVariationFields();
      const fallback = $('add-variation').hidden ? $('entry-type') : $('add-variation');
      form.dataset.dirty = 'true';
      (neighbor?.querySelector('textarea') ?? fallback).focus();
    });
    row.append(input, remove);
    $('variation-inputs').append(row);
    return input;
  }

  function openEditor(mode, category, entry) {
    edit = { mode, categoryId: mode === 'entry' && !entry ? undefined : category?.id, entryId: entry?.id };
    const deleting = mode.startsWith('delete-');
    const title = {
      category: category ? 'Rename category' : 'Add category',
      entry: entry ? 'Edit entry' : 'Add entry',
      'delete-category': 'Delete category',
      'delete-entry': 'Delete entry',
    };
    form.reset();
    form.dataset.dirty = 'false';
    $('dialog-title').textContent = title[mode];
    $('category-field').hidden = mode !== 'category';
    $('entry-fields').hidden = mode !== 'entry';
    $('category-name').required = mode === 'category';
    $('entry-text').required = mode === 'entry';
    categorySelect.required = mode === 'entry';
    $('category-name').value = category?.name ?? '';
    $('entry-type').value = entry?.type ?? 'phrase';
    $('entry-text').value = entry?.text ?? '';
    $('entry-context').value = entry?.context ?? '';
    $('variation-inputs').replaceChildren();
    for (const text of entry?.variations ?? []) addVariationInput(text);
    updateVariationFields();
    updateCategoryOptions(category?.id ?? library.categories[0]?.id);
    message('dialog-feedback');
    message('current-value');
    message('delete-message');
    if (deleting) updateDeleteMessage();
    $('confirm-dialog').textContent = deleting ? 'Delete' : 'Save';
    $('confirm-dialog').classList.toggle('vocabulary-delete', deleting);
    dialog.showModal();
    $(deleting ? 'cancel-dialog' : mode === 'category' ? 'category-name' : 'entry-text').focus();
  }

  function changeLibrary(next) {
    const { mode, categoryId, entryId } = edit;
    const category = next.categories.find(({ id }) => id === categoryId);
    const entry = category?.entries.find(({ id }) => id === entryId);
    if ((categoryId && !category) || (entryId && !entry)) {
      throw new Error('This item was removed or moved. Close this form and reopen it from the library.');
    }

    if (mode === 'category') {
      const name = $('category-name').value.trim();
      if (!name) throw new Error('Enter a category name.');
      if (category) category.name = name;
      else {
        const id = crypto.randomUUID();
        next.categories.push({ id, name, entries: [] });
        return id;
      }
    }
    if (mode === 'entry') {
      const type = $('entry-type').value;
      const text = $('entry-text').value.trim();
      const variations = variationValues();
      const destination = next.categories.find(({ id }) => id === categorySelect.value);
      if (!text) throw new Error('Enter the text for this entry.');
      if (!destination) throw new Error('Choose a category.');
      if (type !== 'phrase' && variations.length) throw new Error('Remove the variations before changing the entry type.');
      const values = { type, text, context: $('entry-context').value.trim(), variations };
      if (category === destination && entry) Object.assign(entry, values);
      else {
        if (entry) category.entries = category.entries.filter(({ id }) => id !== entryId);
        destination.entries.push({ id: entryId ?? crypto.randomUUID(), ...values });
      }
      return selectedCategory ? destination.id : '';
    }
    if (mode === 'delete-category') next.categories = next.categories.filter(({ id }) => id !== categoryId);
    if (mode === 'delete-entry') category.entries = category.entries.filter(({ id }) => id !== entryId);
    return selectedCategory;
  }

  async function reloadAfterConflict() {
    const preferredId = categorySelect.value;
    library = await request(API);
    render();
    updateCategoryOptions(preferredId);
    const category = library.categories.find(({ id }) => id === edit.categoryId);
    const entry = category?.entries.find(({ id }) => id === edit.entryId);
    if (edit.mode.startsWith('delete-')) {
      updateDeleteMessage();
      message('dialog-feedback', 'The library changed. Review the updated deletion before confirming.');
      return;
    }
    const current = entry
      ? [types[entry.type], entry.text, ...(entry.variations ?? []).map((text) => `Variation\n${text}`), entry.context]
        .filter(Boolean).join('\n\n')
      : category && edit.mode === 'category' ? category.name : '';
    message('current-value', current ? `Currently saved\n\n${current}` : '');
    message('dialog-feedback', 'The library changed. Your draft is still here. Review it before saving again.');
  }

  $('import-library').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const input = $('import-file');
    const file = input.files[0];
    input.value = '';
    if (!file || saving || library.categories.length) return;
    saving = true;
    $('add-category').disabled = $('import-library').disabled = true;
    message('library-feedback');
    try {
      if (file.size > 500_000) throw new Error('Choose a library file under 500 KB.');
      const document = JSON.parse(await file.text());
      if (document?.version !== 1 || !Array.isArray(document.categories)) {
        throw new Error('Choose the phrase-vocabulary.json file from Voice Lab.');
      }
      library = await request(API, {method:'PUT', body:JSON.stringify({...library, categories:document.categories})});
      announce('Library imported.');
    } catch (error) {
      if (error.status === 409) {
        try { library = await request(API); } catch { /* The import has not been applied. */ }
      }
      message('library-feedback', error.message);
    } finally {
      saving = false;
      render();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const next = structuredClone(library);
    message('dialog-feedback');
    let selection;
    try {
      selection = changeLibrary(next);
    } catch (error) {
      message('dialog-feedback', error.message);
      return;
    }

    saving = true;
    $('dialog-fields').disabled = $('cancel-dialog').disabled = $('confirm-dialog').disabled = true;
    try {
      library = await request(API, { method: 'PUT', body: JSON.stringify(next) });
      selectedCategory = selection;
      dialog.close();
      message('library-feedback');
      render();
      const categoryEdit = edit.mode.endsWith('category');
      $(categoryEdit ? 'add-category' : 'add-entry').focus();
      announce(edit.mode.startsWith('delete-') ? 'Deleted.' : 'Saved.');
    } catch (error) {
      message('dialog-feedback', error.message);
      if (error.status === 409) {
        try {
          await reloadAfterConflict();
        } catch (loadError) {
          message('dialog-feedback', `Could not refresh the library. Your draft is still here. ${loadError.message}`);
        }
      }
    } finally {
      $('dialog-fields').disabled = $('cancel-dialog').disabled = $('confirm-dialog').disabled = false;
      saving = false;
      if (dialog.open) $('confirm-dialog').focus();
    }
  });

  form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
  dialog.addEventListener('close', () => { form.dataset.dirty = 'false'; });
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  $('cancel-dialog').addEventListener('click', () => dialog.close());
  $('add-variation').addEventListener('click', () => addVariationInput().focus());
  $('entry-type').addEventListener('change', updateVariationFields);
  $('add-category').addEventListener('click', () => openEditor('category'));
  $('add-entry').addEventListener('click', () => openEditor('entry', library.categories.find(({ id }) => id === selectedCategory)));
  $('edit-category').addEventListener('click', () => openEditor('category', library.categories.find(({ id }) => id === selectedCategory)));
  $('delete-category').addEventListener('click', () => openEditor('delete-category', library.categories.find(({ id }) => id === selectedCategory)));
  $('entry-search').addEventListener('input', renderEntries);
  $('type-filter').addEventListener('change', renderEntries);
  $('retry-load').addEventListener('click', () => {
    load().catch(error => message('library-feedback', error.message));
  });
  await load();
}
