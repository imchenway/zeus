import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const MACHO_64_LITTLE_ENDIAN_MAGIC = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const MACHO_64_HEADER_SIZE = 32;

/**
 * 计算不受 macOS 重签名影响的 Mach-O 内容摘要。
 * 摘要保留签名区之前的全部代码与链接数据，只归零签名会改写的 __LINKEDIT 大小和签名命令字段。
 */
export function machoSignatureNeutralSha256(binary) {
  if (!Buffer.isBuffer(binary) || binary.length < MACHO_64_HEADER_SIZE || binary.readUInt32LE(0) !== MACHO_64_LITTLE_ENDIAN_MAGIC) {
    throw new Error('Codex runtime 不是受支持的 64 位小端 Mach-O 文件。');
  }

  const commandCount = binary.readUInt32LE(16);
  const commandBytes = binary.readUInt32LE(20);
  const commandEnd = MACHO_64_HEADER_SIZE + commandBytes;
  if (commandEnd > binary.length) {
    throw new Error('Codex runtime 的 Mach-O 加载命令越界。');
  }

  let commandOffset = MACHO_64_HEADER_SIZE;
  let codeSignature;
  let linkEditOffset;
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > commandEnd) {
      throw new Error('Codex runtime 的 Mach-O 加载命令不完整。');
    }
    const command = binary.readUInt32LE(commandOffset);
    const commandSize = binary.readUInt32LE(commandOffset + 4);
    if (commandSize < 8 || commandOffset + commandSize > commandEnd) {
      throw new Error('Codex runtime 的 Mach-O 加载命令大小无效。');
    }

    if (command === LC_SEGMENT_64 && commandSize >= 72) {
      const segmentName = binary
        .subarray(commandOffset + 8, commandOffset + 24)
        .toString('ascii')
        .replace(/\0.*$/u, '');
      if (segmentName === '__LINKEDIT') linkEditOffset = commandOffset;
    }
    if (command === LC_CODE_SIGNATURE && commandSize >= 16) {
      codeSignature = {
        commandOffset,
        dataOffset: binary.readUInt32LE(commandOffset + 8),
      };
    }
    commandOffset += commandSize;
  }

  if (linkEditOffset === undefined || codeSignature === undefined || codeSignature.dataOffset < commandEnd || codeSignature.dataOffset > binary.length) {
    throw new Error('Codex runtime 缺少有效的 Mach-O 签名结构。');
  }

  const normalized = Buffer.from(binary.subarray(0, codeSignature.dataOffset));
  normalized.fill(0, linkEditOffset + 32, linkEditOffset + 40);
  normalized.fill(0, linkEditOffset + 48, linkEditOffset + 56);
  normalized.fill(0, codeSignature.commandOffset + 8, codeSignature.commandOffset + 16);
  return createHash('sha256').update(normalized).digest('hex');
}
