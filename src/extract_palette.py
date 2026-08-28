# -*- coding: utf-8 -*-
"""从背景图提取主色板（按占比排序）。

用法: python extract_palette.py <图片路径>
输出: JSON [{hex, ratio}, ...] 按占比降序（最多 8 色）
"""
import sys
import json
from PIL import Image

def main():
    path = sys.argv[1]
    img = Image.open(path).convert('RGB')
    # 缩到小尺寸加速聚类
    img.thumbnail((64, 64))
    # 中位切分量化到 8 色
    q = img.quantize(colors=8, method=Image.MEDIANCUT)
    pal = q.getpalette()[: 8 * 3]
    counts = sorted(q.getcolors(), reverse=True)
    total = sum(c for c, _ in counts) or 1
    out = []
    for count, idx in counts:
        r, g, b = pal[idx * 3: idx * 3 + 3]
        out.append({'hex': '#%02x%02x%02x' % (r, g, b), 'ratio': round(count / total, 3)})
    print(json.dumps(out))

if __name__ == '__main__':
    main()
