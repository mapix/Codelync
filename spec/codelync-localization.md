# Codelync localization

The current distribution provides English, Chinese and Japanese across the
iPhone app, Mac companion, website and TestFlight descriptions. English is the
primary language of the GitHub README, contributor documentation and releases;
translated documentation is linked from the English entry point.

## Language selection

- New installations default to the system's preferred language. English is the
  fallback when no supported language is available.
- The iPhone retains its existing Automatic preference and saved explicit
  language selection. Chinese regional/script variants remain supported.
- The Mac uses native localization resources with English as its development
  language and includes Chinese and Japanese strings and permission copy.
- The website offers System, English, 中文 and 日本語. System follows the
  browser's language list, including a later language change. A saved explicit
  choice takes precedence and is shared by the homepage, privacy and support.
  Disabled local storage must still allow language selection for the current page.

## Copy and verification

Source application names, Gateway, protocol identifiers and user conversations
are not translated. Translate product navigation, connection/recovery states,
remote desktop controls, privacy/support information and native permission
prompts. Unknown states retain their meaning in every language.

Verify system Chinese/Japanese/English selection, saved overrides, unsupported
language fallback, complete Japanese remote controls and all website status
states. Native app and browser rendering checks remain separate from translation
and locale resolver tests. Rebuild runtime artifacts after localization changes.

The current welcome wordmark composes the existing generated symbol with native
`Codelync` text. Historical generated wordmark images retain their provenance;
the current app does not display their baked-in former product name.
