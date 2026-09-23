/**
 * User-visible message catalog for the file manager.
 *
 * The tables are the shipped legacy wording, moved unchanged into TypeScript:
 * every key that existed before still exists, in both languages. Messages are
 * looked up by key through the Harness locale binding; an unknown failure code
 * is presented as a filesystem failure, while a user-initiated cancellation is
 * always presented as a cancellation rather than degraded into an I/O error.
 */

/** Runtime namespace of the plugin; the npm package name never appears here. */
export const NS = 'local-file-manager';

export type Dictionary = Readonly<Record<string, string>>;
export type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export const en: Dictionary = {
      title: 'Files', subtitle: 'Browse and manage Host files independently of conversations.', stage: 'File manager',
      roots: 'Directories', add: 'Add directory', pathPlaceholder: 'Absolute Host directory path',
      emptyRoots: 'Add a directory to start browsing. No conversation is required.',
      selectFile: 'Select a file to preview its contents.', loading: 'Loading…', empty: 'This directory is empty.',
      name: 'Name', size: 'Size', modified: 'Modified', refresh: 'Refresh', more: 'Load more',
      removeRoot: 'Remove this entry only — files are not deleted', preview: 'Preview', items: 'items', bytes: 'bytes',
      special: 'Links and special entries are shown but not followed.',
      degraded: 'Degraded mode',
      historyUnavailable: 'Task history is unavailable; ended cards are still retained on the Host.',
      unaddressable: 'Unmanageable entries',
      unaddressableHint: 'These names cannot be represented by the current path grammar, so they cannot be opened, selected or used as a task target.',
      note: 'Directory grants do not change Agent permissions. Drafts survive switching main panels.',
      notPersistent: 'This Host does not persist directory grants across restarts.',
      edit: 'Edit', save: 'Save', saving: 'Saving…', saved: 'Saved', dirty: 'Unsaved changes', close: 'Close', cancel: 'Cancel',
      editor: 'Text editor', openDocuments: 'Open documents', closeDocument: 'Close document',
      closeTitle: 'Save changes before closing?', closeDescription: 'Your unsaved draft will remain open unless you save it or explicitly discard it.',
      discard: 'Discard draft', saveClose: 'Save and close', external: 'The disk file has changed. Your draft has been preserved.',
      compare: 'Compare versions', conflictTitle: 'Disk version conflicts with your draft',
      conflictDescription: 'Review both versions. Rebasing keeps your draft and authorizes a later save against this disk version; it does not write now.',
      diskVersion: 'Current disk version', localDraft: 'Your draft', rebase: 'Keep draft and use this disk version as the base',
      missing: 'This file is unavailable. The draft is retained; saving will not recreate the file.', readOnly: 'This Host is read-only.',
      newFile: 'New file', newDirectory: 'New directory', rename: 'Rename', applyName: 'Confirm name', nameDescription: 'Enter one file or directory name. Existing entries are never silently replaced.',
      select: 'Select', selected: 'selected', delete: 'Delete permanently', deleteTitle: 'Permanently delete these entries?',
      deleteDescription: 'This cannot be undone. Directory contents in the server-prepared manifest will also be deleted.',
      deleteAck: 'I acknowledge permanent deletion cannot be undone', deleteConfirm: 'Permanently delete', deleteEntries: 'Manifest entries', expires: 'Confirmation expires', versions: 'Bound versions',
      deletePreparing: 'Preparing the deletion manifest…', deleteReady: 'The manifest is ready. Review it, then acknowledge and confirm.',
      deleteFailed: 'The operation could not continue. Close this dialog and prepare a new manifest before retrying.', deleteCommitting: 'Applying the confirmed permanent deletion. This cannot be undone.',
      removeRootTitle: 'Remove this directory entry?', removeRootDescription: 'This only removes the entry and revokes its file-manager access; it will not delete directories or files on disk. Open drafts are retained and marked unavailable.',
      removeRootConfirm: 'Remove entry only', removeRootWorking: 'Removing the directory entry…',
      'error.INVALID_DELETE_PLAN': 'A complete, reviewable deletion manifest was not received. No deletion was submitted.',
      'status.completed': 'Completed', 'status.failed': 'Failed', 'status.partial': 'Partially completed',
      'status.queued': 'Queued', 'status.running': 'Running', 'status.pending': 'Not started', 'status.skipped': 'Skipped', 'status.cancelled': 'Cancelled', 'status.interrupted': 'Interrupted',
      copy: 'Copy', cut: 'Cut', paste: 'Paste', copyTask: 'Copy', moveTask: 'Move', pasteTitle: 'Review paste operation',
      pasteDescription: 'Choose how to handle name conflicts. Folders are not merged.',
      pasteConflictPolicy: 'Name conflicts', pasteNewName: 'New name', pasteOverwrite: 'Overwrite file',
      clipboard: 'Clipboard', skip: 'Skip conflicts', renameConflict: 'Rename', overwrite: 'Overwrite this file version', pasteConfirm: 'Start task',
      tasks: 'Tasks', refreshTasks: 'Refresh tasks', retry: 'Retry failed items', cancelTask: 'Cancel task', targetCommitted: 'The target has been published. Source content may still remain; review both copies.',
      closeTask: 'Close task card', closeTaskHint: 'Hide this card only. Files and required recovery information are retained.', clearEndedTasks: 'Clear ended tasks',
      collapseTasks: 'Collapse', expandTasks: 'Expand', activeTasks: 'active', historyFailures: 'Some cards could not be closed; unsuccessful items were retained.',
      'error.TASK_CHANGED': 'The task changed or restarted. Review its current state before closing it.',
      'error.HISTORY_REVISION_EXHAUSTED': 'The task history reached its revision limit; no visibility change was saved.',
      'error.INVALID_HISTORY_RESULT': 'The server did not confirm this close operation. The card was retained.',
      'error.SOURCE_DELETE_FAILED': 'The copy was published but source cleanup failed. Both copies may exist.',
      'error.INTERRUPTED': 'The Host stopped before completion. Review the failed items before retrying.',
      'error.TASK_PERSISTENCE_FAILED': 'Task state could not be saved. Further filesystem work was stopped.',
      'error.TASK_BUSY': 'Wait for this task to settle before retrying.',
      uploadFiles: 'Upload files', uploadDirectory: 'Upload directory', uploadTitle: 'Review upload', uploadConfirm: 'Start upload',
      uploadDescription: 'File bodies are streamed without unpacking ZIP files. Existing directories are never merged. Review each top-level name.',
      directoryFallback: 'This browser uses a file-list directory picker: nested files are retained, but empty directories cannot be detected. Use a browser with the directory-handle picker to include empty directories.',
      download: 'Download', downloadTitle: 'Download is ready', downloadStart: 'Start browser download',
      downloadNote: 'This link streams directly to your browser. Server completion does not prove that the browser saved the file; interrupted downloads restart from the beginning.',
      serverFinished: 'Server stream finished — check the browser download', uploadTask: 'Upload', downloadTask: 'Download',
      'error.UPLOAD_SOURCE_LOST': 'The browser no longer holds these source files. Select them again to start a new upload.',
      'error.INCOMPLETE_UPLOAD': 'The upload was truncated. Uncommitted data was not published.',
      'watch.connecting': 'Connecting observation…', 'watch.watching': 'Live observation', 'watch.polling': 'Native watching unavailable; periodically reconciling',
      'watch.unavailable': 'Observation is unavailable for a directory or exceeds its target limit. Refresh manually.', 'watch.disconnected': 'Observation disconnected; reconnecting and resynchronizing…',
      reference: 'Reference in a session', referenceTitle: 'Choose the target session', referenceDescription: 'Append file references to an existing session draft. The draft is not sent and Agent permissions do not change.',
      referenceSession: 'Target session', referenceSelect: 'Choose a session…', referenceConfirm: 'Append references', referenceWaiting: 'Waiting for this session input to open…',
      referenceBusy: 'This input is busy. The request is retained; retry when it is idle.', referenceStale: 'The draft changed or rejected the insertion. Review the current draft and retry.',
      referenceTargetUnavailable: 'The target session is unavailable. No reference was inserted.', referenceRetry: 'Retry insertion into this draft',
      'error.UNREPRESENTABLE_REFERENCE': 'This entry name cannot be represented safely by the current path grammar.',
      'error.REFERENCE_TARGET_UNAVAILABLE': 'The selected session is unavailable.', 'error.REFERENCE_BUSY': 'The selected session is busy. Retry when it is idle.',
      'error.STRONG_VERSION_REQUIRED': 'This operation needs a fresh content-bound version. Review the entry again.',
      'error.INVALID_PATH': 'Enter a valid absolute directory or root-relative file path.',
      'error.ROOT_NOT_FOUND': 'This directory entry has been removed. Select another directory.',
      'error.ROOT_CHANGED': 'This path now points to a different directory. Remove and re-add it explicitly.',
      'error.ROOT_UNAVAILABLE': 'This directory is unavailable or cannot be accessed.',
      'error.NOT_FOUND': 'The selected file or directory no longer exists.',
      'error.PERMISSION_DENIED': 'The filesystem denied access to this entry.',
      'error.UNSUPPORTED_ENTRY': 'Links and special files cannot be opened as text.',
      'error.UNSUPPORTED_ENCODING': 'This file is not editable UTF-8 text. Its bytes have not been converted.',
      'error.TOO_LARGE': 'This file or request exceeds the configured size limit.',
      'error.DIRECTORY_CHANGED': 'The directory changed. Refresh before loading another page.',
      'error.VERSION_CONFLICT': 'The file changed. Nothing is silently overwritten; review the disk version and your draft.',
      'error.INVALID_REQUEST': 'The file operation could not be submitted.',
      'error.UNSUPPORTED_PLATFORM': 'This version requires a Linux DSH Host.',
      'error.UNSUPPORTED_LINE_ENDINGS': 'This Host cannot preserve these line endings. The draft is retained.',
      'error.LINE_ENDING_MAPPING_LIMIT': 'Preserving mixed line endings exceeded the safe mapping limit. The draft is retained.',
      'error.FILE_MANAGER_UNAVAILABLE': 'The file manager is unavailable on this Host.',
      'error.IO_ERROR': 'The filesystem operation failed.', 'error.TRANSPORT': 'Could not contact the file manager.',
      'error.ALREADY_EXISTS': 'That name already exists. Choose another name.',
      'error.PLAN_EXPIRED': 'The deletion preview expired. Review a new preview before confirming.',
      'error.PLAN_NOT_FOUND': 'The deletion preview is no longer available. Prepare it again.',
      'error.NO_SPACE': 'The destination has no free space.', 'error.CANCELLED': 'The operation was cancelled.',
};

export const zh: Dictionary = {
      title: '文件', subtitle: '独立于会话浏览和管理 DSH 主机文件。', stage: '文件管理器',
      roots: '目录', add: '添加目录', pathPlaceholder: '输入 DSH 主机上的绝对目录路径',
      emptyRoots: '添加一个目录即可开始浏览，无需打开会话。',
      selectFile: '选择一个文件，在这里预览内容。', loading: '正在加载…', empty: '这个目录是空的。',
      name: '名称', size: '大小', modified: '修改时间', refresh: '刷新', more: '加载更多',
      removeRoot: '只移除这个入口，不删除磁盘文件', preview: '预览', items: '项', bytes: '字节',
      special: '显示链接和特殊条目，但不跟随或打开它们。',
      degraded: '降级模式',
      historyUnavailable: '任务历史不可用，已结束的卡片仍保留在 Host 上，未丢失。',
      unaddressable: '不可管理的条目',
      unaddressableHint: '这些名称无法由当前路径文法表示，因此不能打开、勾选，也不能作为任务目标。',
      note: '目录授权不改变 Agent 权限；切换主面板会保留未保存草稿。',
      notPersistent: '当前 Host 不会跨重启保存目录入口。',
      edit: '编辑', save: '保存', saving: '正在保存…', saved: '已保存', dirty: '未保存', close: '关闭', cancel: '取消',
      editor: '文本编辑器', openDocuments: '已打开文档', closeDocument: '关闭文档',
      closeTitle: '关闭前保存修改？', closeDescription: '未保存草稿将继续保留，除非你成功保存或明确放弃。',
      discard: '放弃草稿', saveClose: '保存并关闭', external: '磁盘文件已变化，你的草稿仍然保留。',
      compare: '对照版本', conflictTitle: '磁盘版本与草稿冲突',
      conflictDescription: '请对照两份内容。更新基准会保留草稿，并允许下次保存以此磁盘版本为准；现在不会写入。',
      diskVersion: '当前磁盘版本', localDraft: '你的草稿', rebase: '保留草稿，并以此磁盘版本为新基准',
      missing: '文件已失效，草稿仍然保留；保存不会自动重建文件。', readOnly: '当前 Host 为只读模式。',
      newFile: '新建文件', newDirectory: '新建目录', rename: '重命名', applyName: '确认名称', nameDescription: '请输入单个文件或目录名称，不会静默替换同名条目。',
      select: '选择', selected: '项已选', delete: '永久删除', deleteTitle: '永久删除这些条目？',
      deleteDescription: '此操作不可恢复。目录内属于服务端清单的内容也会删除。',
      deleteAck: '我确认永久删除不可恢复', deleteConfirm: '确认永久删除', deleteEntries: '清单条目', expires: '确认有效期至', versions: '绑定版本',
      deletePreparing: '正在准备删除清单…', deleteReady: '删除清单已就绪，请核对后勾选并明确确认。',
      deleteFailed: '操作未能继续，请关闭弹窗并重新生成清单后再试。', deleteCommitting: '正在执行已确认的永久删除，此操作不可撤销。',
      removeRootTitle: '移除这个目录入口？', removeRootDescription: '仅移除目录入口并撤销文件管理器的访问，不会删除磁盘上的目录或文件。已打开的草稿会保留并标记失效。',
      removeRootConfirm: '仅移除入口', removeRootWorking: '正在移除目录入口…',
      'error.INVALID_DELETE_PLAN': '未取得可核对的完整删除清单，没有提交删除操作。',
      'status.completed': '已完成', 'status.failed': '失败', 'status.partial': '部分完成',
      'status.queued': '排队中', 'status.running': '进行中', 'status.pending': '未执行', 'status.skipped': '已跳过', 'status.cancelled': '已取消', 'status.interrupted': '已中断',
      copy: '复制', cut: '剪切', paste: '粘贴', copyTask: '复制', moveTask: '移动', pasteTitle: '核对粘贴操作',
      pasteDescription: '选择重名时的处理方式，文件夹不会合并。',
      pasteConflictPolicy: '重名处理', pasteNewName: '新名称', pasteOverwrite: '覆盖文件',
      clipboard: '剪贴板', skip: '重名时跳过', renameConflict: '改名', overwrite: '覆盖此版本文件', pasteConfirm: '开始任务',
      tasks: '任务', refreshTasks: '刷新任务', retry: '重试失败项', cancelTask: '取消任务', targetCommitted: '目标已发布，源内容可能仍有残留；请核对两份内容。',
      closeTask: '关闭任务卡片', closeTaskHint: '仅隐藏这张卡片，不删除文件或必要的任务恢复信息。', clearEndedTasks: '清理已结束',
      collapseTasks: '折叠', expandTasks: '展开', activeTasks: '项处理中', historyFailures: '部分卡片未能关闭，未成功的记录已保留。',
      'error.TASK_CHANGED': '任务已变化或重新执行，请核对当前状态后再关闭。',
      'error.HISTORY_REVISION_EXHAUSTED': '任务历史版本已达上限，没有保存可见性变更。',
      'error.INVALID_HISTORY_RESULT': '服务端没有确认关闭结果，卡片已保留。',
      'error.SOURCE_DELETE_FAILED': '复制已发布，但删除源内容失败，可能同时存在两份。',
      'error.INTERRUPTED': 'Host 在完成前停止，请核对失败项后重试。',
      'error.TASK_PERSISTENCE_FAILED': '无法保存任务状态，已停止继续修改文件。',
      'error.TASK_BUSY': '请等待任务结束后再重试。',
      uploadFiles: '上传文件', uploadDirectory: '上传目录', uploadTitle: '核对上传内容', uploadConfirm: '开始上传',
      uploadDescription: '文件以流传输，ZIP 不会自动解压。已有目录不会合并，请逐项核对顶层名称。',
      directoryFallback: '当前浏览器使用文件列表式目录选择：保留文件层级，但无法识别空目录。若需要上传空目录，请使用支持目录句柄选择器的浏览器。',
      download: '下载', downloadTitle: '下载已准备就绪', downloadStart: '开始浏览器下载',
      downloadNote: '此链接直接流式传给浏览器。服务端完成不代表浏览器已经落盘；中断后重试会从头下载。',
      serverFinished: '服务端流已结束，请核对浏览器下载', uploadTask: '上传', downloadTask: '下载',
      'error.UPLOAD_SOURCE_LOST': '浏览器已不再持有这些源文件，请重新选择并新建上传任务。',
      'error.INCOMPLETE_UPLOAD': '上传内容被截断，未提交数据没有发布。',
      'watch.connecting': '正在连接变化监测…', 'watch.watching': '实时监测中', 'watch.polling': '原生监听不可用，正在定期核对变化',
      'watch.unavailable': '目录监测不可用或超过目标数量上限，请手动刷新。', 'watch.disconnected': '监测已断线，正在重连并重新同步…',
      reference: '引用到会话', referenceTitle: '选择目标会话', referenceDescription: '把文件引用追加到已有会话草稿，不自动发送，也不改变 Agent 权限。',
      referenceSession: '目标会话', referenceSelect: '请选择会话…', referenceConfirm: '追加引用', referenceWaiting: '等待此会话输入框就绪…',
      referenceBusy: '此输入框正在忙碌，请求仍保留；空闲后可重试。', referenceStale: '草稿已变化或拒绝插入，请核对当前草稿后重试。',
      referenceTargetUnavailable: '目标会话不可用，没有插入引用。', referenceRetry: '重试追加到此草稿',
      'error.UNREPRESENTABLE_REFERENCE': '该名称无法由当前路径文法安全表示。',
      'error.REFERENCE_TARGET_UNAVAILABLE': '所选会话不可用。', 'error.REFERENCE_BUSY': '所选会话正在忙碌，请空闲后重试。',
      'error.STRONG_VERSION_REQUIRED': '操作需要新的内容绑定版本，请重新核对条目。',
      'error.INVALID_PATH': '请输入有效的绝对目录路径或根内相对文件路径。',
      'error.ROOT_NOT_FOUND': '这个目录入口已被移除，请选择其他目录。',
      'error.ROOT_CHANGED': '这个路径已指向另一份目录，请移除入口后重新添加。',
      'error.ROOT_UNAVAILABLE': '这个目录暂不可用，或当前进程无权访问。',
      'error.NOT_FOUND': '所选文件或目录已经不存在。',
      'error.PERMISSION_DENIED': '文件系统拒绝访问这个条目。',
      'error.UNSUPPORTED_ENTRY': '不能将链接或特殊文件作为文本打开。',
      'error.UNSUPPORTED_ENCODING': '这不是可编辑的 UTF-8 文本，原始字节没有被转换。',
      'error.TOO_LARGE': '这个文件或请求超过了配置的大小上限。',
      'error.DIRECTORY_CHANGED': '目录已经变化，请刷新后再加载更多。',
      'error.VERSION_CONFLICT': '文件已变化，不会静默覆盖；请对照磁盘版本和草稿。',
      'error.INVALID_REQUEST': '无法提交这项文件操作。',
      'error.UNSUPPORTED_PLATFORM': '当前版本需要 Linux DSH 主机。',
      'error.UNSUPPORTED_LINE_ENDINGS': '当前 Host 无法保留这份文件的换行格式，草稿仍然保留。',
      'error.LINE_ENDING_MAPPING_LIMIT': '保留混合换行超出安全映射限额，草稿仍然保留。',
      'error.FILE_MANAGER_UNAVAILABLE': '当前 Host 上的文件管理器不可用。',
      'error.IO_ERROR': '文件系统操作失败。', 'error.TRANSPORT': '暂时无法连接文件管理器。',
      'error.ALREADY_EXISTS': '这个名称已存在，请选择其他名称。',
      'error.PLAN_EXPIRED': '删除预览已过期，请重新预览并确认。',
      'error.PLAN_NOT_FOUND': '删除预览已失效，请重新生成。',
      'error.NO_SPACE': '目标磁盘没有足够空间。', 'error.CANCELLED': '操作已取消。',
};

/** Failure codes the Host can report, used by tests and by message lookups. */
export function errorMessage(translate: Translate, failure: unknown): string {
  const code = failureCode(failure);
  if (code === null) return fallback(translate);
  const key = `error.${code}`;
  const translated = translate(key);
  return translated === key ? fallback(translate) : translated;
}

const fallback = (translate: Translate): string => translate('error.IO_ERROR');

/**
 * Resolves the message code of an unknown failure. An aborted request is a
 * cancellation: `AbortError` carries the numeric DOMException code 20, which a
 * truthiness check would mistake for a real failure code and render as I/O.
 */
export function failureCode(failure: unknown): string | null {
  if (typeof failure !== 'object' || failure === null) return null;
  const record = failure as Record<string, unknown>;
  if (record.name === 'AbortError' || record.code === 20) return 'CANCELLED';
  return typeof record.code === 'string' && record.code.length > 0 ? record.code : null;
}
