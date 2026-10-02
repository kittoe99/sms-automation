export async function readBusinessProfile(apiFetch) {
  const response = await apiFetch('/api/onboarding');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load the saved business profile.');
  return { ...data, source: 'api' };
}

export async function writeBusinessProfile(apiFetch, profile, revision, intent = 'review') {
  const response = await apiFetch('/api/onboarding', {
    method: 'POST', body: JSON.stringify({ ...profile, revision, intent }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not save the business profile. Your changes are still in the form.');
  return { data, source: 'api' };
}
