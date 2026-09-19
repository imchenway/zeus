/** 仓库颜色由稳定身份决定，源码与 Git 面板共用，避免列表重排时变色。 */
export function repositoryColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ['#547fc0', '#a675b6', '#52988c', '#b68b56', '#7771bb'][hash % 5];
}
