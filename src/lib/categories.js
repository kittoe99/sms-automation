export const CATEGORIES = [
  {
    id: 'appointment-reminders',
    name: 'Appointment Reminders',
    description: 'Pickup and booking reminder texts',
  },
  {
    id: 'quote-requests',
    name: 'Quote Requests',
    description: 'Quote follow-ups and estimate requests',
  },
  {
    id: 'followup-automations',
    name: 'Followup Automations',
    description: 'Post-job and nurture sequences',
  },
  {
    id: 'contractor-sms',
    name: 'Contractor SMS',
    description: 'Provider / crew dispatch messaging',
  },
];

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
