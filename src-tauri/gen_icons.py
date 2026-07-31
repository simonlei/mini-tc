"""
Generate icon files for Mini TC (Tauri app).
Uses only Python standard library (zlib, struct) - no PIL needed.
Creates a dual-pane file manager icon: two folder-like panels on a blue gradient.
"""
import zlib
import struct
import os
import math

def create_png(width, height, pixels):
    """Create a PNG file from RGBA pixel data.
    pixels: list of rows, each row is list of (r, g, b, a) tuples.
    """
    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    ihdr = make_chunk(b'IHDR', ihdr_data)

    # IDAT chunk - raw image data with filter byte per row
    raw_data = bytearray()
    for row in pixels:
        raw_data.append(0)  # filter: none
        for r, g, b, a in row:
            raw_data.extend([r, g, b, a])
    compressed = zlib.compress(bytes(raw_data), 9)
    idat = make_chunk(b'IDAT', compressed)

    # IEND chunk
    iend = make_chunk(b'IEND', b'')

    return sig + ihdr + idat + iend


def make_chunk(chunk_type, data):
    """Create a PNG chunk with CRC."""
    chunk = chunk_type + data
    crc = zlib.crc32(chunk) & 0xffffffff
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def lerp_color(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(len(c1)))


def draw_rounded_rect(pixels, w, h, x, y, rw, rh, radius, color):
    """Draw a filled rounded rectangle."""
    for py in range(y, y + rh):
        for px in range(x, x + rw):
            if py < 0 or py >= h or px < 0 or px >= w:
                continue
            # Check corners for rounding
            in_corner = False
            # Top-left
            if px < x + radius and py < y + radius:
                dx = (x + radius) - px
                dy = (y + radius) - py
                if dx * dx + dy * dy > radius * radius:
                    in_corner = True
            # Top-right
            elif px > x + rw - radius - 1 and py < y + radius:
                dx = px - (x + rw - radius - 1)
                dy = (y + radius) - py
                if dx * dx + dy * dy > radius * radius:
                    in_corner = True
            # Bottom-left
            elif px < x + radius and py > y + rh - radius - 1:
                dx = (x + radius) - px
                dy = py - (y + rh - radius - 1)
                if dx * dx + dy * dy > radius * radius:
                    in_corner = True
            # Bottom-right
            elif px > x + rw - radius - 1 and py > y + rh - radius - 1:
                dx = px - (x + rw - radius - 1)
                dy = py - (y + rh - radius - 1)
                if dx * dx + dy * dy > radius * radius:
                    in_corner = True

            if not in_corner:
                # Blend with existing pixel
                bg = pixels[py][px]
                a = color[3] / 255.0
                blended = tuple(int(color[i] * a + bg[i] * (1 - a)) for i in range(3)) + (255,)
                pixels[py][px] = blended


def draw_rect(pixels, w, h, x, y, rw, rh, color):
    """Draw a filled rectangle."""
    for py in range(y, y + rh):
        for px in range(x, x + rw):
            if 0 <= py < h and 0 <= px < w:
                bg = pixels[py][px]
                a = color[3] / 255.0
                if a >= 1.0:
                    pixels[py][px] = color[:3] + (255,)
                else:
                    blended = tuple(int(color[i] * a + bg[i] * (1 - a)) for i in range(3)) + (255,)
                    pixels[py][px] = blended


def generate_icon(size):
    """Generate the Mini TC icon at the given size."""
    # Colors
    bg_top = (15, 52, 96)       # #0f3460
    bg_bottom = (22, 33, 62)    # #16213e
    panel_color = (78, 158, 255, 220)  # #4e9eff semi-transparent
    panel_header = (255, 255, 255, 180)
    folder_color = (255, 200, 80, 255)  # golden folder

    # Initialize pixels with gradient background
    pixels = []
    for y in range(size):
        row = []
        t = y / max(size - 1, 1)
        c = lerp_color(bg_top, bg_bottom, t)
        for x in range(size):
            row.append(c + (255,))
        pixels.append(row)

    # Draw rounded background
    margin = max(2, size // 16)
    radius = max(4, size // 8)
    draw_rounded_rect(pixels, size, size, margin, margin, size - 2 * margin, size - 2 * margin, radius, (15, 52, 96, 255))

    # Draw two panels (left and right) - the dual-pane concept
    panel_margin = max(4, size // 10)
    panel_y = panel_margin + max(2, size // 8)
    gap = max(3, size // 20)
    panel_w = (size - 2 * panel_margin - gap) // 2
    panel_h = size - panel_y - panel_margin
    panel_radius = max(2, size // 16)

    # Left panel
    draw_rounded_rect(pixels, size, size, panel_margin, panel_y, panel_w, panel_h, panel_radius, panel_color)
    # Right panel
    right_x = panel_margin + panel_w + gap
    draw_rounded_rect(pixels, size, size, right_x, panel_y, panel_w, panel_h, panel_radius, panel_color)

    # Draw panel headers (tabs)
    header_h = max(3, size // 14)
    draw_rounded_rect(pixels, size, size, panel_margin, panel_y, panel_w, header_h, max(1, size // 24), panel_header)
    draw_rounded_rect(pixels, size, size, right_x, panel_y, panel_w, header_h, max(1, size // 24), panel_header)

    # Draw folder icons inside panels
    if size >= 32:
        folder_size = max(4, size // 8)
        folder_y = panel_y + header_h + max(2, size // 16)

        # Left folder
        fx = panel_margin + max(3, size // 16)
        draw_folder(pixels, size, fx, folder_y, folder_size, folder_color)
        # Right folder
        fx2 = right_x + max(3, size // 16)
        draw_folder(pixels, size, fx2, folder_y, folder_size, folder_color)

    return pixels


def draw_folder(pixels, canvas_size, x, y, size, color):
    """Draw a simple folder icon."""
    # Folder body
    body_h = size * 3 // 4
    draw_rect(pixels, canvas_size, canvas_size, x, y + size // 4, size, body_h, color)
    # Folder tab
    tab_w = size // 2
    tab_h = size // 4
    draw_rect(pixels, canvas_size, canvas_size, x, y, tab_w, tab_h, color)


def create_ico(sizes_and_pngs):
    """Create an ICO file from a list of (size, png_bytes) pairs."""
    count = len(sizes_and_pngs)
    # ICO header: reserved(2) + type(2) + count(2)
    header = struct.pack('<HHH', 0, 1, count)

    # Calculate offsets
    directory_size = 6 + 16 * count
    offset = directory_size

    directory = bytearray()
    images = bytearray()

    for size, png_data in sizes_and_pngs:
        w = size if size < 256 else 0
        h = size if size < 256 else 0
        # Directory entry: width(1) height(1) colors(1) reserved(1) planes(2) bitcount(2) size(4) offset(4)
        entry = struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png_data), offset)
        directory.extend(entry)
        images.extend(png_data)
        offset += len(png_data)

    return bytes(header) + bytes(directory) + bytes(images)


def main():
    icon_dir = os.path.join(os.path.dirname(__file__), "icons")
    os.makedirs(icon_dir, exist_ok=True)

    # Generate different sizes
    sizes = [32, 128, 256]
    pngs = {}

    for s in sizes:
        pixels = generate_icon(s)
        png_data = create_png(s, s, pixels)
        pngs[s] = png_data
        print(f"Generated {s}x{s} PNG ({len(png_data)} bytes)")

    # Save PNGs
    with open(os.path.join(icon_dir, "32x32.png"), "wb") as f:
        f.write(pngs[32])

    with open(os.path.join(icon_dir, "128x128.png"), "wb") as f:
        f.write(pngs[128])

    with open(os.path.join(icon_dir, "128x128@2x.png"), "wb") as f:
        f.write(pngs[256])

    # Create ICO with multiple sizes
    ico_data = create_ico([(32, pngs[32]), (128, pngs[128]), (256, pngs[256])])
    with open(os.path.join(icon_dir, "icon.ico"), "wb") as f:
        f.write(ico_data)
    print(f"Generated icon.ico ({len(ico_data)} bytes)")

    print("All icons generated successfully!")


if __name__ == "__main__":
    main()
