import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { mark, adopt, waitFor } from "./bootLog.js";

// Splash timing. The splash is static markup in index.html: it paints almost
// immediately and covers the loading work underneath, which then runs in
// parallel. Its only job is to make waiting legible — so the moment that work
// is done it must get out of the way (see `dismissSplash`).
//
// Measured on the current build: html parsed ~43 ms, module eval ~390 ms, both
// panels listed ~533 ms. MIN_SHOW exists only so a genuinely fast launch can't
// flash the splash for one frame; because the clock starts at html:parsed (not
// at module eval, which is ~390 ms later) that floor is already satisfied long
// before the panels land, and it never adds delay to a finished load.
const SPLASH_MIN_SHOW_MS = 250;
const SPLASH_FADE_MS = 250;
const SPLASH_MAX_SHOW_MS = 2500;
// Both file panels are declared in App.vue; each dispatches
// "minitc:panel-listed" once its first directory listing lands.
const PANEL_COUNT = 2;

// When the splash became visible. Taken from the inline script in index.html —
// the splash is static markup painted long before this module finishes
// evaluating, so stamping it here would start the minimum-show window several
// hundred ms late and hold a splash that has already been on screen all along.
const splashShownAt = window.__MINITC_SPLASH_SHOWN_AT__ ?? performance.now();
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
//
// The splash is a *progress* indicator: it covers the loading work and gets out
// of the way the moment that work is done. So MIN_SHOW is a floor on how long
// it may be visible (anti-flash), never a delay to add on top of a finished
// load — hence both conditions are ANDed, and neither may wait for the other.
let readyAt = null;

function dismissSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.dataset.dismissing === "1") return;

  const elapsed = performance.now() - splashShownAt;
  if (panelsListed >= PANEL_COUNT && readyAt === null) readyAt = elapsed;
  const ready = elapsed >= SPLASH_MIN_SHOW_MS && panelsListed >= PANEL_COUNT;
  if (!ready && elapsed < SPLASH_MAX_SHOW_MS) {
    setTimeout(dismissSplash, 30);
    return;
  }

  // `after-ready` is the number that matters when tuning: how much dead time the
  // user spent staring at a finished splash. It should stay at 0.
  const afterReady = readyAt === null ? null : Math.max(0, elapsed - readyAt);
  mark(
    "splash:fade-start",
    `shown=${elapsed.toFixed(0)}ms panels=${panelsListed}` +
      (afterReady === null ? "" : ` after-ready=${afterReady.toFixed(0)}ms`)
  );
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
