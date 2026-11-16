// 验证「文件属性」窗口（Ctrl+Enter / Alt+Enter）的接线完整。
//
// 直接 `node scripts/file-properties-check.mjs`；`-- --mutate` 跑变异臂。
//
// ── 为什么需要静态断言 ────────────────────────────────────────────────
// 这条功能横跨 5 个文件：shortcuts.js 声明命令 → App.vue 认领按键并打开
// 窗口 → FilePanel.vue 的右键菜单 emit → 对话框组件调后端 → 后端命令。
// 任何一环断掉都是「按了没反应」或「窗口空白」，而纯逻辑测试全绿、
// 组件也编译得过（方法论：改实现不改调用点）。所以每一层都用断言钉住：
//   ① 命令注册与按键命中用**生产模块**跑（import shortcuts.js，不是读文本）
//   ② 接线与「模态闸门 / 焦点归还」用静态断言钉住
//   ③ 后端命令名与前端调用名一致（跨语言边界的接缝最容易漂）
//   ④ 变异臂逐个证明这些断言不是恒真的

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mod from "./stripComments.cjs";
import { COMMANDS, bindingsOf, computeConflicts, matches } from "../src/shortcuts.js";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "src", "App.vue");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const DIALOG = path.join(ROOT, "src", "components", "FilePropertiesDialog.vue");
const API = path.join(ROOT, "src", "api.js");
const FORMAT = path.join(ROOT, "src", "format.js");
const LIB = path.join(ROOT, "src-tauri", "src", "lib.rs");
const IMAGEMETA = path.join(ROOT, "src-tauri", "src", "imagemeta.rs");
const VIDEOMETA = path.join(ROOT, "src-tauri", "src", "videometa.rs");

let passed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

// 抽函数体（按大括号配对），用来只判某个函数里的事。
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const braceAt = src.indexOf("{", at + decl.length - 1);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceAt, i + 1);
    }
  }
  return null;
}

// ── 1. 命令注册（import 生产模块，不是读文本） ──

section("1. file.properties 命令已注册且按键真的命中");

const cmd = COMMANDS.find((c) => c.id === "file.properties");
check("shortcuts.js 的 COMMANDS 里有 file.properties", !!cmd);
check("scope 是 global（窗口要盖在两侧面板之上，由 App.vue 接管键盘）", cmd?.scope === "global");
check("默认键含 Ctrl+Enter 与 Alt+Enter", !!cmd && cmd.defaults.includes("Ctrl+Enter") && cmd.defaults.includes("Alt+Enter"));
check(
  "不与同 scope 的其它命令冲突",
  !!cmd && computeConflicts(bindingsOf).get("file.properties")?.errors.length === 0
);

function ev(o = {}) {
  return {
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    key: "", code: "", ...o,
  };
}
const enter = { code: "Enter", key: "Enter" };
check("Ctrl+Enter 命中 file.properties", matches("file.properties", ev({ ...enter, ctrlKey: true })));
check("Alt+Enter 命中 file.properties", matches("file.properties", ev({ ...enter, altKey: true })));
check("裸回车不命中（不能抢 list.open）", !matches("file.properties", ev(enter)));
check("Shift+Enter 不命中（修饰键必须精确匹配）", !matches("file.properties", ev({ ...enter, shiftKey: true })));
check("Ctrl+Shift+Enter 不命中", !matches("file.properties", ev({ ...enter, ctrlKey: true, shiftKey: true })));

// ── 2. 静态接线 ──

const appSrc = stripComments(fs.readFileSync(APP, "utf8"));
const panelSrc = stripComments(fs.readFileSync(PANEL, "utf8"));
// 模板里的 HTML 注释（`<!-- ... -->`）也要剥掉：属性窗口顶部的说明文字里
// 就写着「视频信息」「视频标签」这几个词，不剥的话断言会被文档自己满足 ——
// 变异臂「删掉视频信息区块」就是这么漏过去的。
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
const dialogSrc = stripHtmlComments(stripComments(fs.readFileSync(DIALOG, "utf8")));
const apiSrc = stripComments(fs.readFileSync(API, "utf8"));
const libSrc = fs.readFileSync(LIB, "utf8");
// lib.rs 也要剥注释：`mod videometa;` 被改成 `// mod videometa;` 时，模块
// 其实已经没了，但正则照样能匹配到那行注释里的字面量。
const libCode = stripComments(libSrc);

section("2. App.vue：命令 → 窗口");

check("App.vue import 了 FilePropertiesDialog", /import\s+FilePropertiesDialog\s+from\s*"\.\/components\/FilePropertiesDialog\.vue"/.test(appSrc));
check("App.vue 模板渲染了 <FilePropertiesDialog>", appSrc.includes("<FilePropertiesDialog"));
check("模板用 v-if 控制显示", /<FilePropertiesDialog[\s\S]{0,200}v-if="propertiesVisible"/.test(appSrc));
check("模板把路径传给窗口", /<FilePropertiesDialog[\s\S]{0,200}:path="propertiesPath"/.test(appSrc));
check("模板接了 close 事件", /<FilePropertiesDialog[\s\S]{0,200}@close="closeProperties"/.test(appSrc));

const keyBody = bodyOf(appSrc, "function onGlobalKeydown(e) {");
check("抽到 onGlobalKeydown 函数体", !!keyBody && keyBody.length > 0);
check("onGlobalKeydown 用 matches 认领 file.properties", !!keyBody && keyBody.includes('matches("file.properties", e)'));
check("认领后 markHandled（不被后面的分支二次消费）", !!keyBody && keyBody.includes("markHandled(e)"));
check("分支调用 openProperties()", !!keyBody && keyBody.includes("openProperties()"));
check(
  "file.properties 分支恰好一处（多一处会重复开窗）",
  (appSrc.match(/matches\("file\.properties", e\)/g) || []).length === 1
);

section("3. 模态闸门与焦点归还");

check(
  "onGlobalKeydown 里有 propertiesVisible 闸门（窗口开着时不驱动底下两层）",
  !!keyBody && /if\s*\(\s*propertiesVisible\.value\s*\)\s*return;/.test(keyBody)
);
check(
  "闸门在分支之前（先关闸再谈按键）",
  !!keyBody && keyBody.indexOf("propertiesVisible.value") < keyBody.indexOf('matches("file.properties", e)')
);

const openBody = bodyOf(appSrc, "async function openProperties(panelIdArg) {");
check("抽到 openProperties 函数体", !!openBody && openBody.length > 0);
check("用活动面板的 selectedEntry", !!openBody && openBody.includes("panel?.selectedEntry"));
check("用面板的 currentPath 拼绝对路径", !!openBody && openBody.includes("panel?.currentPath"));
check("路径经 entryPath 解析成绝对路径", !!openBody && openBody.includes("entryPath(entry, dir)"));
check("打开时记下焦点（关闭后要还回去）", !!openBody && openBody.includes("propertiesReturnFocus = document.activeElement"));
check("打开时记下面板（关闭后要还回去）", !!openBody && openBody.includes("propertiesReturnPanel = panelId"));
check("已经开着就直接返回（不重读一遍）", !!openBody && openBody.includes("if (propertiesVisible.value) return;"));

const closeBody = bodyOf(appSrc, "function closeProperties() {");
check("抽到 closeProperties 函数体", !!closeBody && closeBody.length > 0);
check(
  "关闭后把焦点还给原来的元素（带失效判断的守卫）",
  !!closeBody &&
    closeBody.includes("target && target !== document.body && target.isConnected") &&
    closeBody.includes("target.focus()")
);
check("元素已失效时回落到面板列表", !!closeBody && closeBody.includes("panel?.focusList?.()"));

section("3b. 属性窗口跟随选中项（↑/↓ 换了文件就显示新文件）");

// 窗口开着时 ↑/↓ 仍然移动下面列表的高亮（列表自己处理这些键，全局处理器被
// 闸门挡住），所以窗口必须跟着换文件 —— 否则显示的是打开时那一个文件。
const followAt = appSrc.indexOf(
  "=> [leftPanel.value?.selectedEntry || null, rightPanel.value?.selectedEntry || null]"
);
check("App.vue 有跟随选中项的 watcher", followAt > 0);
const followSrc = followAt > 0 ? appSrc.slice(followAt, followAt + 2200) : "";
check(
  "watcher 读两侧面板的 selectedEntry",
  followSrc.includes("leftPanel.value?.selectedEntry") && followSrc.includes("rightPanel.value?.selectedEntry")
);
check(
  "watcher 只在窗口开着时换文件",
  followSrc.includes("propertiesVisible.value") && followSrc.includes("propertiesPath.value = full")
);
check(
  "watcher 用 token 挡住过期的异步结果（连按方向键不会显示错文件）",
  followSrc.includes("propertiesFollowToken")
);
check(
  "watcher 按被检查的面板挑条目（不是活动面板）",
  followSrc.includes("const panelId = propertiesReturnPanel;") &&
    followSrc.includes('panelId === "left" ? leftEntry : rightEntry')
);

const navBody = bodyOf(appSrc, "function onPropertiesNavigate(delta) {");
check("抽到 onPropertiesNavigate 函数体", !!navBody && navBody.length > 0);
check("方向键交给面板自己移动选中项", !!navBody && navBody.includes("panel?.moveSelection?.(delta)"));
check(
  "模板把 on-navigate 传给窗口",
  /<FilePropertiesDialog[\s\S]{0,300}:on-navigate="onPropertiesNavigate"/.test(appSrc)
);

const ownerBody = bodyOf(appSrc, "function ownerPanelId(el) {");
check("抽到 ownerPanelId 函数体", !!ownerBody && ownerBody.length > 0);
check(
  "ownerPanelId 靠 data-panel-id 认面板",
  !!ownerBody && ownerBody.includes("[data-panel-id]") && ownerBody.includes("dataset.panelId")
);
check(
  "打开时把键盘放到被检查的面板（右键从另一侧进来时 ↑/↓ 才动这一侧）",
  openBody.includes("ownerPanelId(document.activeElement) !== panelId") &&
    openBody.includes("panel?.focusList?.()")
);
check(
  "关闭时只把焦点还给同一面板的元素，否则还给面板列表",
  closeBody.includes("ownerPanelId(target) === propertiesReturnPanel")
);

check(
  "对话框在 path 变化时重读（切了文件就刷新）",
  /watch\(\s*\(\)\s*=>\s*props\.path,\s*load\s*\)/.test(dialogSrc)
);
check("对话框有 loadToken 挡住过期的读取结果", /let\s+loadToken\s*=\s*0/.test(dialogSrc) && dialogSrc.includes("token !== loadToken"));
check(
  "对话框在 capture 阶段接管 ↑/↓（焦点不在列表上时也能换文件）",
  /addEventListener\("keydown",\s*onArrowCapture,\s*true\)/.test(dialogSrc) &&
    /removeEventListener\("keydown",\s*onArrowCapture,\s*true\)/.test(dialogSrc)
);
check("对话框的方向键交给 App.vue 移动选中项", dialogSrc.includes("props.onNavigate("));
check(
  "列表自己处理方向键时对话框不重复处理（不会连跳两格）",
  dialogSrc.includes('closest(".file-list")')
);
check(
  "重读时保留旧内容（不会每按一次方向键就闪一下空白）",
  dialogSrc.includes("loading && !info") && dialogSrc.includes("refreshing")
);

section("4. FilePanel.vue：右键「属性…」");

check("FilePanel 的 defineEmits 声明了 properties", /defineEmits\(([\s\S]*?)\)/.exec(panelSrc)?.[1]?.includes('"properties"'));

const menuBody = bodyOf(panelSrc, "function buildMenuItems(entry) {");
check("抽到 buildMenuItems 函数体", !!menuBody && menuBody.length > 0);
check("右键菜单里有「属性…」项", !!menuBody && menuBody.includes('label: "属性…"'));
check("菜单项的 action 是 properties", !!menuBody && menuBody.includes('action: "properties"'));

const ctxBody = bodyOf(panelSrc, "async function handleCtxSelect(item) {");
check("抽到 handleCtxSelect 函数体", !!ctxBody && ctxBody.length > 0);
check("handleCtxSelect 有 properties 分支", !!ctxBody && ctxBody.includes('case "properties":'));
check("该分支 emit properties 并带上 panelId", !!ctxBody && ctxBody.includes('emit("properties", { panelId: props.panelId })'));
check(
  "emit(\"properties\") 恰好一处",
  (panelSrc.match(/emit\("properties"/g) || []).length === 1
);

check(
  "App.vue 的两个 FilePanel 都接了 @properties",
  (appSrc.match(/@properties="onPanelProperties"/g) || []).length === 2
);
const onPanelBody = bodyOf(appSrc, "function onPanelProperties({ panelId } = {}) {");
check("抽到 onPanelProperties 函数体", !!onPanelBody && onPanelBody.length > 0);
check("右键入口先把该面板设为活动面板", !!onPanelBody && onPanelBody.includes("activePanel.value = panelId"));
check("右键入口转给 openProperties", !!onPanelBody && onPanelBody.includes("openProperties(panelId)"));

section("5. 前后端接缝：命令名必须一致");

const apiBody = bodyOf(apiSrc, "export async function getFileProperties(path) {");
check("api.js 导出了 getFileProperties", !!apiBody);
check("它 invoke 的命令名是 read_file_properties", !!apiBody && apiBody.includes('invoke("read_file_properties"'));
check("参数名是 path", !!apiBody && apiBody.includes("{ path }"));

check("后端定义了 #[tauri::command] read_file_properties", /#\[tauri::command\][\s\S]{0,80}fn\s+read_file_properties\(/.test(libSrc));
check("后端把它注册进了 generate_handler!", /generate_handler![\s\S]*read_file_properties[\s\S]*\]/.test(libSrc));
check("后端引入了 imagemeta 模块", /mod\s+imagemeta\s*;/.test(libSrc));
check("imagemeta.rs 文件存在", fs.existsSync(IMAGEMETA));
check("imagemeta.rs 导出了 probe 入口", /pub\s+fn\s+probe\s*\(/.test(fs.readFileSync(IMAGEMETA, "utf8")));

section("5b. 视频元数据：后端探测 → IPC → 属性窗口");

// 视频元数据是「后端探测 → 塞进 FileProperties → 前端渲染」的完整链路。
// 少接一环的症状很隐蔽：后端探测出来了但 IPC 没带过去，前端就会显示
// 「这不是图像或视频文件」—— 用户完全看不出是接线断了还是真的没数据。
const videoSrc = fs.existsSync(VIDEOMETA) ? fs.readFileSync(VIDEOMETA, "utf8") : "";

check("后端引入了 videometa 模块", /^\s*mod\s+videometa\s*;/m.test(libCode));
check("videometa.rs 文件存在", fs.existsSync(VIDEOMETA));
check("videometa.rs 导出了 probe 入口", /pub\s+fn\s+probe\s*\(/.test(videoSrc));
check(
  "FileProperties 有 video 字段",
  /pub\s+video\s*:\s*Option\s*<\s*videometa::VideoMeta\s*>/.test(libSrc)
);
check(
  "read_file_properties 填了 video（探测结果真的被带过 IPC）",
  /video\s*:\s*videometa::probe\s*\(/.test(libSrc)
);
check(
  "VideoMeta 至少带时长 / 分辨率 / 编码（不然窗口里能显示什么？）",
  /pub\s+duration\s*:\s*Option\s*</.test(videoSrc) &&
    /pub\s+width\s*:\s*Option\s*</.test(videoSrc) &&
    /pub\s+height\s*:\s*Option\s*</.test(videoSrc) &&
    /pub\s+video_codec\s*:\s*Option\s*</.test(videoSrc)
);
check(
  "VideoMeta 带容器标签与内嵌 EXIF（手机录的 MOV 里才有）",
  /pub\s+tags\s*:\s*Vec\s*</.test(videoSrc) && /pub\s+exif\s*:\s*Vec\s*</.test(videoSrc)
);
check(
  "VideoMeta 带 GPS（录影时写进容器的位置）",
  /pub\s+gps\s*:\s*Option\s*</.test(videoSrc)
);

// 前端：窗口里要有「视频信息」区块，并且真的读了 video 上的字段。
// 判据必须精确到区块标题本身：`includes("视频信息")` 会被兜底区块的标题
// 「图像 / 视频信息」满足 —— 变异臂 ⑯ 删掉真正的「视频信息」区块时，
// 粗判据依然全绿。这里认的是 `<div class="block-title">视频信息</div>`。
check(
  "窗口里有「视频信息」区块",
  /<div class="block-title">视频信息<\/div>/.test(dialogSrc)
);
check(
  "窗口里有「视频标签」区块",
  /<div class="block-title">视频标签（/.test(dialogSrc)
);
// 字段可以由模板直接读（`video.duration`），也可以由 computed 读
// （`video.value?.duration`）—— 两种写法都算接上了。
const readsVideoField = (name) =>
  new RegExp(`video(?:\\.value\\?\\.|\\.)${name}\\b`).test(dialogSrc);
check("窗口渲染了 video.duration", readsVideoField("duration"));
check("窗口渲染了 video.width / video.height", readsVideoField("width") && readsVideoField("height"));
check("窗口渲染了 video.video_codec", readsVideoField("video_codec"));
check("窗口渲染了 video.audio_codec", readsVideoField("audio_codec"));
check("窗口渲染了 video.bitrate", readsVideoField("bitrate"));
check("窗口渲染了 video.tags（容器标签）", readsVideoField("tags"));
check("窗口渲染了 video.exif（容器内嵌的 EXIF）", readsVideoField("exif"));
check(
  "窗口把 video 接到了 info 上（computed 读 info.value?.video）",
  /info\.value\?\.video/.test(dialogSrc)
);
// 「接上了」必须是**那一行**接上了：只断言文件里出现过 info.value?.video
// 是不够的 —— GPS 那行也写着它，把 video 的 computed 改成返回 null 时断言
// 依然全绿。变异臂 ⑮ 就是这么漏过去的。这里只看 video 的 computed 那一行。
const videoComputedLine = /const\s+video\s*=\s*computed\(.*\)\s*;/.exec(dialogSrc);
check(
  "video 的 computed 确实读 info.value?.video（不是恒为 null）",
  !!videoComputedLine && /info\.value\?\.video/.test(videoComputedLine[0])
);
check(
  "GPS 同时服务图片与视频（image.gps 取不到时用 video.gps）",
  /image\?\.gps\s*\|\|\s*info\.value\?\.video\?\.gps/.test(dialogSrc)
);
check(
  "兜底区块在图片与视频都没有时才出现（视频不该被说成「这不是图像」）",
  /v-if="!image && !video"/.test(dialogSrc)
);

section("5c. 视频优先：看视频属性时不显示图像信息");

// 根因在后端：MP4 / MOV / M4V / 3GP 的文件头也是 ISO BMFF，与 HEIC 同源。
// 早先 imagemeta 只看「有没有 ftyp」，于是 MP4 被认成一个「格式 HEIF」的
// 图像 —— 属性窗口里就多出一块空的图像信息。判据现在是 brand 清单。
const imageSrc = stripComments(fs.readFileSync(IMAGEMETA, "utf8"));
const videoCode = stripComments(videoSrc);

check(
  "imagemeta 的 BMFF 分支认不出图像 brand 时放弃（不返回图像元数据）",
  /let\s+format\s*=\s*bmff_image_brand\(&buf\)\?/.test(imageSrc)
);

const brandHelper = bodyOf(imageSrc, "fn bmff_image_brand(buf: &[u8]) -> Option<&'static str> {");
check("抽到 bmff_image_brand 函数体", !!brandHelper);
check(
  "bmff_image_brand 的兜底是 None（MP4 / MOV 落到这里）",
  !!brandHelper && /\n\s*None\s*\}$/.test(brandHelper)
);

check(
  "imagemeta 有一份共享的图像 brand 清单（pub const IMAGE_BRANDS）",
  /pub\s+const\s+IMAGE_BRANDS\s*:\s*&\[&str\]/.test(imageSrc)
);
check(
  "videometa 用的是同一份清单（不再自带一份 —— 两份会漂）",
  /use\s+crate::imagemeta::\{[^}]*IMAGE_BRANDS[^}]*\}/.test(videoCode) &&
    !/const\s+IMAGE_BRANDS\s*:\s*&\[&str\]/.test(videoCode)
);
check(
  "Rust 里有回归测试：MP4 / MOV 不被认成图像，HEIC 仍被认成图像",
  /fn\s+iso_bmff_video_is_not_claimed_as_image\s*\(/.test(imageSrc) &&
    /fn\s+heic_is_still_claimed_as_image\s*\(/.test(imageSrc)
);

// 前端：视频优先 —— 有 video 时 image 一律为空，图像区块整块不渲染。
const imageComputed = /const\s+image\s*=\s*computed\(([\s\S]{0,400}?)\)\s*;/.exec(dialogSrc);
check("抽到 image 的 computed", !!imageComputed);
check(
  "image 的 computed 在有 video 时返回 null（视频优先）",
  !!imageComputed &&
    /info\.value\?\.video/.test(imageComputed[0]) &&
    /return\s+null/.test(imageComputed[0])
);
check(
  "图像区块仍然由 image 驱动（图片照常显示这一块）",
  /<section\s+v-if="image"\s+class="block">/.test(dialogSrc)
);

section("6. 对话框组件");

check("组件声明了 path prop", /defineProps\([\s\S]{0,200}path\s*:\s*\{\s*type:\s*String/.test(dialogSrc));
check("组件声明了 close 事件", /defineEmits\(\[[^\]]*["']close["']/.test(dialogSrc));
check("组件调用了 getFileProperties", dialogSrc.includes("getFileProperties(props.path)"));
check("组件用 capture 阶段拦 Esc", /addEventListener\("keydown",\s*onEscCapture,\s*true\)/.test(dialogSrc));
check("卸载时移除该监听", /removeEventListener\("keydown",\s*onEscCapture,\s*true\)/.test(dialogSrc));
check("组件复用了 formatBytes（不自己写第二份字节格式化）", /import\s*\{[^}]*formatBytes[^}]*\}\s*from\s*"\.\.\/format\.js"/.test(dialogSrc));

// 四个信息区块都要在（用户要的就是这些内容）
for (const [label, needle] of [
  ["基本信息", "基本信息"],
  ["图像信息", "图像信息"],
  ["GPS 区块", "GPS"],
  ["EXIF 区块", "EXIF"],
]) {
  check(`窗口里有「${label}」区块`, dialogSrc.includes(needle));
}
check("窗口展示了尺寸（宽 × 高）", dialogSrc.includes("width") && dialogSrc.includes("height"));
check("窗口展示了经纬度", dialogSrc.includes("latitude") && dialogSrc.includes("longitude"));
check("窗口展示了创建时间", dialogSrc.includes("info.created"));
check(
  "窗口展示了文件大小（走 formatBytes 的 sizeText）",
  dialogSrc.includes("sizeText") && dialogSrc.includes("info.value.size")
);
check("窗口展示了 EXIF 字段列表", dialogSrc.includes("image.exif"));

// formatBytes 是全 UI 唯一的字节格式化实现 —— 组件不许自己再造一个。
// 判据是「组件里根本不出现字节换算的原料」：1024 / Math.log / Math.pow。
const formatSrc = stripComments(fs.readFileSync(FORMAT, "utf8"));
const formatBody = bodyOf(formatSrc, "export function formatBytes(bytes, empty = \"0 B\") {");
check("抽到 formatBytes 函数体", !!formatBody && formatBody.length > 0);
check(
  "组件里没有自造的字节换算（1024 / Math.log / Math.pow 只应出现在 format.js）",
  !/\b1024\b/.test(dialogSrc) && !/Math\.(log|pow)/.test(dialogSrc)
);

section("7. 快捷键设置对话框能列出新命令（COMMANDS 是唯一数据源）");
check(
  "COMMANDS 里有 file.properties（设置对话框按 COMMANDS 渲染）",
  COMMANDS.some((c) => c.id === "file.properties")
);
check(
  "file.properties 有可显示的标签与说明",
  !!cmd && typeof cmd.label === "string" && cmd.label.length > 0 && typeof cmd.desc === "string" && cmd.desc.length > 0
);

// ── report ──

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log("全部通过");
}

// ── 变异臂 ──

if (process.argv.includes("--mutate")) {
  console.log(`\n${"═".repeat(50)}\n变异测试（每个都应 FAIL）\n${"═".repeat(50)}`);
  const { execFileSync } = await import("node:child_process");

  // 锚点按目标文件实际换行符归一化：仓库里 .vue / .js 的换行并不统一。
  const nlFor = (file, s) =>
    (fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s);

  const mutations = [
    { name: "① 快捷键命令名改成别的（面板分支断线）", file: path.join(ROOT, "src", "shortcuts.js"),
      from: '{ id: "file.properties", scope: "global", label: "文件属性"',
      to: '{ id: "file.props", scope: "global", label: "文件属性"' },
    { name: "② 全局按键分支不再认领 file.properties", file: APP,
      from: 'matches("file.properties", e)', to: 'matches("file.props", e)' },
    { name: "③ 去掉模态闸门（窗口开着时底下两层仍会被驱动）", file: APP,
      from: "  // The file-properties dialog is modal as well: it shows a scrollable list of\n  // EXIF fields, and the arrow keys / Delete would otherwise drive the panels\n  // underneath while the user scrolls the metadata.\n  if (propertiesVisible.value) return;\n",
      to: "" },
    { name: "④ 关闭后不归还焦点（Esc 之后键盘落到 body）", file: APP,
      from: "    const samePanel = ownerPanelId(target) === propertiesReturnPanel;\n    if (target && target !== document.body && target.isConnected && samePanel) {",
      to: "    const samePanel = ownerPanelId(target) === propertiesReturnPanel;\n    if (false) {" },
    { name: "⑤ 前端调错后端命令名（IPC 必然失败）", file: API,
      from: 'invoke("read_file_properties", { path })', to: 'invoke("read_file_prop", { path })' },
    { name: "⑥ 后端命令改名但前端没跟上", file: LIB,
      from: "fn read_file_properties(path: String)", to: "fn read_file_prop(path: String)" },
    { name: "⑦ 右键菜单项的 action 写错（点了没反应）", file: PANEL,
      from: 'items.push({ label: "属性…", action: "properties" });',
      to: 'items.push({ label: "属性…", action: "props" });' },
    { name: "⑧ 对话框不再调后端（窗口永远空白）", file: DIALOG,
      from: "const data = await getFileProperties(props.path);",
      to: "const data = { name: '', path: props.path, is_dir: false, size: 0, created: 0, modified: 0, accessed: 0, readonly: false, hidden: false, system: false, archive: false, image: null };" },
    { name: "⑨ 组件自造字节格式化（与 format.js 漂移）", file: DIALOG,
      from: 'import { formatBytes, formatDuration, formatBitrate } from "../format.js";',
      to: 'import { formatBytes, formatDuration, formatBitrate } from "../format.js";\nconst KB = 1024;\nvoid KB;' },
    { name: "⑩ 不跟随选中项（窗口永远显示打开时那一个文件）", file: APP,
      from: "  () => [leftPanel.value?.selectedEntry || null, rightPanel.value?.selectedEntry || null],",
      to: "  () => [null, null]," },
    { name: "⑪ 对话框不再监听 path 变化（换了文件也不刷新）", file: DIALOG,
      from: "watch(() => props.path, load);",
      to: "// watch(() => props.path, load);" },
    { name: "⑫ 对话框的方向键不接 App.vue（焦点不在列表上时按 ↑/↓ 没反应）", file: DIALOG,
      from: "  props.onNavigate(e.key === \"ArrowDown\" ? 1 : -1);",
      to: "  // props.onNavigate(e.key === \"ArrowDown\" ? 1 : -1);" },
    { name: "⑬ 后端探测了视频但不把结果送过 IPC（窗口里看不到视频信息）", file: LIB,
      from: "video: videometa::probe(p),", to: "video: None," },
    { name: "⑭ 后端不探测视频（视频文件被说成「这不是图像或视频」）", file: LIB,
      from: "mod videometa;", to: "// mod videometa;" },
    { name: "⑮ 前端不读 video 字段（后端送了数据，窗口照样空白）", file: DIALOG,
      from: "const video = computed(() => info.value?.video || null);",
      to: "const video = computed(() => null);" },
    { name: "⑯ 删掉「视频信息」区块（探测到了但没有展示的地方）", file: DIALOG,
      from: '<div class="block-title">视频信息</div>',
      to: '<div class="block-title">视频</div>' },
    { name: "⑰ 兜底区块不再排除视频（视频文件被显示成「这不是图像或视频文件」）", file: DIALOG,
      from: 'v-if="!image && !video"', to: 'v-if="!image"' },
    { name: "⑱ GPS 只看图片（视频里的位置不显示了）", file: DIALOG,
      from: "const gps = computed(() => info.value?.image?.gps || info.value?.video?.gps || null);",
      to: "const gps = computed(() => info.value?.image?.gps || null);" },
    { name: "⑲ 后端把 MP4 也认成图像（视频属性窗口多出一块图像信息）", file: IMAGEMETA,
      from: "    // 主 brand 与兼容列表都没有图像 brand → 视频容器，不认领成图像。\n    None\n",
      to: "    // 主 brand 与兼容列表都没有图像 brand → 视频容器，不认领成图像。\n    Some(\"HEIF\")\n" },
    { name: "⑳ 前端不再让视频优先（视频属性窗口又显示图像信息）", file: DIALOG,
      from: "  if (info.value?.video) return null;",
      to: "  // 视频优先被去掉了" },
    { name: "㉑ videometa 自带一份 brand 清单（与 imagemeta 漂移）", file: VIDEOMETA,
      from: "use crate::imagemeta::{ExifField, GpsInfo, IMAGE_BRANDS};",
      to: "use crate::imagemeta::{ExifField, GpsInfo};\nconst IMAGE_BRANDS: &[&str] = &[\"heic\", \"heix\"];" },
    { name: "㉒ 后端认不出 brand 时硬编一个 HEIF（MP4 又被当成图像）", file: IMAGEMETA,
      from: "        let format = bmff_image_brand(&buf)?;",
      to: "        let format = bmff_image_brand(&buf).unwrap_or(\"HEIF\");" },
  ];

  for (const mu of mutations) {
    const original = fs.readFileSync(mu.file, "utf8");
    const from = nlFor(mu.file, mu.from);
    const to = nlFor(mu.file, mu.to);
    const count = original.split(from).length - 1;
    console.log(`\n▶ ${mu.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      failures.push(`变异目标未唯一命中：${mu.name}`);
      continue;
    }
    let failedNow = 0;
    let out = "";
    try {
      fs.writeFileSync(mu.file, original.split(from).join(to), "utf8");
      try {
        execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
      } catch (e) {
        failedNow = 1;
        out = (e.stdout || "") + (e.stderr || "");
      }
    } finally {
      fs.writeFileSync(mu.file, original, "utf8");
    }
    if (failedNow) {
      passed++;
      const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
      console.log(`  ok   变异被断言抓到（FAIL 如预期）${firstFail ? " | " + firstFail.trim() : ""}`);
    } else {
      failures.push(`变异未被抓到：${mu.name}`);
      console.log("  FAIL 变异未被抓到 —— 该断言是恒真的");
    }
  }
  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
}

if (failures.length) process.exitCode = 1;
