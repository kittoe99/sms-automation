# Phone number entry

CRM phone fields and public embedded forms accept 10-digit US/Canada numbers
without a country code. Leaving the field adds +1 and removes spaces, parentheses,
dots and dashes; form submission also normalizes before serialization. Eleven-digit
numbers beginning with 1 gain only the +. Explicit +country-code numbers retain
their code; international 00 prefixes become +. Incomplete, extension-bearing or
ambiguous unprefixed international numbers are left for existing validation rather
than guessed. Empty optional fields stay empty.

The shared browser helper is public/phoneInput.js. SMS activation also normalizes
at its submit boundary; business profile serialization uses the same helper.
The website contact-phone editor is explicitly a telephone field. Number inputs
for counts, prices and scheduling are unaffected.

This is a CRM frontend/embedded-form change. There are no database migrations,
permission changes or worker/API deployments. E2's existing registration UI already
shows the US/Canada +1 prefix; its customer summaries and service rules are unchanged.
