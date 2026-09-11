/** 产品提示使用现有语言设置；英文地区变体采用同一份英文文案。 */
export type UserFacingErrorLanguage = 'zh-CN' | 'en' | 'en-US';

/** 错误原因是可选诊断信息，不改变原有错误码或业务结果。 */
export interface UserFacingErrorCause {
  /** 原始错误身份。 */
  code?: string;
  /** 有界、脱敏的原始说明。 */
  message: string;
  /** 补充诊断原文只出现在展开详情中。 */
  details?: string;
  /** 包装错误保留的底层原因。 */
  cause?: UserFacingErrorCause;
}

/** 仅提供解决方向；调用方仍须检查业务状态和可用处理函数，不能据此自动重发。 */
export interface UserFacingErrorDescription {
  /** 用户能理解的实际原因。 */
  message: string;
  /** 可展开的脱敏原始说明。 */
  details: string;
  /** 上次操作尚无确定结果，场景只能核对，不能据此再次发送。 */
  outcomeUnconfirmed: boolean;
  /** 场景可以使用的现有解决入口。 */
  action: 'sign_in' | 'model_settings' | 'settings' | 'choose_model' | 'retry' | 'check' | null;
}

/** 同一原因的中英文解释；按错误身份匹配，不根据任意消息中的关键词猜测原因。 */
type ErrorExplanation = readonly [zh: string, en: string, action?: UserFacingErrorDescription['action']];

/** 跨页面、原生窗口和通知共用的原因目录。每组只合并具有相同产品含义的错误。 */
const explanations: ReadonlyArray<readonly [codes: readonly string[], explanation: ErrorExplanation]> = [
  [
    ['ZEUS_CONVERSATION_READ_FAILED', 'ZEUS_CONVERSATION_SNAPSHOT_V2_READ_FAILED', 'Snapshot V2 首屏身份、结构代次或事件水位不一致。'],
    ['会话内容暂时无法刷新', 'Conversation content could not be refreshed right now.', 'retry'],
  ],
  [['ZEUS_CONVERSATION_HYDRATION_TIMEOUT'], ['对话读取超过 20 秒仍未完成，可重新加载对话。', 'The conversation took more than 20 seconds to load. Reload the conversation.', 'retry']],
  [['ZEUS_CONVERSATION_REALTIME_OPEN_TIMEOUT'], ['对话内容已载入，但还未连上实时服务，暂时无法接收新回复。', 'The conversation is loaded, but the live service is not connected yet, so new replies cannot be received.', 'retry']],
  [
    ['ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING'],
    ['暂时无法继续对话：Zeus 尚未取得这次发送后的最新状态。请检查对话状态。', 'The conversation cannot continue until Zeus receives the latest state after this send. Check the conversation status.', 'check'],
  ],
  [['ZEUS_NATIVE_SUBMISSION_NOT_DISPATCHED'], ['这条消息尚未发送给 AI，正在等待发送确认。', 'This message has not been sent to the AI and is waiting for confirmation.']],
  // 响应解析失败不能证明发送失败，操作入口必须引导核对结果。
  [['ZEUS_CODEX_RPC_PROTOCOL_ERROR'], ['Codex 的响应无法读取，暂时无法确认发送结果。请先检查会话状态。', 'The Codex response could not be read, so delivery is unconfirmed. Check the conversation status first.', 'check']],
  // 本地校验已知原因按完整文案识别，避免进入通用错误入口后丢失用户可解决的信息。
  [
    ['Zeus 的文件编辑服务尚未连接。', 'Zeus has not connected to the file editing service yet.'],
    ['Zeus 的文件编辑服务尚未连接。', 'Zeus has not connected to the file editing service yet.'],
  ],
  [
    ['原文件标签已经关闭。', 'The source tab is already closed.'],
    ['原文件标签已经关闭。', 'The source tab is already closed.'],
  ],
  [
    ['已达到 20 个打开文件上限，请先关闭一个标签。', 'The 20 open-file limit has been reached. Close a tab first.'],
    ['已达到 20 个打开文件上限，请先关闭一个标签。', 'The 20 open-file limit has been reached. Close a tab first.'],
  ],
  [
    ['请填写记忆标识、内容、来源和复核日期。', 'Enter the memory identifier, content, source, and review date.'],
    ['请填写记忆标识、内容、来源和复核日期。', 'Enter the memory identifier, content, source, and review date.'],
  ],
  [
    ['置信度必须位于 0 到 1。', 'Confidence must be between 0 and 1.'],
    ['置信度必须位于 0 到 1。', 'Confidence must be between 0 and 1.'],
  ],
  [
    ['这条记忆可能指导 AI 修改文件或其他应用，请先勾选确认。', 'This memory may guide the AI to change files or other apps. Select the confirmation before saving.'],
    ['这条记忆可能指导 AI 修改文件或其他应用，请先勾选确认。', 'This memory may guide the AI to change files or other apps. Select the confirmation before saving.'],
  ],
  [
    ['存储恢复服务尚未就绪。', 'Storage recovery is not available yet.'],
    ['存储恢复服务尚未就绪。', 'Storage recovery is not available yet.'],
  ],
  [
    ['项目模型速度偏好保存结果无效。', 'The saved project model speed preference is invalid.'],
    ['项目模型速度偏好保存结果无效。', 'The saved project model speed preference is invalid.'],
  ],
  [
    ['所选模型来源不明确或已经不可用，请重新选择模型后重试。', 'The selected model source is ambiguous or unavailable. Select the model again and retry.'],
    ['所选模型来源不明确或已经不可用，请重新选择模型后重试。', 'The selected model source is ambiguous or unavailable. Select the model again and retry.'],
  ],
  [
    ['工作目录已可用，但对话仍未连接到 AI 服务。', 'The working folder is available, but the conversation has not connected to the AI service.'],
    ['工作目录已可用，但对话仍未连接到 AI 服务。', 'The working folder is available, but the conversation has not connected to the AI service.'],
  ],
  [
    ['看板设置能力不可用。', 'Board settings are unavailable.'],
    ['看板设置能力不可用。', 'Board settings are unavailable.'],
  ],
  [
    ['无法载入看板配置。', 'Unable to load board settings.'],
    ['无法载入看板配置。', 'Unable to load board settings.'],
  ],
  [
    ['看板移动能力不可用。', 'Board move is unavailable.'],
    ['看板移动能力不可用。', 'Board move is unavailable.'],
  ],
  [
    ['已取消移动。', 'Move cancelled.'],
    ['已取消移动。', 'Move cancelled.'],
  ],
  [
    ['当前版本尚不支持启动自定义阶段。', 'Custom stages cannot be started in this version.'],
    ['当前版本尚不支持启动自定义阶段。', 'Custom stages cannot be started in this version.'],
  ],
  [
    ['找不到已验收交付物所属的对话。', 'The conversation associated with the accepted deliverable could not be found.'],
    ['找不到已验收交付物所属的对话。', 'The conversation associated with the accepted deliverable could not be found.'],
  ],
  [
    ['仓库已不在当前项目中。', 'The repository is no longer part of this project.'],
    ['仓库已不在当前项目中。', 'The repository is no longer part of this project.'],
  ],
  [
    ['目标模式暂不支持指定数字员工。请退出目标模式后再选择。', 'Goal mode does not support choosing a digital employee. Exit goal mode before selecting one.'],
    ['目标模式暂不支持指定数字员工。请退出目标模式后再选择。', 'Goal mode does not support choosing a digital employee. Exit goal mode before selecting one.'],
  ],
  [
    ['代码审查会话未被接受，请查看当前错误提示。', 'The code review conversation was not accepted. Check the current error notice.'],
    ['代码审查会话未被接受，请查看当前错误提示。', 'The code review conversation was not accepted. Check the current error notice.'],
  ],
  [
    ['无效的任务优先级。', 'Invalid task priority.'],
    ['无效的任务优先级。', 'Invalid task priority.'],
  ],
  [
    ['当前没有可处理的冲突。', 'No conflict is available.'],
    ['当前没有可处理的冲突。', 'No conflict is available.'],
  ],
  [
    ['当前操作暂时无法进入准备队列。', 'This operation cannot be queued yet.'],
    ['当前操作暂时无法进入准备队列。', 'This operation cannot be queued yet.'],
  ],
  [
    ['任务优先级更新能力不可用。', 'Task priority update is unavailable.'],
    ['任务优先级更新能力不可用。', 'Task priority update is unavailable.'],
  ],
  [['ZEUS_ZENTAO_BAD_REQUEST'], ['请先填写此禅道连接的账号。', 'Enter the account for this ZenTao connection first.']],
  [['ZEUS_ZENTAO_PASSWORD_MISSING'], ['禅道连接尚未保存密码，请填写密码后再验证。', 'The ZenTao connection has no saved password. Enter a password before verifying.']],
  [['ZEUS_ZENTAO_API_UNAVAILABLE'], ['此禅道地址没有提供登录接口，请检查地址或联系管理员启用 REST API。', 'This ZenTao address has no sign-in endpoint. Check the address or ask the administrator to enable the REST API.']],
  [['ZEUS_ZENTAO_HTTP_400'], ['禅道拒绝了登录请求的参数，请检查账号信息与实例配置。', 'ZenTao rejected the sign-in request parameters. Check the account information and instance settings.']],
  [
    ['ZEUS_ZENTAO_HTTP_401', 'ZEUS_ZENTAO_AUTH_FAILED'],
    ['禅道未接受登录信息，请检查账号和密码。', 'ZenTao did not accept the credentials. Check the account and password.'],
  ],
  [['ZEUS_ZENTAO_HTTP_403'], ['禅道不允许当前账号访问，请检查账号权限。', 'ZenTao denied access to this account. Check its permissions.']],
  [['ZEUS_ZENTAO_TOKEN_MISSING'], ['禅道响应中没有登录凭证，无法确认登录成功。请联系实例管理员检查配置。', 'ZenTao returned no sign-in token, so sign-in cannot be confirmed. Ask the instance administrator to check its configuration.']],
  [['ZEUS_ZENTAO_HTTP_FAILED'], ['禅道服务返回了错误，无法完成登录检查。请查看详情中的响应状态。', 'The ZenTao service returned an error and sign-in could not be checked. See the response status in the details.']],
  [['ZEUS_ZENTAO_TIMEOUT'], ['禅道未能及时响应，请检查服务地址和服务状态。', 'ZenTao did not respond in time. Check the service address and status.']],
  [['ZEUS_ZENTAO_CONNECT_FAILED'], ['未能连接禅道，具体原因尚未确定。请查看错误详情。', 'ZenTao could not be reached, and the cause is unknown. See the error details.']],
  [
    ['ZEUS_LONG_TERM_MEMORY_CANDIDATE_REJECTED'],
    ['此内容属于任务事实或一次性结果，不适合作为长期规则保存。请保留在对应任务中。', 'This content describes task facts or a one-time result and cannot be saved as a long-term rule. Keep it with the task.'],
  ],
  [['ZEUS_LONG_TERM_MEMORY_CONFIRMATION_REQUIRED'], ['这条长期规则会影响后续操作，需要你明确确认后才能保存。', 'This long-term rule affects future actions and needs your explicit confirmation before it can be saved.']],
  [['ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT'], ['这条记忆的当前版本与本次修改不一致，请载入最新记忆后再修改。', 'The current version of this memory does not match this edit. Load the latest memory before editing.']],
  [['ZEUS_LONG_TERM_MEMORY_NOT_FOUND'], ['找不到要修改或移除的记忆，请刷新记忆列表。', 'The memory to edit or remove could not be found. Refresh the memory list.']],
  [['ZEUS_TASK_WORK_TASK_TERMINAL'], ['任务已完成或取消，不能创建新工作项。请先重新打开任务。', 'The task is completed or cancelled and cannot accept new work. Reopen it first.']],
  [['ZEUS_DIGITAL_EMPLOYEE_DISABLED'], ['这个数字员工已停用，请启用后再指派工作。', 'This digital employee is disabled. Enable it before assigning work.']],
  [['ZEUS_DIGITAL_EMPLOYEE_AGENT_ENTRYPOINT_REQUIRED'], ['这个数字员工缺少可执行配置。请在员工设置中补齐配置并保存。', 'This digital employee has no executable configuration. Complete and save it in employee settings.']],
  [
    ['ZEUS_TASK_WORK_SKILL_INVALID', 'ZEUS_TASK_WORK_SKILL_UNAVAILABLE'],
    ['所选技能当前不可用，请重新选择技能。', 'The selected skill is unavailable. Select a skill again.'],
  ],
  [
    ['ZEUS_TASK_WORK_ENVIRONMENT_INVALID', 'ZEUS_TASK_WORK_LOCAL_BRANCH_INVALID', 'ZEUS_TASK_WORK_SOURCE_REF_UNAVAILABLE'],
    ['所选任务分支或工作目录不可用。请重新选择可用分支或工作目录。', 'The selected task branch or working folder is unavailable. Select an available branch or folder.'],
  ],
  [['ZEUS_TASK_WORK_ENVIRONMENT_CLOSED'], ['所选任务工作目录已经关闭，请选择其他目录或新建目录。', 'The selected task working folder is closed. Select another folder or create one.']],
  [
    ['ZEUS_TASK_WORK_ENVIRONMENT_BUSY', 'ZEUS_TASK_WORK_LOCAL_BRANCH_CHECKED_OUT', 'ZEUS_TASK_WORK_LOCAL_BRANCH_MANAGED'],
    ['所选分支或目录正在被其他工作使用。请选择其他目录，或先完成现有工作。', 'Other work is using this branch or folder. Select another folder or finish the existing work first.'],
  ],
  [['ZEUS_TASK_WORK_REPOSITORY_REVISION_REQUIRED'], ['未能读取完整项目仓库信息，暂时不能启动。请刷新仓库列表。', 'The project repository information could not be fully read, so work cannot start. Refresh the repository list.']],
  [
    ['ZEUS_TASK_WORK_CONTEXT_DELIVERABLE_INVALID'],
    ['所选交付物尚未验收或不属于这项任务。请选择本任务中已验收的交付物。', 'The selected deliverable is not accepted or belongs to another task. Select an accepted deliverable from this task.'],
  ],
  [['ZEUS_TASK_WORK_MODEL_UNAVAILABLE'], ['项目中没有可用的所选模型。请在项目的“可用模型”中启用模型后重新选择。', 'The selected model is unavailable in this project. Enable it under the project’s Available models, then select it again.']],
  [['ZEUS_TASK_WORK_REASONING_NOT_ALLOWED'], ['当前模型不支持所选推理强度，请选择支持的强度。', 'The model does not support the selected reasoning effort. Select a supported level.']],
  [['ZEUS_TASK_WORK_SERVICE_TIER_NOT_ALLOWED'], ['当前模型不支持所选服务速率，请选择支持的选项。', 'The model does not support the selected service tier. Select a supported option.']],
  [['ZEUS_TASK_WORK_COMMAND_PARAMETER_REQUIRED'], ['有必填命令参数尚未填写。请补齐表单中的必填项；详情中列出了对应参数。', 'Required command parameters are missing. Complete the required form fields; the details identify the parameters.']],
  [
    ['ZEUS_TASK_WORK_COMMAND_PARAMETER_INVALID', 'ZEUS_TASK_WORK_COMMAND_PARAMETER_UNKNOWN'],
    ['命令参数的类型不正确或包含未定义项。请按命令表单重新填写，并查看详情中的参数名称。', 'A command parameter has the wrong type or is not defined. Enter values using the command form and check the parameter names in the details.'],
  ],
  [
    [
      'ZEUS_GIT_COMMAND_OUTCOME_UNKNOWN',
      'ZEUS_TASK_WORK_OUTCOME_UNKNOWN',
      'ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN',
      'ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN',
      'ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN',
      'ZEUS_EXECUTION_HOST_STOP_OUTCOME_UNKNOWN',
    ],
    ['上次操作的结果尚未确认，Zeus 已暂停继续执行，避免重复操作。请检查实际处理状态。', 'The previous action’s result is unconfirmed. Zeus paused further execution to avoid duplicate actions. Check the actual processing state.'],
  ],
  [
    ['ZEUS_PROJECT_CONVERSATION_START_PERSIST_FAILED', 'ZEUS_NATIVE_CONVERSATION_START_PERSIST_FAILED', 'ZEUS_CONVERSATION_COMMAND_PERSIST_FAILED', 'ZEUS_CONVERSATION_COMMAND_STORAGE_UNAVAILABLE'],
    ['Zeus 无法记录这次操作，已停止继续执行。请查看本机存储错误详情。', 'Zeus could not record this action and stopped further execution. See the local storage error details.'],
  ],
  [['ZEUS_PROJECT_SOURCE_SYMLINK_READ_ONLY'], ['这是指向其他位置的链接文件，只能查看。请打开原文件后修改。', 'This file links to another location and can only be viewed here. Open the original file to edit it.']],
  [['ZEUS_PROJECT_SOURCE_CONFLICT'], ['文件已被其他应用修改，本次保存已停止。请重新加载最新内容，或另存为其他文件。', 'Another app changed the file, so this save was stopped. Reload the latest content or save to another file.']],
  [['ZEUS_PROJECT_SOURCE_TOO_LARGE'], ['文件超过 2 MiB，无法在内置编辑器中保存。请使用外部编辑器。', 'The file exceeds 2 MiB and cannot be saved in the built-in editor. Use an external editor.']],
  [['ZEUS_PROJECT_SOURCE_MOVE_DESCENDANT'], ['文件夹不能移动到自身内部，请选择其他位置。', 'A folder cannot be moved inside itself. Choose another location.']],
  [
    ['ZEUS_PROJECT_SOURCE_ROOT_INVALID', 'ZEUS_PROJECT_WORKSPACE_PATH_INVALID'],
    ['项目目录不存在或无法访问。请检查目录位置和访问权限。', 'The project folder does not exist or cannot be accessed. Check its location and permissions.'],
  ],
  [
    ['ZEUS_PROJECT_SOURCE_PATH_FORBIDDEN', 'ZEUS_PROJECT_WORKSPACE_PATH_OUTSIDE_CONTAINER'],
    ['所选路径位于项目目录之外。请在项目目录内选择文件或文件夹。', 'The selected path is outside the project folder. Select a file or folder within the project.'],
  ],
  [['ZEUS_PROJECT_SOURCE_NOT_FILE'], ['所选对象不是普通文件，请重新选择文件。', 'The selected item is not a regular file. Select a file again.']],
  [['ZEUS_PROJECT_SOURCE_NOT_DIRECTORY'], ['所选对象不是文件夹，请重新选择文件夹。', 'The selected item is not a folder. Select a folder again.']],
  [['ZEUS_PROJECT_SOURCE_NAME_INVALID'], ['文件或文件夹名称无效，请检查名称中是否有不允许的字符。', 'The file or folder name is invalid. Check it for unsupported characters.']],
  [['ZEUS_PROJECT_SOURCE_TARGET_EXISTS'], ['目标位置已有同名文件或文件夹。请修改名称或选择其他位置。', 'A file or folder with this name already exists at the destination. Change the name or choose another location.']],
  [['ZEUS_PROJECT_SHARED_PATH_TOO_BROAD'], ['不能将整个项目设为共享写入目录。请只选择需要共享的子目录。', 'The whole project cannot be shared for writing. Select only the subfolders that need to be shared.']],
  [
    ['ZEUS_PROJECT_WORKSPACE_PATH_DUPLICATE', 'ZEUS_PROJECT_WORKSPACE_PATH_OVERLAP'],
    ['共享目录重复或互相包含，请移除重复项或重叠的目录。', 'Shared folders are duplicated or contain one another. Remove duplicate or overlapping entries.'],
  ],
  [['ZEUS_GIT_COMMIT_REQUIRED'], ['请先选择要查看的提交。', 'Select a commit to view.']],
  // 中止后的写入不会自动撤销，具体暂存位置等恢复信息保留在详情中。
  [
    ['ZEUS_GIT_CANCELLED'],
    [
      'Git 操作已中止。请查看详情中的恢复信息，并核对仓库和远端状态；已完成的改动不会自动撤销。',
      'The Git operation was cancelled. Check the recovery details and verify the repository and remote state; completed changes are not automatically undone.',
    ],
  ],
  [
    ['ZEUS_GIT_REF_REQUIRED', 'ZEUS_GIT_BRANCH_REQUIRED'],
    ['请先选择分支。', 'Select a branch first.'],
  ],
  [['ZEUS_GIT_REPOSITORY_REQUIRED'], ['请先选择项目中的代码仓库。', 'Select a repository in this project first.']],
  [
    ['ZEUS_GIT_REPOSITORY_NOT_FOUND', 'ZEUS_PROJECT_REPOSITORY_NOT_FOUND'],
    ['所选代码仓库已不在当前项目中。请刷新仓库列表后重新选择。', 'The selected repository is no longer in this project. Refresh the repository list and select again.'],
  ],
  [['ZEUS_PROJECT_REPOSITORY_UNAVAILABLE'], ['项目代码仓库无法访问，或已不在允许的项目目录内。请检查仓库位置。', 'The project repository cannot be accessed or is outside the permitted project folder. Check its location.']],
  [['ZEUS_TASK_BRANCH_PREFIX_REQUIRED'], ['任务分支名称必须以 zeus/ 开头，请修改分支名称。', 'Task branch names must start with zeus/. Update the branch name.']],
  [
    ['ZEUS_TASK_BRANCH_INVALID', 'ZEUS_GIT_BRANCH_INVALID'],
    ['分支名称不符合 Git 的命名要求，请检查名称。', 'The branch name does not meet Git’s naming requirements. Check the name.'],
  ],
  [
    ['ZEUS_TASK_BRANCH_ALREADY_EXISTS', 'ZEUS_TASK_BRANCH_ALREADY_MANAGED', 'ZEUS_TASK_LOCAL_BRANCH_CHECKED_OUT'],
    ['此分支已在其他独立工作目录中使用。请选择已有工作目录或其他分支。', 'This branch is already used by another separate working folder. Select the existing folder or another branch.'],
  ],
  [
    ['ZEUS_TASK_BRANCH_NOT_FOUND', 'ZEUS_GIT_BRANCH_NOT_FOUND', 'ZEUS_GIT_REF_NOT_FOUND'],
    ['找不到所选分支或提交。请刷新列表并选择仍然存在的条目。', 'The selected branch or commit could not be found. Refresh the list and select an available entry.'],
  ],
  [['ZEUS_TASK_LOCAL_CHANGE_CONFLICT'], ['本地未跟踪文件与所选分支中的文件冲突。请先备份并移开这些文件。', 'Local untracked files conflict with files in the selected branch. Back them up and move them before continuing.']],
  [
    ['ZEUS_TASK_WORKSPACE_DETACHED', 'ZEUS_GIT_NAMED_BRANCH_REQUIRED'],
    ['当前代码没有位于命名分支上。请先创建或切换到本地分支。', 'The current code is not on a named branch. Create or switch to a local branch first.'],
  ],
  [
    ['ZEUS_TASK_WORKSPACE_DIRTY'],
    ['工作目录还有未提交修改，暂时不能继续。请先提交修改；不需要的修改可以在确认后放弃。', 'The working folder has uncommitted changes. Commit them before continuing, or discard unwanted changes after reviewing them.'],
  ],
  [
    ['ZEUS_GIT_CHECKOUT_BLOCKED'],
    [
      '当前工作区的本地修改会被目标内容覆盖，无法切换分支。本次切换未执行；请先提交、贮藏，或检查后放弃/移开相关文件。',
      'Local changes in the working tree would be overwritten by the target, so the branch was not switched. Commit, stash, or review and discard/move the affected files first.',
    ],
  ],
  [
    ['ZEUS_GIT_CHECKOUT_CONFLICTED'],
    ['当前仓库存在未解决的冲突，无法切换分支。本次切换未执行；请先处理并确认所有冲突文件。', 'The repository has unresolved conflicts, so the branch was not switched. Resolve and confirm all conflicted files first.'],
  ],
  [
    ['ZEUS_GIT_CHECKOUT_BRANCH_IN_USE'],
    [
      '目标分支已在其他工作区中使用，无法在这里切换。本次切换未执行；请先在另一工作区切换到其他分支。',
      'The target branch is already in use by another worktree, so it was not checked out here. Switch that worktree to another branch first.',
    ],
  ],
  [
    ['ZEUS_GIT_SWITCH_FAILED'],
    ['切换分支未完成，当前工作区可能未改变。请刷新仓库状态并查看错误详情后再继续。', 'The branch switch did not complete; the working tree may be unchanged. Refresh the repository status and check the error details before continuing.'],
  ],
  [
    ['ZEUS_TASK_GIT_REMOTE_UNAVAILABLE', 'ZEUS_GIT_REMOTE_REQUIRED'],
    ['代码仓库尚未配置远端地址，无法执行远端操作。请先配置 Git 远端。', 'The repository has no remote configured. Configure a Git remote before performing remote operations.'],
  ],
  [
    ['ZEUS_TASK_WORKSPACE_CONFLICTED', 'ZEUS_GIT_CONFLICT_IN_PROGRESS'],
    ['代码仍有冲突，请先处理并确认所有冲突文件。', 'The code still has conflicts. Resolve and confirm all conflicting files first.'],
  ],
  [
    ['ZEUS_TASK_GIT_PATH_INVALID'],
    ['共享目录和嵌套仓库中的文件不能随上层仓库提交。请到所属仓库中提交。', 'Files in shared folders or nested repositories cannot be committed with the parent repository. Commit them in their own repository.'],
  ],
  [['ZEUS_TASK_MERGE_COMMIT_INCOMPLETE'], ['合并提交必须包含本次合并的全部修改，请选择所有相关文件。', 'A merge commit must include all changes from the merge. Select all relevant files.']],
  [['ZEUS_TASK_COMMIT_SELECTION_CHANGED'], ['所选文件状态已变化，本次未提交。请刷新代码交付页后重新选择文件。', 'The selected files have changed. Nothing was committed. Refresh code delivery and select the files again.', 'check']],
  [['ZEUS_TASK_REMOTE_DIVERGED'], ['远端分支包含本地尚未取得的提交，推送已停止。请先拉取并处理分支差异。', 'The remote branch has commits missing locally, so the push stopped. Pull and reconcile the branches first.']],
  [
    ['ZEUS_TASK_REMOTE_VERIFICATION_FAILED'],
    ['推送后远端分支与预期内容不一致，暂时不能确认推送成功。请检查远端分支。', 'The remote branch does not match the expected content after pushing. The push cannot be confirmed as successful. Check the remote branch.'],
  ],
  [['ZEUS_TASK_WORKTREE_NOT_REGISTERED'], ['Git 中找不到这个任务的独立工作目录记录，请检查任务分支和目录状态。', 'Git has no record of this task’s separate working folder. Check the task branch and folder state.']],
  [
    ['ZEUS_TASK_WORKTREE_PATH_OCCUPIED'],
    [
      '任务工作目录已有其他内容，暂时无法恢复。原文件已保留，请先备份并移开占用内容，再继续对话。',
      'The task folder contains other content and cannot be restored. Existing files were preserved. Back up and move the conflicting content before continuing.',
      'check',
    ],
  ],
  [
    ['ZEUS_TASK_DISCARD_CONFIRMATION_INVALID'],
    ['输入的分支名与要放弃的分支不一致，操作未执行。请输入完整分支名确认。', 'The entered branch name does not match the branch to discard. Nothing was discarded. Enter the complete branch name to confirm.'],
  ],
  [['ZEUS_TASK_CONFLICT_BRANCH_MISMATCH'], ['冲突处理目录已切换到其他分支。请恢复对应分支后再继续。', 'The conflict-resolution folder has switched to another branch. Restore the expected branch before continuing.']],
  [
    ['ZEUS_TASK_CONFLICT_NOT_FOUND', 'ZEUS_TASK_INTEGRATION_NOT_CONFLICTED'],
    ['所选冲突已不需要处理。请刷新冲突列表查看最新状态。', 'The selected conflict no longer needs resolution. Refresh the conflict list for its current state.'],
  ],
  [
    ['ZEUS_TASK_CONFLICT_BINARY_UNSUPPORTED'],
    ['这个冲突涉及图片等二进制文件，无法用文本编辑器处理。请使用外部工具。', 'This conflict involves a binary file, such as an image, and cannot be resolved in the text editor. Use an external tool.'],
  ],
  [['ZEUS_TASK_CONFLICT_TOO_LARGE'], ['冲突文件超过内置编辑器的大小限制，请使用外部编辑器处理。', 'The conflicting file exceeds the built-in editor’s size limit. Resolve it in an external editor.']],
  [
    ['ZEUS_TASK_PRECOMMIT_FORMAT_UNAVAILABLE'],
    ['项目要求提交前格式化代码，但尚未安装所需的 Prettier。请先安装项目依赖。', 'This project requires code formatting before commit, but Prettier is not installed. Install the project dependencies first.'],
  ],
  [
    ['ZEUS_TASK_PRECOMMIT_FORMAT_FAILED'],
    ['提交前的代码格式化失败，因此没有继续提交。请查看详情并修正格式化错误。', 'Code formatting failed before the commit, so the commit did not continue. Check the details and fix the formatting error.'],
  ],
  [['ZEUS_GIT_UPSTREAM_REQUIRED'], ['当前分支尚未关联远端分支。请先设置它要跟踪的远端分支。', 'This branch is not linked to a remote branch. Set its upstream branch first.']],
  [
    ['ZEUS_GIT_CONFIRMATION_EXPIRED', 'ZEUS_GIT_CONFIRMATION_NOT_FOUND', 'ZEUS_GIT_CONFIRMATION_ALREADY_RESOLVED', 'ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED'],
    ['这次 Git 操作的确认已失效或已使用。请重新打开操作预览，核对内容后确认。', 'The confirmation for this Git action expired or was already used. Reopen the action preview and review it before confirming.'],
  ],
  [['ZEUS_GIT_CONFIRMATION_NOT_CONFIRMED'], ['这次 Git 操作需要你先查看并确认影响，请打开操作预览。', 'This Git action needs your review and confirmation. Open its preview first.']],
  [['ZEUS_GIT_CONFIRMATION_REJECTED'], ['你已拒绝这次 Git 操作，它不会继续执行。', 'You declined this Git action. It will not continue.']],
  [
    ['ZEUS_GIT_OPERATION_MISMATCH', 'ZEUS_GIT_CONFIRMATION_COMMAND_CONFLICT'],
    ['Git 操作内容与已确认的内容不一致，已停止执行。请重新查看操作预览。', 'The Git action differs from what you confirmed, so it was stopped. Review the action preview again.'],
  ],
  [['ZEUS_TASK_REOPEN_REQUIRED'], ['这项任务已完成或取消。请先重新打开任务，再恢复其中一段已归档对话。', 'This task is completed or cancelled. Reopen it and restore one of its archived conversations first.']],
  [
    ['ZEUS_TASK_ENVIRONMENT_CHOICE_REQUIRED', 'ZEUS_TASK_PUSH_WORKSPACE_MODE_REQUIRED'],
    ['请先选择本次任务使用的工作目录。', 'Choose the working folder for this task first.'],
  ],
  [
    ['ZEUS_TASK_ENVIRONMENT_INVALID', 'ZEUS_TASK_EXECUTION_CONTEXT_INVALID', 'ZEUS_TASK_LOCAL_BRANCH_INVALID'],
    ['所选工作目录、分支或来源会话不属于这项任务，请重新选择。', 'The selected working folder, branch, or source conversation does not belong to this task. Select again.'],
  ],
  [
    ['ZEUS_TASK_ENVIRONMENT_CLOSED', 'ZEUS_TASK_WORKSPACE_CLOSED'],
    ['这个任务工作目录已关闭或移除，请选择可用目录或新建独立工作目录。', 'This task working folder was closed or removed. Select an available folder or create a separate working folder.'],
  ],
  [
    ['ZEUS_TASK_REPOSITORY_SNAPSHOT_CHANGED', 'ZEUS_TASK_PUSH_CONTEXT_CHANGED', 'ZEUS_TASK_HEAD_CHANGED', 'ZEUS_TARGET_HEAD_CHANGED', 'ZEUS_TASK_INTEGRATION_ATTEMPT_STALE'],
    ['任务或代码分支已发生变化，当前预览已过期。请重新打开预览，确认最新内容后继续。', 'The task or code branch has changed, so this preview is out of date. Reopen it and review the current content before continuing.'],
  ],
  [
    ['ZEUS_TASK_REPOSITORY_SELECTION_INCOMPLETE', 'ZEUS_TASK_REPOSITORY_SELECTION_INVALID', 'ZEUS_TASK_SOURCE_BRANCH_INVALID'],
    ['请为每个代码仓库选择一个可用的来源分支，且不要重复选择仓库。', 'Choose one available source branch for each repository and avoid duplicate repositories.'],
  ],
  [
    ['ZEUS_TASK_ENVIRONMENT_BUSY', 'ZEUS_TASK_WORK_DIRECT_WORKSPACE_BUSY'],
    ['已有 AI 会话正在修改这个目录。请等待或停止该会话，或选择其他工作目录。', 'An AI conversation is already modifying this folder. Wait for it to finish, stop it, or choose another working folder.'],
  ],
  [
    ['ZEUS_TASK_WORKSPACE_NESTED_BUSY'],
    ['嵌套仓库仍有独立工作目录，请先完成并移除这些子目录，再处理上层目录。', 'Nested repositories still have separate working folders. Finish and remove those folders before handling the parent folder.'],
  ],
  [
    ['ZEUS_TASK_WORKTREE_UNAVAILABLE', 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE'],
    ['任务所需的独立工作目录不可用。请检查目录是否存在及访问权限。', 'The task’s separate working folder is unavailable. Check that it exists and that access is allowed.'],
  ],
  [['ZEUS_TASK_RUNTIME_CLEANUP_BUSY'], ['正在停止此任务的运行程序，暂时不能更改任务状态。请等待停止完成。', 'Programs running for this task are being stopped. Wait for them to stop before changing the task status.']],
  [['ZEUS_TASK_INTEGRATION_NOT_MERGED'], ['任务分支还没有合入来源分支，请先完成合入再推送。', 'The task branch has not been merged into its source branch. Merge it before pushing.']],
  [['ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE'], ['部分附件无法读取，因此没有创建对话。请检查或移除这些附件。', 'Some attachments cannot be read, so the conversation was not created. Check or remove those attachments.']],
  [['ZEUS_TASK_WORK_DELIVERABLE_CORRUPT'], ['交付物内容未通过完整性检查，暂时不能使用。请查看详情并重新生成交付物。', 'The deliverable failed its integrity check and cannot be used. See the details and generate it again.']],
  [['ZEUS_TASK_STAGE_INPUT_UNAVAILABLE'], ['无法完整读取上一阶段的交付物，因此当前阶段没有启动。请先检查该交付物。', 'The previous stage’s deliverable could not be fully read, so this stage did not start. Check that deliverable first.']],
  [['ZEUS_TASK_WORK_CONVERSATION_REQUEST_SUPERSEDED'], ['这个待办已移到原任务对话中，请前往该对话处理。', 'This request has moved to the original task conversation. Handle it there.']],
  [['ZEUS_TASK_WORK_DECISION_KIND_INVALID'], ['这个待办需要验收交付物，请使用接受或要求修改的操作。', 'This request requires deliverable review. Use the accept or request-changes action.']],
  [['ZEUS_TASK_WORK_DELIVERABLE_EMPTY'], ['AI 已结束处理，但没有生成可提交的交付物。请查看会话内容后决定下一步。', 'The AI finished without producing a deliverable. Review the conversation before deciding what to do next.']],
  [
    [
      'ZEUS_TASK_WORK_REVISION_CONFLICT',
      'ZEUS_TASK_WORK_PREVIEW_STALE',
      'ZEUS_TASK_WORK_CONTEXT_CHANGED',
      'ZEUS_TASK_WORK_COMMAND_CONFIRMATION_STALE',
      'ZEUS_TASK_WORK_OUTCOME_DECISION_STALE',
      'ZEUS_TASK_WORK_COMMAND_FAILURE_STALE',
      'ZEUS_TASK_STAGE_REVISION_CONFLICT',
      'ZEUS_TASK_STAGE_DELIVERABLE_CONFLICT',
    ],
    ['这项工作已在其他位置更新，本次操作没有使用旧内容继续执行。请载入最新状态后重新确认。', 'This work was updated elsewhere. The action did not continue with the old content. Load the latest state and review it again.'],
  ],
  [['ZEUS_TASK_WORK_NOT_RETRYABLE'], ['这项工作当前不允许重新运行。请先查看它的最新状态并处理阻止继续的原因。', 'This work cannot be run again in its current state. Check its latest state and resolve the reason it is blocked.']],
  [['ZEUS_TASK_WORK_COMMAND_CHANGED'], ['要执行的命令已被修改。请取消当前工作项，重新指派并确认新命令。', 'The command has changed. Cancel this work item, assign it again, and confirm the updated command.']],
  [
    ['ZEUS_TASK_WORK_OUTCOME_ACTION_INVALID'],
    ['请先检查实际执行结果，再选择“确认成功”或“确认失败”。确认不会重新执行命令。', 'Check the actual result, then choose Confirm success or Confirm failure. Confirming does not run the command again.'],
  ],
  [
    ['ZEUS_TASK_WORK_SKILL_SNAPSHOT_MISSING', 'ZEUS_TASK_WORK_PLUGIN_SKILL_SNAPSHOT_INVALID'],
    ['这次运行缺少可用的技能记录，无法按原配置继续。请重新选择技能并创建新的运行。', 'This run has no usable skill record and cannot continue with its original settings. Select skills again and create a new run.'],
  ],
  [
    ['ZEUS_TASK_WORK_SKILL_UNSAFE', 'ZEUS_TASK_WORK_SKILL_SNAPSHOT_PATH_INVALID'],
    ['技能包含指向不允许位置的文件，Zeus 已阻止读取。请检查技能文件。', 'The skill contains files pointing to a disallowed location. Zeus blocked access. Check the skill files.'],
  ],
  [['ZEUS_TASK_WORK_SKILL_TOO_LARGE'], ['技能文件超过本次运行允许的大小，请减少不需要的文件。', 'The skill files exceed the size allowed for this run. Remove files that are not needed.']],
  [
    ['ZEUS_TASK_WORK_SKILL_CATALOG_UNAVAILABLE', 'ZEUS_TASK_WORK_PLUGIN_SKILL_CATALOG_UNAVAILABLE'],
    ['当前无法读取技能列表，请在技能或插件设置中检查是否可用。', 'The skill list cannot be read. Check availability in skill or plugin settings.'],
  ],
  [
    ['ZEUS_TASK_WORK_PLUGIN_SKILL_SNAPSHOT_STALE'],
    ['所选插件技能已更新。请检查新版本并重新指派工作，当前运行不会自动切换版本。', 'The selected plugin skill was updated. Review the new version and assign the work again. The current run will not switch versions automatically.'],
  ],
  [
    ['ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT'],
    ['保存的技能文件已损坏或变化，无法按原配置继续。请检查技能并创建新的运行。', 'The saved skill files are damaged or changed. The run cannot continue with its original settings. Check the skill and create a new run.'],
  ],
  [
    ['ZEUS_TASK_STAGE_NOT_READY', 'ZEUS_TASK_STAGE_ACTIVE_ATTEMPT_EXISTS'],
    ['这个阶段已经开始，不能修改它使用的配置。请结束当前处理后创建新的尝试。', 'This stage has started and its settings cannot be changed. End the current work before creating a new attempt.'],
  ],
  [
    ['ZEUS_TASK_STAGE_DOWNSTREAM_STARTED'],
    ['后续阶段已经开始，不能直接修改上一阶段的验收结果。请先取消后续阶段或要求返工。', 'A later stage has started, so the earlier review result cannot be changed directly. Cancel or request rework of the later stage first.'],
  ],
  [['ZEUS_TASK_STAGE_NOT_CONFIGURED'], ['当前阶段尚未选择可用模型，请先配置模型。', 'No available model is selected for this stage. Configure its model first.']],
  [
    ['ZEUS_TASK_BOARD_DERIVED_GROUP_READ_ONLY'],
    ['这列由任务的执行结果决定，不能通过拖动改变。请使用任务中对应的运行或分支操作。', 'This column is determined by task execution and cannot be changed by dragging. Use the task’s run or branch actions.'],
  ],
  [['ZEUS_TASK_TITLE_REQUIRED'], ['任务标题不能为空，请填写标题。', 'The task title cannot be empty. Enter a title.']],
  [['ZEUS_AUTOMATION_CONFIG_INTERVAL_INVALID'], ['运行间隔不能小于一分钟，请调整间隔。', 'The interval must be at least one minute. Adjust the interval.']],
  [
    ['ZEUS_AUTOMATION_CONFIG_RRULE_REQUIRED', 'ZEUS_AUTOMATION_CONFIG_RRULE_UNSUPPORTED'],
    ['高级调度需要有效的重复规则，目前支持每分钟、每小时、每日和每周。', 'Advanced scheduling needs a valid recurrence rule. Minutely, hourly, daily, and weekly schedules are supported.'],
  ],
  [['ZEUS_AUTOMATION_CONFIG_LOCAL_TIME_INVALID'], ['请按“小时:分钟”填写时间，例如 09:30。', 'Enter the time as hours:minutes, for example 09:30.']],
  [['ZEUS_AUTOMATION_CONFIG_TIMEZONE_INVALID'], ['时区名称无效，请选择有效时区，例如 Asia/Shanghai。', 'The time zone is invalid. Select a valid time zone, such as Asia/Shanghai.']],
  [['ZEUS_AUTOMATION_CONFIG_ORIGINAL_CONVERSATION_REQUIRED'], ['请先选择自动化要继续使用的对话。', 'Select the conversation that this automation should continue.']],
  [['ZEUS_AUTOMATION_CONFIG_ORIGINAL_CONVERSATION_UNAVAILABLE'], ['原对话不存在或不属于所选项目。请重新选择对话。', 'The original conversation no longer exists or belongs to another project. Select a conversation again.']],
  [
    ['ZEUS_AUTOMATION_DISPATCH_ORIGINAL_CONVERSATION_ARCHIVED'],
    ['原对话已归档，自动化无法继续。请先恢复对话或选择其他对话。', 'The original conversation is archived, so the automation cannot continue. Restore it or select another conversation.'],
  ],
  [['ZEUS_AUTOMATION_CONFIG_PROJECT_REQUIRED'], ['请至少选择一个运行项目。', 'Select at least one project to run in.']],
  [['ZEUS_AUTOMATION_CONFIG_REVISION_CONFLICT'], ['自动化配置已在其他位置更新。请载入最新配置后再修改。', 'This automation was updated elsewhere. Load its latest settings before editing.']],
  [
    ['ZEUS_AUTOMATION_PERMISSION_GRANT_REQUIRED', 'ZEUS_AUTOMATION_PERMISSION_GRANT_STALE'],
    ['当前自动化配置尚未获得完全访问授权。请查看权限范围并授权，或降低所需权限。', 'This automation’s current settings do not have full-access authorization. Review and grant access, or reduce the required permissions.'],
  ],
  [['ZEUS_AUTOMATION_TRIGGER_INACTIVE'], ['这个自动化已暂停，请先启用后再运行。', 'This automation is paused. Enable it before running it.']],
  [['ZEUS_AUTOMATION_BUDGET_RUNS_EXHAUSTED'], ['已达到自动化每日运行次数上限。请等待下一天，或调整次数上限。', 'The automation reached its daily run limit. Wait until the next day or adjust the limit.']],
  [['ZEUS_AUTOMATION_DISPATCH_INTERACTION_REQUIRED'], ['自动化需要你的回答或授权，已暂停等待。请在对应对话中处理。', 'The automation needs your answer or approval and is paused. Handle the request in its conversation.']],
  [['ZEUS_AUTOMATION_QUEUE_DISCARDED'], ['已有工作阻止本次运行，已按你设置的策略跳过这次触发。', 'Existing work prevented this run. This trigger was skipped according to your configured policy.']],
  [['ZEUS_AUTOMATION_QUEUE_EVICTED'], ['等待运行的任务已满，已按设置移除最早的一项。', 'The waiting queue is full. The oldest waiting run was removed according to your settings.']],
  [['ZEUS_AUTOMATION_TRIGGER_CAUSAL_CYCLE'], ['这次自动化会重复触发同一项目中的自身，Zeus 已停止它以避免无限循环。', 'This automation would trigger itself again in the same project. Zeus stopped it to prevent an endless loop.']],
  [['ZEUS_AUTOMATION_DISPATCH_NOT_QUEUED'], ['这次运行已离开等待队列，请查看最新运行状态。', 'This run is no longer waiting in the queue. Check its current state.']],
  [['ZEUS_PLUGIN_ALREADY_INSTALLED'], ['此来源的插件已经安装，请使用插件的“更新”操作。', 'The plugin from this source is already installed. Use its Update action.']],
  [['ZEUS_PLUGIN_PROVIDER_LEGACY_CONFLICT'], ['AI 服务中已安装同名插件。请先处理重复安装，再启用 Zeus 中的插件。', 'The AI service already has a plugin with this name. Resolve the duplicate installation before enabling the Zeus plugin.']],
  [['ZEUS_PLUGIN_CONNECTOR_AUTH_REQUIRED'], ['插件需要的应用尚未连接。请在插件设置中完成应用授权。', 'An app required by this plugin is not connected. Authorize the app in plugin settings.']],
  [['ZEUS_PLUGIN_CONNECTOR_SECRET_INVALID'], ['应用访问密钥无效，请在插件连接设置中检查密钥。', 'The app access token is invalid. Check it in the plugin’s connection settings.']],
  [['ZEUS_PLUGIN_SOURCE_SELECTION_REQUIRED'], ['同名插件来自多个来源，请在选择器中明确选择要使用的那一个。', 'Plugins with this name come from multiple sources. Select the specific installation you want to use.']],
  [['ZEUS_PLUGIN_SOURCE_IS_MARKETPLACE'], ['这个地址提供的是插件市场。请先添加市场，再选择要安装的插件。', 'This address is a plugin marketplace. Add the marketplace first, then select a plugin to install.']],
  [
    ['ZEUS_PLUGIN_MANIFEST_MISSING', 'ZEUS_PLUGIN_MANIFEST_INVALID'],
    ['插件缺少有效的安装说明文件，无法安装。请使用完整插件包或联系插件作者。', 'The plugin lacks a valid manifest and cannot be installed. Use the complete plugin package or contact its author.'],
  ],
  [['ZEUS_PLUGIN_MARKETPLACE_INVALID'], ['这个来源没有有效的插件市场信息。请检查市场地址或目录。', 'This source has no valid marketplace information. Check the marketplace address or folder.']],
  [
    ['ZEUS_PLUGIN_MARKETPLACE_NAME_MISMATCH'],
    ['市场中的插件名称与下载内容不一致，安装已停止。请联系市场维护者检查。', 'The marketplace plugin name does not match the downloaded content. Installation stopped. Ask the marketplace maintainer to check it.'],
  ],
  [
    ['ZEUS_PLUGIN_UNSAFE_PATH', 'ZEUS_PLUGIN_UNSAFE_SOURCE'],
    ['插件中的路径指向允许范围之外，或包含不受支持的链接文件，Zeus 已阻止访问。请检查插件来源。', 'Plugin paths point outside the allowed location or include unsupported symbolic links. Zeus blocked access. Check the plugin source.'],
  ],
  [
    ['ZEUS_PLUGIN_TOO_LARGE', 'ZEUS_PLUGIN_RECORD_TOO_LARGE'],
    ['插件内容超过 Zeus 支持的大小或文件数量限制。请减少不需要的文件，或联系插件作者。', 'The plugin exceeds Zeus’s size or file-count limits. Remove unnecessary files or contact the plugin author.'],
  ],
  [
    ['ZEUS_PLUGIN_COMPONENT_UNSUPPORTED'],
    ['这个插件包含 Zeus 暂不支持的功能，无法按当前格式安装。请使用兼容的插件包。', 'This plugin contains features Zeus does not support and cannot be installed in its current format. Use a compatible package.'],
  ],
  [
    ['ZEUS_PLUGIN_REVISION_CONFLICT', 'ZEUS_PLUGIN_SOURCE_CHANGED'],
    ['插件或来源在操作期间发生变化。请刷新并确认最新内容后继续。', 'The plugin or its source changed during the action. Refresh and review the latest content before continuing.'],
  ],
  [['ZEUS_PLUGIN_SOURCE_CONFLICT'], ['此插件来源已用于另一份安装。请在已安装列表中查找并管理已有插件。', 'This plugin source is already used by another installation. Manage it from the installed plugin list.']],
  [['ZEUS_PLUGIN_MARKETPLACE_ENTRY_UNAVAILABLE'], ['插件市场的规则不允许安装这个插件。请查看市场规则或选择其他插件。', 'Marketplace policy does not allow this plugin to be installed. Review the policy or choose another plugin.']],
  [
    ['ZEUS_PLUGIN_MCP_CONFIGURATION_INVALID', 'ZEUS_PLUGIN_CONFIGURATION_INVALID'],
    ['插件连接配置无效。请按插件提供的说明检查命令、服务地址和访问参数。', 'The plugin connection configuration is invalid. Check the command, service address, and access parameters against the plugin’s instructions.'],
  ],
  [['ZEUS_PLUGIN_MCP_APP_APPROVAL_REQUIRED'], ['这个应用操作需要授权。请在插件设置中检查该工具的权限。', 'This app action requires approval. Review the tool’s permissions in plugin settings.']],
  [
    ['ZEUS_PLUGIN_MCP_TOOL_DENIED', 'ZEUS_PLUGIN_HOOK_TOOL_DENIED', 'ZEUS_PLUGIN_HOOK_PERMISSION_DENIED'],
    ['插件的权限规则拒绝了这个操作。请查看插件权限及错误详情。', 'The plugin’s permission rules denied this action. Check the plugin permissions and error details.'],
  ],
  [['ZEUS_PLUGIN_MCP_TOOL_DECLINED'], ['你已拒绝这次插件操作，它不会继续执行。', 'You declined this plugin action. It will not continue.']],
  [
    ['ZEUS_PLUGIN_HOOK_PROMPT_BLOCKED', 'ZEUS_PLUGIN_HOOK_COMPACTION_BLOCKED'],
    ['插件的检查规则阻止了这次请求。请查看插件提供的原因。', 'The plugin’s checks blocked this request. Review the reason provided by the plugin.'],
  ],
  [
    ['ZEUS_PLUGIN_TOOL_APPROVAL_CHANNEL_UNAVAILABLE'],
    ['插件的授权连接已断开，当前操作不能继续。请重新连接后处理最新授权请求。', 'The plugin’s approval connection was lost, so the action cannot continue. Reconnect and handle the latest approval request.'],
  ],
  [
    ['ZEUS_PLUGIN_MCP_TOOL_CHANGED'],
    ['插件工具在本次对话期间已更新。请开始新对话使用新版本，当前对话不会自动切换。', 'The plugin tool changed during this conversation. Start a new conversation to use the new version. This conversation will not switch automatically.'],
  ],
  [
    ['ZEUS_PLUGIN_ACTIVATION_CORRUPT', 'ZEUS_PLUGIN_STORED_COMPONENTS_INVALID', 'ZEUS_PLUGIN_STORED_JSON_INVALID'],
    ['Zeus 无法读取保存的插件配置。请查看错误详情并检查插件安装。', 'Zeus cannot read the saved plugin configuration. See the error details and check the plugin installation.'],
  ],
  [
    ['ZEUS_SKILL_NOT_FOUND', 'ZEUS_SKILL_INPUT_INVALID', 'ZEUS_PLUGIN_REFERENCE_NOT_FOUND', 'ZEUS_TASK_WORK_PLUGIN_SKILL_UNAVAILABLE'],
    ['所选技能或插件在当前项目中不可用，请重新选择可用项。', 'The selected skill or plugin is unavailable in this project. Select an available item.'],
  ],
  [['ZEUS_SKILL_REFERENCE_DUPLICATE'], ['同一条消息不能重复选择同一个技能，请移除重复项。', 'The same skill cannot be selected twice for one message. Remove the duplicate.']],
  [['ZEUS_SKILL_REFERENCES_INVALID'], ['一条消息最多选择 8 个技能，请检查技能选择。', 'Select up to 8 skills for one message. Check your selection.']],
  [['ZEUS_ZENTAO_BASE_URL_INVALID'], ['禅道地址必须是完整的 http:// 或 https:// 地址，且不能包含账号或查询参数。', 'Enter a complete http:// or https:// ZenTao address without credentials or query parameters.']],
  [
    ['ZEUS_ZENTAO_DUPLICATE_HOST', 'ZEUS_ZENTAO_INSTANCE_ALREADY_EXISTS'],
    ['这个禅道地址已经配置，请编辑已有连接。', 'This ZenTao address is already configured. Edit its existing connection.'],
  ],
  [['ZEUS_ZENTAO_INSTANCE_NOT_FOUND'], ['找不到这个禅道连接，请刷新连接列表。', 'This ZenTao connection could not be found. Refresh the connection list.']],
  [['ZEUS_BROWSER_SECURE_FIELD_BLOCKED'], ['密码等敏感信息需要由你在浏览器登录窗口中填写。', 'Enter sensitive information, such as passwords, yourself in the browser sign-in window.']],
  [['ZEUS_BROWSER_EXTENSION_TIMEOUT'], ['浏览器扩展未能及时响应。请检查目标浏览器和 Zeus 扩展是否已打开。', 'The browser extension did not respond in time. Check that the target browser and Zeus extension are open.']],
  [['ZEUS_MODEL_HTTP_401'], ['模型服务拒绝了访问密钥（API Key）。请在模型供应商设置中检查密钥。', 'The model service rejected the API key. Check it in model provider settings.', 'model_settings']],
  [['ZEUS_MODEL_HTTP_403'], ['模型服务不允许访问模型目录。请检查账号权限和服务设置。', 'The model service denied access to its catalog. Check account permissions and service settings.', 'model_settings']],
  [
    ['ZEUS_MODEL_HTTP_404'],
    ['模型服务找不到目录接口。请检查服务地址和模型目录路径，或手动添加模型。', 'The model service could not find the catalog endpoint. Check the service address and catalog path, or add models manually.', 'model_settings'],
  ],
  [['ZEUS_MODEL_HTTP_429'], ['模型服务暂时限制了目录请求。请稍后再读取模型列表。', 'The model service temporarily limited catalog requests. Load the model list later.', 'retry']],
  [
    ['ZEUS_MODEL_HTTP_500', 'ZEUS_MODEL_HTTP_502', 'ZEUS_MODEL_HTTP_503', 'ZEUS_MODEL_HTTP_504'],
    ['模型服务处理目录请求时发生错误，暂时无法读取模型列表。', 'The model service encountered an error handling the catalog request. The model list cannot be loaded yet.', 'retry'],
  ],
  [['ZEUS_IM_TASK_EDIT_FIELD_INVALID'], ['只能修改任务标题或描述。用法：/task edit <任务> title|description <内容>', 'Only the task title or description can be edited. Usage: /task edit <task> title|description <content>']],
  [
    ['服务地址必须是完整 URL。', '服务地址只支持 HTTP 或 HTTPS。'],
    ['服务地址需要以 https:// 或 http:// 开头，请填写完整地址。', 'Enter a complete service address starting with https:// or http://.', 'model_settings'],
  ],
  [
    ['服务地址不能包含账号、密码、查询参数或片段。'],
    ['服务地址不能包含账号、密码或问号、井号后的参数。请将密钥填写在 API Key 输入框中。', 'The service address cannot contain credentials, query parameters, or a fragment. Enter the key in the API key field.', 'model_settings'],
  ],
  [['模型目录路径必须是站内绝对路径。'], ['模型目录路径必须以 / 开头，且不能包含 ..、? 或 #，例如 /models。', 'The model catalog path must start with / and cannot contain .., ?, or #; for example, /models.', 'model_settings']],
  [['模型列表必须是数组且不能超过 200 项。'], ['一次最多配置 200 个模型，请检查导入的模型列表格式和数量。', 'Configure up to 200 models at a time. Check the imported model list’s format and size.', 'model_settings']],
  [['模型配置必须是对象。'], ['模型配置格式无法读取，请在模型供应商设置中重新填写。', 'The model configuration format cannot be read. Enter it again in model provider settings.', 'model_settings']],
  [
    ['未找到 Homebrew。请先安装 Homebrew，再重试 Zeus 更新。'],
    [
      '自动更新需要 Homebrew（macOS 软件安装工具），但本机没有找到它。请安装 Homebrew 后再检查更新。',
      'Automatic updates require Homebrew, a macOS package manager, but it was not found on this Mac. Install Homebrew before checking for updates.',
    ],
  ],
  [
    ['Homebrew 下载完成，但缓存安装包未通过发布清单校验。', '已预取的更新包已变化或不完整，请重新下载。'],
    ['下载的更新包不完整或与发布信息不符，Zeus 已停止安装。请重新下载更新。', 'The downloaded update is incomplete or does not match the release information. Zeus stopped installation. Download the update again.', 'retry'],
  ],
  [['当前没有可预取的 Zeus 更新。'], ['目前没有可下载的 Zeus 更新。', 'No Zeus update is currently available to download.']],
  [['更新状态与当前 Zeus App 版本不一致。'], ['更新信息与当前 Zeus 版本不一致。请重新检查更新。', 'The update information does not match this Zeus version. Check for updates again.', 'retry']],
  [
    ['更新安装包与当前 Mac 架构不一致。'],
    ['此更新包不支持当前 Mac 的处理器，Zeus 已停止安装。请检查是否选择了适合这台 Mac 的版本。', 'This update does not support this Mac’s processor. Zeus stopped installation. Check that you selected the version for this Mac.'],
  ],
  [
    ['当前 Zeus 没有目标 Homebrew Cask 管理收据，不能自动接管安装。', 'Homebrew Cask 管理的 Zeus App 不是当前正在使用的日常正式应用。', 'Homebrew 安装后的 Zeus App 位置与当前日常正式应用不一致。'],
    [
      'Homebrew 管理的安装与当前使用的 Zeus 不一致，无法自动更新这份应用。请检查 Zeus 的安装来源和位置。',
      'The installation managed by Homebrew does not match this Zeus app. It cannot be updated automatically. Check the app’s installation source and location.',
    ],
  ],
  [
    ['Homebrew Cask 与 Zeus 发布清单不一致，为避免安装错误版本已停止升级。', 'Zeus 只允许使用 imchenway/tap 中的正式 Cask 升级。'],
    [
      'Homebrew 的更新信息与 Zeus 官方发布不一致，安装已停止。请检查安装来源并等待发布信息更新。',
      'Homebrew’s update information does not match the official Zeus release. Installation stopped. Check the installation source and wait for the release information to update.',
    ],
  ],
  [
    ['Homebrew 返回的 Zeus Cask 信息不是有效 JSON。', 'Homebrew 没有返回唯一的 Zeus Cask。', 'Homebrew Zeus Cask 缺少必要版本或产物信息。'],
    ['Homebrew 返回的 Zeus 安装信息不完整或无法读取，暂时不能更新。', 'Homebrew returned incomplete or unreadable Zeus installation information. The app cannot be updated yet.'],
  ],
  [
    ['Homebrew 安装后的 Zeus App 不存在。', 'Homebrew 安装后没有返回 Zeus App 的精确位置。', 'Homebrew 没有返回有效的 Zeus 缓存路径。'],
    ['Homebrew 未能找到需要的 Zeus 应用或安装包，无法继续更新。请查看安装详情。', 'Homebrew could not locate the required Zeus app or installer and cannot continue the update. See the installation details.'],
  ],
  [
    ['ZEUS_UPDATE_INSTALLED_IDENTITY_MISMATCH'],
    ['安装后的应用名称或版本与目标更新不符，Zeus 已停止自动启动。请查看安装详情。', 'The installed app’s identity or version does not match the update. Zeus stopped automatic relaunch. See the installation details.'],
  ],
  [['ZEUS_UPDATE_DOWNLOAD_INTERRUPTED'], ['更新下载中断，当前版本仍可使用。可以重新下载。', 'The update download was interrupted. You can keep using the current version and download again.', 'retry']],
  [
    ['ZEUS_RELEASE_MANIFEST_NETWORK'],
    [
      '无法连接 GitHub 更新服务，请检查网络或代理设置后重新检查更新。当前版本仍可使用。',
      'Could not connect to the GitHub update service. Check your network or proxy settings and try again. You can keep using the current version.',
      'retry',
    ],
  ],
  [['ZEUS_RELEASE_MANIFEST_TIMEOUT'], ['读取 GitHub 更新清单超时，请稍后重新检查更新。当前版本仍可使用。', 'Reading the GitHub update manifest timed out. Try again later. You can keep using the current version.', 'retry']],
  [['ZEUS_RELEASE_MANIFEST_HTTP_TRANSIENT'], ['GitHub 更新服务暂时不可用或请求受限，请稍后重新检查更新。', 'The GitHub update service is temporarily unavailable or rate limited. Try again later.', 'retry']],
  [
    ['ZEUS_RELEASE_MANIFEST_HTTP_REJECTED'],
    ['GitHub 更新清单无法访问，请查看错误详情中的响应状态。当前版本仍可使用。', 'The GitHub update manifest is not accessible. See the response status in the error details. You can keep using the current version.'],
  ],
  [['ZEUS_RELEASE_MANIFEST_INVALID'], ['收到的更新清单不完整或格式不正确，已停止本次更新。请稍后重新检查更新。', 'The update manifest is incomplete or invalid, so this update was stopped. Check for updates again later.']],
  [
    ['unauthorized', 'invalid_api_key', 'authentication_error'],
    ['AI 服务拒绝了登录信息。请在设置中检查登录状态或访问密钥（API Key）。', 'The AI service rejected the credentials. Check your sign-in or API key in Settings.', 'model_settings'],
  ],
  [
    ['permission_denied', 'permission_error'],
    ['AI 服务不允许此账号执行该请求。请检查账号或模型的使用权限。', 'The AI service does not allow this account to perform the request. Check account or model access.', 'settings'],
  ],
  [
    ['usageLimitExceeded', 'insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached'],
    ['AI 服务的账户用量或余额已达限制，暂时无法继续。请检查该服务的用量与账单。', 'The AI service account has reached its usage or credit limit. Check the service’s usage and billing.', 'settings'],
  ],
  [
    ['rate_limit_exceeded', 'rate_limit_error', 'tooManyRequests'],
    ['AI 服务收到的请求过多，暂时限制了使用。请等待限制解除后再继续。', 'The AI service is receiving too many requests and has temporarily limited access. Wait until the limit clears before continuing.'],
  ],
  [
    ['contextWindowExceeded', 'context_length_exceeded'],
    ['对话内容超过了模型可处理的长度，无法继续这次请求。请缩短输入或选择容量更大的模型。', 'The conversation exceeds the model’s length limit. Shorten the input or choose a model with a larger context window.', 'choose_model'],
  ],
  [
    ['httpConnectionFailed', 'responseStreamConnectionFailed'],
    ['与 AI 服务的连接未能建立，无法读取回复。请检查该服务的连接设置。', 'A connection to the AI service could not be established. Check the service’s connection settings.', 'settings'],
  ],
  [['responseStreamDisconnected'], ['AI 服务在回复结束前断开了连接，因此没有收到完整回复。', 'The AI service disconnected before finishing its response, so the reply is incomplete.']],
  [
    ['model_not_found'],
    ['AI 服务找不到所选模型，或当前账号无权使用它。请检查模型名称和账号权限。', 'The AI service cannot find the selected model, or this account cannot access it. Check the model name and account access.', 'choose_model'],
  ],
  [
    ['content_filter', 'safety_violation'],
    ['AI 服务拒绝了这次请求的内容。请调整请求后再继续。', 'The AI service declined the content of this request. Revise it before continuing.'],
  ],
  [['ZEUS_UNIFIED_QUEUE_HEAD_FAILED'], ['这条消息的处理已暂停，Zeus 尚未确定具体原因。请查看错误详情。', 'Processing of this message is paused, and Zeus has not identified the cause. See the error details.']],
  [['ZEUS_COMPUTER_SECURE_FIELD_BLOCKED'], ['密码、验证码等敏感字段需要由你在目标应用中填写。', 'Enter passwords, verification codes, and other sensitive fields yourself in the target app.']],
  [['ZEUS_COMPUTER_DISABLED'], ['尚未启用电脑操作。请在“设置 → 浏览器”中启用并授予系统权限。', 'Computer actions are disabled. Enable them and grant system permissions under Settings → Browser.', 'settings']],
  [
    ['ZEUS_MODEL_CONNECTION_INSECURE_HTTP_CONFIRMATION_REQUIRED'],
    [
      '此服务使用未加密的 HTTP，会暴露密钥和对话内容。请在连接设置中确认风险后再保存。',
      'This service uses unencrypted HTTP, which can expose credentials and conversations. Review and confirm the risk in connection settings before saving.',
      'model_settings',
    ],
  ],
  [['ZEUS_TASK_NOT_FOUND'], ['找不到这项任务。请返回任务列表确认它是否仍然存在。', 'This task could not be found. Check whether it is still available in the task list.']],
  [['ZEUS_TASK_ARCHIVED'], ['这项任务已归档，请先恢复任务再继续。', 'This task is archived. Restore it before continuing.']],
  [['ZEUS_NATIVE_QUEUE_RECOVERY_REQUIRED'], ['消息处理已暂停。请在对话中检查上次处理状态后继续。', 'Message processing is paused. Check the previous request’s status in the conversation before continuing.', 'check']],
  [
    ['ZEUS_MODEL_API_KEY_INVALID', 'ZEUS_MODEL_API_KEY_REQUIRED'],
    ['未填写服务访问密钥（API Key）。请在模型供应商设置中填写。', 'The service API key is missing. Enter it in the model provider settings.', 'model_settings'],
  ],
  [
    ['ZEUS_MODEL_CATALOG_RESPONSE_INVALID'],
    ['模型服务返回的目录格式无法读取。请检查“模型目录路径”是否符合服务要求，或手动添加模型。', 'The model catalog response cannot be read. Check the model catalog path required by the service, or add models manually.', 'model_settings'],
  ],
  [
    ['ZEUS_MODEL_CATALOG_TIMEOUT', 'ZEUS_MODEL_CATALOG_CONNECT_TIMEOUT'],
    ['模型服务未能及时响应。请检查服务地址和服务的运行状态。', 'The model service did not respond in time. Check the service address and whether it is running.', 'model_settings'],
  ],
  [['ZEUS_MODEL_CONNECTION_ALREADY_EXISTS'], ['此模型连接已存在，请编辑已有连接。', 'This model connection already exists. Edit the existing connection.', 'model_settings']],
  [
    ['ZEUS_MODEL_CONNECTION_IN_USE'],
    ['仍有项目在使用此模型连接。请先在这些项目的“可用模型”中移除相关模型，再删除连接。', 'Projects are still using this connection. Remove its models from Available models in those projects before deleting it.', 'model_settings'],
  ],
  [['ZEUS_PROJECT_MODEL_SELECTION_INVALID'], ['选择中包含已不可用的模型。请重新选择当前可用模型。', 'Your selection contains unavailable models. Select models that are currently available.', 'choose_model']],
  [['ZEUS_MODEL_CATALOG_HTTPS_PROTOCOL_MISMATCH'], ['服务地址使用 HTTPS，但该端口不支持 HTTPS。请检查服务地址和端口。', 'The service address uses HTTPS, but that port does not support HTTPS. Check the address and port.', 'model_settings']],
  [
    ['ZEUS_MODEL_CATALOG_CERTIFICATE_UNTRUSTED'],
    [
      '此模型服务的 HTTPS 证书不受本机信任，连接已停止。请联系服务管理员修复证书。',
      'This Mac does not trust the model service’s HTTPS certificate, so the connection was stopped. Ask the service administrator to fix the certificate.',
      'model_settings',
    ],
  ],
  [
    ['ZEUS_MODEL_CATALOG_CERTIFICATE_HOST_MISMATCH'],
    [
      '模型服务的证书与连接地址不匹配。请使用证书对应的地址，或联系服务管理员修复证书。',
      'The service certificate does not match its address. Use the address covered by the certificate or ask the administrator to fix it.',
      'model_settings',
    ],
  ],
  [
    ['ZEUS_MODEL_CATALOG_CERTIFICATE_EXPIRED'],
    ['模型服务的 HTTPS 证书已过期，需要服务管理员更新证书后才能连接。', 'The model service’s HTTPS certificate has expired. The administrator must renew it before you can connect.', 'model_settings'],
  ],
  [['ZEUS_MODEL_CATALOG_HOST_NOT_FOUND'], ['无法找到模型服务的地址。请检查地址是否正确，以及网络是否可用。', 'The model service address could not be resolved. Check the address and network connection.', 'model_settings']],
  [
    ['ZEUS_MODEL_CATALOG_CONNECTION_REFUSED'],
    ['模型服务拒绝连接。请检查服务是否已启动，以及连接地址和端口是否正确。', 'The model service refused the connection. Check that it is running and that the address and port are correct.', 'model_settings'],
  ],
  [['ZEUS_MODEL_CATALOG_CONNECTION_RESET'], ['模型服务在请求过程中断开了连接，未能读取完整模型列表。', 'The model service disconnected during the request, so the full model list could not be loaded.', 'retry']],
  [
    ['ZEUS_MODEL_CATALOG_TLS_FAILED'],
    ['无法与模型服务建立加密连接。请联系服务管理员检查 HTTPS 配置。', 'An encrypted connection to the model service could not be established. Ask its administrator to check the HTTPS configuration.', 'model_settings'],
  ],
  [['ZEUS_MODEL_CATALOG_NETWORK_FAILED'], ['未能连接模型目录，具体原因尚未确定。请查看错误详情。', 'The model catalog could not be reached, and the cause is not yet known. See the error details.']],
  [
    ['ZEUS_IM_AGENT_PRESET_UNAVAILABLE'],
    ['机器人使用的智能体配置不可用。请在 Zeus 桌面端的机器人设置中重新选择配置。', 'The bot’s agent settings are unavailable. Select an available configuration in the Zeus desktop app’s bot settings.', 'settings'],
  ],
  [['ZEUS_IM_ANSWER_REQUIRED'], ['请至少选择一个答案后再提交。', 'Select at least one answer before submitting.']],
  [
    ['ZEUS_IM_APPROVAL_FAIL_CLOSED', 'ZEUS_IM_APPROVAL_NOT_ADVERTISED'],
    ['Telegram 暂不支持允许这种操作。请在 Zeus 桌面端查看并处理请求。', 'Telegram cannot approve this type of action. Review and handle the request in the Zeus desktop app.'],
  ],
  [
    ['ZEUS_IM_ATTACHMENT_INTEGRITY_FAILED', 'ZEUS_IM_LONG_REPLY_INTEGRITY_FAILED'],
    ['附件内容或文件信息未通过检查，Zeus 已停止发送。请在桌面端查看原文件。', 'The attachment failed content or file validation, so Zeus stopped sending it. Check the original file in the desktop app.'],
  ],
  [['ZEUS_IM_ATTACHMENT_PATH_INVALID'], ['附件位于不允许访问的目录中，Zeus 已阻止读取。请在桌面端重新选择附件。', 'The attachment is outside the permitted folders, so Zeus blocked access. Select the attachment again in the desktop app.']],
  [
    ['ZEUS_IM_ATTACHMENT_ROOT_UNAVAILABLE', 'ZEUS_IM_CONVERSATION_ATTACHMENT_ROOT_UNAVAILABLE'],
    ['Zeus 无法访问附件保存目录。请在桌面端检查目录和文件权限。', 'Zeus cannot access the attachment storage folder. Check the folder and file permissions in the desktop app.'],
  ],
  [['ZEUS_IM_ATTACHMENT_TOO_LARGE'], ['单个附件不能超过 20 MiB，请选择更小的文件。', 'Each attachment must be no larger than 20 MiB. Choose a smaller file.']],
  [['ZEUS_IM_ATTACHMENT_TOTAL_EXCEEDED'], ['一次发送的附件总大小不能超过 100 MiB，请分批发送。', 'Attachments in one message must total no more than 100 MiB. Send them in smaller batches.']],
  [
    ['ZEUS_IM_CALLBACK_EXPIRED'],
    ['这个按钮已过期、已使用或不属于当前用户。请重新打开任务或对话，使用最新按钮。', 'This button has expired, was already used, or belongs to another user. Reopen the task or conversation and use its latest buttons.'],
  ],
  [
    ['ZEUS_IM_CALLBACK_INVALID', 'ZEUS_IM_CALLBACK_UNSUPPORTED'],
    ['此按钮无法用于当前操作。请重新打开任务或对话，使用最新按钮。', 'This button cannot be used for the current action. Reopen the task or conversation and use its latest buttons.'],
  ],
  [['ZEUS_IM_COMMAND_INPUT_REQUIRED'], ['请在 /steer 后填写要补充给 AI 的内容。', 'Enter the additional instructions for the AI after /steer.']],
  [['ZEUS_IM_COMMAND_UNSUPPORTED'], ['无法识别此命令。发送 /help 查看可用命令。', 'This command is not recognized. Send /help to see available commands.']],
  [['ZEUS_IM_CONNECTION_EXISTS'], ['已经连接了一个 Telegram 机器人。请先移除现有连接，再添加新的机器人。', 'A Telegram bot is already connected. Remove the existing connection before adding another.', 'settings']],
  [
    ['ZEUS_IM_CONNECTION_NOT_FOUND', 'ZEUS_IM_CONNECTION_RECONFIGURE_REQUIRED'],
    ['Telegram 连接不可用。请在 Zeus 桌面端重新配置机器人连接。', 'The Telegram connection is unavailable. Configure the bot connection again in the Zeus desktop app.', 'settings'],
  ],
  [['ZEUS_IM_CONNECTION_REVISION_CONFLICT'], ['机器人设置已被更新。请刷新后再修改。', 'The bot settings have changed. Refresh before editing them.']],
  [['ZEUS_IM_CONVERSATION_NOT_SELECTED'], ['尚未选择对话。发送消息开始新对话，或发送 /conversations 选择已有对话。', 'No conversation is selected. Send a message to start one, or send /conversations to select an existing conversation.']],
  [['ZEUS_IM_CONVERSATION_UNAVAILABLE'], ['所选对话已不可用。请发送 /conversations 选择其他对话，或发送 /new 开始新对话。', 'The selected conversation is unavailable. Send /conversations to choose another or /new to start a new one.']],
  [
    ['ZEUS_IM_EMPTY_MESSAGE', 'ZEUS_IM_INTERACTION_TEXT_REQUIRED'],
    ['消息中没有可处理的内容，请填写文字或添加支持的附件。', 'The message has no content to process. Enter text or add a supported attachment.'],
  ],
  [
    ['ZEUS_IM_ENDPOINT_INVALID', 'ZEUS_IM_TRUSTED_ENDPOINT_MISSING', 'ZEUS_IM_UNTRUSTED_ENDPOINT'],
    ['当前 Telegram 用户尚未与此机器人配对。请在 Zeus 桌面端完成配对。', 'This Telegram user is not paired with the bot. Complete pairing in the Zeus desktop app.'],
  ],
  [
    ['ZEUS_IM_SENDER_UNAVAILABLE', 'ZEUS_IM_FILE_SENDER_UNAVAILABLE', 'ZEUS_IM_MESSAGE_EDITOR_UNAVAILABLE'],
    ['Zeus 的 Telegram 发送服务暂不可用。请在桌面端检查机器人连接。', 'The Zeus Telegram sending service is unavailable. Check the bot connection in the desktop app.'],
  ],
  [
    ['ZEUS_IM_PAIRING_INVALID', 'ZEUS_IM_PAIRING_PLAINTEXT_UNAVAILABLE'],
    ['配对码已失效。请在 Zeus 桌面端重新生成，并在 10 分钟内完成配对。', 'The pairing code is no longer valid. Generate a new code in the Zeus desktop app and pair within 10 minutes.'],
  ],
  [
    ['ZEUS_IM_PLAN_STALE', 'ZEUS_IM_REQUEST_STALE'],
    ['这个请求已变化、已处理或无法通过 Telegram 回答。请在 Zeus 桌面端查看最新请求。', 'This request has changed, was already handled, or cannot be answered through Telegram. Check the latest request in the Zeus desktop app.'],
  ],
  [['ZEUS_IM_REQUEST_INVALID'], ['Telegram 无法显示这个问题，请在 Zeus 桌面端回答。', 'Telegram cannot display this question. Answer it in the Zeus desktop app.']],
  [['ZEUS_IM_PRIVATE_CHAT_REQUIRED'], ['请使用已配对账号与机器人进行一对一私聊，群聊不受支持。', 'Use a one-to-one private chat with the bot from the paired account. Group chats are not supported.']],
  [['ZEUS_IM_PROJECT_NOT_FOUND'], ['机器人绑定的项目已不可用。请在 Zeus 桌面端检查项目并重新配置连接。', 'The project linked to the bot is unavailable. Check the project and configure the connection again in the Zeus desktop app.']],
  [['ZEUS_IM_REMOTE_APPROVAL_DISABLED'], ['远程授权已关闭，请在 Zeus 桌面端处理操作请求。', 'Remote approvals are disabled. Handle action requests in the Zeus desktop app.']],
  [['ZEUS_IM_TASK_COMMAND_UNSUPPORTED'], ['无法识别此任务命令。发送 /task 查看用法。', 'This task command is not recognized. Send /task to see usage instructions.']],
  [
    ['ZEUS_IM_TASK_CONVERSATION_MISMATCH', 'ZEUS_IM_TASK_CONVERSATION_UNAVAILABLE'],
    ['所选对话不可用或不属于此任务。请重新打开任务，选择“处理此任务”。', 'The selected conversation is unavailable or belongs to another task. Reopen the task and select Work on this task.'],
  ],
  [['ZEUS_IM_TASK_EDIT_VALUE_REQUIRED'], ['任务修改内容不能为空，请填写新的标题或描述。', 'Task edits cannot be empty. Enter the new title or description.']],
  [['ZEUS_IM_TASK_NOT_FOUND'], ['在机器人绑定的项目中找不到此任务。请打开任务列表重新选择。', 'This task could not be found in the bot’s project. Open the task list and select again.']],
  [['ZEUS_IM_TASK_PAGE_INVALID'], ['页码必须是有效的正整数。请使用 /tasks 加页码，例如 /tasks 1。', 'Use a valid positive page number after /tasks, for example /tasks 1.']],
  [['ZEUS_IM_TASK_STALE'], ['任务已被更新，本次修改未执行。请重新打开任务后修改。', 'The task has changed, so this edit was not applied. Reopen the task before editing.']],
  [['ZEUS_IM_TASK_STATUS_REQUIRED'], ['请填写任务和目标状态，例如 /task status 任务编号 状态。', 'Enter the task and target status, for example /task status task-code status.']],
  [
    ['ZEUS_IM_TASK_TERMINAL_STATUS_DESKTOP_REQUIRED'],
    ['完成或取消任务可能停止对话并清理工作目录，请在 Zeus 桌面端确认。', 'Completing or cancelling a task may stop conversations and clean up working folders. Confirm this in the Zeus desktop app.'],
  ],
  [['ZEUS_IM_TASK_TITLE_REQUIRED'], ['请在 /task create 后填写任务标题。', 'Enter a task title after /task create.']],
  [['ZEUS_IM_TOKEN_FORMAT_INVALID'], ['机器人密钥格式不正确，请复制 BotFather 提供的完整密钥。', 'The bot token format is invalid. Copy the complete token provided by BotFather.', 'settings']],
  [
    ['ZEUS_IM_TOKEN_MISSING', 'ZEUS_IM_TOKEN_REQUIRED'],
    ['机器人密钥不可用。请在 Zeus 桌面端的机器人设置中填写 BotFather 提供的密钥。', 'The bot token is unavailable. Enter the token provided by BotFather in the Zeus desktop app’s bot settings.', 'settings'],
  ],
  [['ZEUS_COMPUTER_APP_NOT_RUNNING'], ['目标应用没有运行。请先打开应用，再让 AI 继续操作。', 'The target app is not running. Open it before asking the AI to continue.']],
  [
    ['ZEUS_COMPUTER_ACCESSIBILITY_PERMISSION_REQUIRED'],
    ['尚未授予 Zeus 辅助功能权限。请在 macOS“系统设置 → 隐私与安全性 → 辅助功能”中允许访问。', 'Zeus has not been granted Accessibility permission. Allow it in macOS System Settings → Privacy & Security → Accessibility.', 'settings'],
  ],
  [['ZEUS_COMPUTER_SCREEN_LOCKED'], ['电脑已锁定或当前桌面不可用，AI 暂时不能操作应用。解锁并返回桌面后再继续。', 'The computer is locked or the desktop is unavailable. Unlock it and return to the desktop before continuing.']],
  [['ZEUS_COMPUTER_ELEMENT_STALE'], ['目标应用的内容已变化。需要重新读取页面后才能操作。', 'The target app’s content has changed. It must be read again before the action can continue.']],
  [['ZEUS_COMPUTER_TARGET_UNAVAILABLE'], ['无法确认要操作的控件，本次动作尚未执行。需要重新读取目标窗口。', 'The target control could not be identified. The action has not run; inspect the target window again.']],
  [
    ['ZEUS_COMPUTER_ACTION_CHANGED'],
    ['操作目标、内容或授权状态已变化，本次动作尚未执行。需要重新读取窗口并确认实际操作。', 'The action target, contents, or authorization has changed. The action has not run; inspect the window and confirm the actual action again.'],
  ],
  [
    ['ZEUS_COMPUTER_SELF_CONTROL_BLOCKED', 'ZEUS_COMPUTER_ZEUS_CONTROL_BLOCKED'],
    ['AI 不能代替你操作 Zeus 的授权窗口。请由你直接确认或拒绝。', 'The AI cannot operate Zeus approval windows on your behalf. Approve or decline the request yourself.'],
  ],
  [['ZEUS_RECOVERED_UNSENT_CONFIRMATION_REQUIRED'], ['恢复对话时发现这条消息尚未发送，请选择发送或取消。', 'This message was not sent before the conversation was restored. Choose to send or cancel it.']],
  [['ZEUS_CODEX_LOGIN_REQUIRED'], ['尚未登录 Codex，无法使用该服务。请在“设置 → AI 连接”中登录。', 'Codex is not signed in. Sign in under Settings → AI connections to use this service.', 'sign_in']],
  [
    ['ZEUS_CODEX_DEPENDENCY_UNAVAILABLE'],
    [
      '无法启动本机 Codex，订阅登录和模型连接暂不可用。请查看错误详情，并按官方安装指引安装或修复 Codex 后重新登录。',
      'Codex could not start on this computer, so subscription sign-in and model connections are unavailable. See the error details and official installation guide, then install or repair Codex and sign in again.',
      'settings',
    ],
  ],
  [['ZEUS_CODEX_NOT_READY'], ['Codex 服务尚未就绪。请在“设置 → 模型供应商”中重新连接后再试。', 'Codex is not ready. Reconnect under Settings → Model providers and try again.', 'model_settings']],
  [['ZEUS_CODEX_LOGIN_TIMED_OUT'], ['登录等待超时，配置已保留。请重新登录。', 'Sign-in timed out. Your configuration is preserved; try again.', 'sign_in']],
  [['ZEUS_CODEX_LOGIN_FAILED'], ['这次 Codex 登录未完成，请重新登录；具体原因可查看详情。', 'This Codex sign-in did not complete. Sign in again and check the details for the cause.', 'sign_in']],
  [['ZEUS_CODEX_LOGIN_UNAVAILABLE'], ['这次 Codex 登录已失效，请重新发起登录。', 'This Codex sign-in is no longer available. Start a new sign-in.', 'sign_in']],
  [['ZEUS_CODEX_MODEL_SYNC_FAILED'], ['账号已登录，但订阅模型尚未同步成功。请检查网络和模型来源配置后重试。', 'Signed in, but subscription models have not synced. Check the network and model source configuration, then retry.', 'retry']],
  [
    ['ZEUS_CODEX_MODEL_CATALOG_FIXED'],
    [
      '账号已登录，但固定的本地模型名单阻止了订阅模型更新。请取消 model_catalog_json 配置后重试。',
      'Signed in, but a fixed local model catalog prevents subscription model updates. Remove the model_catalog_json override and retry.',
      'retry',
    ],
  ],
  [['ZEUS_CODEX_LOGIN_BROWSER_OPEN_FAILED'], ['无法打开官方登录页，请检查系统浏览器后重试。', 'Could not open the official sign-in page. Check your system browser and retry.', 'sign_in']],
  [['ZEUS_CODEX_CONFIG_ACTIVATION_REQUIRED'], ['配置已导入，但尚未启用。请重试启用。', 'Configuration was imported but is not active. Retry activation.', 'settings']],
  [
    ['ZEUS_CODEX_PROVIDER_CREDENTIAL_UNAVAILABLE', 'ZEUS_MODEL_CONNECTION_CREDENTIAL_UNAVAILABLE', 'ZEUS_MODEL_CONNECTION_API_KEY_REQUIRED'],
    ['AI 服务的登录信息或 API 密钥不可用。请检查对应的模型连接设置。', 'The AI service credentials or API key are unavailable. Check the model connection settings.', 'model_settings'],
  ],
  [
    ['ZEUS_CODEX_MODEL_AT_CAPACITY', 'serverOverloaded'],
    ['所选模型目前繁忙，无法处理这次请求。可以切换模型，或稍后再试。', 'The selected model is busy and cannot handle this request. Choose another model or try again later.', 'choose_model'],
  ],
  [['ZEUS_CONTEXT_MODEL_WINDOW_UNAVAILABLE'], ['Zeus 未能读取所选模型的使用限制，暂时无法向它发送请求。请重新连接 Codex。', 'Zeus could not read the selected model’s limits and cannot send the request yet. Reconnect Codex.', 'settings']],
  // 任务文档读取失败保留具体原因；缺少可选文档由读取入口正常处理，不会进入这些错误分支。
  [
    ['项目 docs 不是普通目录或是符号链接。', 'ZEUS_CONTEXT_SOURCE_PATH_INVALID: 项目 docs 不是普通目录或是符号链接。'],
    ['Zeus 要读取的 docs 不是普通文件夹，或是指向其他位置的链接。请检查该目录。', 'The docs entry Zeus is trying to read is not a regular folder or is a symbolic link. Check that entry.'],
  ],
  [['ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND'], ['任务文档所在的项目目录不存在或无法读取。请检查目录位置和访问权限。', 'The project folder containing task documents does not exist or cannot be read. Check its location and access permissions.']],
  [['ZEUS_CONTEXT_SOURCE_NOT_FOUND'], ['找不到要读取的任务文档。请检查项目 docs 目录中的文件是否仍然存在。', 'The task document could not be found. Check whether the file still exists in the project docs folder.']],
  [['ZEUS_CONTEXT_SOURCE_PATH_INVALID'], ['任务文档的路径、文件类型或内容格式不符合读取要求。请查看错误详情。', 'The task document path, file type, or content format does not meet the reading requirements. See the error details.']],
  [
    ['ZEUS_CONTEXT_SOURCE_CHANGED'],
    ['任务文档在读取期间发生了变化，本次读取已停止。请等待文档保存完成后重新操作。', 'The task document changed while it was being read, so reading stopped. Wait for the document to finish saving, then try again.'],
  ],
  [
    ['ZEUS_MODEL_NOT_READY', 'ZEUS_MODEL_CONNECTION_NOT_FOUND', 'ZEUS_CONVERSATION_ROUTE_CHANGED'],
    ['所选模型的连接已更改或不可用。请检查模型设置并重新选择可用模型。', 'The selected model connection has changed or is unavailable. Check its settings and select an available model.', 'choose_model'],
  ],
  [['ZEUS_LOCAL_API_READ_TIMEOUT'], ['Zeus 的后台服务未能及时响应，当前信息暂时无法读取。', 'The Zeus background service did not respond in time. This information cannot be loaded yet.', 'retry']],
  [['ZEUS_CODEX_RPC_TIMEOUT'], ['Codex 未能在限定时间内响应，Zeus 暂时无法确认请求的处理情况。', 'Codex did not respond in time. Zeus cannot yet confirm the request’s progress.', 'check']],
  [['ZEUS_EXECUTION_HOST_DRAINING'], ['Zeus 正在重启后台服务，暂时无法处理新的操作。', 'Zeus is restarting its background service and cannot handle new actions yet.', 'retry']],
  [
    ['ZEUS_STORAGE_READ_ONLY_FAULT'],
    ['Zeus 的本地数据发生读写错误，已暂停修改以保护现有数据。请使用页面上的数据恢复入口。', 'Zeus encountered a local data error and paused changes to protect existing data. Use the data recovery action on this page.'],
  ],
  [['ZEUS_CONVERSATION_ARCHIVE_PENDING_MESSAGES'], ['还有消息等待处理，因此暂时不能归档。请先处理或取消这些消息。', 'Messages are still waiting to be processed. Finish or cancel them before archiving.']],
  [['ZEUS_CONVERSATION_ARCHIVE_PENDING_REQUEST'], ['AI 正在等待你的回答或授权，因此暂时不能归档。请先处理会话中的问题。', 'The AI is waiting for your answer or approval. Resolve the request in the conversation before archiving.']],
  [['ZEUS_CONVERSATION_ARCHIVE_ACTIVE'], ['AI 仍在处理这段对话，因此暂时不能归档。请等待处理结束，或先停止当前处理。', 'The AI is still working on this conversation. Wait for it to finish or stop the current work before archiving.']],
  [['ZEUS_NATIVE_CONVERSATION_IN_PROGRESS'], ['会话中仍有未结束的处理，暂时不能归档。请查看会话中的处理状态。', 'This conversation still has unfinished work and cannot be archived yet. Check its current status.']],
  [
    ['ZEUS_CONVERSATION_ARCHIVE_STATE_UNCONFIRMED'],
    ['暂时无法确认上次处理是否结束，尚未归档。请检查会话状态。', 'The conversation has not been archived because its previous work could not be confirmed as finished. Check the conversation status.', 'check'],
  ],
  [
    ['ZEUS_CONVERSATION_NOT_FOUND', 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND'],
    ['找不到这段会话。它可能已被移除，请返回会话列表确认。', 'This conversation could not be found. It may have been removed; check the conversation list.'],
  ],
  [['ZEUS_PROJECT_NOT_FOUND'], ['找不到对应项目。请返回项目列表确认项目是否仍然存在。', 'The project could not be found. Check whether it is still available in the project list.']],
  [['ZEUS_NATIVE_QUEUE_PROVIDER_ARCHIVED'], ['这段会话已归档，需要先恢复会话才能继续。', 'This conversation is archived. Restore it before continuing.']],
  [
    ['ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE', 'ZEUS_NATIVE_SUBMISSION_NOT_RETRYABLE'],
    ['这条消息的处理状态已变化，当前不能执行该操作。请查看最新消息状态。', 'The message’s processing state has changed, so this action is no longer available. Check its latest status.'],
  ],
  [
    ['ZEUS_NATIVE_SUBMISSION_OUTCOME_UNKNOWN', 'ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED', 'ZEUS_CONVERSATION_COMMAND_OUTCOME_UNKNOWN', 'ZEUS_CONVERSATION_DISPATCH_COMMAND_OUTCOME_UNKNOWN', 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'],
    ['尚未确认上次操作是否已执行，Zeus 已暂停重复执行以避免重复处理。', 'Zeus has not confirmed whether the previous action ran and has paused repeated attempts to avoid duplicate work.', 'check'],
  ],
  [
    ['ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT'],
    ['这次操作与已有提交记录冲突，Zeus 已阻止重复执行。请刷新并查看原提交状态。', 'This action conflicts with an existing submission. Zeus blocked duplicate execution. Refresh and check the original submission.', 'check'],
  ],
  [['ZEUS_ASYNC_QUESTION_ALREADY_SUBMITTED'], ['该问题已有回答，本次未重复发送。请通过普通消息补充。', 'This question already has an answer. Nothing was sent again. Use a regular message to add more information.']],
  [['ZEUS_ASYNC_QUESTION_TURN_ENDED'], ['原轮次已结束，回答未发送，草稿已保留。请明确选择作为新消息发送。', 'The original turn has ended. Your answer was not sent and the draft is preserved. Choose to send it as a new message.']],
  [
    ['ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'ZEUS_PROVIDER_STOP_RECOVERY_REQUIRED'],
    ['尚未确认 AI 上次的处理是否已经结束，暂时不能继续。', 'Zeus has not confirmed that the AI’s previous work has ended, so it cannot continue yet.', 'check'],
  ],
  [
    ['ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'ZEUS_PERMISSION_DENIED', 'EACCES', 'EPERM'],
    ['当前没有执行此操作所需的权限。请检查相关文件或应用的访问权限。', 'This action needs access that has not been granted. Check the relevant file or app permissions.', 'settings'],
  ],
  [
    ['ZEUS_COMPUTER_SENSITIVE_ACTION_DECLINED', 'ZEUS_BROWSER_SENSITIVE_ACTION_DECLINED'],
    ['你已拒绝这次操作，AI 不会继续执行它。', 'You declined this action, so the AI will not perform it.'],
  ],
  [
    ['ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE'],
    ['任务工作目录恢复失败，暂时无法继续对话。请检查任务目录和分支后再继续。', 'The task working folder could not be restored, so the conversation cannot continue yet. Check the task folder and branch before continuing.', 'check'],
  ],
  [
    ['ZEUS_CONVERSATION_EXECUTION_LEASE_HELD'],
    ['这段对话仍有一次发送准备尚未结束，暂时不能发送下一条消息。请检查对话状态后再继续。', 'A send is still being prepared for this conversation. Check the conversation state before sending another message.', 'check'],
  ],
  [
    ['ZEUS_NATIVE_WORKTREE_UNAVAILABLE', 'ZEUS_TASK_WORKSPACE_UNAVAILABLE'],
    ['本次任务使用的工作目录无法访问。请检查目录是否存在，以及 Zeus 是否有访问权限。', 'The task’s working folder cannot be accessed. Check that it exists and that Zeus has permission to access it.', 'settings'],
  ],
  [['ENOENT'], ['需要的文件或程序不存在。请检查所选路径是否正确。', 'A required file or program could not be found. Check the selected path.', 'settings']],
  [['ENOSPC'], ['磁盘可用空间不足，无法完成此操作。请释放空间后再继续。', 'There is not enough disk space to complete this action. Free up space before continuing.']],
  [['ECONNREFUSED'], ['目标服务拒绝了连接。请确认服务已启动，并检查连接地址。', 'The destination service refused the connection. Check that it is running and that the address is correct.', 'settings']],
  [
    ['ENOTFOUND', 'EAI_AGAIN'],
    ['无法找到服务地址。请检查连接地址和网络设置。', 'The service address could not be resolved. Check the address and network settings.', 'settings'],
  ],
  [
    ['ECONNRESET', 'ETIMEDOUT'],
    ['与服务的连接中断或超时，这次操作没有取得完整响应。', 'The service connection was interrupted or timed out before a complete response was received.', 'retry'],
  ],
];

/** 只返回允许跨界面传递的诊断字段；限制深度避免循环对象和无界错误链。 */
export function userFacingErrorCause(error: unknown, depth = 0): UserFacingErrorCause {
  const value = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  // 字符串形式的历史错误只识别开头的完整错误码，不猜测正文关键词。
  const message = typeof value.message === 'string' ? value.message : typeof error === 'string' ? error : '';
  // Electron 会在 message 外包裹固定 IPC 前缀，仅拆解 Zeus 自身通道的这一格式。
  const codeMessage = message.replace(/^Error invoking remote method 'zeus:[^'\r\n]+': (?:[A-Za-z_$][\w$]*Error: |Error: )?/u, '');
  const code = typeof value.code === 'string' ? value.code : typeof value.error === 'string' ? value.error : /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(codeMessage)?.[1];
  // 仅保留诊断对象的有界标量字段，避免跨界面携带凭据对象或大块业务数据。
  const detailFields =
    value.details && typeof value.details === 'object' && !Array.isArray(value.details)
      ? Object.entries(value.details)
          .filter(([, detail]) => typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean')
          .slice(0, 16)
      : [];
  return {
    ...(code && /^[A-Za-z0-9_.:-]{1,128}$/u.test(code) ? { code } : {}),
    message: redactUserFacingErrorDetails(message),
    ...(typeof value.details === 'string'
      ? { details: redactUserFacingErrorDetails(value.details) }
      : typeof value.additionalDetails === 'string'
        ? { details: redactUserFacingErrorDetails(value.additionalDetails) }
        : Array.isArray(value.additionalDetails)
          ? { details: redactUserFacingErrorDetails(value.additionalDetails.filter((item): item is string => typeof item === 'string').join('\n')) }
          : detailFields.length > 0
            ? { details: redactUserFacingErrorDetails(JSON.stringify(Object.fromEntries(detailFields))) }
            : {}),
    ...(depth < 3 && value.cause && value.cause !== error ? { cause: userFacingErrorCause(value.cause, depth + 1) } : {}),
  };
}

/** 原文进入详情前移除密钥、个人路径和堆栈；摘要不能成为敏感信息的旁路。 */
export function redactUserFacingErrorDetails(value: string): string {
  return value
    .replace(/(^|\n)\s*(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, '$1$2: [REDACTED]')
    .replace(/\b([A-Za-z0-9_.-]*(?:api[ _-]?key|(?:access|refresh|session)[ _-]?token|token|password|passphrase|secret|authorization|cookie))["']?\s*[=:]\s*(["'])(?:\\.|(?!\2)[^\r\n])*?\2/giu, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, '$1?[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,128}\b/gu, '[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/gu, '[REDACTED]')
    .replace(/\b([A-Za-z0-9_.-]*(?:api[ _-]?key|(?:access|refresh|session)[ _-]?token|token|password|passphrase|secret|authorization|cookie))["']?\s*[=:]\s*["']?[^\s,;"'&]+/giu, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s,;"'<>]+/gu, '[LOCAL PATH]')
    .replace(/[A-Za-z]:\\[^\s,;"'<>]+/gu, '[LOCAL PATH]')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*at\s/u.test(line))
    .join('\n')
    .trim()
    .slice(0, 2000);
}

/** 优先解释读取失败或归档尚未完成，其余错误使用最内层已知原因。 */
export function describeUserFacingError(error: unknown, language: UserFacingErrorLanguage = 'zh-CN'): UserFacingErrorDescription {
  const root = userFacingErrorCause(error);
  const chain: UserFacingErrorCause[] = [];
  for (let item: UserFacingErrorCause | undefined = root; item; item = item.cause) chain.push(item);
  // 已解释过的字符串仍可切换语言，避免再次格式化时丢失原因。
  const translated = explanations.find(([, copy]) => copy[0] === root.message || copy[1] === root.message)?.[1];
  // 发送后核对可能包住读取失败，仍优先解释刷新状态，底层原因继续完整保留在详情中。
  const readFailure = chain.find((item) => item.code === 'ZEUS_CONVERSATION_READ_FAILED' || item.code === 'ZEUS_CONVERSATION_ARCHIVE_STATE_UNCONFIRMED');
  // 只改变解释优先级，不改变下方对发送结果未知的保护。
  const explanationChain = readFailure ? [readFailure] : [...chain].reverse();
  const match = explanationChain.flatMap((item) => explanations.filter(([codes]) => codes.includes(item.message) || (item.code && codes.includes(item.code))))[0]?.[1] ?? translated;
  const details = chain
    .map((item) => [[item.code, item.message].filter(Boolean).join(': '), item.details].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n');
  const zh = language === 'zh-CN';
  const unknownOutcome = chain.some((item) => /OUTCOME_UNKNOWN|DELIVERY_UNCONFIRMED|REPLAY_BLOCKED|ACCEPTANCE_HYDRATION_PENDING|^ZEUS_CODEX_RPC_PROTOCOL_ERROR$/u.test(item.code ?? ''));
  return {
    message: match?.[zh ? 0 : 1] ?? (zh ? 'Zeus 尚未识别这次错误的具体原因。请查看错误详情。' : 'Zeus has not identified the cause of this error. See the error details.'),
    details: translated && !root.code && !root.cause && !root.details ? '' : details,
    outcomeUnconfirmed: unknownOutcome,
    action: unknownOutcome && (!match?.[2] || match[2] === 'retry') ? 'check' : (match?.[2] ?? null),
  };
}
