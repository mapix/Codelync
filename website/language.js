(() => {
  const supported = ['en', 'zh', 'ja'];
  let preference = 'system';
  try {
    const saved = localStorage.getItem('codelync-language');
    if (supported.includes(saved)) preference = saved;
  } catch { /* The system preference works without browser storage. */ }
  function resolveLanguage(value, languages = []) {
    if (supported.includes(value)) return value;
    for (const tag of languages) {
      const language = String(tag).toLowerCase().replaceAll('_', '-').split('-')[0];
      if (supported.includes(language)) return language;
    }
    return 'en';
  }
  const getLanguage = () => resolveLanguage(preference, navigator.languages || [navigator.language]);
  function apply() {
    const language = getLanguage();
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    const select = document.getElementById('language');
    if (select) {
      select.value = preference;
      select.setAttribute('aria-label', {en:'Language',zh:'语言',ja:'言語'}[language]);
      select.querySelector('[value="system"]').textContent = {en:'System',zh:'跟随系统',ja:'システム'}[language];
    }
    for (const block of document.querySelectorAll('[data-language]')) block.hidden = block.dataset.language !== language;
    const labels = {en:{home:'Home',privacy:'Privacy',support:'Support'},zh:{home:'首页',privacy:'隐私',support:'支持'},ja:{home:'ホーム',privacy:'プライバシー',support:'サポート'}};
    for (const link of document.querySelectorAll('[data-locale-link]')) link.textContent = labels[language][link.dataset.localeLink];
    const page = document.body.dataset.page;
    if (page) document.title = `Codelync — ${labels[language][page]}`;
    window.dispatchEvent(new Event('codelync-languagechange'));
  }
  window.CodelyncLanguage = {getLanguage, resolveLanguage};
  document.getElementById('language')?.addEventListener('change', event => {
    preference = supported.includes(event.target.value) ? event.target.value : 'system';
    try {
      if (preference === 'system') localStorage.removeItem('codelync-language');
      else localStorage.setItem('codelync-language', preference);
    } catch { /* Keep the current selection for this page. */ }
    apply();
  });
  window.addEventListener('languagechange', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== 'codelync-language') return;
    preference = supported.includes(event.newValue) ? event.newValue : 'system';
    apply();
  });
  apply();
})();
