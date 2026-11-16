'use strict';
const english = {
  "skip": "Skip to content",
  "navHow": "How it works",
  "navTrust": "Trust & boundaries",
  "eyebrow": "Your existing sessions, on the move",
  "headlineOne": "Away from your desk.",
  "headlineTwo": "Still in the flow.",
  "intro": "Browse existing projects, sessions and available child logs on your iPhone. Every supported interaction returns to the original session.",
  "scope": "Supports Codex, Antigravity Desktop and Claude Desktop (Gateway). Available actions follow each desktop app’s current state.",
  "download": "Download for Mac",
  "source": "Source repository ↗",
  "requirements": "Apple Silicon · macOS 14+ · iPhone builds require repository access",
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
  "featureOneTitle": "The original session",
  "featureOne": "Sessions keep running in the original desktop app. Only verified controls appear on your phone; Claude Desktop’s full controls are still being verified.",
  "featureTwoTitle": "Projects and child logs",
  "featureTwo": "Switch sessions by project and read available child logs. Active, waiting and unconfirmed states come from the original app. Child logs are read-only.",
  "featureThreeTitle": "Read incrementally, on demand",
  "featureThree": "Recent sessions appear first. Opening one loads the latest messages; scrolling up loads earlier history. Cached content and drafts remain during disconnection.",
  "featureFourTitle": "Tools and media, when needed",
  "featureFour": "Collapse tool results and click attachments to load them. Videos are limited to 1 MB; larger videos stay blocked. Read access depends on the source.",
  "howEyebrow": "Make the connection",
  "howTitle": "From your desk to your pocket.",
  "howIntro": "Download Mac 0.6.1 for Codex, Antigravity Desktop and Claude Desktop (Gateway). Available actions depend on each original app. The iPhone app needs a source build; pairing needs no separate account or VPN.",
  "stepOneTitle": "Install the Mac companion",
  "stepOne": "Download the preview, move CodeLight to Applications and open it. Start and Pause control CodeLight. Enable or disable each connection independently.",
  "stepTwoTitle": "Prepare the iPhone app",
  "stepTwo": "With source-repository access, follow the build guide. You need Xcode and your own Apple development signing.",
  "buildGuide": "Read the build guide ↗",
  "stepThreeTitle": "Scan and continue",
  "stepThree": "Scan the current Mac QR code. Your phone automatically chooses an available connection. Use Settings or the session’s connection icon to switch routes.",
  "securityEyebrow": "Clear trust boundaries",
  "securityTitle": "Your desktop stays in control.",
  "securityCopy": "Sessions and permissions stay with the original desktop app. Connections share one Mac identity, and public routes use HTTPS. Pair only phones you trust.",
  "securityWebsite": "This site serves static information and downloads. It handles no pairing, sessions, or account data and loads no third-party analytics.",
  "securityGuide": "Read security and compatibility notes ↗",
  "faqTitle": "Before you start",
  "faqOneTitle": "Which desktop apps and devices are supported?",
  "faqOne": "Mac 0.6.1 supports Codex, Antigravity Desktop and Claude Desktop (Gateway). Available actions follow each desktop’s state and confirmed capabilities. App support does not imply identical controls; Claude Desktop’s complete formal controls are still being verified. Mac targets Apple Silicon with macOS 14+.",
  "faqTwoTitle": "Why is there no iPhone download button?",
  "faqTwo": "There is no public iPhone App Store or TestFlight release yet. Building the phone app requires source-repository access. Development packages containing personal device registration are not public downloads.",
  "faqThreeTitle": "How do I reconnect to my Mac?",
  "faqThree": "Open CodeLight on your Mac and make sure it is started. Check both devices’ networks, then retry or choose a saved connection. Cached sessions and drafts remain. Scan the current Mac QR code if every saved connection has expired.",
  "faqRelayTitle": "Can I use my own public network Relay?",
  "faqRelay": "Yes. Save a compatible HTTPS server and access key with Configure Relay on Mac, then enable it independently alongside Local network and Cloudflare. Your phone uses the same QR flow. Cloudflare temporary addresses can change on restart; configured Relay keeps its authenticated route.",
  "faqFourTitle": "What do unconfirmed status and traffic totals mean?",
  "faqFour": "Unconfirmed means reliable original-session state has not been obtained. It is not idle or zero. Traffic totals count CodeLight’s network interface bytes, not model tokens or all network overhead.",
  "faqFiveTitle": "Is this an official desktop-app product?",
  "faqFive": "CodeLight is an independent MIT-licensed project that retains Happy component attribution. It is not affiliated with OpenAI, Anthropic or Google. The source repository requires access permission; unavailable desktop capabilities remain explicit.",
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
  "faqUnknown": "Use Check result and confirm the action in the original desktop app. CodeLight keeps the original operation ID and does not submit the action again automatically.",
  "faqVideoTitle": "Why can’t I open a video?",
  "faqVideo": "Attachments load only after a click. Videos are limited to 1,000,000 bytes (1 MB). Known oversized videos are not downloaded, played or saved. Unconfirmed size or read access is shown as unavailable.",
  "releaseScope": "Mac 0.6.1 supports three desktops within their confirmed capabilities. Developer ID signed, Apple notarized and stapled."
};
const chinese = Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(node=>[node.dataset.i18n,node.textContent]));
let language = 'zh', release = null;
try { language = localStorage.getItem('codelight-language') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'); } catch { /* Storage can be disabled; the page remains usable. */ }
if(language!=='en')language='zh';
const languageButton = document.getElementById('language');
const downloadButton = document.getElementById('download-mac');
const status = document.getElementById('release-status');
const hash = document.getElementById('sha256');
const copyButton = document.getElementById('copy-hash');
function applyLanguage() {
  const strings = language==='en' ? english : chinese;
  document.documentElement.lang = language==='en' ? 'en' : 'zh-CN';
  document.title = language==='en' ? 'CodeLight — Stay in the flow.' : 'CodeLight — 让思路，继续向前。';
  for(const node of document.querySelectorAll('[data-i18n]')) node.textContent = strings[node.dataset.i18n] || chinese[node.dataset.i18n] || '';
  languageButton.textContent = language==='en' ? '中文' : 'English';
  languageButton.setAttribute('aria-label',language==='en' ? '切换到中文' : 'Switch language to English');
  showRelease();
}
function showRelease() {
  if(!release)return;
  const size = (release.bytes/1048576).toFixed(1);
  status.textContent = language==='en' ? `v${release.version} preview · Developer ID signed · Apple notarized` : `v${release.version} 预览版 · Developer ID 签名 · Apple 公证`;
  document.getElementById('artifact-description').textContent = language==='en' ? `Version ${release.version} · ${size} MiB · macOS 14+ · Apple Silicon` : `版本 ${release.version} · ${size} MiB · macOS 14+ · Apple Silicon`;
  hash.textContent = release.sha256;
  copyButton.disabled = false;
  downloadButton.href = `downloads/${release.filename}`;
  downloadButton.removeAttribute('aria-disabled');
  downloadButton.classList.remove('pending');
}
languageButton.addEventListener('click',()=>{language=language==='en'?'zh':'en';try{localStorage.setItem('codelight-language',language);}catch{}applyLanguage();});
downloadButton.addEventListener('click',event=>{if(!release){event.preventDefault();document.getElementById('download-title').scrollIntoView({block:'center'});}});
copyButton.addEventListener('click',async()=>{if(!release)return;try{await navigator.clipboard.writeText(release.sha256);copyButton.textContent=language==='en'?'Copied':'已复制';}catch{copyButton.textContent=language==='en'?'Select the checksum to copy':'请选中上方校验值复制';}});
applyLanguage();
fetch('release.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('Release unavailable');return response.json();}).then(value=>{
  // A download opens only for a reviewed release; manifest fields never become HTML or arbitrary URLs.
  if(value.notarization!=='Accepted'||value.stapled!==true||value.gatekeeperAccepted!==true||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version)||value.filename!==`CodeLight-${value.version}-macos-arm64.zip`||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<=0)throw Error('Unverified release');
  release=value;showRelease();
}).catch(()=>{});
