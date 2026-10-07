/* ============================================================
 * 服务端 ZIP 打包（零依赖）
 * ------------------------------------------------------------
 * 后台浏览器端已有同名实现（admin/src/lib/transfer.ts），但它依赖
 * Blob / document，只在浏览器里跑得动。静态站导出发生在服务端，
 * 所以这里用完全相同的 store（不压缩）算法写一份，只把输出类型
 * 从 Blob 换成 Uint8Array。
 *
 * 不做 deflate：静态站里的 .js/.css 已经是压缩产物，再压几乎没有
 * 收益，换来的却是一整页同步代码与一个压缩库依赖。
 * ============================================================ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export interface ZipEntry {
  name: string;
  text?: string;
  data?: Uint8Array;
}

/** 把一批条目打成 ZIP（store 模式），返回完整字节。 */
export function zipFiles(files: ZipEntry[], now = new Date()): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const dt = dosTime(now);
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data ?? encoder.encode(String(file.text ?? ''));
    const crc = crc32(data);

    const localHead = concat([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      new Uint8Array(u16(20)),
      new Uint8Array(u16(0x0800)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(dt.time)),
      new Uint8Array(u16(dt.date)),
      new Uint8Array(u32(crc)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u16(name.length)),
      new Uint8Array(u16(0)),
      name,
      data
    ]);
    local.push(localHead);

    central.push(
      concat([
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(0x0800)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(dt.time)),
        new Uint8Array(u16(dt.date)),
        new Uint8Array(u32(crc)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u16(name.length)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u32(0)),
        new Uint8Array(u32(offset)),
        name
      ])
    );
    offset += localHead.length;
  }

  const centralData = concat(central);
  const end = concat([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    new Uint8Array(u16(0)),
    new Uint8Array(u16(0)),
    new Uint8Array(u16(files.length)),
    new Uint8Array(u16(files.length)),
    new Uint8Array(u32(centralData.length)),
    new Uint8Array(u32(offset)),
    new Uint8Array(u16(0))
  ]);

  return concat([...local, centralData, end]);
}
