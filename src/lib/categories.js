export const CATEGORIES = [
  {
    id: 'appointment-reminders',
    name: 'Appointment Reminders',
    description: 'Pickup and booking reminder texts',
    activeAutomation: true,
  },
  {
    id: 'quote-requests',
    name: 'Quote Requests',
    description: 'Quote follow-ups and estimate requests',
    activeAutomation: true,
  },
  {
    id: 'followup-automations',
    name: 'Followup Automations',
    description: 'Reserved for post-job and nurture sequences',
    activeAutomation: false,
  },
];

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
