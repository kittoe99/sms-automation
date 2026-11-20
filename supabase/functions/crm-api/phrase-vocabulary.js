const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const types = new Set(['phrase', 'rebuttal', 'instruction']);

function invalid(message = 'Invalid phrase library.') {
  throw Object.assign(new Error(message), {status:400});
}

function uniqueId(value, seen) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid('Invalid library ID.');
  const id = value.toLowerCase();
  if (seen.has(id)) invalid('Library IDs must be unique.');
  seen.add(id);
  return id;
}

export function phraseVocabularyInput(document) {
  const {version, revision, categories} = document || {};
  if (version !== 1 || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(categories)) invalid();
  const categoryIds = new Set(), names = new Set(), entryIds = new Set();
  const normalized = categories.map(category => {
    const name = typeof category?.name === 'string' ? category.name.trim() : '';
    if (!name || name.length > 100 || !Array.isArray(category.entries)) invalid('Enter a category name up to 100 characters.');
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) invalid('Category names must be unique.');
    names.add(nameKey);
    return {id:uniqueId(category.id, categoryIds), name, entries:category.entries.map(entry => {
      const {type, text, context = '', variations = []} = entry || {};
      if (!types.has(type) || typeof text !== 'string' || !text.trim() || typeof context !== 'string') invalid('Enter the text and type for each entry.');
      if (!Array.isArray(variations) || (variations.length && type !== 'phrase')
        || variations.some(text => typeof text !== 'string' || !text.trim())) invalid('Enter wording for each phrase variation.');
      return {id:uniqueId(entry.id, entryIds), type, text:text.trim(), context:context.trim(), variations:variations.map(text => text.trim())};
    })};
  });
  return {revision, categories:normalized};
}
