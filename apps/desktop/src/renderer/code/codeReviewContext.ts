import { createContext } from 'react';

/** 由受信文件预览服务提供完整的前后版本，避免把补丁片段误作完整文件。 */
export const CodeReviewTextContext = createContext<{ original: string; modified: string } | null>(null);
