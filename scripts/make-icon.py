"""產生圖示：藍綠色六角格（7 格花瓣，像板子＋五色粒子）。
輸出：src/icon.svg、desktop/icon.ico（exe 與視窗圖示）、desktop/icon_64.rgba（視窗小圖，64x64 原始 RGBA）。
並把 favicon 寫進 src/app.template.html 的 <link rel="icon">。用法：python scripts/make-icon.py（需要 Pillow）"""
import base64, math, os, re
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
S = 256
RS, GAP = 40.0, 5.0           # 格子外接圓半徑、格間縫隙
R = RS - GAP
CELLS = [  # (角度或 None, 顏色)：中心＋六格花瓣，由藍到綠繞一圈
    (None, '#7df9e4'),
    (30, '#3b9cff'), (90, '#2bb6f0'), (150, '#1ccfd0'), (210, '#14d6a4'), (270, '#2fd97a'), (330, '#5aa7ff'),
]
BG_TOP, BG_BOT = (14, 52, 66), (5, 20, 28)

def hex_pts(cx, cy, r):
    return [(cx + r * math.cos(math.radians(60 * k)), cy + r * math.sin(math.radians(60 * k))) for k in range(6)]

def centers():
    out = []
    for ang, col in CELLS:
        if ang is None: out.append((S / 2, S / 2, col))
        else:
            d = math.sqrt(3) * RS
            out.append((S / 2 + d * math.cos(math.radians(ang)), S / 2 + d * math.sin(math.radians(ang)), col))
    return out

def hexcol(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def render(size):
    k = 4  # 超取樣
    N = size * k; sc = N / S
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    bg = Image.new('RGBA', (N, N))
    px = bg.load()
    for y in range(N):
        t = y / (N - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
        for x in range(N): px[x, y] = c
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=int(58 * sc), fill=255)
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    for cx, cy, col in centers():
        d.polygon([(x * sc, y * sc) for x, y in hex_pts(cx, cy, R)], fill=hexcol(col) + (255,))
    return img.resize((size, size), Image.LANCZOS)

def svg():
    cells = ''.join('<polygon points="%s" fill="%s"/>' % (' '.join('%.1f,%.1f' % p for p in hex_pts(cx, cy, R)), col) for cx, cy, col in centers())
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#0e3442"/><stop offset="1" stop-color="#05141c"/></linearGradient></defs>'
            '<rect width="256" height="256" rx="58" fill="url(#g)"/>' + cells + '</svg>')

open(os.path.join(ROOT, 'src', 'icon.svg'), 'w', encoding='utf-8').write(svg())
big = render(256)
big.save(os.path.join(ROOT, 'desktop', 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
open(os.path.join(ROOT, 'desktop', 'icon_64.rgba'), 'wb').write(render(64).tobytes())
render(256).save(os.path.join(ROOT, 'desktop', 'icon_preview.png'))

tp = os.path.join(ROOT, 'src', 'app.template.html')
t = open(tp, encoding='utf-8').read()
link = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,' + base64.b64encode(svg().encode()).decode() + '">'
if '<link rel="icon"' in t: t = re.sub(r'<link rel="icon"[^>]*>', lambda m: link, t, count=1)
else: t = t.replace('<title>', link + '\n<meta name="theme-color" content="#081317">\n<title>', 1)
open(tp, 'w', encoding='utf-8').write(t)
print('icon done')
