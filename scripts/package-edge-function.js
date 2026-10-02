import fs from 'node:fs';
import path from 'node:path';

const name = process.argv[2];
if (!/^[a-z][a-z-]*$/.test(name)) throw new Error('Pass an Edge function name');
const entry = `supabase/functions/${name}/index.ts`;
if (!fs.existsSync(entry)) throw new Error(`Function not found: ${name}`);
const visited = new Set();
const files = [];

function visit(file) {
  const normalized = file.replaceAll('\\', '/');
  if (visited.has(normalized)) return;
  if (!fs.existsSync(normalized)) throw new Error(`Missing function dependency: ${normalized}`);
  visited.add(normalized);
  const content = fs.readFileSync(normalized, 'utf8');
  files.push({ name: normalized, content });
  const imports = [...content.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g),
    ...content.matchAll(/import\(['"]([^'"]+)['"]\)/g)];
  for (const match of imports) {
    if (!match[1].startsWith('.')) continue;
    visit(path.normalize(path.join(path.dirname(normalized), match[1])));
  }
}

visit(entry);
const importMap = 'supabase/functions/import_map.json';
files.push({ name: importMap, content: fs.readFileSync(importMap, 'utf8') });
const result = { name, entrypoint_path: entry, import_map_path: importMap, files };
const output = path.join('data', `edge-package-${name}.json`);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ name, files: files.length, bytes: files.reduce((sum, file) => sum + file.content.length, 0), output }));
