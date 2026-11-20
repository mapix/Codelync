# Codelync localization

The current distribution provides English, Chinese and Japanese across the
iPhone app, Android app, Mac companion, website and release/TestFlight descriptions.
English is the primary language of the GitHub README, contributor documentation
and releases; translated documentation is linked from the English entry point.

## Language selection

- New installations default to the system's preferred language. English is the
  fallback when no supported language is available.
- Both the iPhone and Android apps (`com.learnings.codelync`) share the same
  `Automatic` preference (`Localization.getLocales()` via `resolveLanguage.ts`)
  and saved explicit `preferredLanguage` selection across `en`, `zh-Hans`,
  `zh-Hant`, and `ja` (plus all registered mobile locales in `_all.ts`), applying
  changes via local persistence and app reload. Chinese script and regional tags
  (`zh-Hans`/`zh-CN`/`zh-SG` vs `zh-Hant`/`zh-TW`/`zh-HK`/`zh-MO`, including
  legacy underscore tags) resolve accurately on both iOS and Android without
  collapsing Traditional Chinese into Simplified Chinese.
- The Mac uses native localization resources with English as its development
  language and includes Chinese and Japanese strings and permission copy.
- The website offers System, English, 中文 and 日本語. System follows the
  browser's language list, including a later language change. A saved explicit
  choice takes precedence and is shared by the homepage, privacy and support.
  Disabled local storage must still allow language selection for the current page.

## Copy and verification

Source application names (`Codex`, `Antigravity Desktop`, `Claude Desktop` with
`Gateway`), protocol identifiers and user conversations are not translated;
active product descriptions, onboarding, empty states and `settings.aboutFooter`
stay strictly aligned with `Codex`, `Antigravity Desktop` and `Claude Desktop
(Gateway)` and each source's confirmed capabilities, without advertising deferred
CLI/TUI or window harnesses. Translate product navigation, connection/recovery
states, remote desktop controls and special-key screen-reader labels, composer
action labels and sandbox qualifiers, connection route status/recovery guidance,
privacy/support information, native permission prompts and custom modal prompt
actions. Shared mobile copy across iPhone and Android uses platform-neutral
device wording (such as phone/smartphone rather than hardcoding `iPhone` in
shared scan/restore strings), and custom prompt modals rendered on Android and
Web (`WebPromptModal` via `Modal.prompt`, such as `"Paste pairing link"`)
default their action buttons to localized `t('common.cancel')` and
`t('common.ok')` rather than hardcoded English `'Cancel'` / `'OK'`. Unknown
states retain their meaning in every language. All supported languages—including
Simplified Chinese (`zh-Hans`), Traditional Chinese (`zh-Hant`), and Japanese
(`ja`)—provide distinct explicit copy rather than falling back to English
(`en.*`) or coarse language-prefix checks (`startsWith('zh')` without `zh-Hant`
separation) across active UI groups (`codelync*`, pairing/location recovery
errors, `sourceBridge`, `message`, `windowControl`, `server`, `onboarding`
scan/restore/offline states, `sessionInfo.resumeSession*`, and all `*Labels.ts`
dictionaries).

Verify system Chinese (`zh-Hans` and `zh-Hant`)/Japanese/English selection, saved
overrides, unsupported language fallback, localized Android modal prompts,
complete Japanese remote controls and all website status states across iPhone,
Android, Mac and web. Native app and browser rendering checks remain separate
from translation and locale resolver tests. Rebuild runtime artifacts after
localization changes.

The current welcome wordmark composes the existing generated symbol (matching
`CodelyncMark` squircle rounding `size * 0.22`) with native `Codelync` text, and
onboarding connection artwork preserves its native aspect ratio with clean
rounded clipping across light and dark themes. Historical generated wordmark
images retain their provenance; the current app does not display their baked-in
former product name.
