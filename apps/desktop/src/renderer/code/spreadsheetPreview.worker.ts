import { read, set_cptable, utils, type CellObject, type WorkBook } from 'xlsx';
import * as codepage from 'xlsx/dist/cpexcel.full.mjs';
import { filePreviewLimits } from '@zeus/shared';

// 旧版 XLS 的中文等非 Unicode 字符依赖完整编码表。
set_cptable(codepage);

/** 工作簿行保留原始位置，格式化正文只作为文本显示。 */
export interface SpreadsheetPreviewRow {
  /** Excel 原始零基行号。 */
  index: number;
  /** 按原始列顺序保存的显示文本。 */
  values: string[];
  /** 合并区域只在左上角记录行数和列数。 */
  spans?: Record<number, { rows: number; columns: number }>;
}

/** 单个工作表的有界预览，不传输原始工作簿或活动内容。 */
export interface SpreadsheetPreviewData {
  /** 工作簿原始工作表顺序。 */
  sheetNames: string[];
  /** 当前返回的工作表名称。 */
  sheetName: string;
  /** Excel 原始列标识，如 A、AA。 */
  columns: string[];
  /** 保留空行及合并区域的显示数据。 */
  rows: SpreadsheetPreviewRow[];
  /** 原工作表超出显示边界时必须提示。 */
  truncated: boolean;
}

/** 首次请求转移文件字节，切换工作表复用 Worker 内的解析结果。 */
export interface SpreadsheetPreviewRequest {
  /** 已授权文件的字节，仅首次请求提供。 */
  bytes?: ArrayBuffer;
  /** 空值或已不存在的工作表回到第一个工作表。 */
  sheetName: string;
}

/** 解析错误使用固定原因，避免把库堆栈显示给用户。 */
export type SpreadsheetPreviewResponse = { data: SpreadsheetPreviewData } | { error: 'limit' | 'empty' | 'encrypted' | 'invalid' };

/** ponytail: 每表最多 10,000 行、200 列及 200,000 格，超出内容需分段读取。 */
const spreadsheetLimits = { rows: 10_000, columns: 200, cells: 200_000 } as const;
/** 原始工作簿只驻留在可终止的解析 Worker 中。 */
let workbook: WorkBook | undefined;

/** 按 Excel 坐标生成显示文本，不把首行当表头，也不重算公式。 */
function previewSheet(requestedName: string): SpreadsheetPreviewData {
  if (!workbook?.SheetNames.length) throw new Error('empty');
  /** 刷新后已删除的工作表不沿用旧坐标。 */
  const sheetName = workbook.SheetNames.includes(requestedName) ? requestedName : workbook.SheetNames[0];
  /** 当前工作表的原始单元格和范围。 */
  const sheet = workbook.Sheets[sheetName];
  /** 没有使用范围的工作表仍允许切换到其他工作表。 */
  const result: SpreadsheetPreviewData = { sheetNames: workbook.SheetNames, sheetName, columns: [], rows: [], truncated: false };
  if (!sheet?.['!ref'] && !sheet?.['!fullref']) return result;
  /** sheetRows 截断时以完整范围判断是否需要提示。 */
  const range = utils.decode_range(sheet['!fullref'] ?? sheet['!ref']!);
  if (!Number.isSafeInteger(range.e.r) || !Number.isSafeInteger(range.e.c) || range.e.r < 0 || range.e.r > 1_048_575 || range.e.c < 0 || range.e.c > 16_383) throw new Error('invalid');
  /** 列数和总格数共同约束宽表的显示成本。 */
  const columnCount = Math.min(range.e.c + 1, spreadsheetLimits.columns);
  /** 行列均从原始 A1 开始，空白前缀不改变坐标。 */
  const rowCount = Math.min(range.e.r + 1, spreadsheetLimits.rows, Math.floor(spreadsheetLimits.cells / columnCount));
  /** 稠密模式避免按文件声明的超大范围创建稀疏属性。 */
  const cells = sheet['!data'] as CellObject[][] | undefined;
  result.columns = Array.from({ length: columnCount }, (_, column) => utils.encode_col(column));
  result.rows = Array.from({ length: rowCount }, (_, row) => ({
    index: row,
    values: Array.from({ length: columnCount }, (_, column) => {
      /** 格式化文本保留日期、金额和前导零；缺少缓存结果时显示公式。 */
      const cell = cells?.[row]?.[column];
      return !cell ? '' : cell.f && cell.v == null ? `=${cell.f}` : (cell.w ?? utils.format_cell(cell));
    }),
  }));
  result.truncated = rowCount <= range.e.r || columnCount <= range.e.c;
  for (const merge of sheet['!merges'] ?? []) {
    if (merge.s.r < 0 || merge.s.c < 0 || merge.s.r >= rowCount || merge.s.c >= columnCount || merge.e.r < merge.s.r || merge.e.c < merge.s.c) continue;
    /** 合并区域在预览边界处裁剪，不访问未返回的行列。 */
    const row = result.rows[merge.s.r];
    row.spans ??= {};
    row.spans[merge.s.c] = { rows: Math.min(merge.e.r + 1, rowCount) - merge.s.r, columns: Math.min(merge.e.c + 1, columnCount) - merge.s.c };
  }
  return result;
}

/** 文件只解析一次，工作表切换不重新读取磁盘。 */
globalThis.onmessage = (event: MessageEvent<SpreadsheetPreviewRequest>) => {
  try {
    if (event.data.bytes) {
      if (event.data.bytes.byteLength > filePreviewLimits.spreadsheet) throw new Error('limit');
      if (!event.data.bytes.byteLength) throw new Error('empty');
      workbook = read(event.data.bytes, { type: 'array', dense: true, cellHTML: false, cellFormula: true, sheetRows: spreadsheetLimits.rows + 1 });
    }
    globalThis.postMessage({ data: previewSheet(event.data.sheetName) } satisfies SpreadsheetPreviewResponse);
  } catch (cause) {
    /** 加密和格式错误使用不同恢复提示，均保留系统打开入口。 */
    const message = cause instanceof Error ? cause.message : '';
    globalThis.postMessage({ error: message === 'limit' ? 'limit' : message === 'empty' ? 'empty' : /password|encrypt/iu.test(message) ? 'encrypted' : 'invalid' } satisfies SpreadsheetPreviewResponse);
  }
};
