//! 视频元数据探测：容器、时长、分辨率、编码、标签、GPS。
//!
//! 与 [`crate::imagemeta`] 是同一套做法：
//!   • 只做**字节级读取**，不引入任何视频解析 crate（依赖树刻意保持精简）；
//!   • **解析失败永远不能变成「整个属性窗口打不开」** —— 所有字段都是
//!     `Option`，拿不到就少显示一行，而不是报错。
//!
//! 支持的容器：
//!   • ISO BMFF（MP4 / MOV / M4V / 3GP）：`moov` 里的 `mvhd` / `tkhd` /
//!     `stsd` / `stts` / `hdlr`，以及 `meta/ilst` 的 iTunes 标签与 GPS；
//!   • Matroska / WebM（EBML）；
//!   • AVI（RIFF）；
//!   • FLV（AMF0 `onMetaData`）。
//!
//! 判据是**文件头**，不是扩展名：同一个 `.mp4` 可能是视频，也可能只有一条
//! 音轨；只有真的找到视频轨才认领为视频（认领错了，属性窗口就会给一个
//! 纯音频文件显示「视频信息」）。
//!
//! 容器里能拿到多少，取决于写文件的工具：手机拍的 MOV 一般带设备型号、
//! 拍摄时间与 GPS 坐标；剪辑软件导出的 MP4 可能只剩时长与分辨率。

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::imagemeta::{ExifField, GpsInfo};

/// 探测到的视频元数据。
#[derive(Serialize, Clone, Default, Debug)]
pub struct VideoMeta {
    /// 容器格式：`MP4` / `QuickTime` / `Matroska` / `WebM` / `AVI` / `FLV`。
    pub format: String,
    /// 时长（秒）。
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 帧率（帧 / 秒）。
    pub fps: Option<f64>,
    /// 视频编码（人话名，如 `H.264 / AVC`）。
    pub video_codec: Option<String>,
    /// 音频编码（如 `AAC`）。
    pub audio_codec: Option<String>,
    /// 音频声道数。
    pub audio_channels: Option<u32>,
    /// 音频采样率（Hz）。
    pub audio_sample_rate: Option<u32>,
    /// 平均码率（bit/s）。按「文件大小 ÷ 时长」算，含容器开销。
    pub bitrate: Option<u64>,
    /// 创建时间（字符串，格式随容器而异）。
    pub created: Option<String>,
    /// 容器自带的标签（标题 / 编码器 / 设备 …）。
    pub tags: Vec<ExifField>,
    /// 相机 / 手机录影时写进容器的完整 EXIF（拍摄参数、镜头、作者 …）。
    pub exif: Vec<ExifField>,
    /// GPS 坐标（部分手机录的视频会带）。
    pub gps: Option<GpsInfo>,
}

/// 探测一个文件的视频元数据。不是视频（或读不出来）时返回 `None`。
pub fn probe(path: &Path) -> Option<VideoMeta> {
    let mut f = File::open(path).ok()?;
    let file_len = f.metadata().ok()?.len();
    // 容器头至少也要十几字节。
    if file_len < 16 {
        return None;
    }
    let mut head = [0u8; 16];
    read_exact_at(&mut f, 0, &mut head)?;

    if &head[4..8] == b"ftyp" {
        return parse_bmff(&mut f, file_len);
    }
    if &head[0..4] == b"\x1a\x45\xdf\xa3" {
        return parse_matroska(&mut f, file_len);
    }
    if &head[0..4] == b"RIFF" && &head[8..12] == b"AVI " {
        return parse_avi(&mut f, file_len);
    }
    if &head[0..3] == b"FLV" {
        return parse_flv(&mut f, file_len);
    }
    None
}

// ── 通用小工具 ──

/// 从 `off` 处读满 `buf`；读不满就返回 `None`。
fn read_exact_at(f: &mut File, off: u64, buf: &mut [u8]) -> Option<()> {
    f.seek(SeekFrom::Start(off)).ok()?;
    f.read_exact(buf).ok()
}

/// 从 `off` 处读 `len` 字节。
fn read_bytes_at(f: &mut File, off: u64, len: usize) -> Option<Vec<u8>> {
    if len == 0 {
        return Some(Vec::new());
    }
    let mut v = vec![0u8; len];
    read_exact_at(f, off, &mut v)?;
    Some(v)
}

fn be_u16(d: &[u8], off: usize) -> Option<u16> {
    let s = d.get(off..off + 2)?;
    Some(u16::from_be_bytes([s[0], s[1]]))
}

fn be_u32(d: &[u8], off: usize) -> Option<u32> {
    let s = d.get(off..off + 4)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be_u64(d: &[u8], off: usize) -> Option<u64> {
    let s = d.get(off..off + 8)?;
    Some(u64::from_be_bytes([
        s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    ]))
}

fn le_u16(d: &[u8], off: usize) -> Option<u16> {
    let s = d.get(off..off + 2)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn le_u32(d: &[u8], off: usize) -> Option<u32> {
    let s = d.get(off..off + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// 16.16 定点数（ISO BMFF 的画面尺寸用的就是它）。
fn fixed_16_16(d: &[u8], off: usize) -> Option<u32> {
    be_u32(d, off).map(|v| v >> 16)
}

/// Unix 秒 → `YYYY-MM-DD HH:MM:SS`（UTC）。
fn format_utc(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let rem = unix_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 天数（自 1970-01-01）→ 民用日期（Howard Hinnant 的算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ══════════════════════════════════════════════════════════════════
// ISO BMFF（MP4 / MOV / M4V / 3GP）
// ══════════════════════════════════════════════════════════════════

/// ISO BMFF 的一个 box 头。
#[derive(Clone, Copy)]
struct BoxHdr {
    /// box 起始偏移。
    off: u64,
    /// 载荷起始偏移。
    body_off: u64,
    /// 载荷长度（文件被截断时按实际剩余算）。
    body_len: u64,
    /// 四字符类型。
    kind: [u8; 4],
}

/// 读一个 box 头。`end` 是允许读到的最大偏移。
fn box_hdr(f: &mut File, off: u64, end: u64) -> Option<BoxHdr> {
    if off + 8 > end {
        return None;
    }
    let mut h = [0u8; 8];
    read_exact_at(f, off, &mut h)?;
    let size32 = be_u32(&h, 0)? as u64;
    let kind = [h[4], h[5], h[6], h[7]];
    let (size, hdr_len) = if size32 == 1 {
        // 64 位长度。
        if off + 16 > end {
            return None;
        }
        (be_u64_at(f, off + 8)?, 16u64)
    } else if size32 == 0 {
        // 长度 0 = 一直到文件尾。
        (end - off, 8u64)
    } else {
        (size32, 8u64)
    };
    if size < hdr_len {
        return None;
    }
    let body_off = off + hdr_len;
    let body_len = size - hdr_len;
    // 文件被截断时按实际剩余长度算，别越界读。
    let body_len = body_len.min(end.saturating_sub(body_off));
    Some(BoxHdr {
        off,
        body_off,
        body_len,
        kind,
    })
}

fn be_u64_at(f: &mut File, off: u64) -> Option<u64> {
    let mut b = [0u8; 8];
    read_exact_at(f, off, &mut b)?;
    Some(u64::from_be_bytes(b))
}

/// 列出某个容器 box 的直接子 box。
fn box_children(f: &mut File, parent: BoxHdr) -> Vec<BoxHdr> {
    let mut out = Vec::new();
    let end = parent.body_off + parent.body_len;
    let mut off = parent.body_off;
    while off + 8 <= end && out.len() < 512 {
        let h = match box_hdr(f, off, end) {
            Some(h) => h,
            None => break,
        };
        let next = h.body_off + h.body_len;
        out.push(h);
        if next <= off {
            break;
        }
        off = next;
    }
    out
}

/// ISO 8601 起始纪元（1904-01-01）到 UNIX 纪元的秒数差。
const MAC_EPOCH_OFFSET: i64 = 2_082_844_800;

fn parse_bmff(f: &mut File, file_len: u64) -> Option<VideoMeta> {
    let mut meta = VideoMeta::default();
    let mut brand = String::new();
    let mut compatible: Vec<String> = Vec::new();
    let mut moov: Option<BoxHdr> = None;

    let mut off = 0u64;
    while off + 8 <= file_len {
        let h = box_hdr(f, off, file_len)?;
        match &h.kind {
            b"ftyp" => {
                let d =
                    read_bytes_at(f, h.body_off, h.body_len.min(64) as usize).unwrap_or_default();
                if d.len() >= 8 {
                    brand = String::from_utf8_lossy(&d[0..4]).trim().to_string();
                    let mut p = 8;
                    while p + 4 <= d.len() {
                        compatible.push(String::from_utf8_lossy(&d[p..p + 4]).trim().to_string());
                        p += 4;
                    }
                }
            }
            b"moov" => moov = Some(h),
            _ => {}
        }
        let next = h.body_off + h.body_len;
        if next <= off {
            break;
        }
        off = next;
    }

    // HEIC / AVIF 这些也走 ISO BMFF，但它们是**图像**：不认领，否则属性
    // 窗口会给一张 HEIC 图显示「视频信息」。
    const IMAGE_BRANDS: &[&str] = &[
        "heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "crx", "jxl",
    ];
    let is_image = IMAGE_BRANDS.contains(&brand.as_str())
        || compatible
            .iter()
            .any(|b| IMAGE_BRANDS.contains(&b.as_str()));
    if is_image {
        return None;
    }

    meta.format = match brand.as_str() {
        "qt" => "QuickTime".to_string(),
        "3gp" | "3g2" => "3GP".to_string(),
        _ => "MP4".to_string(),
    };

    let moov = moov?;
    let kids = box_children(f, moov);

    // mvhd：时间刻度、总时长、创建时间。
    for k in &kids {
        if &k.kind == b"mvhd" {
            let d = read_bytes_at(f, k.body_off, k.body_len.min(120) as usize).unwrap_or_default();
            parse_mvhd(&d, &mut meta);
        }
    }

    // trak：逐条轨，取视频轨与音频轨。
    let mut has_video = false;
    for k in &kids {
        if &k.kind != b"trak" {
            continue;
        }
        if parse_trak(f, *k, &mut meta) {
            has_video = true;
        }
    }
    // 没有视频轨的 MP4 是纯音频（如 .m4a），不认领。
    if !has_video {
        return None;
    }

    // meta / udta → ilst：标签与 GPS。
    for k in &kids {
        if &k.kind == b"meta" {
            parse_meta_box(f, *k, &mut meta);
        } else if &k.kind == b"udta" {
            for u in box_children(f, *k) {
                if &u.kind == b"meta" {
                    parse_meta_box(f, u, &mut meta);
                }
            }
        }
    }

    // 相机 / 手机录影时可能塞了一份完整 EXIF，甚至一份 XMP。
    if meta.exif.is_empty() {
        if let Some(d) = read_bytes_at(
            f,
            moov.body_off,
            moov.body_len.min(32 * 1024 * 1024) as usize,
        ) {
            if let Some(at) = find_bytes(&d, b"Exif\0\0") {
                if let Some((fields, gps)) = crate::imagemeta::parse_exif_payload(&d[at..]) {
                    meta.exif = fields;
                    if meta.gps.is_none() {
                        meta.gps = gps;
                    }
                }
            }
        }
    }
    if let Some(xmp) = find_xmp(f, moov) {
        merge_xmp(&xmp, &mut meta);
    }

    finish_bitrate(&mut meta, file_len);
    Some(meta)
}

/// `mvhd`：时间刻度、总时长、创建时间。
fn parse_mvhd(d: &[u8], meta: &mut VideoMeta) {
    let version = d.first().copied().unwrap_or(0);
    let (ts_off, dur_off, dur_len, ct_off) = if version == 1 {
        (20usize, 24usize, 8usize, 4usize)
    } else {
        (12usize, 16usize, 4usize, 4usize)
    };
    let timescale = be_u32(d, ts_off).unwrap_or(0);
    if timescale > 0 {
        let dur = if dur_len == 8 {
            be_u64(d, dur_off).unwrap_or(0)
        } else {
            be_u32(d, dur_off).unwrap_or(0) as u64
        };
        if dur > 0 {
            meta.duration = Some(dur as f64 / timescale as f64);
        }
    }
    if meta.created.is_none() {
        let ct = if version == 1 {
            be_u64(d, ct_off).unwrap_or(0)
        } else {
            be_u32(d, ct_off).unwrap_or(0) as u64
        };
        if ct > 0 {
            meta.created = Some(format_utc(ct as i64 - MAC_EPOCH_OFFSET));
        }
    }
}

/// 解析一条轨。返回 true 表示这是一条视频轨。
fn parse_trak(f: &mut File, trak: BoxHdr, meta: &mut VideoMeta) -> bool {
    let mut handler = String::new();
    let mut timescale: Option<u32> = None;
    let mut tkhd_w: Option<u32> = None;
    let mut tkhd_h: Option<u32> = None;
    let mut stsd: Option<StsdInfo> = None;
    let mut stts_delta: Option<u32> = None;

    for k in box_children(f, trak) {
        match &k.kind {
            b"tkhd" => {
                let d =
                    read_bytes_at(f, k.body_off, k.body_len.min(128) as usize).unwrap_or_default();
                let version = d.first().copied().unwrap_or(0);
                // 尺寸在矩阵之后：v0 偏移 76，v1 偏移 88。
                let dim_off = if version == 1 { 88 } else { 76 };
                tkhd_w = fixed_16_16(&d, dim_off);
                tkhd_h = fixed_16_16(&d, dim_off + 4);
            }
            b"mdia" => {
                for m in box_children(f, k) {
                    match &m.kind {
                        b"hdlr" => {
                            let d = read_bytes_at(f, m.body_off, m.body_len.min(32) as usize)
                                .unwrap_or_default();
                            if d.len() >= 12 {
                                handler = String::from_utf8_lossy(&d[8..12]).trim().to_string();
                            }
                        }
                        b"mdhd" => {
                            let d = read_bytes_at(f, m.body_off, m.body_len.min(48) as usize)
                                .unwrap_or_default();
                            let version = d.first().copied().unwrap_or(0);
                            let ts_off = if version == 1 { 20 } else { 12 };
                            timescale = be_u32(&d, ts_off);
                        }
                        b"minf" => {
                            for s in box_children(f, m) {
                                if &s.kind != b"stbl" {
                                    continue;
                                }
                                for e in box_children(f, s) {
                                    match &e.kind {
                                        b"stsd" => {
                                            let d = read_bytes_at(
                                                f,
                                                e.body_off,
                                                e.body_len.min(4096) as usize,
                                            )
                                            .unwrap_or_default();
                                            stsd = Some(parse_stsd(&d));
                                        }
                                        b"stts" => {
                                            let d = read_bytes_at(
                                                f,
                                                e.body_off,
                                                e.body_len.min(4096) as usize,
                                            )
                                            .unwrap_or_default();
                                            stts_delta = parse_stts_delta(&d);
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    match handler.as_str() {
        "vide" => {
            // `tkhd` 给的是**显示**尺寸（竖屏视频已按旋转矩阵交换过宽高，
            // 与资源管理器显示的一致）；`stsd` 给的是编码尺寸，兜底用。
            let stsd_w = stsd.as_ref().and_then(|s| s.width);
            let stsd_h = stsd.as_ref().and_then(|s| s.height);
            if let Some(w) = tkhd_w.or(stsd_w) {
                meta.width = Some(w);
            }
            if let Some(h) = tkhd_h.or(stsd_h) {
                meta.height = Some(h);
            }
            if let Some(s) = &stsd {
                if let Some(c) = &s.format {
                    meta.video_codec = Some(codec_label(c));
                }
            }
            if let (Some(ts), Some(delta)) = (timescale, stts_delta) {
                if ts > 0 && delta > 0 {
                    meta.fps = Some(ts as f64 / delta as f64);
                }
            }
            true
        }
        "soun" => {
            if let Some(s) = &stsd {
                if let Some(c) = &s.format {
                    meta.audio_codec = Some(codec_label(c));
                }
                if s.channels.is_some() {
                    meta.audio_channels = s.channels;
                }
                if s.sample_rate.is_some() {
                    meta.audio_sample_rate = s.sample_rate;
                }
            }
            false
        }
        _ => false,
    }
}

/// `stsd` 里解出来的采样描述。
struct StsdInfo {
    format: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    channels: Option<u32>,
    sample_rate: Option<u32>,
}

/// 解析 `stsd` 的**第一个**采样描述。
///
/// 布局（ISO BMFF）：版本 / 标志(4) + 条目数(4)，然后每个条目是
/// 「长度(4) + 格式(4) + 保留(6) + 数据引用索引(2)」，其后才是视觉 / 声音
/// 专属字段。
fn parse_stsd(d: &[u8]) -> StsdInfo {
    let mut out = StsdInfo {
        format: None,
        width: None,
        height: None,
        channels: None,
        sample_rate: None,
    };
    // 条目从偏移 8 开始。
    let entry = 8usize;
    if d.len() < entry + 16 {
        return out;
    }
    let fmt = &d[entry + 4..entry + 8];
    out.format = Some(String::from_utf8_lossy(fmt).trim().to_string());
    // 视觉：宽高在条目内偏移 32 / 34；声音：声道 24、采样率 32。
    out.width = be_u16(d, entry + 32).map(|v| v as u32);
    out.height = be_u16(d, entry + 34).map(|v| v as u32);
    out.channels = be_u16(d, entry + 24).map(|v| v as u32);
    out.sample_rate = be_u32(d, entry + 32).map(|v| v >> 16);
    out
}

/// `stts` 里第一个采样间隔（用来算帧率）。
fn parse_stts_delta(d: &[u8]) -> Option<u32> {
    // 版本 / 标志(4) + 条目数(4)，随后是「采样数(4) + 采样间隔(4)」。
    if d.len() < 16 {
        return None;
    }
    be_u32(d, 12).filter(|v| *v > 0)
}

// ── ISO BMFF 的 meta / ilst（标签与 GPS） ──

/// `meta` 容器里的一切：ilst 的标签 + keys 的自定义键。
fn parse_meta_box(f: &mut File, meta_box: BoxHdr, meta: &mut VideoMeta) {
    // `meta` 有两种形态：FullBox（前面 4 字节是版本 / 标志）和裸容器。
    // **不能靠「某个偏移上是不是 hdlr」来判** —— 两种形态下 hdlr 都可能出现，
    // 判错就会整块读空（裸容器被当成 FullBox 而跳过 4 字节，FullBox 又可能
    // 被当成裸容器）。所以两种起点都试，谁解出 ilst / keys 用谁。
    let mut best: Option<VideoMeta> = None;
    for skip in [4u64, 0u64] {
        let inner = BoxHdr {
            off: meta_box.off,
            body_off: meta_box.body_off + skip,
            body_len: meta_box.body_len.saturating_sub(skip),
            kind: meta_box.kind,
        };
        let mut scratch = VideoMeta::default();
        collect_meta_children(f, inner, &mut scratch);
        let count = scratch.tags.len();
        if count > best.as_ref().map(|b| b.tags.len()).unwrap_or(0) {
            best = Some(scratch);
        }
    }
    if let Some(b) = best {
        meta.tags.extend(b.tags);
        if meta.gps.is_none() {
            meta.gps = b.gps;
        }
    }
}

/// 读 `meta` 的直接子 box，抽出 keys 的键名表与 ilst 的标签。
fn collect_meta_children(f: &mut File, inner: BoxHdr, out: &mut VideoMeta) {
    let kids = box_children(f, inner);

    // keys：自定义键名表（iPhone 的 mdta 元数据全靠它）。
    let mut keys: Vec<String> = Vec::new();
    for k in &kids {
        if &k.kind == b"keys" {
            let d = read_bytes_at(f, k.body_off, k.body_len.min(64 * 1024) as usize)
                .unwrap_or_default();
            keys = parse_keys(&d);
        }
    }

    for k in &kids {
        if &k.kind != b"ilst" {
            continue;
        }
        let d =
            read_bytes_at(f, k.body_off, k.body_len.min(1024 * 1024) as usize).unwrap_or_default();
        parse_ilst(&d, &keys, out);
    }
}

/// `keys` box：自定义键名表，索引从 1 开始。
fn parse_keys(d: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    // 版本 / 标志(4) + 条目数(4)。
    let mut p = 8usize;
    while p + 8 <= d.len() {
        let size = be_u32(d, p).unwrap_or(0) as usize;
        let value_start = p + 8;
        if size == 0 || value_start + size > d.len() {
            break;
        }
        let name = String::from_utf8_lossy(&d[value_start..value_start + size])
            .trim_end_matches('\0')
            .to_string();
        out.push(name);
        p = value_start + size;
    }
    out
}

/// `ilst`：iTunes 风格标签（`©nam` 等）与 mdta 自定义键。
fn parse_ilst(d: &[u8], keys: &[String], meta: &mut VideoMeta) {
    let mut p = 0usize;
    while p + 8 <= d.len() {
        let size = be_u32(d, p).unwrap_or(0) as usize;
        let kind = [d[p + 4], d[p + 5], d[p + 6], d[p + 7]];
        if size < 8 || p + size > d.len() {
            break;
        }
        let body = &d[p + 8..p + size];

        // 类型是四字符代码（`©nam`）还是 mdta 索引（数字）。
        let label = if kind[0] == 0xA9 {
            itunes_label(&kind)
        } else {
            let idx = u32::from_be_bytes(kind) as usize;
            if idx >= 1 && idx <= keys.len() {
                mdta_label(&keys[idx - 1])
            } else {
                ""
            }
        };

        // 载荷是若干个 "data" box。
        let mut q = 0usize;
        while q + 8 <= body.len() {
            let dsize = be_u32(body, q).unwrap_or(0) as usize;
            if dsize < 16 || q + dsize > body.len() {
                break;
            }
            if &body[q + 4..q + 8] == b"data" {
                let dtype = be_u32(body, q + 8).unwrap_or(0);
                let payload = &body[q + 16..q + dsize];
                if let Some(text) = data_to_string(dtype, payload) {
                    if !label.is_empty() {
                        meta.tags.push(ExifField {
                            label: label.to_string(),
                            value: text.clone(),
                        });
                    }
                    // 位置字段转成 GPS。
                    if label == "位置" {
                        if let Some((lat, lon, alt)) = parse_iso6709(&text) {
                            meta.gps = Some(GpsInfo {
                                latitude: Some(lat),
                                longitude: Some(lon),
                                altitude: alt,
                                ..Default::default()
                            });
                        }
                    }
                }
            }
            q += dsize;
        }
        p += size;
    }
}

/// `data` box 的类型 → 文本。
fn data_to_string(dtype: u32, payload: &[u8]) -> Option<String> {
    match dtype {
        1 => Some(String::from_utf8_lossy(payload).trim().to_string()),
        2 => {
            // UTF-16：locale 为 0 时是 LE。
            let mut s = String::new();
            let mut i = 0;
            while i + 1 < payload.len() {
                let c = u16::from_le_bytes([payload[i], payload[i + 1]]);
                s.push(char::from_u32(c as u32).unwrap_or('\u{fffd}'));
                i += 2;
            }
            Some(s.trim().to_string())
        }
        21 => Some(
            be_u32(payload, 0)
                .map(|v| (v as i32).to_string())
                .unwrap_or_default(),
        ),
        22 => Some(
            be_u32(payload, 0)
                .map(|v| v.to_string())
                .unwrap_or_default(),
        ),
        _ => None,
    }
}

/// iTunes 四字符代码 → 中文标签。
fn itunes_label(kind: &[u8; 4]) -> &'static str {
    match kind {
        b"\xa9nam" => "标题",
        b"\xa9ART" => "艺术家",
        b"\xa9alb" => "专辑",
        b"\xa9cmt" => "备注",
        b"\xa9day" => "创建时间",
        b"\xa9gen" => "类型",
        b"\xa9too" => "编码工具",
        b"\xa9mak" => "设备厂商",
        b"\xa9mod" => "设备型号",
        b"\xa9aut" => "作者",
        b"\xa9xyz" => "位置",
        _ => "标签",
    }
}

/// mdta 自定义键（`com.apple.quicktime.*`）→ 中文标签。
fn mdta_label(key: &str) -> &'static str {
    match key {
        "com.apple.quicktime.creationdate" => "创建时间",
        "com.apple.quicktime.make" => "设备厂商",
        "com.apple.quicktime.model" => "设备型号",
        "com.apple.quicktime.software" => "软件",
        "com.apple.quicktime.title" => "标题",
        "com.apple.quicktime.location.ISO6709" => "位置",
        "com.apple.quicktime.author" => "作者",
        "com.apple.quicktime.contentID" => "内容 ID",
        "com.apple.quicktime.encoder" => "编码器",
        _ => "标签",
    }
}

/// ISO 6709 位置串：`+37.3317-122.0307+010.000/`。
fn parse_iso6709(s: &str) -> Option<(f64, f64, Option<f64>)> {
    let chars: Vec<char> = s.trim().chars().collect();
    let mut vals: Vec<(f64, bool)> = Vec::new();
    let mut i = 0usize;
    while vals.len() < 3 && i < chars.len() {
        // 跳过分隔符。
        while i < chars.len() && !chars[i].is_ascii_digit() && chars[i] != '+' && chars[i] != '-' {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let neg = if chars[i] == '-' {
            i += 1;
            true
        } else {
            if chars[i] == '+' {
                i += 1;
            }
            false
        };
        let start = i;
        while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
            i += 1;
        }
        if i == start {
            break;
        }
        let text: String = chars[start..i].iter().collect();
        let v: f64 = text.parse().ok()?;
        vals.push((v, neg));
    }
    if vals.len() < 2 {
        return None;
    }
    let lat = if vals[0].1 { -vals[0].0 } else { vals[0].0 };
    let lon = if vals[1].1 { -vals[1].0 } else { vals[1].0 };
    let alt = vals.get(2).map(|v| if v.1 { -v.0 } else { v.0 });
    Some((lat, lon, alt))
}

// ── XMP（uuid box） ──

/// 标准 XMP 的 uuid：`BE7ACFCB-97A9-42E8-9C71-999491E3AFAC`。
const XMP_UUID: [u8; 16] = [
    0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8, 0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC,
];

/// 在 `moov` 底下找 XMP（uuid box）。
fn find_xmp(f: &mut File, moov: BoxHdr) -> Option<String> {
    let mut stack = vec![moov];
    let mut found: Option<String> = None;
    while let Some(parent) = stack.pop() {
        for c in box_children(f, parent) {
            if &c.kind == b"uuid" {
                let d = read_bytes_at(f, c.body_off, c.body_len.min(4 * 1024 * 1024) as usize)
                    .unwrap_or_default();
                if d.len() > 16 && d[0..16] == XMP_UUID {
                    found = Some(String::from_utf8_lossy(&d[16..]).to_string());
                }
            } else if &c.kind == b"udta" || &c.kind == b"meta" {
                stack.push(c);
            }
        }
        if found.is_some() {
            break;
        }
    }
    found
}

/// 从 XMP 里捡几个常用字段。
///
/// XMP 是 XML，不做完整解析（也没有 XML 解析器）——只按「属性名 = "值"」
/// 和「元素文本」两种形状取，认不出就少显示一行。
fn merge_xmp(xmp: &str, meta: &mut VideoMeta) {
    let mut add = |label: &str, value: Option<String>| {
        if let Some(v) = value {
            if !v.is_empty() && !meta.tags.iter().any(|t| t.label == label) {
                meta.tags.push(ExifField {
                    label: label.to_string(),
                    value: v,
                });
            }
        }
    };
    add("标题", xmp_element_text(xmp, "dc:title"));
    add("作者", xmp_element_text(xmp, "dc:creator"));
    add("编码工具", xmp_attr(xmp, "xmp:CreatorTool"));
    add("创建时间", xmp_attr(xmp, "photoshop:DateCreated"));

    // GPS：exif:GPSLatitude="37,20.5N" / exif:GPSLongitude="122,1.0W"
    let lat = xmp_attr(xmp, "exif:GPSLatitude").and_then(|v| parse_xmp_dms(&v));
    let lon = xmp_attr(xmp, "exif:GPSLongitude").and_then(|v| parse_xmp_dms(&v));
    if let (Some(la), Some(lo)) = (lat, lon) {
        let alt = xmp_attr(xmp, "exif:GPSAltitude").and_then(|v| parse_xmp_rational(&v));
        meta.gps = Some(GpsInfo {
            latitude: Some(la),
            longitude: Some(lo),
            altitude: alt,
            ..Default::default()
        });
    }
}

/// 取 `name="value"` 里的值。
fn xmp_attr(xml: &str, name: &str) -> Option<String> {
    let needle = format!("{}=\"", name);
    let at = xml.find(&needle)? + needle.len();
    let rest = &xml[at..];
    let end = rest.find('"')?;
    Some(unescape_xml(&rest[..end]))
}

/// 取 `<name>文本</name>` 的文本（dc:title 走的是这条路）。
fn xmp_element_text(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{}", name);
    let at = xml.find(&open)?;
    let gt = match xml[at..].find('>') {
        Some(p) => at + p + 1,
        None => return None,
    };
    let close = format!("</{}>", name);
    let end = match xml[gt..].find(&close) {
        Some(p) => gt + p,
        None => return None,
    };
    let text = strip_tags(&xml[gt..end]);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // 折叠空白。
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// `37,20.5N` → 37.3417（度分秒 + 半球）。
fn parse_xmp_dms(s: &str) -> Option<f64> {
    let t = s.trim();
    let (body, hemi) = match t.chars().last() {
        Some(c) if c.is_ascii_alphabetic() => (&t[..t.len() - 1], c.to_ascii_uppercase()),
        _ => (t, 'N'),
    };
    let parts: Vec<&str> = body.split(',').collect();
    let deg: f64 = parts.first()?.trim().parse().ok()?;
    let min: f64 = parts
        .get(1)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0.0);
    let sec: f64 = parts
        .get(2)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0.0);
    let v = deg + min / 60.0 + sec / 3600.0;
    Some(if matches!(hemi, 'S' | 'W') { -v } else { v })
}

/// `10/1` → 10.0。
fn parse_xmp_rational(s: &str) -> Option<f64> {
    let mut it = s.split('/');
    let num: f64 = it.next()?.trim().parse().ok()?;
    let den: f64 = it.next().and_then(|v| v.trim().parse().ok()).unwrap_or(1.0);
    if den == 0.0 {
        return None;
    }
    Some(num / den)
}

/// 在字节串里找子序列。
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ══════════════════════════════════════════════════════════════════
// Matroska / WebM（EBML）
// ══════════════════════════════════════════════════════════════════

/// EBML 元素 ID（保留 marker 位，与规范里的写法一致）。
mod ebml_id {
    pub const HEADER: u64 = 0x1A45DFA3;
    pub const DOC_TYPE: u64 = 0x4282;
    pub const SEGMENT: u64 = 0x18538067;
    pub const INFO: u64 = 0x1549A966;
    pub const TIMECODE_SCALE: u64 = 0x2AD7B1;
    pub const DURATION: u64 = 0x4489;
    pub const MUXING_APP: u64 = 0x4D80;
    pub const WRITING_APP: u64 = 0x5741;
    pub const DATE_UTC: u64 = 0x4461;
    pub const TITLE: u64 = 0x7BA9;
    pub const TRACKS: u64 = 0x1654AE6B;
    pub const TRACK_ENTRY: u64 = 0xAE;
    pub const TRACK_TYPE: u64 = 0x83;
    pub const CODEC_ID: u64 = 0x86;
    pub const DEFAULT_DURATION: u64 = 0x23E383;
    pub const VIDEO: u64 = 0xE0;
    pub const PIXEL_WIDTH: u64 = 0xB0;
    pub const PIXEL_HEIGHT: u64 = 0xBA;
    pub const DISPLAY_WIDTH: u64 = 0x54B0;
    pub const DISPLAY_HEIGHT: u64 = 0x54BA;
    pub const AUDIO: u64 = 0xE1;
    pub const SAMPLING_FREQ: u64 = 0xB5;
    pub const CHANNELS: u64 = 0x9F;
    pub const TAGS: u64 = 0x1254C367;
    pub const CLUSTER: u64 = 0x1F43B675;
    pub const TAG: u64 = 0x7373;
    pub const SIMPLE_TAG: u64 = 0x67C8;
    pub const TAG_NAME: u64 = 0x45A3;
    pub const TAG_STRING: u64 = 0x4487;
}

/// 读一个 EBML 元素头，返回 `(id, size, data_off)`。
///
/// ID 与 size 都是变长整数（vint）：首字节的前导零决定长度。size 全 1 表示
/// 「长度未知」（Segment 常常如此），此时按「一直到父元素末尾」处理。
fn ebml_elem_at(f: &mut File, off: u64, end: u64) -> Option<(u64, u64, u64)> {
    if off >= end {
        return None;
    }
    let mut buf = [0u8; 16];
    let n = std::cmp::min(16usize, (end - off) as usize);
    if n < 2 {
        return None;
    }
    read_exact_at(f, off, &mut buf[..n])?;
    let first = buf[0];
    if first == 0 {
        return None;
    }
    let id_len = first.leading_zeros() as usize + 1;
    if id_len > 4 || id_len >= n {
        return None;
    }
    let mut id = 0u64;
    for i in 0..id_len {
        id = (id << 8) | buf[i] as u64;
    }
    let p = id_len;
    let sfirst = buf[p];
    let size_len = sfirst.leading_zeros() as usize + 1;
    if size_len > 8 || p + size_len > n {
        return None;
    }
    let mut size = (sfirst as u64) & ((1u64 << (8 - size_len)) - 1);
    for i in 1..size_len {
        size = (size << 8) | buf[p + i] as u64;
    }
    let data_off = off + (p + size_len) as u64;
    // 长度未知：所有位都是 1。
    let unknown = size == ((1u64 << (7 * size_len)) - 1);
    let size = if unknown {
        end.saturating_sub(data_off)
    } else {
        size.min(end.saturating_sub(data_off))
    };
    Some((id, size, data_off))
}

/// 列出一个区段的直接子元素。
fn ebml_children(f: &mut File, start: u64, end: u64) -> Vec<(u64, u64, u64)> {
    let mut out = Vec::new();
    let mut off = start;
    while off < end && out.len() < 256 {
        match ebml_elem_at(f, off, end) {
            Some((id, size, data_off)) => {
                let next = data_off + size;
                out.push((id, size, data_off));
                if next <= off {
                    break;
                }
                off = next;
            }
            None => break,
        }
    }
    out
}

fn ebml_uint(f: &mut File, off: u64, size: u64) -> Option<u64> {
    if size == 0 || size > 8 {
        return None;
    }
    let d = read_bytes_at(f, off, size as usize)?;
    let mut v = 0u64;
    for b in d {
        v = (v << 8) | b as u64;
    }
    Some(v)
}

fn ebml_int(f: &mut File, off: u64, size: u64) -> Option<i64> {
    if size == 0 || size > 8 {
        return None;
    }
    let d = read_bytes_at(f, off, size as usize)?;
    let mut v = 0i64;
    for b in d {
        v = (v << 8) | b as i64;
    }
    Some(v)
}

fn ebml_float(f: &mut File, off: u64, size: u64) -> Option<f64> {
    match size {
        4 => {
            let d = read_bytes_at(f, off, 4)?;
            Some(f32::from_be_bytes([d[0], d[1], d[2], d[3]]) as f64)
        }
        8 => {
            let d = read_bytes_at(f, off, 8)?;
            Some(f64::from_be_bytes([
                d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7],
            ]))
        }
        _ => None,
    }
}

fn ebml_string(f: &mut File, off: u64, size: u64) -> Option<String> {
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let d = read_bytes_at(f, off, size as usize)?;
    Some(
        String::from_utf8_lossy(&d)
            .trim_end_matches('\0')
            .trim()
            .to_string(),
    )
}

fn parse_matroska(f: &mut File, file_len: u64) -> Option<VideoMeta> {
    let mut meta = VideoMeta::default();

    // EBML 头里读 DocType（matroska / webm）。
    let mut doc_type = String::new();
    for (id, size, off) in ebml_children(f, 0, file_len) {
        if id == ebml_id::HEADER {
            for (cid, csize, coff) in ebml_children(f, off, off + size) {
                if cid == ebml_id::DOC_TYPE {
                    doc_type = ebml_string(f, coff, csize).unwrap_or_default();
                }
            }
        }
        if id == ebml_id::SEGMENT {
            break;
        }
    }
    meta.format = if doc_type.eq_ignore_ascii_case("webm") {
        "WebM".to_string()
    } else {
        "Matroska".to_string()
    };

    // Segment 及其子元素。
    let mut seg: Option<(u64, u64)> = None; // (data_off, end)
    for (id, size, off) in ebml_children(f, 0, file_len) {
        if id == ebml_id::SEGMENT {
            seg = Some((off, off + size));
            break;
        }
    }
    let (seg_off, seg_end) = seg?;

    let mut timecode_scale: u64 = 1_000_000;
    let mut duration_units: Option<f64> = None;
    let mut has_video = false;

    // 逐个读 Segment 的直接子元素。**遇到 Cluster 就停**：后面全是数据簇，
    // 一个长视频能有几千个，逐个列出来只是白seek。
    let mut cur = seg_off;
    while cur < seg_end {
        let (id, size, off) = match ebml_elem_at(f, cur, seg_end) {
            Some(v) => v,
            None => break,
        };
        match id {
            ebml_id::INFO => {
                for (cid, csize, coff) in ebml_children(f, off, off + size) {
                    match cid {
                        ebml_id::TIMECODE_SCALE => {
                            if let Some(v) = ebml_uint(f, coff, csize) {
                                if v > 0 {
                                    timecode_scale = v;
                                }
                            }
                        }
                        ebml_id::DURATION => {
                            duration_units = ebml_float(f, coff, csize);
                        }
                        ebml_id::MUXING_APP => {
                            if let Some(v) = ebml_string(f, coff, csize) {
                                if !v.is_empty() {
                                    meta.tags.push(ExifField {
                                        label: "封装工具".to_string(),
                                        value: v,
                                    });
                                }
                            }
                        }
                        ebml_id::WRITING_APP => {
                            if let Some(v) = ebml_string(f, coff, csize) {
                                if !v.is_empty() {
                                    meta.tags.push(ExifField {
                                        label: "写入工具".to_string(),
                                        value: v,
                                    });
                                }
                            }
                        }
                        ebml_id::TITLE => {
                            if let Some(v) = ebml_string(f, coff, csize) {
                                if !v.is_empty() {
                                    meta.tags.push(ExifField {
                                        label: "标题".to_string(),
                                        value: v,
                                    });
                                }
                            }
                        }
                        ebml_id::DATE_UTC => {
                            // 自 2001-01-01 起的纳秒。
                            if let Some(ns) = ebml_int(f, coff, csize) {
                                let unix = ns / 1_000_000_000 - 978_307_200;
                                meta.created = Some(format_utc(unix));
                            }
                        }
                        _ => {}
                    }
                }
            }
            ebml_id::TRACKS => {
                for (tid, tsize, toff) in ebml_children(f, off, off + size) {
                    if tid != ebml_id::TRACK_ENTRY {
                        continue;
                    }
                    let mut track_type: Option<u64> = None;
                    let mut codec_id = String::new();
                    let mut default_duration: Option<u64> = None;
                    let mut width: Option<u32> = None;
                    let mut height: Option<u32> = None;
                    let mut channels: Option<u32> = None;
                    let mut sampling: Option<u32> = None;

                    for (cid, csize, coff) in ebml_children(f, toff, toff + tsize) {
                        match cid {
                            ebml_id::TRACK_TYPE => track_type = ebml_uint(f, coff, csize),
                            ebml_id::CODEC_ID => {
                                codec_id = ebml_string(f, coff, csize).unwrap_or_default()
                            }
                            ebml_id::DEFAULT_DURATION => {
                                default_duration = ebml_uint(f, coff, csize)
                            }
                            ebml_id::VIDEO => {
                                for (vid, vsize, voff) in ebml_children(f, coff, coff + csize) {
                                    match vid {
                                        ebml_id::PIXEL_WIDTH => {
                                            width = ebml_uint(f, voff, vsize).map(|v| v as u32)
                                        }
                                        ebml_id::PIXEL_HEIGHT => {
                                            height = ebml_uint(f, voff, vsize).map(|v| v as u32)
                                        }
                                        ebml_id::DISPLAY_WIDTH => {
                                            if width.is_none() {
                                                width = ebml_uint(f, voff, vsize).map(|v| v as u32)
                                            }
                                        }
                                        ebml_id::DISPLAY_HEIGHT => {
                                            if height.is_none() {
                                                height = ebml_uint(f, voff, vsize).map(|v| v as u32)
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            ebml_id::AUDIO => {
                                for (aid, asize, aoff) in ebml_children(f, coff, coff + csize) {
                                    match aid {
                                        ebml_id::CHANNELS => {
                                            channels = ebml_uint(f, aoff, asize).map(|v| v as u32)
                                        }
                                        ebml_id::SAMPLING_FREQ => {
                                            sampling =
                                                ebml_float(f, aoff, asize).map(|v| v.round() as u32)
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

                    match track_type {
                        Some(1) => {
                            has_video = true;
                            if width.is_some() {
                                meta.width = width;
                            }
                            if height.is_some() {
                                meta.height = height;
                            }
                            if !codec_id.is_empty() {
                                meta.video_codec = Some(matroska_codec_label(&codec_id));
                            }
                            if let Some(d) = default_duration {
                                if d > 0 {
                                    meta.fps = Some(1_000_000_000.0 / d as f64);
                                }
                            }
                        }
                        Some(2) => {
                            if !codec_id.is_empty() {
                                meta.audio_codec = Some(matroska_codec_label(&codec_id));
                            }
                            if channels.is_some() {
                                meta.audio_channels = channels;
                            }
                            if sampling.is_some() {
                                meta.audio_sample_rate = sampling;
                            }
                        }
                        _ => {}
                    }
                }
            }
            ebml_id::TAGS => {
                parse_matroska_tags(f, off, size, &mut meta);
            }
            ebml_id::CLUSTER => break,
            _ => {}
        }
        let next = off + size;
        if next <= cur {
            break;
        }
        cur = next;
    }

    if !has_video {
        return None;
    }
    if let Some(d) = duration_units {
        let secs = d * timecode_scale as f64 / 1_000_000_000.0;
        if secs > 0.0 {
            meta.duration = Some(secs);
        }
    }
    finish_bitrate(&mut meta, file_len);
    Some(meta)
}

/// Matroska 的 `Tags` 元素（标签名 / 标签值）。
fn parse_matroska_tags(f: &mut File, off: u64, size: u64, meta: &mut VideoMeta) {
    for (tid, tsize, toff) in ebml_children(f, off, off + size) {
        if tid != ebml_id::TAG {
            continue;
        }
        for (sid, ssize, soff) in ebml_children(f, toff, toff + tsize) {
            if sid != ebml_id::SIMPLE_TAG {
                continue;
            }
            let mut name = String::new();
            let mut value = String::new();
            for (nid, nsize, noff) in ebml_children(f, soff, soff + ssize) {
                match nid {
                    ebml_id::TAG_NAME => name = ebml_string(f, noff, nsize).unwrap_or_default(),
                    ebml_id::TAG_STRING => value = ebml_string(f, noff, nsize).unwrap_or_default(),
                    _ => {}
                }
            }
            if !name.is_empty() && !value.is_empty() {
                meta.tags.push(ExifField { label: name, value });
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════
// AVI（RIFF）
// ══════════════════════════════════════════════════════════════════

/// RIFF chunk 的头。
#[derive(Clone, Copy)]
struct Chunk {
    kind: [u8; 4],
    data_off: u64,
    size: u64,
}

/// 列出一个 RIFF 区间里的 chunk。
fn riff_chunks(f: &mut File, start: u64, end: u64) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut off = start;
    while off + 8 <= end && out.len() < 512 {
        let mut h = [0u8; 8];
        if read_exact_at(f, off, &mut h).is_none() {
            break;
        }
        let kind = [h[0], h[1], h[2], h[3]];
        let size = le_u32(&h, 4).unwrap_or(0) as u64;
        let data_off = off + 8;
        if size == u32::MAX as u64 {
            break;
        }
        out.push(Chunk {
            kind,
            data_off,
            size,
        });
        // chunk 按偶数字节对齐。
        let next = data_off + size + (size & 1);
        if next <= off {
            break;
        }
        off = next;
    }
    out
}

fn parse_avi(f: &mut File, file_len: u64) -> Option<VideoMeta> {
    let mut meta = VideoMeta::default();
    meta.format = "AVI".to_string();

    let mut micro_sec_per_frame: Option<u32> = None;
    let mut total_frames: Option<u32> = None;
    let mut avi_width: Option<u32> = None;
    let mut avi_height: Option<u32> = None;
    let mut has_video = false;
    // 视频流 strh 里的 (scale, rate, length)：用来在没有 avih 时算时长。
    let mut vids_timing: Option<(u32, u32, u32)> = None;

    for chunk in riff_chunks(f, 12, file_len) {
        if &chunk.kind != b"LIST" {
            continue;
        }
        let mut lt = [0u8; 4];
        if read_exact_at(f, chunk.data_off, &mut lt).is_none() {
            continue;
        }
        let list_end = chunk.data_off + chunk.size;
        match &lt {
            b"hdrl" => {
                for c in riff_chunks(f, chunk.data_off + 4, list_end) {
                    if &c.kind == b"avih" {
                        let d = read_bytes_at(f, c.data_off, c.size.min(64) as usize)
                            .unwrap_or_default();
                        if d.len() >= 40 {
                            micro_sec_per_frame = le_u32(&d, 0);
                            total_frames = le_u32(&d, 16);
                            avi_width = le_u32(&d, 32);
                            avi_height = le_u32(&d, 36);
                        }
                    } else if &c.kind == b"LIST" {
                        // 每条流一个 strl。
                        let mut lt2 = [0u8; 4];
                        if read_exact_at(f, c.data_off, &mut lt2).is_none() {
                            continue;
                        }
                        if &lt2 != b"strl" {
                            continue;
                        }
                        let strl_end = c.data_off + c.size;
                        let mut fcc_type = [0u8; 4];
                        let mut fcc_handler = [0u8; 4];
                        let mut rate = 0u32;
                        let mut scale = 1u32;
                        let mut length = 0u32;
                        let mut bi_width: Option<u32> = None;
                        let mut bi_height: Option<u32> = None;
                        let mut bi_comp = [0u8; 4];
                        let mut wf_format = 0u16;
                        let mut wf_channels: Option<u32> = None;
                        let mut wf_rate: Option<u32> = None;

                        for s in riff_chunks(f, c.data_off + 4, strl_end) {
                            match &s.kind {
                                b"strh" => {
                                    let d = read_bytes_at(f, s.data_off, s.size.min(64) as usize)
                                        .unwrap_or_default();
                                    if d.len() >= 32 {
                                        fcc_type = [d[0], d[1], d[2], d[3]];
                                        fcc_handler = [d[4], d[5], d[6], d[7]];
                                        scale = le_u32(&d, 20).unwrap_or(1).max(1);
                                        rate = le_u32(&d, 24).unwrap_or(0);
                                        length = le_u32(&d, 28).unwrap_or(0);
                                    }
                                }
                                b"strf" => {
                                    let d = read_bytes_at(f, s.data_off, s.size.min(64) as usize)
                                        .unwrap_or_default();
                                    if &fcc_type == b"vids" {
                                        // BITMAPINFOHEADER
                                        if d.len() >= 40 {
                                            bi_width = le_u32(&d, 4);
                                            bi_height = le_u32(&d, 8);
                                            bi_comp = [d[16], d[17], d[18], d[19]];
                                        }
                                    } else if &fcc_type == b"auds" {
                                        // WAVEFORMATEX
                                        if d.len() >= 16 {
                                            wf_format = le_u16(&d, 0).unwrap_or(0);
                                            wf_channels = le_u16(&d, 2).map(|v| v as u32);
                                            wf_rate = le_u32(&d, 4);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }

                        if &fcc_type == b"vids" {
                            has_video = true;
                            meta.width = bi_width.or(avi_width);
                            meta.height = bi_height.or(avi_height);
                            let comp = String::from_utf8_lossy(&bi_comp).trim().to_string();
                            let handler = String::from_utf8_lossy(&fcc_handler).trim().to_string();
                            let label = if !comp.is_empty() && comp != "\0\0\0\0" {
                                codec_label(&comp)
                            } else {
                                codec_label(&handler)
                            };
                            if !label.is_empty() {
                                meta.video_codec = Some(label);
                            }
                            if rate > 0 && scale > 0 {
                                meta.fps = Some(rate as f64 / scale as f64);
                            }
                            vids_timing = Some((scale, rate, length));
                        } else if &fcc_type == b"auds" {
                            if let Some(ch) = wf_channels {
                                meta.audio_channels = Some(ch);
                            }
                            if let Some(r) = wf_rate {
                                meta.audio_sample_rate = Some(r);
                            }
                            let label = wav_format_label(wf_format);
                            if !label.is_empty() {
                                meta.audio_codec = Some(label.to_string());
                            }
                        }
                    }
                }
            }
            b"INFO" => {
                for c in riff_chunks(f, chunk.data_off + 4, list_end) {
                    let label = info_chunk_label(&c.kind);
                    if label.is_empty() {
                        continue;
                    }
                    let d =
                        read_bytes_at(f, c.data_off, c.size.min(4096) as usize).unwrap_or_default();
                    let text = String::from_utf8_lossy(&d)
                        .trim()
                        .trim_end_matches('\0')
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        meta.tags.push(ExifField {
                            label: label.to_string(),
                            value: text,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    if !has_video {
        return None;
    }
    // 时长：优先用主流信息（总帧数 × 每帧微秒），否则用视频流的长度 / 速率。
    if let (Some(frames), Some(usec)) = (total_frames, micro_sec_per_frame) {
        if frames > 0 && usec > 0 {
            meta.duration = Some(frames as f64 * usec as f64 / 1_000_000.0);
        }
    }
    if meta.duration.is_none() {
        // strh 的长度 / 速率。
        if let Some((scale, rate, length)) = vids_timing {
            if rate > 0 && length > 0 {
                meta.duration = Some(length as f64 * scale as f64 / rate as f64);
            }
        }
    }
    finish_bitrate(&mut meta, file_len);
    Some(meta)
}

/// RIFF `INFO` 列表里的常见标签。
fn info_chunk_label(kind: &[u8; 4]) -> &'static str {
    match kind {
        b"INAM" => "标题",
        b"IART" => "艺术家",
        b"ICMT" => "备注",
        b"ICRD" => "创建时间",
        b"ISFT" => "编码工具",
        b"IGNR" => "类型",
        b"ICOP" => "版权",
        b"IARL" => "作者",
        b"IPRD" => "产品",
        _ => "",
    }
}

/// WAVEFORMATEX 的 `wFormatTag` → 音频编码名。
fn wav_format_label(tag: u16) -> &'static str {
    match tag {
        0x0001 => "PCM",
        0x0002 => "ADPCM",
        0x0003 => "IEEE Float",
        0x0055 => "MP3",
        0x0092 => "Dolby AC3 SPDIF",
        0x00FF => "AAC",
        0x1600 => "Vorbis",
        0x2000 => "AC3",
        0xFFFE => "WAVEFORMATEX 扩展",
        _ => "",
    }
}

// ══════════════════════════════════════════════════════════════════
// FLV
// ══════════════════════════════════════════════════════════════════

fn parse_flv(f: &mut File, file_len: u64) -> Option<VideoMeta> {
    let mut head = [0u8; 16];
    read_exact_at(f, 0, &mut head)?;
    if &head[0..3] != b"FLV" {
        return None;
    }
    let data_offset = be_u32(&head, 5).unwrap_or(9) as u64;

    let mut meta = VideoMeta::default();
    meta.format = "FLV".to_string();
    let mut has_video = false;

    let mut off = data_offset;
    for _ in 0..64 {
        if off + 11 > file_len {
            break;
        }
        let mut h = [0u8; 11];
        if read_exact_at(f, off, &mut h).is_none() {
            break;
        }
        let tag_type = h[0];
        let size = ((h[1] as u64) << 16) | ((h[2] as u64) << 8) | h[3] as u64;
        let data = read_bytes_at(f, off + 11, size.min(1024 * 1024) as usize).unwrap_or_default();

        match tag_type {
            // 脚本标签：onMetaData。
            18 => {
                let mut pos = 0usize;
                if let Some(props) = amf0_object(&data, &mut pos) {
                    for (k, v) in props {
                        match k.as_str() {
                            "duration" => meta.duration = v.as_f64(),
                            "width" => meta.width = v.as_f64().map(|x| x as u32),
                            "height" => meta.height = v.as_f64().map(|x| x as u32),
                            "framerate" => meta.fps = v.as_f64(),
                            "videocodecid" => {
                                if let Some(id) = v.as_f64() {
                                    meta.video_codec = Some(flv_video_codec_label(id as u32));
                                }
                            }
                            "audiocodecid" => {
                                if let Some(id) = v.as_f64() {
                                    meta.audio_codec = Some(flv_audio_codec_label(id as u32));
                                }
                            }
                            "audiosamplerate" => {
                                meta.audio_sample_rate = v.as_f64().map(|x| x as u32)
                            }
                            "stereo" => {
                                // 单声道 / 立体声。
                                if let Some(stereo) = v.as_bool() {
                                    meta.audio_channels = Some(if stereo { 2 } else { 1 });
                                }
                            }
                            "encoder" => {
                                if let Some(s) = v.as_str() {
                                    if !s.is_empty() {
                                        meta.tags.push(ExifField {
                                            label: "编码工具".to_string(),
                                            value: s,
                                        });
                                    }
                                }
                            }
                            "creator" => {
                                if let Some(s) = v.as_str() {
                                    if !s.is_empty() {
                                        meta.tags.push(ExifField {
                                            label: "创建工具".to_string(),
                                            value: s,
                                        });
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    if meta.width.is_some() && meta.height.is_some() {
                        has_video = true;
                    }
                }
            }
            // 视频标签：首字节的低 4 位是编码 ID。
            9 => {
                if let Some(&b) = data.first() {
                    let codec_id = (b & 0x0F) as u32;
                    let label = flv_video_codec_label(codec_id);
                    if !label.is_empty() {
                        meta.video_codec = Some(label);
                    }
                }
                has_video = true;
            }
            // 音频标签：首字节的高 4 位是编码 ID。
            8 => {
                if let Some(&b) = data.first() {
                    let codec_id = (b >> 4) as u32;
                    let label = flv_audio_codec_label(codec_id);
                    if !label.is_empty() && meta.audio_codec.is_none() {
                        meta.audio_codec = Some(label);
                    }
                }
            }
            _ => {}
        }

        let next = off + 11 + size + 4; // 末尾还有 4 字节的 PreviousTagSize
        if next <= off {
            break;
        }
        off = next;
    }

    if !has_video {
        return None;
    }
    finish_bitrate(&mut meta, file_len);
    Some(meta)
}

// ── AMF0 ──

/// AMF0 的一个值。
enum Amf {
    Num(f64),
    Str(String),
    Bool(bool),
    /// 键值对。严格数组也归到这里，键用下标的十进制字符串。
    Obj(Vec<(String, Amf)>),
}

impl Amf {
    fn as_f64(&self) -> Option<f64> {
        match self {
            Amf::Num(v) => Some(*v),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<String> {
        match self {
            Amf::Str(s) => Some(s.clone()),
            _ => None,
        }
    }
    fn as_bool(&self) -> Option<bool> {
        match self {
            Amf::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

/// 读一个 AMF0 值。
fn amf0_value(d: &[u8], pos: &mut usize, depth: u32) -> Option<Amf> {
    if depth > 4 {
        return None;
    }
    let marker = *d.get(*pos)?;
    *pos += 1;
    Some(match marker {
        0x00 => {
            let b = d.get(*pos..*pos + 8)?;
            *pos += 8;
            Amf::Num(f64::from_be_bytes([
                b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
            ]))
        }
        0x01 => {
            let v = *d.get(*pos)?;
            *pos += 1;
            Amf::Bool(v != 0)
        }
        0x02 => {
            let len = be_u16(d, *pos)? as usize;
            *pos += 2;
            let s = d.get(*pos..*pos + len)?;
            *pos += len;
            Amf::Str(String::from_utf8_lossy(s).to_string())
        }
        0x03 => Amf::Obj(amf0_props(d, pos, depth + 1)?),
        0x05 => Amf::Obj(Vec::new()), // Null
        0x08 => {
            // ECMA 数组：计数 + 键值对（与对象同构）。
            let _count = be_u32(d, *pos)?;
            *pos += 4;
            Amf::Obj(amf0_props(d, pos, depth + 1)?)
        }
        0x0A => {
            // 严格数组：计数 + 值列表（没有键，用下标当键）。
            let count = be_u32(d, *pos)? as usize;
            *pos += 4;
            let mut items = Vec::new();
            for i in 0..count.min(256) {
                let v = amf0_value(d, pos, depth + 1)?;
                items.push((i.to_string(), v));
            }
            Amf::Obj(items)
        }
        0x0C => {
            // 长字符串：u32 长度 + UTF-8。
            let len = be_u32(d, *pos)? as usize;
            *pos += 4;
            let s = d.get(*pos..*pos + len)?;
            *pos += len;
            Amf::Str(String::from_utf8_lossy(s).to_string())
        }
        _ => return None,
    })
}

/// 读对象 / ECMA 数组的键值对，直到 `ObjectEnd` 标记。
fn amf0_props(d: &[u8], pos: &mut usize, depth: u32) -> Option<Vec<(String, Amf)>> {
    let mut out = Vec::new();
    loop {
        let key = match amf0_value(d, pos, depth)? {
            Amf::Str(s) => s,
            _ => break,
        };
        // 对象结束标记：0x00 0x00 0x09。
        if d.get(*pos..*pos + 3) == Some(&[0x00, 0x00, 0x09]) {
            *pos += 3;
            break;
        }
        let value = amf0_value(d, pos, depth)?;
        out.push((key, value));
        if out.len() > 256 {
            break;
        }
    }
    Some(out)
}

/// 从脚本标签里取出 onMetaData 的键值对。
fn amf0_object(d: &[u8], pos: &mut usize) -> Option<Vec<(String, Amf)>> {
    // 第一个值是字符串 "onMetaData"。
    let name = match amf0_value(d, pos, 0)? {
        Amf::Str(s) => s,
        _ => return None,
    };
    if !name.eq_ignore_ascii_case("onMetaData") {
        return None;
    }
    match amf0_value(d, pos, 0)? {
        Amf::Obj(items) => Some(items),
        _ => None,
    }
}

// ── 编码名 ──

/// ISO BMFF / AVI 的四字符代码 → 编码名。
fn codec_label(code: &str) -> String {
    let c = code.trim();
    let label = match c {
        "avc1" | "avc3" | "AVC1" | "H264" | "h264" | "x264" | "X264" | "AVCD" => "H.264 / AVC",
        "hvc1" | "hev1" | "HVC1" | "HEVC" | "hevc" | "h265" | "H265" => "H.265 / HEVC",
        "av01" | "AV01" => "AV1",
        "vp08" | "VP80" => "VP8",
        "vp09" | "VP90" => "VP9",
        "mp4v" | "MP4V" | "FMP4" => "MPEG-4 Part 2",
        "DIVX" | "XVID" | "xvid" => "MPEG-4 Part 2",
        "mpg2" | "MPG2" | "mpeg2" => "MPEG-2",
        "mp4a" | "MP4A" | "AACL" | "aac " => "AAC",
        "alac" | "ALAC" => "Apple Lossless",
        "ac-3" | "AC-3" | "ac3" => "AC-3",
        "ec-3" | "EC-3" => "E-AC-3",
        "Opus" | "opus" => "Opus",
        "sowt" | "twos" => "PCM",
        "lpcm" => "PCM",
        ".mp3" | "mp3 " | "MP3 " => "MP3",
        "jpeg" | "MJPG" | "mjpg" => "MJPEG",
        "FLV1" | "flv1" => "Sorenson H.263",
        "VP6F" | "vp6f" => "VP6",
        _ => "",
    };
    label.to_string()
}

/// Matroska 的 `CodecID` → 编码名。
fn matroska_codec_label(id: &str) -> String {
    let label = match id {
        "V_MPEG4/ISO/AVC" => "H.264 / AVC",
        "V_MPEGH/ISO/HEVC" => "H.265 / HEVC",
        "V_AV1" => "AV1",
        "V_VP8" => "VP8",
        "V_VP9" => "VP9",
        "V_MPEG4/ISO/ASP" | "V_MPEG4/ISO/SP" => "MPEG-4 Part 2",
        "V_THEORA" => "Theora",
        "V_UNCOMPRESSED" => "未压缩",
        "A_AAC" => "AAC",
        "A_OPUS" => "Opus",
        "A_VORBIS" => "Vorbis",
        "A_FLAC" => "FLAC",
        "A_MPEG/L3" => "MP3",
        "A_AC3" => "AC-3",
        "A_EAC3" => "E-AC-3",
        "A_PCM/INT/LIT" | "A_PCM/INT/BIG" => "PCM",
        _ => "",
    };
    if label.is_empty() {
        // 认不出就原样报出 CodecID（信息比空白强）。
        return id.to_string();
    }
    label.to_string()
}

/// FLV 视频编码 ID。
fn flv_video_codec_label(id: u32) -> String {
    match id {
        1 => "JPEG",
        2 => "Sorenson H.263",
        3 => "Screen Video",
        4 => "On2 VP6",
        5 => "On2 VP6 with Alpha",
        6 => "Screen Video v2",
        7 => "H.264 / AVC",
        12 => "H.265 / HEVC",
        _ => "",
    }
    .to_string()
}

/// FLV 音频编码 ID。
fn flv_audio_codec_label(id: u32) -> String {
    match id {
        0 => "PCM",
        1 => "ADPCM",
        2 => "MP3",
        3 => "PCM (16-bit)",
        4 => "Nellymoser 16 kHz",
        5 => "Nellymoser 8 kHz",
        6 => "Nellymoser",
        7 => "G.711 A-law",
        8 => "G.711 mu-law",
        10 => "AAC",
        11 => "Speex",
        14 => "MP3 8 kHz",
        _ => "",
    }
    .to_string()
}

/// 平均码率：文件大小 ÷ 时长。
///
/// 这是**整个文件**的平均码率（含容器开销与音视频轨之和），不是某一条
/// 视频轨的码率 —— 容器里通常没有可靠的轨道级码率。
fn finish_bitrate(meta: &mut VideoMeta, file_len: u64) {
    if let Some(d) = meta.duration {
        if d > 0.0 && file_len > 0 {
            meta.bitrate = Some((file_len as f64 * 8.0 / d) as u64);
        }
    }
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("mini-tc-videometa-test");
        std::fs::create_dir_all(&dir).expect("应能建临时目录");
        dir.join(name)
    }

    /// 造一个最小的 MP4：`ftyp` + `moov`（`mvhd` + 一条视频轨）。
    fn minimal_mp4() -> Vec<u8> {
        fn box_of(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
            v.extend_from_slice(kind);
            v.extend_from_slice(payload);
            v
        }
        /// 把几个 box 头尾相接成一个负载。
        fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
            let mut v = Vec::new();
            for p in parts {
                v.extend_from_slice(p);
            }
            v
        }

        // mvhd（version 0）：creation / mod / timescale / duration ...
        let mut mvhd = Vec::new();
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // version + flags
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // creation
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // modification
        mvhd.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd.extend_from_slice(&5000u32.to_be_bytes()); // duration → 5 秒
        mvhd.extend_from_slice(&[0u8; 80]);

        // tkhd（version 0）：宽高在偏移 76 / 80。
        let mut tkhd = Vec::new();
        tkhd.extend_from_slice(&0x7u32.to_be_bytes()); // version + flags
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // creation
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // modification
        tkhd.extend_from_slice(&1u32.to_be_bytes()); // track id
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // reserved
        tkhd.extend_from_slice(&5000u32.to_be_bytes()); // duration
        tkhd.extend_from_slice(&[0u8; 52]); // reserved(8) + layer/alt/vol/res(8) + matrix(36)
        tkhd.extend_from_slice(&(1920u32 << 16).to_be_bytes()); // width 16.16
        tkhd.extend_from_slice(&(1080u32 << 16).to_be_bytes()); // height 16.16

        // stsd：一条 avc1 采样描述。
        // 条目布局：长度(4) + 格式(4) + 保留(6) + 数据引用(2) + 预定义(16)
        //          + 宽(2) + 高(2) …
        let mut stsd = Vec::new();
        stsd.extend_from_slice(&0u32.to_be_bytes()); // version + flags
        stsd.extend_from_slice(&1u32.to_be_bytes()); // entry count
        let mut entry = vec![0u8; 86];
        entry[0..4].copy_from_slice(&86u32.to_be_bytes()); // 条目长度
        entry[4..8].copy_from_slice(b"avc1"); // 格式
        entry[32..34].copy_from_slice(&1280u16.to_be_bytes()); // 宽
        entry[34..36].copy_from_slice(&720u16.to_be_bytes()); // 高
        stsd.extend_from_slice(&entry);

        // stts：采样数 50 × 间隔 20（时间刻度 1000 → 50 fps）。
        let mut stts = Vec::new();
        stts.extend_from_slice(&0u32.to_be_bytes());
        stts.extend_from_slice(&1u32.to_be_bytes());
        stts.extend_from_slice(&50u32.to_be_bytes());
        stts.extend_from_slice(&20u32.to_be_bytes());

        let stbl = box_of(
            b"stbl",
            &cat(&[box_of(b"stsd", &stsd), box_of(b"stts", &stts)]),
        );
        // minf 里直接就是 stbl。
        let minf = box_of(b"minf", &stbl);

        // hdlr：vide
        let mut hdlr = Vec::new();
        hdlr.extend_from_slice(&0u32.to_be_bytes());
        hdlr.extend_from_slice(&0u32.to_be_bytes());
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0u8; 12]);
        hdlr.extend_from_slice(b"VideoHandler\0");

        let mut mdhd = Vec::new();
        mdhd.extend_from_slice(&0u32.to_be_bytes());
        mdhd.extend_from_slice(&0u32.to_be_bytes());
        mdhd.extend_from_slice(&0u32.to_be_bytes());
        mdhd.extend_from_slice(&1000u32.to_be_bytes());
        mdhd.extend_from_slice(&5000u32.to_be_bytes());

        let mdia = box_of(
            b"mdia",
            &cat(&[box_of(b"mdhd", &mdhd), box_of(b"hdlr", &hdlr), minf]),
        );
        let trak = box_of(b"trak", &cat(&[box_of(b"tkhd", &tkhd), mdia]));
        let moov = box_of(b"moov", &cat(&[box_of(b"mvhd", &mvhd), trak]));

        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(b"isom");
        ftyp.extend_from_slice(&512u32.to_be_bytes());
        ftyp.extend_from_slice(b"isom");

        let mut out = Vec::new();
        out.extend_from_slice(&box_of(b"ftyp", &ftyp));
        out.extend_from_slice(&moov);
        out
    }

    #[test]
    fn mp4_reads_duration_resolution_and_codec() {
        let path = tmp_path("sample.mp4");
        std::fs::write(&path, minimal_mp4()).expect("应能写临时文件");
        let meta = probe(&path).expect("应能探测出视频元数据");
        assert_eq!(meta.format, "MP4");
        assert_eq!(meta.duration, Some(5.0));
        // tkhd 的**显示**尺寸优先于 stsd 的编码尺寸（与资源管理器一致）。
        assert_eq!(meta.width, Some(1920));
        assert_eq!(meta.height, Some(1080));
        assert_eq!(meta.video_codec.as_deref(), Some("H.264 / AVC"));
        assert_eq!(meta.fps, Some(50.0));
        assert!(meta.bitrate.unwrap() > 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn heic_file_is_not_claimed_as_video() {
        let path = tmp_path("sample.heic");
        let mut data = Vec::new();
        data.extend_from_slice(&8u32.to_be_bytes());
        data.extend_from_slice(b"ftyp");
        data.extend_from_slice(b"heic");
        data.extend_from_slice(&[0u8; 16]);
        std::fs::write(&path, &data).expect("应能写临时文件");
        assert!(probe(&path).is_none(), "HEIC 是图像，不该被认领成视频");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn avi_reads_main_header() {
        let path = tmp_path("sample.avi");
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(b"AVI ");
        // hdrl → avih
        let mut avih = vec![0u8; 56];
        avih[0..4].copy_from_slice(&40000u32.to_le_bytes()); // 每帧 40 ms → 25 fps
        avih[16..20].copy_from_slice(&250u32.to_le_bytes()); // 总帧数 250 → 10 秒
        avih[32..36].copy_from_slice(&1280u32.to_le_bytes());
        avih[36..40].copy_from_slice(&720u32.to_le_bytes());
        let mut strh = vec![0u8; 56];
        strh[0..4].copy_from_slice(b"vids");
        strh[4..8].copy_from_slice(b"H264");
        strh[20..24].copy_from_slice(&1u32.to_le_bytes()); // scale
        strh[24..28].copy_from_slice(&25u32.to_le_bytes()); // rate → 25 fps
        strh[28..32].copy_from_slice(&250u32.to_le_bytes()); // length
        let mut strf = vec![0u8; 40];
        strf[4..8].copy_from_slice(&1280u32.to_le_bytes());
        strf[8..12].copy_from_slice(&720u32.to_le_bytes());
        strf[16..20].copy_from_slice(b"H264");

        let mut strl = Vec::new();
        strl.extend_from_slice(b"strl");
        strl.extend_from_slice(&chunk(b"strh", &strh));
        strl.extend_from_slice(&chunk(b"strf", &strf));

        let mut hdrl = Vec::new();
        hdrl.extend_from_slice(b"hdrl");
        hdrl.extend_from_slice(&chunk(b"avih", &avih));
        hdrl.extend_from_slice(&chunk(b"LIST", &strl));

        data.extend_from_slice(&chunk(b"LIST", &hdrl));
        std::fs::write(&path, &data).expect("应能写临时文件");

        let meta = probe(&path).expect("应能探测出视频元数据");
        assert_eq!(meta.format, "AVI");
        assert_eq!(meta.width, Some(1280));
        assert_eq!(meta.height, Some(720));
        assert_eq!(meta.duration, Some(10.0));
        assert_eq!(meta.video_codec.as_deref(), Some("H.264 / AVC"));
        let _ = std::fs::remove_file(&path);
    }

    fn chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(kind);
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            v.push(0);
        }
        v
    }

    #[test]
    fn iso6709_position_becomes_gps() {
        let (lat, lon, alt) = parse_iso6709("+37.3317-122.0307+010.000/").expect("应能解析");
        assert!((lat - 37.3317).abs() < 1e-6);
        assert!((lon + 122.0307).abs() < 1e-6);
        assert_eq!(alt, Some(10.0));
    }

    #[test]
    fn civil_date_conversion() {
        // 2024-05-01T00:00:00Z
        assert_eq!(format_utc(1_714_521_600), "2024-05-01 00:00:00");
    }

    #[test]
    fn garbage_file_yields_nothing() {
        let path = tmp_path("garbage.bin");
        std::fs::write(&path, vec![0x11u8; 512]).expect("应能写临时文件");
        assert!(probe(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    /// 造一个最小的 Matroska：`EBML` 头 + `Segment`（Info + Tracks）。
    fn minimal_mkV() -> Vec<u8> {
        // EBML 元素：ID 是保留 marker 位的字节串，size 是 vint。
        fn elem(id: &[u8], payload: &[u8]) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(id);
            // size 用 4 字节 vint（0x10 | 长度）。
            let n = payload.len();
            assert!(n < 0x0F_FFFF, "样例太大");
            v.push(0x10 | ((n >> 21) & 0x07) as u8);
            v.push(((n >> 14) & 0x7F) as u8);
            v.push(((n >> 7) & 0x7F) as u8);
            v.push((n & 0x7F) as u8);
            v.extend_from_slice(payload);
            v
        }
        fn uint_elem(id: &[u8], value: u64) -> Vec<u8> {
            // 尽量用最少的字节存下这个整数。
            let bytes = value.to_be_bytes();
            let first = bytes.iter().position(|b| *b != 0).unwrap_or(7);
            elem(id, &bytes[first..])
        }
        fn str_elem(id: &[u8], text: &str) -> Vec<u8> {
            elem(id, text.as_bytes())
        }
        fn float_elem(id: &[u8], value: f64) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&value.to_be_bytes());
            elem(id, &v)
        }

        // Info：TimecodeScale 1ms + Duration 4000（→ 4 秒）。
        let mut info = Vec::new();
        info.extend_from_slice(&uint_elem(&[0x2A, 0xD7, 0xB1], 1_000_000));
        info.extend_from_slice(&float_elem(&[0x44, 0x89], 4000.0));
        info.extend_from_slice(&str_elem(&[0x4D, 0x80], "mkvmerge v9.0"));

        // Tracks：一条视频轨（V_MPEG4/ISO/AVC，1920×1080）。
        let mut video = Vec::new();
        video.extend_from_slice(&uint_elem(&[0xB0], 1920));
        video.extend_from_slice(&uint_elem(&[0xBA], 1080));
        let mut track = Vec::new();
        track.extend_from_slice(&uint_elem(&[0xD7], 1920)); // PixelWidth（视频内的）
        track.extend_from_slice(&uint_elem(&[0x83], 1)); // TrackType = video
        track.extend_from_slice(&str_elem(&[0x86], "V_MPEG4/ISO/AVC"));
        track.extend_from_slice(&elem(&[0xE0], &video));
        let tracks = elem(&[0x16, 0x54, 0xAE, 0x6B], &elem(&[0xAE], &track));

        // Segment 里直接放 Info 与 Tracks 两块。
        let mut seg_payload = Vec::new();
        seg_payload.extend_from_slice(&elem(&[0x15, 0x49, 0xA9, 0x66], &info));
        seg_payload.extend_from_slice(&tracks);
        let segment = elem(&[0x18, 0x53, 0x80, 0x67], &seg_payload);

        let header = elem(
            &[0x1A, 0x45, 0xDF, 0xA3],
            &str_elem(&[0x42, 0x82], "matroska"),
        );

        let mut out = Vec::new();
        out.extend_from_slice(&header);
        out.extend_from_slice(&segment);
        out
    }

    #[test]
    fn matroska_reads_duration_resolution_and_codec() {
        let path = tmp_path("sample.mkv");
        std::fs::write(&path, minimal_mkV()).expect("应能写临时文件");
        let meta = probe(&path).expect("应能探测出视频元数据");
        assert_eq!(meta.format, "Matroska");
        // Duration 4000 × TimecodeScale 1ms → 4 秒。
        assert_eq!(meta.duration, Some(4.0));
        assert_eq!(meta.width, Some(1920));
        assert_eq!(meta.height, Some(1080));
        assert_eq!(meta.video_codec.as_deref(), Some("H.264 / AVC"));
        assert!(meta.tags.iter().any(|t| t.value == "mkvmerge v9.0"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn itunes_tags_and_iso6709_become_labels_and_gps() {
        // `meta` 有 FullBox 与裸容器两种形态，两种都得能解出标签。
        // 这里两种各跑一遍 —— 判据写死成其中一种时，另一半的文件会静默
        // 丢掉全部标签（属性窗口里「视频标签」区块直接空掉，没有任何报错）。
        for (name, full_box) in [("fullbox", true), ("bare", false)] {
            let path = tmp_path(&format!("tagged-{}.mov", name));
            let meta = build_tagged_mov(full_box);
            std::fs::write(&path, &meta).expect("应能写临时文件");

            let parsed = probe(&path).expect("应能探测出视频元数据");
            assert_eq!(parsed.format, "QuickTime", "{} 形态", name);
            assert!(
                parsed.tags.iter().any(|t| t.value == "海边散步"),
                "{} 形态应解出标题标签，实际 {:?}",
                name,
                parsed.tags
            );
            assert!(
                parsed.tags.iter().any(|t| t.value == "Apple"),
                "{} 形态应解出设备厂商，实际 {:?}",
                name,
                parsed.tags
            );
            let gps = parsed.gps.expect("位置标签应转成 GPS");
            assert!((gps.latitude.unwrap() - 37.3317).abs() < 1e-6);
            assert!((gps.longitude.unwrap() + 122.0307).abs() < 1e-6);
            let _ = std::fs::remove_file(&path);
        }
    }

    /// 造一个带 iTunes 标签与 ISO 6709 位置的 MOV。
    /// `full_box` 决定 `meta` 是 FullBox（带版本 / 标志）还是裸容器。
    fn build_tagged_mov(full_box: bool) -> Vec<u8> {
        fn box_of(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
            v.extend_from_slice(kind);
            v.extend_from_slice(payload);
            v
        }
        fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
            let mut v = Vec::new();
            for p in parts {
                v.extend_from_slice(p);
            }
            v
        }
        /// 一个 ilst 条目：四字符代码 + 一个 text 类型的 data box。
        fn ilst_item(code: &[u8; 4], text: &str) -> Vec<u8> {
            let mut data = Vec::new();
            data.extend_from_slice(&1u32.to_be_bytes()); // 类型：UTF-8
            data.extend_from_slice(&0u32.to_be_bytes()); // locale
            data.extend_from_slice(text.as_bytes());
            let mut body = Vec::new();
            body.extend_from_slice(&box_of(b"data", &data));
            box_of(code, &body)
        }

        let ilst = cat(&[
            ilst_item(b"\xa9nam", "海边散步"),
            ilst_item(b"\xa9mak", "Apple"),
            ilst_item(b"\xa9xyz", "+37.3317-122.0307+010.000/"),
        ]);
        let mut hdlr_box = Vec::new();
        hdlr_box.extend_from_slice(&0u32.to_be_bytes()); // version + flags
        hdlr_box.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
        hdlr_box.extend_from_slice(b"mdir");
        hdlr_box.extend_from_slice(b"appl");
        hdlr_box.extend_from_slice(&[0u8; 9]);

        let mut meta = Vec::new();
        if full_box {
            // FullBox：版本 / 标志(4) + 一个完整的 hdlr box + ilst box。
            meta.extend_from_slice(&0u32.to_be_bytes());
            meta.extend_from_slice(&box_of(b"hdlr", &hdlr_box));
        } else {
            // 裸容器：第一个子 box 直接就是 hdlr。
            meta.extend_from_slice(&box_of(b"hdlr", &hdlr_box));
        }
        meta.extend_from_slice(&box_of(b"ilst", &ilst));
        let udta = box_of(b"udta", &box_of(b"meta", &meta));

        // 一条视频轨（tkhd 足够撑起「有视频轨」这个判定）。
        let mut tkhd = Vec::new();
        tkhd.extend_from_slice(&0x7u32.to_be_bytes());
        tkhd.extend_from_slice(&[0u8; 84]);
        let mut hdlr = Vec::new();
        hdlr.extend_from_slice(&0u32.to_be_bytes());
        hdlr.extend_from_slice(&0u32.to_be_bytes());
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0u8; 12]);
        let mdia = box_of(b"mdia", &cat(&[box_of(b"hdlr", &hdlr)]));
        let trak = box_of(b"trak", &cat(&[box_of(b"tkhd", &tkhd), mdia]));
        let moov = box_of(b"moov", &cat(&[udta, trak]));

        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(b"qt  ");
        ftyp.extend_from_slice(&512u32.to_be_bytes());
        ftyp.extend_from_slice(b"qt  ");

        let mut out = Vec::new();
        out.extend_from_slice(&box_of(b"ftyp", &ftyp));
        out.extend_from_slice(&moov);
        out
    }

    #[test]
    fn m4a_without_video_track_is_not_claimed() {
        // .m4a 走的是同一套 ISO BMFF box 结构，但没有视频轨。
        // 认领它会让属性窗口给一个音乐文件显示「视频信息」。
        fn box_of(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
            v.extend_from_slice(kind);
            v.extend_from_slice(payload);
            v
        }
        fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
            let mut v = Vec::new();
            for p in parts {
                v.extend_from_slice(p);
            }
            v
        }
        let mut hdlr = Vec::new();
        hdlr.extend_from_slice(&0u32.to_be_bytes());
        hdlr.extend_from_slice(&0u32.to_be_bytes());
        hdlr.extend_from_slice(b"soun");
        hdlr.extend_from_slice(&[0u8; 12]);
        let mdia = box_of(b"mdia", &cat(&[box_of(b"hdlr", &hdlr)]));
        let trak = box_of(b"trak", &cat(&[mdia]));
        let moov = box_of(b"moov", &cat(&[trak]));
        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(b"M4A ");
        ftyp.extend_from_slice(&512u32.to_be_bytes());
        ftyp.extend_from_slice(b"M4A ");
        let mut out = Vec::new();
        out.extend_from_slice(&box_of(b"ftyp", &ftyp));
        out.extend_from_slice(&moov);

        let path = tmp_path("sample.m4a");
        std::fs::write(&path, &out).expect("应能写临时文件");
        assert!(probe(&path).is_none(), "纯音频不该被认领成视频");
        let _ = std::fs::remove_file(&path);
    }
}
