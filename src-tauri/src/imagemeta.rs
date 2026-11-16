//! 图像元数据探测：尺寸 + EXIF（含 GPS）。
//!
//! 这里只做**字节级读取**，不解码像素，也不引入任何图像 / EXIF 第三方 crate：
//!   • 尺寸与色彩信息从各格式的定长头部字段直接读（PNG 的 IHDR、JPEG 的 SOF、
//!     GIF / BMP / WebP / TIFF / HEIC 各自的固定偏移）；
//!   • EXIF 从 JPEG 的 APP1（`Exif\0\0`）、PNG 的 `eXIf` 块、TIFF 本体、
//!     HEIC/AVIF 的 Exif item 里取出 TIFF 结构后按 IFD 逐项解析。
//!
//! 为什么自己写而不引 crate：这个 app 的依赖树是刻意保持精简的（tauri / serde /
//! trash / arboard …），而这里真正需要的解析不到 600 行；引一个 crate 换来的是
//! 一份要长期跟着升级的 API 面，还要为「它到底解不解析 XMP」操心。
//!
//! 设计上的一条硬规矩：**解析失败永远不能变成「整个属性窗口打不开」**。
//! 所有读取都返回 `Option`，拿不到就少显示一行，而不是报错。所以
//! `probe()` 对任何文件都尽量给出能给的字段。

use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// 探测时读取的最大字节数。
///
/// EXIF 段（APP1）最长 64 KB，且几乎总是紧跟在文件头后面。给 4 MB 的余量，
/// 足以覆盖「EXIF 在前、像素数据在后」的全部常规布局，又不至于为了看一眼
/// 属性就把一张 30 MB 的原片整个读进内存。
const PROBE_LIMIT: usize = 4 * 1024 * 1024;

/// 一条 EXIF 字段（标签 + 已格式化好的值）。
#[derive(Serialize, Clone, Debug)]
pub struct ExifField {
    pub label: String,
    pub value: String,
}

/// GPS 信息。坐标一律是**十进制度**（正北正东为正）。
#[derive(Serialize, Clone, Default, Debug)]
pub struct GpsInfo {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub direction: Option<f64>,
    /// GPS 时间戳，形如 `12:34:56`。
    pub timestamp: Option<String>,
    /// GPS 日期，形如 `2024:05:01`。
    pub date: Option<String>,
}

/// 一个图像文件的元数据。
#[derive(Serialize, Clone, Default, Debug)]
pub struct ImageMeta {
    /// 格式名：`JPEG` / `PNG` / `GIF` / `BMP` / `WebP` / `TIFF` / `HEIC` / `AVIF`。
    pub format: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 每通道位深（JPEG 里是采样精度）。
    pub bit_depth: Option<u32>,
    /// 色彩类型：`真彩色` / `灰度` / `索引色` / `YCbCr` …。
    pub color_type: Option<String>,
    pub has_alpha: bool,
    /// EXIF 的方向（0x0112）：`正常` / `顺时针旋转 90°` …
    pub orientation: Option<String>,
    /// EXIF 字段（拍摄参数、相机信息、作者、版权 …）。
    pub exif: Vec<ExifField>,
    pub gps: Option<GpsInfo>,
}

/// 读取文件的前 `limit` 个字节。读不到就返回空 —— 调用方据此判定「不是图像」。
fn read_head(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let f = File::open(path).ok()?;
    let mut buf = Vec::new();
    // 读不满 limit 也算成功：文件本来就这么大。
    let _ = f.take(limit as u64).read_to_end(&mut buf);
    Some(buf)
}

/// 探测一个文件的图像元数据。不是图像（或读不出来）时返回 `None`。
pub fn probe(path: &Path) -> Option<ImageMeta> {
    let buf = read_head(path, PROBE_LIMIT)?;
    if buf.is_empty() {
        return None;
    }

    // JPEG：SOI = FF D8
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xD8 {
        let mut meta = ImageMeta {
            format: "JPEG".to_string(),
            ..Default::default()
        };
        parse_jpeg(&buf, &mut meta);
        return Some(meta);
    }

    // PNG：\x89 P N G \r \n \x1a \n
    if buf.len() >= 8 && &buf[0..8] == b"\x89PNG\r\n\x1a\n" {
        let mut meta = ImageMeta {
            format: "PNG".to_string(),
            ..Default::default()
        };
        parse_png(&buf, &mut meta);
        return Some(meta);
    }

    // GIF87a / GIF89a
    if buf.len() >= 10 && (&buf[0..6] == b"GIF87a" || &buf[0..6] == b"GIF89a") {
        let mut meta = ImageMeta {
            format: "GIF".to_string(),
            width: Some(u16::from_le_bytes([buf[6], buf[7]]) as u32),
            height: Some(u16::from_le_bytes([buf[8], buf[9]]) as u32),
            ..Default::default()
        };
        meta.color_type = Some("索引色".to_string());
        meta.has_alpha = true; // GIF 的透明色来自图形控制扩展，这里先按「可能有」处理
        return Some(meta);
    }

    // BMP
    if buf.len() >= 30 && &buf[0..2] == b"BM" {
        let width = i32::from_le_bytes([buf[18], buf[19], buf[20], buf[21]]).unsigned_abs();
        let raw_height = i32::from_le_bytes([buf[22], buf[23], buf[24], buf[25]]);
        // 负的高度表示自上而下的位图，取绝对值。
        let height = raw_height.unsigned_abs();
        let bpp = u16::from_le_bytes([buf[28], buf[29]]);
        let mut meta = ImageMeta {
            format: "BMP".to_string(),
            width: Some(width),
            height: Some(height),
            bit_depth: Some(bpp as u32),
            ..Default::default()
        };
        meta.color_type = Some(if bpp == 32 { "真彩色" } else { "真彩色" }.to_string());
        meta.has_alpha = bpp == 32;
        return Some(meta);
    }

    // WebP：RIFF....WEBP
    if buf.len() >= 16 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        let mut meta = ImageMeta {
            format: "WebP".to_string(),
            ..Default::default()
        };
        parse_webp(&buf, &mut meta);
        return Some(meta);
    }

    // ISO BMFF（HEIC / HEIF / AVIF）：第 4..8 字节是 "ftyp"
    if buf.len() >= 12 && &buf[4..8] == b"ftyp" {
        let brand = &buf[8..12];
        let format = match brand {
            b"heic" | b"heix" | b"hevc" | b"hevx" => "HEIC",
            b"mif1" | b"msf1" => "HEIF",
            b"avif" | b"avis" => "AVIF",
            _ => "HEIF",
        };
        let mut meta = ImageMeta {
            format: format.to_string(),
            ..Default::default()
        };
        parse_bmff(&buf, &mut meta);
        return Some(meta);
    }

    // TIFF 本体（II / MM 字节序 + 42）
    if buf.len() >= 8 && (&buf[0..2] == b"II" || &buf[0..2] == b"MM") {
        let mut meta = ImageMeta {
            format: "TIFF".to_string(),
            ..Default::default()
        };
        if let Some(exif) = parse_tiff(&buf) {
            meta.width = exif.width;
            meta.height = exif.height;
            meta.orientation = exif.orientation;
            meta.exif = exif.fields;
            meta.gps = exif.gps;
        }
        return Some(meta);
    }

    None
}

/// 解析一段 EXIF 数据（可带 `Exif\0\0` 前缀），返回字段与 GPS。
///
/// 给 [`crate::videometa`] 用：部分视频容器里也塞了一份完整的 EXIF（相机 /
/// 手机录影时写下的拍摄参数）。解析不出就返回 `None`，调用方少显示几行。
pub fn parse_exif_payload(data: &[u8]) -> Option<(Vec<ExifField>, Option<GpsInfo>)> {
    let body = if data.len() >= 6 && &data[0..6] == b"Exif\0\0" {
        &data[6..]
    } else {
        data
    };
    let exif = parse_tiff(body)?;
    Some((exif.fields, exif.gps))
}

// ── JPEG ──

/// JPEG 的 SOF（Start Of Frame）段。`C4`(DHT) / `C8`(JPG) / `CC`(DAC) 不是帧头。
fn is_sof(marker: u8) -> bool {
    (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
}

fn parse_jpeg(buf: &[u8], meta: &mut ImageMeta) {
    let mut i = 2usize; // 跳过 SOI
    let mut seen_exif = false;

    while i + 1 < buf.len() {
        // 段以 0xFF 开头，0xFF 可以连续出现（填充字节）。
        if buf[i] != 0xFF {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < buf.len() && buf[j] == 0xFF {
            j += 1;
        }
        if j >= buf.len() {
            break;
        }
        let marker = buf[j];
        i = j + 1;

        // 不带负载的标记：SOI / EOI / RSTn / TEM。
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        // EOI 或 SOS：后面是熵编码数据，不再有元数据段。
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        if i + 2 > buf.len() {
            break;
        }
        let seg_len = ((buf[i] as usize) << 8) | buf[i + 1] as usize;
        if seg_len < 2 {
            break;
        }
        let data_start = i + 2;
        let data_end = (data_start + seg_len - 2).min(buf.len());
        let data = &buf[data_start..data_end];

        if marker == 0xE1 && !seen_exif {
            // APP1：可能是 EXIF（"Exif\0\0"），也可能是 XMP（"http://ns.adobe.com…"）。
            if data.len() >= 6 && &data[0..6] == b"Exif\0\0" {
                if let Some(exif) = parse_tiff(&data[6..]) {
                    meta.exif = exif.fields;
                    meta.gps = exif.gps;
                    meta.orientation = exif.orientation;
                    if meta.width.is_none() {
                        meta.width = exif.width;
                        meta.height = exif.height;
                    }
                    seen_exif = true;
                }
            }
        }

        if is_sof(marker) && data.len() >= 6 {
            meta.bit_depth = Some(data[0] as u32);
            meta.height = Some(u16::from_be_bytes([data[1], data[2]]) as u32);
            meta.width = Some(u16::from_be_bytes([data[3], data[4]]) as u32);
            let components = data[5];
            meta.color_type = Some(
                match components {
                    1 => "灰度",
                    3 => "YCbCr",
                    4 => "CMYK",
                    _ => "多分量",
                }
                .to_string(),
            );
            // JPEG 没有 alpha 通道（CMYK 的第 4 分量是墨水，不是透明度）。
            meta.has_alpha = false;
        }

        i = data_end;
    }
}

// ── PNG ──

fn png_color_type(ct: u8) -> &'static str {
    match ct {
        0 => "灰度",
        2 => "真彩色",
        3 => "索引色",
        4 => "灰度 + Alpha",
        6 => "真彩色 + Alpha",
        _ => "未知",
    }
}

fn parse_png(buf: &[u8], meta: &mut ImageMeta) {
    let mut i = 8usize; // 跳过签名
    while i + 8 <= buf.len() {
        let len = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let ctype = &buf[i + 4..i + 8];
        let data_start = i + 8;
        let data_end = (data_start + len).min(buf.len());
        let data = &buf[data_start..data_end];

        match ctype {
            b"IHDR" => {
                if data.len() >= 13 {
                    meta.width = Some(u32::from_be_bytes([
                        data[0], data[1], data[2], data[3],
                    ]));
                    meta.height = Some(u32::from_be_bytes([
                        data[4], data[5], data[6], data[7],
                    ]));
                    meta.bit_depth = Some(data[8] as u32);
                    meta.color_type = Some(png_color_type(data[9]).to_string());
                    meta.has_alpha = data[9] == 4 || data[9] == 6;
                }
            }
            // eXIf 块里就是一段 TIFF 流（没有 "Exif\0\0" 前缀）。
            b"eXIf" => {
                if let Some(exif) = parse_tiff(data) {
                    meta.exif = exif.fields;
                    meta.gps = exif.gps;
                    meta.orientation = exif.orientation;
                }
            }
            // 文本块：关键词 + NUL + 内容。
            b"tEXt" => {
                if let Some((k, v)) = split_png_text(data) {
                    meta.exif.push(ExifField {
                        label: format!("PNG · {}", k),
                        value: v,
                    });
                }
            }
            b"iTXt" => {
                if let Some((k, v)) = parse_itxt(data) {
                    meta.exif.push(ExifField {
                        label: format!("PNG · {}", k),
                        value: v,
                    });
                }
            }
            b"zTXt" => {
                if let Some((k, v)) = split_png_text(data) {
                    meta.exif.push(ExifField {
                        label: format!("PNG · {}", k),
                        value: v,
                    });
                }
            }
            b"IEND" => break,
            _ => {}
        }

        // 跳过 CRC
        i = data_end + 4;
        if len == 0 && ctype != b"IEND" {
            break; // 防御：零长块会让我们死循环
        }
    }
}

/// `tEXt` / `zTXt`：关键词 + NUL + 文本。
fn split_png_text(data: &[u8]) -> Option<(String, String)> {
    let nul = data.iter().position(|&c| c == 0)?;
    let key = String::from_utf8_lossy(&data[..nul]).trim().to_string();
    let value = String::from_utf8_lossy(&data[nul + 1..])
        .trim_end_matches('\0')
        .trim()
        .to_string();
    if key.is_empty() {
        return None;
    }
    Some((key, value))
}

/// `iTXt`：关键词 + NUL + 压缩标志(1) + 压缩方法(1) + 语言 + NUL + 译文 + NUL + 文本。
fn parse_itxt(data: &[u8]) -> Option<(String, String)> {
    let nul = data.iter().position(|&c| c == 0)?;
    let key = String::from_utf8_lossy(&data[..nul]).trim().to_string();
    let rest = &data[nul + 1..];
    if rest.len() < 2 {
        return None;
    }
    let compressed = rest[0];
    let lang_end = rest[2..].iter().position(|&c| c == 0)? + 2;
    let trans_end = rest[lang_end + 1..]
        .iter()
        .position(|&c| c == 0)
        .map(|p| p + lang_end + 1)
        .unwrap_or(rest.len());
    let text = &rest[trans_end + 1..];
    if compressed != 0 {
        // 压缩过的文本解不了，标出来而不是假装没有。
        return Some((key, "（已压缩，无法显示）".to_string()));
    }
    let value = String::from_utf8_lossy(text)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    if key.is_empty() {
        return None;
    }
    Some((key, value))
}

// ── WebP ──

fn parse_webp(buf: &[u8], meta: &mut ImageMeta) {
    let mut i = 12usize; // "RIFF" + size + "WEBP"
    while i + 8 <= buf.len() {
        let fourcc = &buf[i..i + 4];
        let size = u32::from_le_bytes([buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]]) as usize;
        let data_start = i + 8;
        let data_end = (data_start + size).min(buf.len());
        let data = &buf[data_start..data_end];

        match fourcc {
            b"VP8X" => {
                // 扩展头：flags(4) + 画布宽-1(3, LE) + 画布高-1(3, LE)
                if data.len() >= 10 {
                    meta.width = Some(u32::from_le_bytes([
                        data[4], data[5], data[6], 0,
                    ]) + 1);
                    meta.height = Some(u32::from_le_bytes([
                        data[7], data[8], data[9], 0,
                    ]) + 1);
                    meta.has_alpha = data[0] & 0x10 != 0;
                }
            }
            b"VP8 " => {
                // 有损：帧头 3 字节 + 同步码 9D 01 2A + 宽(2) + 高(2)
                if data.len() >= 10 && data[3] == 0x9D && data[4] == 0x01 && data[5] == 0x2A {
                    meta.width = Some(u16::from_le_bytes([data[6], data[7]]) as u32 & 0x3FFF);
                    meta.height = Some(u16::from_le_bytes([data[8], data[9]]) as u32 & 0x3FFF);
                }
            }
            b"VP8L" => {
                // 无损：1 字节签名 0x2F + 4 字节里塞着 14 位宽 / 14 位高
                if data.len() >= 5 && data[0] == 0x2F {
                    let bits = u32::from_le_bytes([data[1], data[2], data[3], data[4]]);
                    meta.width = Some((bits & 0x3FFF) + 1);
                    meta.height = Some(((bits >> 14) & 0x3FFF) + 1);
                    meta.has_alpha = (bits >> 28) & 1 != 0;
                }
            }
            _ => {}
        }

        if size == 0 {
            break;
        }
        i = data_end;
    }
}

// ── ISO BMFF（HEIC / AVIF）──

fn parse_bmff(buf: &[u8], meta: &mut ImageMeta) {
    // `ispe`（图像空间尺寸）可能埋在 meta/ipr/ipco 里的任意一层，扫描比逐层
    // 解 box 树简单得多，也不会被 box 深度绊倒。
    if let Some(at) = find_bytes(buf, b"ispe") {
        // box: size(4) + "ispe"(4) + version/flags(4) + width(4) + height(4)
        if at + 12 <= buf.len() {
            meta.width = Some(u32::from_be_bytes([
                buf[at + 4],
                buf[at + 5],
                buf[at + 6],
                buf[at + 7],
            ]));
            meta.height = Some(u32::from_be_bytes([
                buf[at + 8],
                buf[at + 9],
                buf[at + 10],
                buf[at + 11],
            ]));
        }
    }

    // Exif item：payload 开头是 4 字节偏移量，指向 TIFF 头的位置。
    if let Some(at) = find_bytes(buf, b"Exif") {
        let payload = at + 4;
        if payload + 4 <= buf.len() {
            let off = u32::from_be_bytes([
                buf[payload],
                buf[payload + 1],
                buf[payload + 2],
                buf[payload + 3],
            ]) as usize;
            let tiff_start = payload + off;
            if tiff_start + 8 <= buf.len() {
                if let Some(exif) = parse_tiff(&buf[tiff_start..]) {
                    meta.exif = exif.fields;
                    meta.gps = exif.gps;
                    meta.orientation = exif.orientation;
                }
            } else if payload + 8 <= buf.len() {
                // 有些写法没有那 4 字节偏移量，直接就是 TIFF 流。
                if let Some(exif) = parse_tiff(&buf[payload..]) {
                    meta.exif = exif.fields;
                    meta.gps = exif.gps;
                    meta.orientation = exif.orientation;
                }
            }
        }
    }
}

/// 在字节串里找子序列（返回首个命中位置）。
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

// ── TIFF / EXIF ──

/// 解析出来的 EXIF 内容。
struct ExifData {
    fields: Vec<ExifField>,
    gps: Option<GpsInfo>,
    width: Option<u32>,
    height: Option<u32>,
    orientation: Option<String>,
}

/// TIFF 里的一个值条目。
#[derive(Clone, Copy)]
struct Entry {
    tag: u16,
    typ: u16,
    count: u32,
    /// 值字段在 IFD 内的起始偏移（条目起点 + 8）。
    val_off: usize,
}

/// TIFF 字节序视图。只读，不复制。
struct Tiff<'a> {
    d: &'a [u8],
    le: bool,
}

impl<'a> Tiff<'a> {
    fn u16_at(&self, off: usize) -> Option<u16> {
        let b = self.d.get(off..off + 2)?;
        Some(if self.le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }

    fn u32_at(&self, off: usize) -> Option<u32> {
        let b = self.d.get(off..off + 4)?;
        Some(if self.le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    }

    /// 读一个 IFD，返回其中的条目。
    fn read_ifd(&self, off: usize) -> Option<Vec<Entry>> {
        let n = self.u16_at(off)? as usize;
        // 损坏文件里 count 可能离谱大；上限只是为了不把内存吃光。
        if n > 4096 {
            return None;
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let eoff = off + 2 + i * 12;
            if eoff + 12 > self.d.len() {
                break;
            }
            let tag = self.u16_at(eoff)?;
            let typ = self.u16_at(eoff + 2)?;
            let count = self.u32_at(eoff + 4)?;
            out.push(Entry {
                tag,
                typ,
                count,
                val_off: eoff + 8,
            });
        }
        Some(out)
    }

    /// 取条目的数据字节。短值内联在条目里，长值由偏移指向。
    fn data_of(&self, e: &Entry) -> Option<&'a [u8]> {
        let size = type_size(e.typ)? as usize;
        let total = size.checked_mul(e.count as usize)?;
        if total == 0 {
            return Some(&[]);
        }
        if total <= 4 {
            return self.d.get(e.val_off..e.val_off.checked_add(total)?);
        }
        let ptr = self.u32_at(e.val_off)? as usize;
        // TIFF 规范里偏移 0 表示「无值」，不能当作指向文件开头。
        if ptr == 0 {
            return None;
        }
        self.d.get(ptr..ptr.checked_add(total)?)
    }

    fn ascii(&self, e: &Entry) -> Option<String> {
        let b = self.data_of(e)?;
        let s: String = b
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as char)
            .collect();
        Some(s.trim().to_string())
    }

    fn u32_value(&self, e: &Entry) -> Option<u32> {
        match e.typ {
            3 => {
                // SHORT
                let b = self.data_of(e)?;
                let raw = if self.le {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                };
                Some(raw as u32)
            }
            4 => {
                let b = self.data_of(e)?;
                Some(if self.le {
                    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
                } else {
                    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
                })
            }
            _ => None,
        }
    }

    /// 有理数（类型 5）：num / den。
    fn rational(&self, e: &Entry) -> Option<f64> {
        let b = self.data_of(e)?;
        if b.len() < 8 {
            return None;
        }
        let num = if self.le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        };
        let den = if self.le {
            u32::from_le_bytes([b[4], b[5], b[6], b[7]])
        } else {
            u32::from_be_bytes([b[4], b[5], b[6], b[7]])
        };
        if den == 0 {
            return None;
        }
        Some(num as f64 / den as f64)
    }

    /// 有符号有理数（类型 10）。
    fn srational(&self, e: &Entry) -> Option<f64> {
        let b = self.data_of(e)?;
        if b.len() < 8 {
            return None;
        }
        let read = |o: usize| -> i32 {
            if self.le {
                i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
            } else {
                i32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
            }
        };
        let num = read(0);
        let den = read(4);
        if den == 0 {
            return None;
        }
        Some(num as f64 / den as f64)
    }

    /// 一组有理数（GPS 的度分秒就是 3 个）。
    ///
    /// 必须**整块取出再切**：count > 1 时 TIFF 把这组值放在别处，条目里的
    /// 值槽存的是「数据块的偏移」而不是第一个有理数。按 `val_off + i*8`
    /// 逐个造子条目只在 i == 0 时碰巧正确（那时读到的正是那个偏移），
    /// i >= 1 读到的是数据块里的分数本身被当成偏移 —— 于是 GPS 的经纬度
    /// （度分秒 3 个）整个解析不出来。
    fn rationals(&self, e: &Entry) -> Option<Vec<f64>> {
        let count = e.count as usize;
        if count == 0 || count > 8 {
            return None;
        }
        let block = self.data_of(e)?;
        if block.len() < count * 8 {
            return None;
        }
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let b = &block[i * 8..i * 8 + 8];
            let num = if self.le {
                u32::from_le_bytes([b[0], b[1], b[2], b[3]])
            } else {
                u32::from_be_bytes([b[0], b[1], b[2], b[3]])
            };
            let den = if self.le {
                u32::from_le_bytes([b[4], b[5], b[6], b[7]])
            } else {
                u32::from_be_bytes([b[4], b[5], b[6], b[7]])
            };
            if den == 0 {
                return None;
            }
            out.push(num as f64 / den as f64);
        }
        Some(out)
    }
}

/// TIFF 各类型占用的字节数。
fn type_size(typ: u16) -> Option<u16> {
    Some(match typ {
        1 | 2 | 6 | 7 => 1,   // BYTE / ASCII / SBYTE / UNDEFINED
        3 | 8 => 2,           // SHORT / SSHORT
        4 | 9 | 11 | 13 => 4, // LONG / SLONG / FLOAT / IFD
        5 | 10 | 12 => 8,     // RATIONAL / SRATIONAL / DOUBLE
        _ => return None,
    })
}

/// 解析一段 TIFF 数据（EXIF 的载荷就是它）。
fn parse_tiff(data: &[u8]) -> Option<ExifData> {
    if data.len() < 8 {
        return None;
    }
    let le = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let t = Tiff { d: data, le };
    // 42 是经典 TIFF 的魔数；BigTIFF 用 43（这里不解析）。
    if t.u16_at(2)? != 42 {
        return None;
    }
    let ifd0 = t.u32_at(4)? as usize;

    let mut out = ExifData {
        fields: Vec::new(),
        gps: None,
        width: None,
        height: None,
        orientation: None,
    };

    // 长度单位（英寸 / 厘米）要留着给分辨率那两行用。
    let mut res_unit: Option<String> = None;
    let entries = t.read_ifd(ifd0)?;

    // 第一遍：取分辨率单位。
    for e in &entries {
        if e.tag == 0x0128 {
            res_unit = match t.u32_value(e) {
                Some(1) => Some("无单位".to_string()),
                Some(2) => Some("英寸".to_string()),
                Some(3) => Some("厘米".to_string()),
                Some(v) => Some(format!("未知 ({})", v)),
                None => None,
            };
        }
    }

    for e in &entries {
        if let Some((label, value)) = describe_entry(&t, e, res_unit.as_deref()) {
            match e.tag {
                0x0112 => out.orientation = Some(value.clone()),
                0x0100 => out.width = value.parse().ok(),
                0x0101 => out.height = value.parse().ok(),
                _ => {}
            }
            out.fields.push(ExifField { label, value });
        }
    }

    // 子 IFD：Exif IFD（0x8769）与 GPS IFD（0x8825）。
    let mut exif_ifd: Option<usize> = None;
    let mut gps_ifd: Option<usize> = None;
    for e in &entries {
        match e.tag {
            0x8769 => exif_ifd = t.u32_value(e).map(|v| v as usize),
            0x8825 => gps_ifd = t.u32_value(e).map(|v| v as usize),
            _ => {}
        }
    }

    if let Some(off) = exif_ifd {
        if let Some(sub) = t.read_ifd(off) {
            for e in &sub {
                if let Some((label, value)) = describe_exif_entry(&t, e) {
                    out.fields.push(ExifField { label, value });
                }
            }
        }
    }

    if let Some(off) = gps_ifd {
        if let Some(sub) = t.read_ifd(off) {
            out.gps = parse_gps(&t, &sub);
            for e in &sub {
                if let Some((label, value)) = describe_gps_entry(&t, e) {
                    out.fields.push(ExifField { label, value });
                }
            }
        }
    }

    Some(out)
}

// ── 字段格式化 ──

/// 方向（0x0112）。
fn orientation_label(v: u32) -> String {
    match v {
        1 => "正常".to_string(),
        2 => "水平翻转".to_string(),
        3 => "旋转 180°".to_string(),
        4 => "垂直翻转".to_string(),
        5 => "转置".to_string(),
        6 => "顺时针旋转 90°".to_string(),
        7 => "逆时针旋转 90°".to_string(),
        8 => "转置旋转 90°".to_string(),
        other => format!("未知 ({})", other),
    }
}

/// 测光模式（0x9207）。
fn metering_label(v: u32) -> String {
    match v {
        0 => "未知",
        1 => "平均测光",
        2 => "中央重点平均测光",
        3 => "点测光",
        4 => "多点测光",
        5 => "评价测光",
        6 => "局部测光",
        255 => "其它",
        other => return format!("未知 ({})", other),
    }
    .to_string()
}

/// 光源（0x9208）。
fn light_source_label(v: u32) -> String {
    match v {
        0 => "未知",
        1 => "日光",
        2 => "荧光灯",
        3 => "闪光灯",
        4 => "钨丝灯",
        9 => "晴天",
        10 => "阴天",
        11 => "阴影",
        12 => "日光色荧光灯",
        13 => "白色荧光灯",
        14 => "冷白色荧光灯",
        15 => "白色荧光灯",
        17 => "标准光源 A",
        18 => "标准光源 B",
        19 => "标准光源 C",
        20 => "D55",
        21 => "D65",
        22 => "D75",
        255 => "其它",
        other => return format!("未知 ({})", other),
    }
    .to_string()
}

/// 闪光灯（0x9209）。低字节是状态位，高位是模式。
fn flash_label(v: u32) -> String {
    let fired = v & 0x01 != 0;
    let no_function = v & 0x20 != 0;
    let mode = match (v >> 5) & 0x03 {
        0 => " compulsory",
        1 => " compulsory",
        2 => " optional",
        _ => "",
    };
    let _ = mode;
    if no_function {
        return "无闪光功能".to_string();
    }
    if fired {
        "已闪光".to_string()
    } else {
        "未闪光".to_string()
    }
}

/// 曝光模式（0xA402）。
fn exposure_mode_label(v: u32) -> String {
    (match v {
        0 => "自动曝光",
        1 => "手动曝光",
        2 => "自动包围曝光",
        3 => "快门优先",
        4 => "光圈优先",
        5 => "创意模式",
        6 => "运动模式",
        7 => "人像模式",
        8 => "风景模式",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 白平衡（0xA403）。
fn white_balance_label(v: u32) -> String {
    (match v {
        0 => "自动",
        1 => "手动",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 色彩空间（0xA001）。
fn color_space_label(v: u32) -> String {
    (match v {
        1 => "sRGB",
        2 => "Adobe RGB",
        0xFFFF => "未校准",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 文件来源（0xA300）。
fn file_source_label(v: u32) -> String {
    (match v {
        1 => "胶片扫描仪",
        2 => "反射扫描仪",
        3 => "数码相机",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 场景类型（0xA301）。
fn scene_type_label(v: u32) -> String {
    (match v {
        1 => "直接拍摄",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 场景拍摄类型（0xA406）。
fn scene_capture_type_label(v: u32) -> String {
    (match v {
        0 => "标准",
        1 => "风景",
        2 => "人像",
        3 => "夜景",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 增益控制（0xA407）。
fn gain_control_label(v: u32) -> String {
    (match v {
        0 => "无",
        1 => "低增益提升",
        2 => "高增益提升",
        3 => "低增益抑制",
        4 => "高增益抑制",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 对比度 / 饱和度 / 锐度（0xA408-0xA40A）。
fn tone_label(v: u32) -> String {
    (match v {
        0 => "正常",
        1 => "柔和",
        2 => "硬朗",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 主体距离范围（0xA40C）。
fn distance_range_label(v: u32) -> String {
    (match v {
        0 => "未知",
        1 => "微距",
        2 => "近景",
        3 => "远景",
        other => return format!("未知 ({})", other),
    })
    .to_string()
}

/// 把 APEX 形式的快门速度还原成「1/x 秒」。
fn apex_to_shutter(apex: f64) -> String {
    let seconds = 2f64.powf(-apex);
    if seconds >= 1.0 {
        format!("{} s", trim_float(seconds))
    } else {
        let denom = (1.0 / seconds).round();
        format!("1/{} s", denom as i64)
    }
}

/// 把 APEX 形式的光圈还原成 f 值。
fn apex_to_fnumber(apex: f64) -> String {
    format!("f/{}", trim_float(2f64.powf(apex / 2.0)))
}

/// 去掉浮点尾巴：2.80 → 2.8，3.00 → 3。
fn trim_float(v: f64) -> String {
    let s = format!("{:.2}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() {
        "0".to_string()
    } else {
        s.to_string()
    }
}

/// EXIF 的时间戳 `2024:05:01 12:00:00` → `2024-05-01 12:00:00`。
fn exif_datetime(raw: &str) -> String {
    let s = raw.trim();
    // 只改前两个冒号（日期部分），时间部分的冒号保留。
    let bytes: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut colons = 0;
    for (i, ch) in bytes.iter().enumerate() {
        if *ch == ':' && colons < 2 && i < 10 {
            out.push('-');
            colons += 1;
        } else {
            out.push(*ch);
        }
    }
    out
}

/// IFD0 / IFD1（TIFF 基本标签）。
fn describe_entry(t: &Tiff, e: &Entry, res_unit: Option<&str>) -> Option<(String, String)> {
    let label = match e.tag {
        0x0100 => "图像宽度",
        0x0101 => "图像高度",
        0x010E => "图片描述",
        0x010F => "相机厂商",
        0x0110 => "相机型号",
        0x0112 => "方向",
        0x011A => "水平分辨率",
        0x011B => "垂直分辨率",
        0x0128 => "分辨率单位",
        0x0131 => "软件",
        0x0132 => "修改时间",
        0x013B => "作者",
        0x8298 => "版权",
        0x829A => "曝光时间",
        _ => return None,
    };

    let value = match e.tag {
        0x0100 | 0x0101 => t.u32_value(e)?.to_string(),
        0x0112 => orientation_label(t.u32_value(e)?),
        0x011A | 0x011B => {
            let v = t.rational(e)?;
            let unit = res_unit.unwrap_or("");
            if unit.is_empty() || unit == "无单位" {
                format!("{}", trim_float(v))
            } else {
                format!("{} {}", trim_float(v), unit)
            }
        }
        0x0128 => match t.u32_value(e)? {
            1 => "无单位".to_string(),
            2 => "英寸".to_string(),
            3 => "厘米".to_string(),
            v => format!("未知 ({})", v),
        },
        0x829A => {
            let v = t.rational(e)?;
            if v >= 1.0 {
                format!("{} s", trim_float(v))
            } else {
                format!("1/{} s", (1.0 / v).round() as i64)
            }
        }
        _ => {
            let s = t.ascii(e)?;
            if s.is_empty() {
                return None;
            }
            if e.tag == 0x0132 {
                exif_datetime(&s)
            } else {
                s
            }
        }
    };
    Some((label.to_string(), value))
}

/// Exif IFD（0x8769 指向的子表）。
fn describe_exif_entry(t: &Tiff, e: &Entry) -> Option<(String, String)> {
    let label = match e.tag {
        0x9000 => "Exif 版本",
        0x9003 => "拍摄时间",
        0x9004 => "数字化时间",
        0x9101 => "色彩分量配置",
        0x9201 => "快门速度",
        0x9202 => "光圈",
        0x9203 => "亮度值",
        0x9204 => "曝光补偿",
        0x9205 => "最大光圈",
        0x9206 => "主体距离",
        0x9207 => "测光模式",
        0x9208 => "光源",
        0x9209 => "闪光灯",
        0x920A => "焦距",
        0x9286 => "用户注释",
        0x9290 => "拍摄时刻（子秒）",
        0xA001 => "色彩空间",
        0xA002 => "像素宽度",
        0xA003 => "像素高度",
        0xA20E => "焦平面水平分辨率",
        0xA20F => "焦平面垂直分辨率",
        0xA210 => "焦平面分辨率单位",
        0xA300 => "文件来源",
        0xA301 => "场景类型",
        0xA402 => "曝光模式",
        0xA403 => "白平衡",
        0xA404 => "数码变焦比",
        0xA405 => "35mm 等效焦距",
        0xA406 => "场景拍摄类型",
        0xA407 => "增益控制",
        0xA408 => "对比度",
        0xA409 => "饱和度",
        0xA40A => "锐度",
        0xA40C => "主体距离范围",
        0xA420 => "图像唯一 ID",
        0xA430 => "相机所有者",
        0xA431 => "相机序列号",
        0xA432 => "镜头规格",
        0xA433 => "镜头厂商",
        0xA434 => "镜头型号",
        0xA435 => "镜头序列号",
        _ => return None,
    };

    let value = match e.tag {
        0x9003 | 0x9004 => {
            let s = t.ascii(e)?;
            if s.is_empty() {
                return None;
            }
            exif_datetime(&s)
        }
        0x9201 => apex_to_shutter(t.srational(e)?),
        0x9202 | 0x9205 => apex_to_fnumber(t.srational(e)?),
        0x9204 => {
            let v = t.srational(e)?;
            format!("{}{} EV", if v >= 0.0 { "+" } else { "" }, trim_float(v))
        }
        0x9206 => format!("{} m", trim_float(t.rational(e)?)),
        0x9207 => metering_label(t.u32_value(e)?),
        0x9208 => light_source_label(t.u32_value(e)?),
        0x9209 => flash_label(t.u32_value(e)?),
        0x920A => format!("{} mm", trim_float(t.rational(e)?)),
        0x9286 => {
            // UserComment 前 8 字节是字符集标识（"ASCII\0\0\0" 等）。
            let b = t.data_of(e)?;
            let text: String = b
                .iter()
                .skip(8)
                .take_while(|&&c| c != 0)
                .map(|&c| c as char)
                .collect();
            let text = text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            text
        }
        0xA001 => color_space_label(t.u32_value(e)?),
        0xA300 => file_source_label(t.u32_value(e)?),
        0xA301 => scene_type_label(t.u32_value(e)?),
        0xA402 => exposure_mode_label(t.u32_value(e)?),
        0xA403 => white_balance_label(t.u32_value(e)?),
        0xA404 => format!("{}x", trim_float(t.rational(e)?)),
        0xA405 => format!("{} mm", t.u32_value(e)?),
        0xA406 => scene_capture_type_label(t.u32_value(e)?),
        0xA407 => gain_control_label(t.u32_value(e)?),
        0xA408 | 0xA409 | 0xA40A => tone_label(t.u32_value(e)?),
        0xA40C => distance_range_label(t.u32_value(e)?),
        0xA20E | 0xA20F => {
            let v = t.rational(e)?;
            format!("{}", trim_float(v))
        }
        0xA210 => match t.u32_value(e)? {
            1 => "无单位".to_string(),
            2 => "英寸".to_string(),
            3 => "厘米".to_string(),
            v => format!("未知 ({})", v),
        },
        0x9101 => {
            let b = t.data_of(e)?;
            if b.len() >= 4 {
                let names = ["", "Y", "YCbCr", "RGB", "CMYK"];
                let v = b[0] as usize;
                if v < names.len() && !names[v].is_empty() {
                    names[v].to_string()
                } else {
                    format!("未知 ({})", v)
                }
            } else {
                return None;
            }
        }
        0x9000 => t.ascii(e)?,
        _ => {
            // 剩下的多 SHORT / LONG / ASCII / RATIONAL。
            match e.typ {
                2 => t.ascii(e)?,
                3 | 4 => t.u32_value(e)?.to_string(),
                5 => trim_float(t.rational(e)?),
                10 => trim_float(t.srational(e)?),
                _ => return None,
            }
        }
    };

    if value.is_empty() {
        return None;
    }
    Some((label.to_string(), value))
}

/// GPS IFD 里除经纬度外的可读字段。
fn describe_gps_entry(t: &Tiff, e: &Entry) -> Option<(String, String)> {
    let label = match e.tag {
        0x0000 => "GPS 版本",
        0x0001 => "纬度方向",
        0x0003 => "经度方向",
        0x0005 => "海拔方向",
        0x0008 => "卫星数量",
        0x0009 => "GPS 状态",
        0x000A => "GPS 测量模式",
        0x000B => "GPS 精度",
        0x000C => "速度单位",
        0x000D => "GPS 速度",
        0x0010 => "方向参考",
        0x0012 => "地图基准",
        0x001B => "定位方法",
        _ => return None,
    };
    let value = match e.tag {
        0x0000 => {
            let b = t.data_of(e)?;
            if b.len() >= 4 {
                format!("{}.{}", b[0], b[1])
            } else {
                return None;
            }
        }
        0x0001 => {
            let s = t.ascii(e)?;
            match s.as_str() {
                "N" => "北纬".to_string(),
                "S" => "南纬".to_string(),
                other => other.to_string(),
            }
        }
        0x0003 => {
            let s = t.ascii(e)?;
            match s.as_str() {
                "E" => "东经".to_string(),
                "W" => "西经".to_string(),
                other => other.to_string(),
            }
        }
        0x0005 => match t.data_of(e)?[0] {
            0 => "海平面以上".to_string(),
            1 => "海平面以下".to_string(),
            _ => return None,
        },
        0x0008 => t.u32_value(e)?.to_string(),
        0x0009 => {
            let s = t.ascii(e)?;
            match s.as_str() {
                "A" => "有效定位".to_string(),
                "V" => "定位无效".to_string(),
                other => other.to_string(),
            }
        }
        0x000A => match t.ascii(e)?.as_str() {
            "2" => "二维定位",
            "3" => "三维定位",
            other => other,
        }
        .to_string(),
        0x000B => format!("{} m", trim_float(t.rational(e)?)),
        0x000C => {
            let s = t.ascii(e)?;
            match s.as_str() {
                "K" => "km/h",
                "M" => "mph",
                "N" => "节",
                other => other,
            }
            .to_string()
        }
        0x000D => format!("{} km/h", trim_float(t.rational(e)?)),
        0x0010 => {
            let s = t.ascii(e)?;
            match s.as_str() {
                "T" => "真北",
                "M" => "磁北",
                other => other,
            }
            .to_string()
        }
        0x0012 => t.ascii(e)?,
        0x001B => {
            // 未定义类型，通常是 ASCII 文本。
            let b = t.data_of(e)?;
            let text: String = b
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as char)
                .collect();
            let text = text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            text
        }
        _ => return None,
    };
    if value.is_empty() {
        return None;
    }
    Some((label.to_string(), value))
}

/// 从 GPS IFD 抽出经纬度 / 海拔 / 方向 / 时间。
fn parse_gps(t: &Tiff, entries: &[Entry]) -> Option<GpsInfo> {
    let mut lat: Option<f64> = None;
    let mut lon: Option<f64> = None;
    let mut alt: Option<f64> = None;
    let mut alt_ref: u8 = 0;
    let mut dir: Option<f64> = None;
    let mut timestamp: Option<String> = None;
    let mut date: Option<String> = None;
    let mut lat_ref = String::new();
    let mut lon_ref = String::new();

    for e in entries {
        match e.tag {
            0x0001 => lat_ref = t.ascii(e).unwrap_or_default(),
            0x0002 => {
                if let Some(dms) = t.rationals(e) {
                    lat = dms_to_deg(&dms);
                }
            }
            0x0003 => lon_ref = t.ascii(e).unwrap_or_default(),
            0x0004 => {
                if let Some(dms) = t.rationals(e) {
                    lon = dms_to_deg(&dms);
                }
            }
            0x0005 => alt_ref = t.data_of(e).map(|b| b[0]).unwrap_or(0),
            0x0006 => alt = t.rational(e),
            0x0007 => {
                if let Some(parts) = t.rationals(e) {
                    if parts.len() >= 3 {
                        timestamp = Some(format!(
                            "{:02}:{:02}:{:02}",
                            parts[0].round() as u32,
                            parts[1].round() as u32,
                            parts[2].round() as u32
                        ));
                    }
                }
            }
            0x000D => {}
            0x0010 => {}
            0x0011 => dir = t.rational(e),
            0x001D => {
                let s = t.ascii(e).unwrap_or_default();
                if !s.is_empty() {
                    date = Some(exif_datetime(&s));
                }
            }
            _ => {}
        }
    }

    // 参考方向在部分机型里缺失，此时按正值处理。
    let mut lat = lat?;
    if lat_ref.eq_ignore_ascii_case("S") {
        lat = -lat;
    }
    let mut lon = lon?;
    if lon_ref.eq_ignore_ascii_case("W") {
        lon = -lon;
    }
    // 海拔是**可选**的：很多手机不写 GPSAltitudeRef / GPSAltitude，用 `?`
    // 提前返回会把整组经纬度一起丢掉。只在真的有海拔值时才取负。
    let altitude = match alt {
        Some(a) if alt_ref == 1 => Some(-a),
        Some(a) => Some(a),
        None => None,
    };

    Some(GpsInfo {
        latitude: Some(lat),
        longitude: Some(lon),
        altitude,
        direction: dir,
        timestamp,
        date,
    })
}

/// 度分秒 → 十进制度。
fn dms_to_deg(dms: &[f64]) -> Option<f64> {
    if dms.len() < 3 {
        return None;
    }
    Some(dms[0] + dms[1] / 60.0 + dms[2] / 3600.0)
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一段最小的 JPEG：SOI + APP1(Exif) + EOI。
    fn jpeg_with_exif(exif_payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8];
        let mut seg = vec![0xFF, 0xE1];
        let len = exif_payload.len() + 8; // 段长含自身 2 字节
        seg.extend_from_slice(&(len as u16).to_be_bytes());
        seg.extend_from_slice(b"Exif\0\0");
        seg.extend_from_slice(exif_payload);
        out.extend_from_slice(&seg);
        out.extend_from_slice(&[0xFF, 0xD9]);
        out
    }

    /// 造一段最小 TIFF：II 字节序 + IFD0，含一个 ASCII 标签。
    fn tiff_with_ascii(tag: u16, text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"II");
        out.extend_from_slice(&42u16.to_le_bytes());
        out.extend_from_slice(&8u32.to_le_bytes()); // IFD0 偏移
        out.extend_from_slice(&1u16.to_le_bytes()); // 1 个条目
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes()); // ASCII
        out.extend_from_slice(&(text.len() as u32 + 1).to_le_bytes());
        // 值偏移：头部 8 + IFD 头 2 + 条目 12 + 下一个 IFD 指针 4 = 26。
        out.extend_from_slice(&26u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // 下一个 IFD
        out.extend_from_slice(text.as_bytes());
        out.push(0);
        out
    }

    /// 造一段带 GPS IFD 的最小 TIFF：IFD0 只挂一个 GPS 指针（0x8825）。
    ///
    /// `with_altitude` 为 false 时不写 GPSAltitude —— 用来验证「没有海拔
    /// 也不能把整组经纬度一起丢掉」（很多手机就不写海拔）。
    fn tiff_with_gps(with_altitude: bool) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(b"II");
        out.extend_from_slice(&42u16.to_le_bytes());
        out.extend_from_slice(&8u32.to_le_bytes()); // IFD0 @ 8

        // ── IFD0 @ 8：一个条目（GPS IFD 指针） ──
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&0x8825u16.to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes()); // LONG
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&24u32.to_le_bytes()); // GPS IFD 占位，稍后回填
        out.extend_from_slice(&0u32.to_le_bytes()); // 下一个 IFD
        // IFD0 占 8..26（count 2 + 条目 12 + next 4）→ GPS IFD 起点是 26。

        // ── GPS IFD @ 26 ──
        let n: u16 = if with_altitude { 5 } else { 4 };
        out.extend_from_slice(&n.to_le_bytes());
        // 每条 12 字节；数据区紧跟在「下一个 IFD 指针」之后。
        let data_base = 28 + n as usize * 12 + 4;
        let lat_off = data_base;
        let lon_off = lat_off + 24;
        let gps_ifd_off = 26u32;

        // 0x0001 GPSLatitudeRef = "N"（ASCII，内联值）
        out.extend_from_slice(&0x0001u16.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(b"N\0\0\0");

        // 0x0002 GPSLatitude = 116°23'30"（RATIONAL × 3，外置）
        out.extend_from_slice(&0x0002u16.to_le_bytes());
        out.extend_from_slice(&5u16.to_le_bytes());
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&(lat_off as u32).to_le_bytes());

        // 0x0003 GPSLongitudeRef = "E"（ASCII，内联值）
        out.extend_from_slice(&0x0003u16.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(b"E\0\0\0");

        // 0x0004 GPSLongitude = 39°54'15"（RATIONAL × 3，外置）
        out.extend_from_slice(&0x0004u16.to_le_bytes());
        out.extend_from_slice(&5u16.to_le_bytes());
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&(lon_off as u32).to_le_bytes());

        // 0x0006 GPSAltitude（可选）
        if with_altitude {
            out.extend_from_slice(&0x0006u16.to_le_bytes());
            out.extend_from_slice(&5u16.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(&((lon_off + 24) as u32).to_le_bytes());
        }
        out.extend_from_slice(&0u32.to_le_bytes()); // 下一个 IFD

        assert_eq!(out.len(), data_base, "GPS IFD 之后应紧接数据区");

        // 回填 IFD0 里的 GPS 指针（偏移 10 = 条目起点 + 8 = 值槽）。
        out[10 + 8..10 + 12].copy_from_slice(&gps_ifd_off.to_le_bytes());

        // 度分秒：每项 3 个有理数（度 / 分 / 秒，分母都是 1）
        for (d, m, s) in [(116u32, 23u32, 30u32), (39u32, 54u32, 15u32)] {
            out.extend_from_slice(&d.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(&m.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(&s.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
        }
        if with_altitude {
            out.extend_from_slice(&123u32.to_le_bytes()); // 海拔 123 m
            out.extend_from_slice(&1u32.to_le_bytes());
        }

        out
    }

    #[test]
    fn reads_ascii_tag_from_tiff() {
        let tiff = tiff_with_ascii(0x0131, "mini-tc");
        let exif = parse_tiff(&tiff).expect("TIFF 应可解析");
        let software = exif
            .fields
            .iter()
            .find(|f| f.label == "软件")
            .expect("应有「软件」字段");
        assert_eq!(software.value, "mini-tc");
    }

    #[test]
    fn jpeg_exif_is_found_inside_app1() {
        let tiff = tiff_with_ascii(0x0110, "TestCam");
        let jpeg = jpeg_with_exif(&tiff);
        let mut meta = ImageMeta {
            format: "JPEG".into(),
            ..Default::default()
        };
        parse_jpeg(&jpeg, &mut meta);
        let model = meta.exif.iter().find(|f| f.label == "相机型号");
        assert_eq!(model.map(|f| f.value.as_str()), Some("TestCam"));
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        assert!(parse_tiff(&[0, 1, 2, 3, 4, 5, 6, 7]).is_none());
        assert!(parse_tiff(b"II\x2a\x00\xff\xff\xff\xff").is_none());
    }

    #[test]
    fn dms_conversion() {
        let d = dms_to_deg(&[116.0, 23.0, 30.0]).unwrap();
        assert!((d - 116.3916666).abs() < 1e-6);
    }

    #[test]
    fn apex_round_trip() {
        // APEX 7 ≈ 1/128 秒
        assert_eq!(apex_to_shutter(7.0), "1/128 s");
        // APEX 5 ≈ f/5.66
        assert_eq!(apex_to_fnumber(5.0), "f/5.66");
    }

    #[test]
    fn gps_coordinates_are_decoded_from_dms() {
        let tiff = tiff_with_gps(true);
        let exif = parse_tiff(&tiff).expect("TIFF 应可解析");
        let gps = exif.gps.expect("应有 GPS 信息");
        let lat = gps.latitude.expect("应有纬度");
        let lon = gps.longitude.expect("应有经度");
        // 116°23'30" → 116.391666…；39°54'15" → 39.904166…
        assert!((lat - 116.3916666).abs() < 1e-6, "纬度不对: {}", lat);
        assert!((lon - 39.9041666).abs() < 1e-6, "经度不对: {}", lon);
        assert_eq!(gps.altitude, Some(123.0));
    }

    #[test]
    fn gps_without_altitude_still_reports_coordinates() {
        // 很多手机不写 GPSAltitude —— 那时也不能把整组经纬度丢掉。
        let tiff = tiff_with_gps(false);
        let exif = parse_tiff(&tiff).expect("TIFF 应可解析");
        let gps = exif.gps.expect("没有海拔也要有 GPS");
        assert!(gps.latitude.is_some(), "纬度不该丢");
        assert!(gps.longitude.is_some(), "经度不该丢");
        assert_eq!(gps.altitude, None, "没有海拔就该是 None");
    }

    /// 走完整链路：真实的 JPEG 文件 → probe() → 尺寸 / EXIF / GPS。
    ///
    /// 上面的测试都是直接调 `parse_tiff`；这一条把「文件读头 → APP1 定位
    /// → TIFF 解析 → GPS 还原」整条链串起来，避免某一环只在单元测试里
    /// 被绕过（APP1 的段长算错就会让整段 EXIF 读不到）。
    #[test]
    fn probe_reads_size_and_gps_from_a_real_jpeg_file() {
        let mut jpeg = jpeg_with_exif(&tiff_with_gps(true));
        // 插一段 SOF0：精度 8、高 480、宽 640、3 个分量。
        let mut sof = vec![0xFF, 0xC0];
        sof.extend_from_slice(&11u16.to_be_bytes()); // 段长
        sof.push(8); // 精度
        sof.extend_from_slice(&480u16.to_be_bytes());
        sof.extend_from_slice(&640u16.to_be_bytes());
        sof.push(3); // 分量数
        sof.extend_from_slice(&[0u8; 9]); // 3 × (id, 采样, 量化表)
        // 插到 APP1 之前（SOI 之后）。
        jpeg.splice(2..2, sof);

        let dir = std::env::temp_dir().join("mini-tc-imagemeta-test");
        std::fs::create_dir_all(&dir).expect("应能建临时目录");
        let path = dir.join("gps-sample.jpg");
        std::fs::write(&path, &jpeg).expect("应能写临时文件");

        let meta = probe(&path).expect("应能探测出图像元数据");
        assert_eq!(meta.format, "JPEG");
        assert_eq!(meta.width, Some(640));
        assert_eq!(meta.height, Some(480));
        let gps = meta.gps.expect("GPS 应被还原");
        assert!((gps.latitude.unwrap() - 116.3916666).abs() < 1e-6);
        assert!((gps.longitude.unwrap() - 39.9041666).abs() < 1e-6);
        assert_eq!(gps.altitude, Some(123.0));

        let _ = std::fs::remove_file(&path);
    }
}
