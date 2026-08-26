from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


PNG_SIZES = (16, 20, 24, 32, 40, 44, 48, 50, 64, 128, 150, 256, 512, 1024)
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def restore_transparency(image: Image.Image) -> Image.Image:
    rgb = image.convert("RGB")
    red, _, blue = rgb.split()
    warmth = ImageChops.subtract(red, blue)
    mask = warmth.point(lambda value: 255 if value >= 4 else 0)
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))

    flood = mask.copy()
    ImageDraw.floodfill(flood, (0, 0), 255)
    holes = ImageChops.invert(flood)
    mask = ImageChops.lighter(mask, holes).filter(ImageFilter.GaussianBlur(1.25))

    rgba = rgb.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def resized(master: Image.Image, width: int, height: int | None = None) -> Image.Image:
    target_height = height if height is not None else width
    return master.resize((width, target_height), Image.Resampling.LANCZOS)


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic Windows icon assets from the approved master image.")
    parser.add_argument("source", type=Path)
    parser.add_argument("repository", type=Path)
    args = parser.parse_args()

    repository = args.repository.resolve()
    branding = repository / "windows" / "branding"
    png_root = branding / "png"
    packaging = repository / "windows" / "packaging" / "Assets"

    with Image.open(args.source) as source:
        master = restore_transparency(source)

    save_png(master, branding / "CodexScriptLoader-master.png")
    for size in PNG_SIZES:
        save_png(resized(master, size), png_root / f"CodexScriptLoader-{size}.png")

    ico_path = branding / "CodexScriptLoader.ico"
    resized(master, 1024).save(ico_path, format="ICO", sizes=[(size, size) for size in ICO_SIZES], bitmap_format="png")

    save_png(resized(master, 50), packaging / "StoreLogo.png")
    save_png(resized(master, 44), packaging / "Square44x44Logo.png")
    save_png(resized(master, 150), packaging / "Square150x150Logo.png")

    wide = Image.new("RGBA", (310, 150), (0, 0, 0, 0))
    wide_icon = resized(master, 138)
    wide.alpha_composite(wide_icon, ((wide.width - wide_icon.width) // 2, (wide.height - wide_icon.height) // 2))
    save_png(wide, packaging / "Wide310x150Logo.png")

    print(f"ICON_ASSETS_PASS master={master.size[0]}x{master.size[1]} png={len(PNG_SIZES)} ico={len(ICO_SIZES)}")


if __name__ == "__main__":
    main()
