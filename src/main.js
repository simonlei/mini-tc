import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { mark, adopt, waitFor } from "./bootLog.js";

// Splash timing. Boot instrumentation (see src/bootLog.js) showed the app is
// fully working ~510 ms after the first HTML byte: both panels have listed by
// ~124 ms after this module is evaluated, so the gate that actually decides
// when the splash leaves is MIN_SHOW_MS, not the listing.
//
// Measured, from process start: ~1520 ms of it is native WebView2 setup that
// JS cannot shorten, then ~40 ms HTML, ~345 ms module eval, ~85 ms to list
// both panels. So the only budget left to cut is here — every millisecond of
// MIN_SHOW + FADE is pure dead time on top of a working UI.
const SPLASH_MIN_SHOW_MS = 250;
const SPLASH_FADE_MS = 250;
const SPLASH_MAX_SHOW_MS = 2500;
// Both file panels are declared in App.vue; each dispatches
// "minitc:panel-listed" once its first directory listing lands.
const PANEL_COUNT = 2;

const splashShownAt = performance.now();
let panelsListed = 0;
window.addEventListener("minitc:panel-listed", () => {
  panelsListed += 1;
});

// Adopt the pre-module marks recorded inline in index.html.
adopt(window.__MINITC_BOOT_MARKS__);
mark("main.js:eval");
// The startup timeline is only complete once the splash is off screen.
waitFor("splash:removed");

createApp(App).mount("#app");
mark("vue:mounted");

// Fade out once Vue has mounted AND the minimum show duration has passed AND
// both panels have listed. A double rAF guarantees the panels' first frame is
// on-screen before we start counting down, so the splash covers the *whole*
// transition rather than racing a half-painted app.
function dismissSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.dataset.dismissing === "1") return;

  const elapsed = performance.now() - splashShownAt;
  const ready = elapsed >= SPLASH_MIN_SHOW_MS && panelsListed >= PANEL_COUNT;
  if (!ready && elapsed < SPLASH_MAX_SHOW_MS) {
    setTimeout(dismissSplash, 30);
    return;
  }

  mark("splash:fade-start", `waited=${elapsed.toFixed(0)}ms panels=${panelsListed}`);
  splash.dataset.dismissing = "1";
  // Applied here so SPLASH_FADE_MS is authoritative: the CSS duration and this
  // constant had drifted apart (0.6s vs 300ms) and the CSS silently won.
  splash.style.transitionDuration = `${SPLASH_FADE_MS}ms`;
  splash.classList.add("hide");
  splash.addEventListener("transitionend", () => {
    if (splash.parentNode) splash.parentNode.removeChild(splash);
    mark("splash:removed", "first unobstructed frame");
  }, { once: true });
}

requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
