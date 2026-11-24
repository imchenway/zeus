/** 将本地图片裁去透明边缘，并保存为最长边不超过 64 像素的静态 PNG。 */
export async function readModelConnectionIcon(file: File): Promise<string> {
  if (file.size > 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Unsupported provider icon');
  const image = await createImageBitmap(file);
  try {
    const sample = document.createElement('canvas');
    // 统一采样尺寸，扫描开销不随用户所选图片的尺寸增加。
    const ratio = Math.min(1, 128 / Math.max(image.width, image.height));
    sample.width = Math.max(1, Math.round(image.width * ratio));
    sample.height = Math.max(1, Math.round(image.height * ratio));
    const context = sample.getContext('2d');
    if (!context) throw new Error('Provider icon canvas unavailable');
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const { data } = context.getImageData(0, 0, sample.width, sample.height);
    let left = sample.width;
    let top = sample.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < sample.height; y += 1) {
      for (let x = 0; x < sample.width; x += 1) {
        if (data[(y * sample.width + x) * 4 + 3]! < 16) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < 0) throw new Error('Empty provider icon');
    const width = right - left + 1;
    const height = bottom - top + 1;
    const scale = Math.min(1, 64 / Math.max(width, height));
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(width * scale));
    output.height = Math.max(1, Math.round(height * scale));
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('Provider icon canvas unavailable');
    outputContext.drawImage(sample, left, top, width, height, 0, 0, output.width, output.height);
    return output.toDataURL('image/png');
  } finally {
    image.close();
  }
}
