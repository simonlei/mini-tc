import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

// Splash must stay on screen long enough to read the logo + see at least
// one full cycle of the loader dots. Tweak MIN_SHOW_MS / FADE_MS here if
// timing needs change — single source of truth.
const SPLASH_MIN_SHOW_MS = 1200;
const SPLASH_FADE_MS = 600;

const splashShownAt = performance.now();

createApp(App).mount("#app");

// Fade out once Vue has mounted AND the minimum show duration has passed.
// A double rAF guarantees the panels' first frame is on-screen before we
// start counting down, so the splash covers the *whole* transition rather
// than racing a half-painted app.
function dismissSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.dataset.dismissing === "1") return;
  const elapsed = performance.now() - splashShownAt;
  const wait = Math.max(0, SPLASH_MIN_SHOW_MS - elapsed);
  setTimeout(() => {
    splash.dataset.dismissing = "1";
    splash.classList.add("hide");
    splash.addEventListener("transitionend", () => {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    }, { once: true });
  }, wait);
}

requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
