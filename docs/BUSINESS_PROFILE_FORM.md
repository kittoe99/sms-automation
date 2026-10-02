# Guided CRM business setup

Open Platform → Businesses → View details to extend the customer's submitted
profile. The form uses five numbered sections in the existing E2 paper/blue theme;
it introduces no extra navigation tab. Required basics and optional details are
identified beside the controls.

- Business details: business identity, contact information, description and an
  IANA time-zone dropdown. The saved time zone is retained even if it is an alias.
- Services and availability: add/remove individual services and service areas.
  Choose an hours preset and explicitly Use schedule to populate editable hours.
- Customer questions and pricing: enter question/answer cards or choose a common
  question and supply the actual answer. Pricing supports custom quotes, fixed
  prices, starting prices, hourly rates in USD, and custom descriptions. Add a
  pricing detail to turn the builder into an editable saved entry. A completed
  pending detail is included on save; incomplete pricing shows an error.
- Policies and booking guidance: choose policy topics as writing prompts, then
  supply actual policy text. Suggested booking and handoff rules are appended
  only when Add rule is chosen; they remain editable.
- Brand voice: optional friendly, professional or casual style cards; leaving
  the style unset retains the voice specified in the relevant AI instructions.

No presets are inserted on load, no business names or prices are invented, and
original customer registration is retained in a collapsed reference section.

After the input sections, **Review your business profile** shows every editable
profile field in a detailed summary. It updates on typing, selections, preset
insertion and entry removal. Empty fields say Not provided. Edit links return to
the matching field without clearing the form. A completed pricing builder is
shown as pending and included on save; incomplete pricing is identified separately.
This is a preview of the current form, not a claim that unsaved edits are approved.

Existing free-form FAQs and pricing entries, custom rules, non-USD saved pricing,
and unknown profile fields remain supported. FAQ pairs are serialized as one
plain-text entry, with a question mark separator or an em dash for topic headings.
Other list fields remain string arrays. The API/profile shape is unchanged.

Save draft retains working facts without approving them. Save reviewed profile
checks required services/areas, description length and FAQ answers/combined length
before the existing revision-aware API review. Backend validation and permissions
remain authoritative. Errors retain inputs. Review enables service addition; it
does not publish websites, release customer services or activate SMS sending.

Written hours and booking guidance do not configure appointment availability or
booking limits. Handoff guidance does not configure staff notifications/routing.
The profile supplies general business conversation facts; automation groups use
their own AI instructions and business details.

This frontend change adds no migration. The existing owning-repository migration
order documented in the paired project records is unchanged; never replay either
history against the shared database. E2 registration and dashboard behavior are
unchanged. Implementation/test results and production release verification are
recorded separately in both PROJECT_RECORD.md files.
