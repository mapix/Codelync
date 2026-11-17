'use strict';
const english = {
  "skip": "Skip to content",
  "navHow": "How it works",
  "navTrust": "Trust & boundaries",
  "eyebrow": "Your existing sessions, on the move",
  "headlineOne": "Away from your desk.",
  "headlineTwo": "Still in the flow.",
  "intro": "For people with a Gateway already configured. Browse existing projects, sessions and available child logs on your iPhone; the original session handles each interaction.",
  "scope": "Connect Codex, Antigravity Desktop and Claude Desktop (Gateway). For everyday subscription use, we recommend the official apps.",
  "download": "Download for Mac",
  "source": "Source repository ↗",
  "requirements": "Apple Silicon · macOS 14+ · iPhone requires iOS 15.1+",
  "preparing": "Release verification is in progress. Download is not available yet.",
  "connected": "Connected",
  "gatewayTraffic": "Gateway traffic",
  "receiving": "Receiving",
  "sending": "Sending",
  "totalTraffic": "All-time traffic",
  "interactions": "Interactions",
  "sameOwner": "The original session is still running on your Mac",
  "sessions": "Sessions",
  "exampleProject": "Example project",
  "activeTwo": "Active 2",
  "waitingOne": "Waiting 1",
  "demoSelected": "Improve the connection flow",
  "demoMessage": "The changes are ready. Next, check the synchronization result on your phone.",
  "demoQuestion": "What should we check next?",
  "demoChoice": "Opening sessions and scrolling history",
  "demoComposer": "Continue this session…",
  "illustration": "Product illustration · synthetic content",
  "bandTitle": "Your projects and progress, within reach.",
  "bandOne": "Native iPhone interface",
  "bandTwo": "Original session identity",
  "bandThree": "MIT licensed",
  "featuresEyebrow": "Take the session with you",
  "featuresTitle": "The right things, in plain sight.",
  "featureOneTitle": "Choose desktop sources",
  "featureOne": "Choose the three desktop sources individually and save your choices. Sessions keep running in their original apps; your phone offers only verified actions.",
  "featureTwoTitle": "Projects and child logs",
  "featureTwo": "Switch sessions by project and read available child logs. Active, waiting and unconfirmed states come from the original app. Child logs are read-only.",
  "featureThreeTitle": "Read incrementally, on demand",
  "featureThree": "Your Mac prepares session state before your phone connects. Directory and status updates carry changes; warm sessions show recent messages first. Scroll up for earlier history. Messages and drafts survive disconnection.",
  "featureFourTitle": "Tools and media, when needed",
  "featureFour": "Collapse tool results and click attachments to load them. Videos are limited to 1 MB; larger videos stay blocked. Read access depends on the source.",
  "howEyebrow": "Make the connection",
  "howTitle": "From your desk to your pocket.",
  "howIntro": "Configure your Gateway in the original desktop app first, then install the Mac companion and iPhone app. Codelync pairing needs no separate account or VPN.",
  "stepOneTitle": "Install the Mac companion",
  "stepOne": "Download the preview, move Codelync to Applications and open it. Start and Pause control Codelync; select desktop apps under Sources. Choices survive restart.",
  "stepTwoTitle": "Prepare the iPhone app",
  "stepTwo": "The TestFlight beta is coming soon. You can also build the public source with Xcode and your own Apple development signing.",
  "buildGuide": "Read the build guide ↗",
  "stepFourTitle": "Enable remote desktop when needed",
  "stepFour": "Remote desktop is off by default. Enable it in the feature switches in iPhone Settings, then enable it on Mac and grant Screen Recording and Accessibility. Open its separate landscape page to choose a display, clarity and frame rate.",
  "stepThreeTitle": "Scan and continue",
  "stepThree": "Scan the current Mac QR code. Your phone automatically chooses an available connection. Use Settings or the session’s connection icon to switch routes.",
  "securityEyebrow": "Clear trust boundaries",
  "securityTitle": "Your desktop stays in control.",
  "securityCopy": "Sessions and permissions stay with the original desktop app. Connections share one Mac identity, and public routes use HTTPS. Pair only phones you trust.",
  "securityWebsite": "This site serves static information and downloads. It handles no pairing, sessions, or account data and loads no third-party analytics.",
  "securityGuide": "Read security and compatibility notes ↗",
  "faqTitle": "Before you start",
  "faqOneTitle": "Which desktop apps and devices are supported?",
  "faqOne": "This distribution is for people with a Gateway already configured, connecting Codex, Antigravity Desktop and Claude Desktop (Gateway). Available actions depend on each original app’s state and confirmed capabilities; Claude Desktop’s complete formal controls are still being verified. Mac requires Apple Silicon and macOS 14+. Standalone CLI/TUI apps are not connected.",
  "faqTwoTitle": "How do I install the iPhone app?",
  "faqTwo": "The TestFlight beta is coming soon. This page will show a real join link once external testing is approved. Source builds remain available from the public repository; personal device development packages are not public downloads.",
  "faqThreeTitle": "How do I reconnect to my Mac?",
  "faqThree": "Open Codelync on your Mac and make sure it is started. Check both devices’ networks, then retry or choose a saved connection. The fixed top icon holds connection status, error details and recovery actions. Messages and drafts remain, and a readable route stays selected while realtime updates recover. Scan the current Mac QR code if every saved connection has expired.",
  "faqDesktopTitle": "How do I enable remote desktop?",
  "faqDesktop": "Enable Remote Desktop in the feature switches in iPhone Settings, then enable it on Mac and grant the requested permissions. View fullscreen, choose displays and quality, use pointer and scroll controls, switch macOS desktops or open Mission Control. Public access also needs a reachable media path; some networks need your own media server and TURN relay. Feedback across physical devices and networks is still being collected.",
  "faqRelayTitle": "Can I use my own public network Relay?",
  "faqRelay": "Yes. Save a compatible HTTPS server and access key with Configure Relay on Mac, then enable it independently alongside Local network and Cloudflare. Your phone uses the same QR flow. Cloudflare temporary addresses can change on restart; configured Relay keeps its authenticated route.",
  "faqFourTitle": "What do unconfirmed status and traffic totals mean?",
  "faqFour": "Unconfirmed means reliable original-session state has not been obtained. It is not idle or zero. Traffic totals count Codelync’s network interface bytes, not model tokens or all network overhead.",
  "faqFiveTitle": "Is this an official desktop-app product?",
  "faqFive": "Codelync is an independent MIT-licensed project with Happy component attribution, unaffiliated with OpenAI, Anthropic or Google. For everyday subscription use, we recommend the official apps; Codelync is for people with an existing Gateway configuration. The source repository is public.",
  "downloadEyebrow": "A release you can verify",
  "downloadTitle": "Know exactly what you download.",
  "artifactPending": "Version, size, and SHA-256 appear here after release verification.",
  "copyHash": "Copy checksum",
  "footer": "Stay in the flow.",
  "footerSource": "Source repository",
  "feedback": "Feedback",
  "faqOriginalTitle": "Mac is connected, but the original app is offline?",
  "faqOriginal": "Open the corresponding Codex, Antigravity Desktop or Claude Desktop app, then retry reading the session. Saved messages remain readable; unconfirmed controls stay unavailable.",
  "faqUnknownTitle": "What if an action’s result is unconfirmed?",
  "faqUnknown": "Use Check result and confirm the action in the original desktop app. Codelync keeps the original operation ID and does not submit the action again automatically.",
  "faqVideoTitle": "Why can’t I open a video?",
  "faqVideo": "Attachments load only after a click. Videos are limited to 1,000,000 bytes (1 MB). Known oversized videos are not downloaded, played or saved. Unconfirmed size or read access is shown as unavailable.",
  "releaseScope": "An independent project, not an official OpenAI, Anthropic or Google product. Available actions follow each original app’s confirmed capabilities.",
  "betaComingSoon": "iPhone beta coming soon.",
  "betaInReview": "iPhone beta under review.",
  "betaAvailable": "iPhone beta available on TestFlight.",
  "betaClosed": "iPhone beta temporarily unavailable.",
  "joinBeta": "Join iPhone beta ↗",
  "privacy": "Privacy",
  "support": "Support"
};
const chinese = Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(node=>[node.dataset.i18n,node.textContent]));
const dictionaries = {en: english, zh: chinese, ja: window.CodelyncJapanese};
let language = window.CodelyncLanguage.getLanguage(), release = null, beta = null;
const downloadButton = document.getElementById('download-mac');
const status = document.getElementById('release-status');
const hash = document.getElementById('sha256');
const copyButton = document.getElementById('copy-hash');
const betaButton = document.getElementById('join-testflight');
const betaStatus = document.getElementById('testflight-status');
function applyLanguage() {
  const strings = dictionaries[language];
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
  document.title = {en:'Codelync — Stay in the flow.', zh:'Codelync — 让思路，继续向前。', ja:'Codelync — 思考は、そのまま。'}[language];
  for(const node of document.querySelectorAll('[data-i18n]')) node.textContent = strings[node.dataset.i18n] || english[node.dataset.i18n] || '';
  showRelease();
  showBeta();
}
function showBeta() {
  const state = beta?.status || 'coming-soon';
  const strings = dictionaries[language];
  const keys = {'coming-soon':'betaComingSoon','in-review':'betaInReview',available:'betaAvailable',closed:'betaClosed'};
  betaStatus.textContent = strings[keys[state]];
  betaButton.hidden = state !== 'available';
  if (state === 'available') {
    betaButton.href = beta.publicLink;
    document.querySelector('[data-i18n="stepTwo"]').textContent = language === 'ja'
      ? 'Apple の TestFlight をインストールし、このページの「iPhone Beta に参加」から Codelync を入手してください。公開ソースからのビルドも可能です。'
      : language==='en'
      ? 'Install TestFlight from Apple, then use Join iPhone beta on this page to install Codelync. Source builds remain available from the public repository.'
      : '先安装 Apple 的 TestFlight，再从本页“加入 iPhone Beta”安装 Codelync。也可直接使用公开源码自行构建。';
    document.querySelector('[data-i18n="faqTwo"]').textContent = language === 'ja'
      ? `このページの検証済み参加リンクをご利用ください。外部テストはバージョン ${beta.appVersion}、ビルド ${beta.build} です。参加状況は Apple とテストグループが管理します。公開ソースからのビルドも可能です。`
      : language==='en'
      ? `Use the verified Join iPhone beta link on this page. The external test includes version ${beta.appVersion}, build ${beta.build}. TestFlight availability is managed by Apple and the beta group; source builds remain available from the public repository.`
      : `使用本页已核验的“加入 iPhone Beta”链接。当前外部测试包含 ${beta.appVersion} 版、build ${beta.build}。可加入状态受 Apple 和测试组控制；也可直接使用公开源码自行构建。`;
  } else {
    betaButton.removeAttribute('href');
  }
}
function verifiedBeta(value) {
  if (!value || value.schemaVersion !== 2 || !['coming-soon','in-review','available','closed'].includes(value.status)
    || typeof value.externalGroupEnabled !== 'boolean' || typeof value.externalGroupContainsBuild !== 'boolean'
    || typeof value.externalApproved !== 'boolean') throw Error('Invalid beta status');
  const normalized = {...value,
    appVersion: value.version, publicLink: value.publicURL,
    externalBuildApproved: value.externalApproved, checkedAt: value.publishedAt};
  if (normalized.status === 'available' && (!normalized.externalGroupEnabled || !normalized.externalGroupContainsBuild || !normalized.externalBuildApproved
    || !/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{8}$/.test(normalized.publicLink || '')
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(normalized.appVersion || '') || !/^[0-9]{8,12}$/.test(normalized.build || '')
    || typeof normalized.checkedAt !== 'string' || !Number.isFinite(Date.parse(normalized.checkedAt))
    || !/^[0-9]+$/.test(value.appId || '') || !/^[A-Za-z0-9-]{1,128}$/.test(value.groupId || ''))) throw Error('Unverified beta link');
  return normalized;
}
function showRelease() {
  if(!release)return;
  const size = (release.bytes/1048576).toFixed(1);
  status.textContent = language === 'ja' ? `v${release.version} プレビュー · Developer ID 署名済み · Apple 公証済み` : language==='en' ? `v${release.version} preview · Developer ID signed · Apple notarized` : `v${release.version} 预览版 · Developer ID 签名 · Apple 公证`;
  document.getElementById('artifact-description').textContent = language === 'ja' ? `バージョン ${release.version} · ${size} MiB · macOS 14+ · Apple Silicon` : language==='en' ? `Version ${release.version} · ${size} MiB · macOS 14+ · Apple Silicon` : `版本 ${release.version} · ${size} MiB · macOS 14+ · Apple Silicon`;
  hash.textContent = release.sha256;
  copyButton.disabled = false;
  downloadButton.href = `downloads/${release.filename}`;
  downloadButton.removeAttribute('aria-disabled');
  downloadButton.classList.remove('pending');
}
window.addEventListener('codelync-languagechange', () => { language = window.CodelyncLanguage.getLanguage(); applyLanguage(); });
downloadButton.addEventListener('click',event=>{if(!release){event.preventDefault();document.getElementById('download-title').scrollIntoView({block:'center'});}});
copyButton.addEventListener('click',async()=>{if(!release)return;try{await navigator.clipboard.writeText(release.sha256);copyButton.textContent={en:'Copied',zh:'已复制',ja:'コピー済み'}[language];}catch{copyButton.textContent={en:'Select the checksum to copy',zh:'请选中上方校验值复制',ja:'チェックサムを選択してコピーしてください'}[language];}});
applyLanguage();
fetch('release.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('Release unavailable');return response.json();}).then(value=>{
  // A download opens only for a reviewed release; manifest fields never become HTML or arbitrary URLs.
  if(value.notarization!=='Accepted'||value.stapled!==true||value.gatekeeperAccepted!==true||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version)||value.filename!==`Codelync-${value.version}-macos-arm64.zip`||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<=0)throw Error('Unverified release');
  release=value;showRelease();
}).catch(()=>{});
fetch('testflight.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('Beta unavailable');return response.json();})
  .then(value=>{beta=verifiedBeta(value);showBeta();}).catch(()=>{});
