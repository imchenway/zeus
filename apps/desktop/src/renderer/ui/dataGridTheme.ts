import { themeQuartz } from 'ag-grid-community';

/** 数据表共用 Zeus 色板、字体和紧凑表头，业务视图可调整行高和网格线。 */
export const dataGridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--zeus-product-canvas)',
  dataBackgroundColor: 'var(--zeus-product-canvas)',
  oddRowBackgroundColor: 'var(--zeus-product-canvas)',
  foregroundColor: 'var(--zeus-product-text)',
  headerBackgroundColor: 'var(--zeus-card-background)',
  headerTextColor: 'var(--zeus-product-muted)',
  borderColor: 'var(--zeus-card-border)',
  accentColor: 'var(--zeus-accent)',
  rowHoverColor: 'color-mix(in srgb, var(--zeus-product-text) 3%, var(--zeus-product-canvas))',
  fontFamily: 'inherit',
  fontSize: 12,
  headerFontSize: 11,
  rowHeight: 40,
  // 表格键盘焦点由各视图的局部样式提示。
  rangeSelectionBorderColor: 'transparent',
  headerHeight: 32,
  cellHorizontalPadding: 10,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowBorder: false,
  headerRowBorder: false,
  columnBorder: false,
  headerColumnResizeHandleColor: 'var(--zeus-control-accent)',
});
