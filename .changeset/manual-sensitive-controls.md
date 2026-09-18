---
"@fieldfox/widget": patch
"@fieldfox/server": patch
---

Keep password current values out of widget requests and provider prompts. Leave one-time-code and payment controls marked with autocomplete tokens for manual entry, excluding them from new-widget requests and fill targets.
