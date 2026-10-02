import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canManageLocalBusinesses } from './dataMode.js';
import { listTenants, setStoredTenantAccounts } from './tenantContext.js';

let writes = Promise.resolve();
function registryFile() {
  return path.resolve(process.env.LOCAL_BUSINESSES_FILE || 'data/local-businesses.json');
}
async function readBusinesses() {
  try {
    const entries = JSON.parse(await readFile(registryFile(), 'utf8'));
    if (!Array.isArray(entries)) throw new Error('Invalid local business registry');
    return entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
export async function loadLocalBusinesses() {
  if (canManageLocalBusinesses()) setStoredTenantAccounts(await readBusinesses());
}
function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function addLocalBusiness(input = {}) {
  const operation = writes.then(async () => {
    if (!canManageLocalBusinesses()) throw invalid('Manual local business setup is unavailable', 403);
    const name = String(input.name || '').trim();
    if (!name || name.length > 100) throw invalid('Enter a business name of 1–100 characters');
    const timeZone = String(input.timeZone || 'America/Denver').trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw invalid('Enter a valid time zone'); }
    const businesses = await readBusinesses();
    const existing = [...listTenants(), ...businesses];
    if (existing.some(b => b.name.toLowerCase() === name.toLowerCase())) throw invalid('That business already exists', 409);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'business';
    let id = slug;
    for (let suffix = 2; existing.some(b => b.id === id); suffix++) id = `${slug}-${suffix}`;
    const business = { id, name, shortName: name.slice(0, 40), timeZone, status: 'active' };
    businesses.push(business);
    const filename = registryFile();
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(businesses, null, 2));
    await rename(temporary, filename);
    setStoredTenantAccounts(businesses);
    return business;
  });
  writes = operation.catch(() => {});
  return operation;
}
