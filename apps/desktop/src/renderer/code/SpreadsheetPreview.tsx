import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { ClientSideRowModelModule, RenderApiModule, type ColDef } from 'ag-grid-community';
import { filePreviewLimits } from '@zeus/shared';
import { dataGridTheme } from '../ui/dataGridTheme.js';
import { ResourceLoading } from '../ui/ResourceLoading.js';
import { useReadingState } from '../ui/readingState.js';
import { ZeusSelect } from '../ZeusSelect.js';
import type { SpreadsheetPreviewData, SpreadsheetPreviewRequest, SpreadsheetPreviewResponse, SpreadsheetPreviewRow } from './spreadsheetPreview.worker.js';

/** 只读预览仅加载免费的客户端行模型。 */
const spreadsheetModules = [ClientSideRowModelModule, RenderApiModule];
/** 工作表保留网格线，固定行高用于准确显示合并区域。 */
const spreadsheetTheme = dataGridTheme.withParams({ rowHeight: 32, rowBorder: true, columnBorder: true, headerRowBorder: true });
/** 所有列均只读，不对原文件的行顺序增加排序或筛选。 */
const spreadsheetColumnDefaults: ColDef<SpreadsheetPreviewRow> = { sortable: false, filter: false, editable: false };
/** 文件读取及首次解析最多等待 20 秒，随后终止 Worker。 */
const spreadsheetReadTimeoutMs = 20_000;
/** 固定错误原因对应中英文恢复提示。 */
const spreadsheetErrors = {
  limit: ['Excel 文件超过 10 MiB 预览上限，请用系统应用打开。', 'The workbook exceeds the 10 MiB preview limit. Open it in a system app.'],
  empty: ['工作簿没有工作表。', 'This workbook has no worksheets.'],
  encrypted: ['此工作簿已加密，请用系统应用打开并解锁。', 'This workbook is encrypted. Open and unlock it in a system app.'],
  invalid: ['无法解析此工作簿，请用系统应用打开。', 'Could not read this workbook. Open it in a system app.'],
} as const;

/** Excel 复用文件授权与数据表，只展示内容，不执行公式或写回文件。 */
export function SpreadsheetPreview(props: { url: string; name: string; readingKey: string; zh: boolean }) {
  /** 工作表偏好沿用文件阅读作用域，不绑定短期授权令牌。 */
  const [sheetName, setSheetName] = useReadingState(`spreadsheet-sheet:${props.readingKey}`, '');
  /** 最近请求的工作表用于丢弃快速切换时已过期的回复。 */
  const requestedSheet = useRef(sheetName);
  /** 解析实例随文件关闭或刷新一起释放。 */
  const worker = useRef<Worker | null>(null);
  /** 只有有界显示结果进入 React 状态。 */
  const [data, setData] = useState<SpreadsheetPreviewData | null>(null);
  /** 当前单元格的完整正文可通过原生文本控件阅读和复制。 */
  const [cell, setCell] = useState({ row: 0, column: 0 });
  /** 解析失败保留上方既有系统打开按钮。 */
  const [error, setError] = useState('');

  useEffect(() => {
    /** 中止旧文件的读取，不让关闭后的回复更新界面。 */
    const controller = new AbortController();
    /** Worker 构造也可能被平台拒绝，必须显示可恢复错误。 */
    let parser: Worker;
    try {
      parser = new Worker(new URL('./spreadsheetPreview.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setError(spreadsheetErrors.invalid[props.zh ? 0 : 1]);
      return;
    }
    worker.current = parser;
    setData(null);
    setError('');
    /** 计时器可从失败、成功及卸载路径统一取消。 */
    const timeout = window.setTimeout(() => fail(props.zh ? 'Excel 读取超时，请刷新或用系统应用打开。' : 'Workbook preview timed out. Refresh or open it in a system app.'), spreadsheetReadTimeoutMs);

    /** 终止本次解析并显示直接影响阅读的失败原因。 */
    function fail(message: string) {
      if (controller.signal.aborted) return;
      controller.abort();
      window.clearTimeout(timeout);
      parser.terminate();
      worker.current = null;
      setData(null);
      setError(message);
    }

    parser.onmessage = (event: MessageEvent<SpreadsheetPreviewResponse>) => {
      if (controller.signal.aborted) return;
      window.clearTimeout(timeout);
      if ('error' in event.data) {
        fail(spreadsheetErrors[event.data.error][props.zh ? 0 : 1]);
        return;
      }
      /** 同一 Worker 的旧回复不覆盖用户最后选择的工作表。 */
      const next = event.data.data;
      if (next.sheetName !== requestedSheet.current && next.sheetNames.includes(requestedSheet.current)) return;
      requestedSheet.current = next.sheetName;
      setSheetName(next.sheetName);
      setCell({ row: 0, column: 0 });
      setData(next);
    };
    parser.onerror = () => fail(spreadsheetErrors.invalid[props.zh ? 0 : 1]);
    // 主页面读取受授权资源，转移字节避免 Worker 跨协议来源或重复复制。
    void fetch(props.url, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        /** 读取后再次校验大小，解析器不接受超出显示约定的工作簿。 */
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        if (bytes.byteLength > filePreviewLimits.spreadsheet) {
          fail(spreadsheetErrors.limit[props.zh ? 0 : 1]);
          return;
        }
        parser.postMessage({ bytes, sheetName: requestedSheet.current } satisfies SpreadsheetPreviewRequest, [bytes]);
      })
      .catch(() => fail(props.zh ? '文件无法读取，请刷新或用系统应用打开。' : 'Could not load the file. Refresh or open it in a system app.'));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      parser.terminate();
      worker.current = null;
    };
  }, [props.url, props.zh, setSheetName]);

  /** 行号固定在左侧，正文列使用原始 Excel 列名并禁止排序、重排及编辑。 */
  const columns = useMemo<ColDef<SpreadsheetPreviewRow>[]>(
    () =>
      !data
        ? []
        : [
            { colId: 'row', headerName: '', valueGetter: ({ data: row }) => (row?.index ?? 0) + 1, width: 64, pinned: 'left', resizable: false, lockPosition: true, suppressNavigable: true, cellClass: 'spreadsheet-preview-row-number' },
            ...data.columns.map((headerName, column): ColDef<SpreadsheetPreviewRow> => ({
              colId: String(column),
              headerName,
              width: 180,
              resizable: true,
              valueGetter: ({ data: row }) => row?.values[column] ?? '',
              colSpan: ({ data: row }) => row?.spans?.[column]?.columns ?? 1,
              rowSpan: ({ data: row }) => row?.spans?.[column]?.rows ?? 1,
              cellClass: ({ data: row }) => (row?.spans?.[column] ? 'spreadsheet-preview-merged' : undefined),
            })),
          ],
    [data],
  );

  return (
    <div className="spreadsheet-preview">
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <ResourceLoading label={props.zh ? '正在读取 Excel…' : 'Reading workbook…'} />
      ) : (
        <>
          <div className="spreadsheet-preview-toolbar">
            <span>{props.zh ? '工作表' : 'Worksheet'}</span>
            <ZeusSelect
              ariaLabel={props.zh ? '工作表' : 'Worksheet'}
              size="compact"
              searchable={false}
              value={sheetName}
              options={data.sheetNames.map((name) => ({ value: name, label: name }))}
              onChange={(name) => {
                requestedSheet.current = name;
                setSheetName(name);
                worker.current?.postMessage({ sheetName: name } satisfies SpreadsheetPreviewRequest);
              }}
            />
          </div>
          {data.truncated ? (
            <p role="status">
              {props.zh
                ? `仅预览前 ${data.rows.length.toLocaleString()} 行、${data.columns.length} 列；完整内容请用系统应用打开。`
                : `Showing the first ${data.rows.length.toLocaleString()} rows and ${data.columns.length} columns. Open in a system app for the full sheet.`}
            </p>
          ) : null}
          {!data.rows.length ? (
            <p role="status">{props.zh ? '此工作表为空。' : 'This worksheet is empty.'}</p>
          ) : (
            <>
              <label className="spreadsheet-preview-cell">
                <span>
                  {data.columns[cell.column]}
                  {cell.row + 1}
                </span>
                <textarea rows={2} readOnly aria-label={`${data.columns[cell.column]}${cell.row + 1} ${props.zh ? '单元格完整内容' : 'Full cell value'}`} value={data.rows[cell.row]?.values[cell.column] ?? ''} />
              </label>
              <div className="spreadsheet-preview-table">
                <AgGridReact<SpreadsheetPreviewRow>
                  key={data.sheetName}
                  modules={spreadsheetModules}
                  theme={spreadsheetTheme}
                  columnDefs={columns}
                  rowData={data.rows}
                  getRowId={({ data: row }) => String(row.index)}
                  defaultColDef={spreadsheetColumnDefaults}
                  suppressMovableColumns
                  suppressRowTransform
                  enableCellTextSelection
                  ensureDomOrder
                  onGridReady={({ api }) => api.setGridAriaProperty('label', `${props.name} · ${data.sheetName}`)}
                  onCellFocused={({ rowIndex, column }) => {
                    /** 行号列不替换当前正文单元格。 */
                    const index = Number(typeof column === 'string' ? column : column?.getColId());
                    if (rowIndex !== null && Number.isInteger(index)) setCell({ row: rowIndex, column: index });
                  }}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
