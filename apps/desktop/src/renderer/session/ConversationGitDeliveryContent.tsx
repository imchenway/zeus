import type { DashboardClient, ProjectRecord } from '../apiClient.js';
import type { NativeConversationChoice } from './sessionTypes.js';
import { RepositoryGitDeliveryContent } from '../git/RepositoryGitDeliveryContent.js';

/** 会话交付沿用绑定客户端和真实会话身份，与项目 Git 共享完整交付内容。 */
export function ConversationGitDeliveryContent(props: { client: DashboardClient; project: ProjectRecord; conversation: NativeConversationChoice; language: 'zh-CN' | 'en-US'; onClose: () => void }) {
  return <RepositoryGitDeliveryContent client={props.client} project={props.project} language={props.language} conversation={{ id: props.conversation.id, title: props.conversation.title, client: props.client }} onClose={props.onClose} />;
}
