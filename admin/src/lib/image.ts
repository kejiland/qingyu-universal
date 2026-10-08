/* ============================================================
 * 图片压缩 / 缩略图（对齐上游 admin.js 的 compressImageFile）
 * ------------------------------------------------------------
 * 上游上传媒体时会先压缩主图并**额外生成一张 640px 的 webp 缩略图**，
 * 主图与缩略图各 PUT 一次，最后把 thumbPublicUrl 一起登记到媒体库
 * （见 app/public/admin.js 的 uploadImageAsset：
 *   `if (packed.thumb && u.thumbUploadUrl) await put(u.thumbUploadUrl, packed.thumb, 'image/webp')`）。
 *
 * 之前 Vue 后台只登记了 thumbUrl 却从没上传过缩略图内容，
 * 于是 thumb_url 指向一个空对象：上传当次用原图能显示，
 * 刷新后列表改读 thumb_url 就 404 ——「能上传、刷新后预览没了」。
 * ============================================================ */

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

/** 等比缩放到 maxDim 内并转码；webP 不支持时回退 JPEG（与上游一致）。 */
async function resize(
  file: Blob,
  maxDim: number,
  quality: number,
  forceType: string
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const img = await loadImage(file);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  let blob = await canvasBlob(canvas, forceType, quality);
  if (!blob && forceType !== 'image/jpeg') blob = await canvasBlob(canvas, 'image/jpeg', quality);
  return blob ? { blob, width: w, height: h } : null;
}

export interface CompressedImage {
  /** 实际要上传的主图（压缩过则用新文件，否则是原文件） */
  file: File;
  /** 缩略图；gif / svg / ico 或压缩失败时为 null */
  thumb: File | null;
  compressed: boolean;
}

/**
 * 压缩主图 + 生成缩略图。与原逻辑逐条对齐：
 * - gif / svg / ico 不压缩（动图与矢量图压缩会丢信息），也不生成缩略图
 * - 压缩后反而更大时保留原图（避免「越压越大」）
 */
export async function compressImageFile(file: File): Promise<CompressedImage> {
  const type = String(file.type || '').toLowerCase();
  if (!/^image\//.test(type) || /gif|svg|ico/.test(type)) {
    return { file, thumb: null, compressed: false };
  }
  try {
    const main = await resize(file, 2200, 0.82, 'image/webp');
    if (!main?.blob) return { file, thumb: null, compressed: false };
    if (main.blob.size >= file.size && /jpeg|jpg|png|webp/.test(type)) {
      return { file, thumb: null, compressed: false };
    }

    const ext = main.blob.type === 'image/jpeg' ? '.jpg' : '.webp';
    const base = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    const mainFile = new File([main.blob], base + ext, {
      type: main.blob.type,
      lastModified: Date.now()
    });

    const thumb = await resize(file, 640, 0.76, 'image/webp');
    const thumbFile = thumb?.blob
      ? new File([thumb.blob], `${base}-thumb.webp`, { type: thumb.blob.type, lastModified: Date.now() })
      : null;

    return { file: mainFile, thumb: thumbFile, compressed: true };
  } catch {
    return { file, thumb: null, compressed: false };
  }
}
