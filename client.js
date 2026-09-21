window.__ModuleLoader__.load({
  id: '@lolkda/dsh-file-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local-file-manager';
    let requestSequence = 0;
    const requestId = () => globalThis.crypto?.randomUUID?.() || `fm-${Date.now().toString(36)}-${(++requestSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
    const en = {
      title: 'Files', subtitle: 'Browse and manage Host files independently of conversations.', stage: 'File manager',
      roots: 'Directories', add: 'Add directory', pathPlaceholder: 'Absolute Host directory path',
      emptyRoots: 'Add a directory to start browsing. No conversation is required.',
      selectFile: 'Select a file to preview its contents.', loading: 'Loading…', empty: 'This directory is empty.',
      name: 'Name', size: 'Size', modified: 'Modified', refresh: 'Refresh', more: 'Load more',
      removeRoot: 'Remove this entry only — files are not deleted', preview: 'Preview', items: 'items', bytes: 'bytes',
      special: 'Links and special entries are shown but not followed.',
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
      deleteDescription: 'This cannot be undone. Directory contents in the server-prepared manifest will also be deleted. Review the list before acknowledging.',
      deleteAck: 'I acknowledge permanent deletion cannot be undone', deleteConfirm: 'Permanently delete', deleteEntries: 'Manifest entries', expires: 'Confirmation expires', versions: 'Bound versions',
      deletePreparing: 'Preparing the server manifest. Nothing has been deleted; you may cancel.', deleteReady: 'The manifest is ready. Review it, then acknowledge and confirm.',
      deleteFailed: 'The operation could not continue. Close this dialog and prepare a new manifest before retrying.', deleteCommitting: 'Applying the confirmed permanent deletion. This cannot be undone.',
      removeRootTitle: 'Remove this directory entry?', removeRootDescription: 'This only removes the entry and revokes its file-manager access; it will not delete directories or files on disk. Open drafts are retained and marked unavailable.',
      removeRootConfirm: 'Remove entry only', removeRootWorking: 'Removing the directory entry…',
      'error.INVALID_DELETE_PLAN': 'A complete, reviewable deletion manifest was not received. No deletion was submitted.',
      'status.completed': 'Completed', 'status.failed': 'Failed', 'status.partial': 'Partially completed',
      'status.queued': 'Queued', 'status.running': 'Running', 'status.pending': 'Not started', 'status.skipped': 'Skipped', 'status.cancelled': 'Cancelled', 'status.interrupted': 'Interrupted',
      copy: 'Copy', cut: 'Cut', paste: 'Paste', copyTask: 'Copy', moveTask: 'Move', pasteTitle: 'Review paste operation',
      pasteDescription: 'Choose a policy for each name conflict. File overwrite is bound to the reviewed version; directories are never merged.',
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
      'error.UNREPRESENTABLE_REFERENCE': 'This path cannot be represented safely by the current reference syntax.',
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
      'error.IO_ERROR': 'The filesystem operation failed.', 'error.TRANSPORT': 'Could not contact the file manager.',
      'error.ALREADY_EXISTS': 'That name already exists. Choose another name.',
      'error.PLAN_EXPIRED': 'The deletion preview expired. Review a new preview before confirming.',
      'error.PLAN_NOT_FOUND': 'The deletion preview is no longer available. Prepare it again.',
      'error.NO_SPACE': 'The destination has no free space.', 'error.CANCELLED': 'The operation was cancelled.',
    };
    const zh = {
      title: '文件', subtitle: '独立于会话浏览和管理 DSH 主机文件。', stage: '文件管理器',
      roots: '目录', add: '添加目录', pathPlaceholder: '输入 DSH 主机上的绝对目录路径',
      emptyRoots: '添加一个目录即可开始浏览，无需打开会话。',
      selectFile: '选择一个文件，在这里预览内容。', loading: '正在加载…', empty: '这个目录是空的。',
      name: '名称', size: '大小', modified: '修改时间', refresh: '刷新', more: '加载更多',
      removeRoot: '只移除这个入口，不删除磁盘文件', preview: '预览', items: '项', bytes: '字节',
      special: '显示链接和特殊条目，但不跟随或打开它们。',
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
      deleteDescription: '此操作不可恢复。目录内属于服务端预览清单的内容也会删除，请先核对清单再勾选确认。',
      deleteAck: '我确认永久删除不可恢复', deleteConfirm: '确认永久删除', deleteEntries: '清单条目', expires: '确认有效期至', versions: '绑定版本',
      deletePreparing: '正在生成服务端删除清单，尚未删除任何内容；你可以取消。', deleteReady: '删除清单已就绪，请核对后勾选并明确确认。',
      deleteFailed: '操作未能继续，请关闭弹窗并重新生成清单后再试。', deleteCommitting: '正在执行已确认的永久删除，此操作不可撤销。',
      removeRootTitle: '移除这个目录入口？', removeRootDescription: '仅移除目录入口并撤销文件管理器的访问，不会删除磁盘上的目录或文件。已打开的草稿会保留并标记失效。',
      removeRootConfirm: '仅移除入口', removeRootWorking: '正在移除目录入口…',
      'error.INVALID_DELETE_PLAN': '未取得可核对的完整删除清单，没有提交删除操作。',
      'status.completed': '已完成', 'status.failed': '失败', 'status.partial': '部分完成',
      'status.queued': '排队中', 'status.running': '进行中', 'status.pending': '未执行', 'status.skipped': '已跳过', 'status.cancelled': '已取消', 'status.interrupted': '已中断',
      copy: '复制', cut: '剪切', paste: '粘贴', copyTask: '复制', moveTask: '移动', pasteTitle: '核对粘贴操作',
      pasteDescription: '请逐项选择重名策略。覆盖文件必须核对当前目标版本，目录不会隐式合并。',
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
      'error.UNREPRESENTABLE_REFERENCE': '当前引用语法无法安全表示这个路径。',
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
      'error.IO_ERROR': '文件系统操作失败。', 'error.TRANSPORT': '暂时无法连接文件管理器。',
      'error.ALREADY_EXISTS': '这个名称已存在，请选择其他名称。',
      'error.PLAN_EXPIRED': '删除预览已过期，请重新预览并确认。',
      'error.PLAN_NOT_FOUND': '删除预览已失效，请重新生成。',
      'error.NO_SPACE': '目标磁盘没有足够空间。', 'error.CANCELLED': '操作已取消。',
    };
    const css = `
.dsh-fm{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;overflow:hidden}
.dsh-fm *{box-sizing:border-box}.dsh-fm input,.dsh-fm textarea,.dsh-fm select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base)}
.dsh-fm button:focus-visible,.dsh-fm input:focus-visible,.dsh-fm textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-fm header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-fm h1{font-size:24px;line-height:1.3;margin:0 0 5px}.dsh-fm h2{font-size:12px;font-weight:600;margin:0 0 14px;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-subtitle,.dsh-fm .fm-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-fm .fm-badge{font-size:11px;border-radius:20px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);white-space:nowrap}
.dsh-fm .fm-layout{flex:1;min-height:0;display:grid;grid-template-columns:210px minmax(260px,1fr) minmax(310px,1.2fr)}
.dsh-fm aside{min-width:0;padding:18px 12px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);overflow:auto}
.dsh-fm .fm-rootrow{display:flex;align-items:center;gap:4px;margin:5px 0}.dsh-fm .fm-rootrow>button:first-child{flex:1;min-width:0;text-align:left;justify-content:flex-start;display:flex;gap:8px}
.dsh-fm .fm-rootrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-fm .fm-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.dsh-fm form{margin-top:18px;display:flex;flex-direction:column;gap:9px}.dsh-fm input{width:100%;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px}
.dsh-fm input[type=checkbox]{width:auto}.dsh-fm .fm-files,.dsh-fm .fm-preview{min-width:0;min-height:0;display:flex;flex-direction:column}.dsh-fm .fm-files{border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-fm .fm-pathbar{min-height:50px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-fm .fm-crumbs{display:flex;gap:2px;align-items:center;overflow:auto;min-width:0}.dsh-fm .fm-crumbs button{font-size:12px;white-space:nowrap}.dsh-fm .fm-crumbs i{font-style:normal;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-scroll{flex:1;min-height:0;overflow:auto;padding:8px}.dsh-fm .fm-entryline{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:4px;min-width:0}
.dsh-fm .fm-selection-control{display:grid;place-items:center;align-self:stretch;min-height:36px;cursor:pointer}.dsh-fm input.fm-selection[type=checkbox]{width:16px;height:16px;padding:0;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.dsh-fm input.fm-selection:disabled{cursor:not-allowed;opacity:.5}
.dsh-fm .fm-row{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;min-width:0;min-height:36px;text-align:left;padding:8px 9px;margin:1px 0;font-size:13px;line-height:20px;height:auto}
.dsh-fm .fm-filename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-fm .fm-size{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-fm .fm-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;min-height:170px;padding:28px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}
.dsh-fm .fm-preview pre,.dsh-fm .fm-editor{flex:1;min-height:160px;overflow:auto;margin:0;padding:16px;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;white-space:pre;border:0;border-radius:0;resize:none;width:100%;outline-offset:-2px}
.dsh-fm .fm-preview-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-fm .fm-actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.dsh-fm .fm-tabs{display:flex;gap:3px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:5px}
.dsh-fm .fm-tabs button{white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;font-size:12px}.dsh-fm .fm-error,.dsh-fm .fm-notice{margin:8px 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;line-height:1.5}.dsh-fm .fm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-fm footer{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:14px;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-fm .fm-more{display:block;margin:12px auto}
.dsh-fm-dialog{color:var(--dsw-alias-label-primary);font:inherit}.dsh-fm-dialog .fm-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0;font-size:13px;line-height:1.5}.dsh-fm-dialog .fm-input{width:100%;min-width:0}.dsh-fm-dialog .fm-field+.fm-input,.dsh-fm-dialog select+.fm-input{margin-top:8px}
.dsh-fm-dialog select{box-sizing:border-box;max-width:100%;min-height:36px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}.dsh-fm-dialog select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fm-dialog-content{color:var(--dsw-alias-label-primary);font:inherit}.fm-dialog-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.fm-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:0}.fm-compare pre{white-space:pre-wrap;overflow:auto;max-height:45vh;padding:12px;border:1px solid var(--dsw-alias-border-l1);font:12px/1.6 ui-monospace,monospace}.fm-compare h3{font-size:13px}.fm-compare>div{min-width:0}
@media(max-width:1100px){.dsh-fm .fm-layout{grid-template-columns:180px minmax(230px,1fr);overflow:auto}.dsh-fm .fm-preview{grid-column:1/-1;border-top:1px solid var(--dsw-alias-border-l1);min-height:270px;max-height:55vh}.dsh-fm .fm-files,.dsh-fm aside{min-height:220px}.dsh-fm footer span:last-child{display:none}}
@media(max-width:650px){.dsh-fm header{padding:16px}.dsh-fm .fm-layout{display:flex;flex-direction:column}.dsh-fm aside{min-height:0;max-height:200px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-fm .fm-files{min-height:240px}.dsh-fm .fm-preview{flex:1;max-height:none}.fm-compare{grid-template-columns:1fr}}
`;
    function FolderIcon({ size = 18, active = false }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { flex: 'none', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' } },
        h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M3 11h18', stroke: 'currentColor', strokeWidth: 1.6 }));
    }
    function FileIcon() {
      return h('svg', { width: 17, height: 19, viewBox: '0 0 20 24', fill: 'none', 'aria-hidden': true, style: { flex: 'none' } },
        h('path', { d: 'M4 2h8l5 5v15H4V2Z M12 2v6h5 M7 12h7 M7 16h7', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }));
    }

    /** Per-plugin document ownership outlives a mounted main-panel view. */
    function createDocumentStore() {
      let serial = 0;
      let state = Object.freeze({ documents: Object.freeze([]), activeId: null });
      const listeners = new Set();
      const normalize = text => text.replace(/\r\n|\r/g, '\n');
      const sameRef = (a, b) => a.rootId === b.rootId && a.path === b.path;
      const invalid = (code, message) => { throw Object.assign(new Error(message), { code }); };
      function validate(snapshot) {
        if (!snapshot || typeof snapshot.rootId !== 'string' || typeof snapshot.path !== 'string' || typeof snapshot.version !== 'string' || typeof snapshot.text !== 'string') {
          invalid('INVALID_SNAPSHOT', 'A complete file text snapshot is required.');
        }
        return { ...snapshot };
      }
      function commit(documents, activeId = state.activeId) {
        state = Object.freeze({
          documents: Object.freeze(documents.map(document => Object.freeze({ ...document, base: Object.freeze({ ...document.base }), external: document.external ? Object.freeze({ ...document.external }) : null }))),
          activeId,
        });
        for (const listener of listeners) listener();
      }
      function update(id, change) {
        if (!state.documents.some(document => document.id === id)) invalid('DOCUMENT_NOT_FOUND', 'This document is no longer open.');
        commit(state.documents.map(document => document.id === id ? change(document) : document));
      }
      return {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        activate(id) {
          if (!state.documents.some(document => document.id === id)) invalid('DOCUMENT_NOT_FOUND', 'This document is no longer open.');
          commit(state.documents, id);
        },
        open(incoming, { activate = true } = {}) {
          const next = validate(incoming);
          const previous = state.documents.find(document => sameRef(document, next));
          if (previous) {
            const changed = previous.dirty
              ? { ...previous, external: next.version === previous.base.version ? null : next, missing: false }
              : { ...previous, base: next, draft: normalize(next.text), external: null, missing: false };
            commit(state.documents.map(document => document.id === previous.id ? changed : document), activate ? previous.id : state.activeId);
            return previous.id;
          }
          const id = `document-${++serial}`;
          commit([...state.documents, { id, rootId: next.rootId, path: next.path, base: next, draft: normalize(next.text), dirty: false, external: null, missing: false, editing: false, saving: false }], activate ? id : state.activeId);
          return id;
        },
        edit(id, text) {
          if (typeof text !== 'string') invalid('INVALID_TEXT', 'The editor draft must be text.');
          update(id, document => ({ ...document, draft: text, dirty: text !== normalize(document.base.text), editing: true }));
        },
        saving(id, saving) { update(id, document => ({ ...document, saving })); },
        saved(id, receipt, submittedDraft, actualSnapshot) {
          update(id, document => {
            if (!sameRef(document, receipt)) invalid('REFERENCE_MISMATCH', 'The save receipt belongs to a different file.');
            let base;
            if (actualSnapshot) {
              base = validate(actualSnapshot);
              if (!sameRef(document, base)) invalid('REFERENCE_MISMATCH', 'The verified snapshot belongs to a different file.');
              if (base.version !== receipt.version) invalid('VERSION_CONFLICT', 'The file changed after the save receipt was issued.');
            } else {
              // Legacy uniform-EOL callers are retained; the UI always supplies
              // the verified disk snapshot and never guesses mixed/CR endings.
              if (receipt.newline === 'mixed' || receipt.newline === 'cr') invalid('INVALID_SNAPSHOT', 'Nonuniform or CR line endings require the actual saved snapshot.');
              let text = normalize(submittedDraft);
              if (receipt.newline === 'crlf') text = text.replace(/\n/g, '\r\n');
              base = { ...document.base, ...receipt, text };
            }
            return { ...document, base, dirty: document.draft !== normalize(base.text), external: null, missing: false };
          });
        },
        conflict(id, incoming) {
          const latest = validate(incoming);
          update(id, document => {
            if (!sameRef(document, latest)) invalid('REFERENCE_MISMATCH', 'The conflict snapshot belongs to a different file.');
            return { ...document, external: latest };
          });
        },
        rebase(id) {
          update(id, document => {
            if (!document.external) invalid('INVALID_STATE', 'There is no disk version to use as a new base.');
            return { ...document, base: document.external, dirty: document.draft !== normalize(document.external.text), external: null, missing: false };
          });
        },
        markMissing(rootId, prefix) {
          commit(state.documents.map(document => document.rootId === rootId && (!prefix || document.path === prefix || document.path.startsWith(`${prefix}/`)) ? { ...document, missing: true } : document));
        },
        relocate(id, incoming) {
          const next = validate(incoming);
          if (state.documents.some(document => document.id !== id && sameRef(document, next))) invalid('DOCUMENT_CONFLICT', 'The destination path already has an open document.');
          update(id, document => {
            const sameContents = document.base.text === next.text && document.base.bom === next.bom && document.base.newline === next.newline;
            return {
              ...document, rootId: next.rootId, path: next.path, missing: false,
              base: !document.dirty || sameContents ? next : { ...document.base, rootId: next.rootId, path: next.path },
              draft: document.dirty ? document.draft : normalize(next.text),
              external: document.dirty && !sameContents ? next : null,
            };
          });
        },
        close(id, { discard = false } = {}) {
          const document = state.documents.find(item => item.id === id);
          if (!document) return true;
          if (document.saving || (document.dirty && !discard)) return false;
          const next = state.documents.filter(item => item.id !== id);
          commit(next, state.activeId === id ? next.at(-1)?.id ?? null : state.activeId);
          return true;
        },
      };
    }

    function createActivityStore() {
      let state = Object.freeze({ clipboard: null, tasks: Object.freeze([]), transfers: Object.freeze([]), references: Object.freeze([]), tasksCollapsed: false, historyPending: false, historyFailures: Object.freeze([]) });
      const listeners = new Set();
      const commit = change => { state = Object.freeze({ ...state, ...change }); for (const listener of listeners) listener(); };
      return {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        clipboard(value) { commit({ clipboard: value }); },
        collapse(value) { commit({ tasksCollapsed: value === true }); },
        history(pending, failures = state.historyFailures) { commit({ historyPending: pending === true, historyFailures: Object.freeze([...failures]) }); },
        remove(kind, id) { commit({ [kind]: Object.freeze(state[kind].filter(item => item.id !== id)) }); },
        put(kind, value, { partial = false } = {}) {
          const previous = state[kind].find(item => item.id === value.id);
          const history = kind === 'tasks' || kind === 'transfers';
          const revisionOf = item => Number.isSafeInteger(item?.historyRevision) && item.historyRevision >= 0 ? item.historyRevision : 0;
          const revision = revisionOf(value);
          if (history && previous && revision < revisionOf(previous)) return false;
          if (partial && !previous) return false;
          if (previous && (!history || revision === revisionOf(previous)) && !partial && previous.updatedAt > value.updatedAt) return false;
          const next = partial ? { ...previous, ...value } : { ...value };
          if (history) {
            next.historyRevision = revision;
            const active = ['queued', 'running'].includes(next.status);
            next.dismissed = !active && (next.dismissed === true || (previous?.dismissed === true && revision === revisionOf(previous)));
          }
          commit({ [kind]: Object.freeze([...state[kind].filter(item => item.id !== value.id), Object.freeze(next)]) });
          return true;
        },
      };
    }

    /** Decode bounded SSE records without buffering a whole subscription. */
    async function consumeEvents(response, { signal, onFrame }) {
      const invalid = () => Object.assign(new Error('The file event stream is invalid.'), { code: 'EVENT_STREAM_INVALID' });
      if (!response.ok || !response.body) throw invalid();
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const abort = () => { reader.cancel().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      let buffer = '';
      let ended = false;
      try {
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) { ended = true; break; }
          buffer += decoder.decode(value, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (frame.length > 262144) throw invalid();
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (data) {
              let parsed;
              try { parsed = JSON.parse(data); } catch { throw invalid(); }
              if (!parsed || typeof parsed.kind !== 'string') throw invalid();
              await onFrame(parsed);
            }
          }
          if (buffer.length > 262144) throw invalid();
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        if (!ended) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }

    function ReferenceBridge({ t, sessionId, useInput, useSession, activity, runtime, ui }) {
      const state = React.useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot);
      const input = useInput(value => value);
      const session = useSession(value => value);
      const requests = state.references.filter(request => request.sessionId === sessionId);
      React.useEffect(() => {
        const current = activity.getSnapshot().references.filter(request => request.sessionId === sessionId);
        if (current.some(request => request.status === 'inserting')) return;
        const request = current.find(request => request.status === 'pending');
        if (!request || runtime.controller.signal.aborted) return;
        const blocked = error => activity.put('references', { ...request, status: 'blocked', error, updatedAt: Date.now() });
        if (session.removed || session.openState === 'error') { blocked('referenceTargetUnavailable'); return; }
        if (session.openState !== 'open') return;
        if (input.phase !== 'plain') { blocked('referenceBusy'); return; }
        const context = runtime.referenceScope?.(sessionId);
        if (!context) { blocked('referenceTargetUnavailable'); return; }
        const end = input.draft.length - input.occurrences.reduce((length, occurrence) => length + occurrence.length - 1, 0);
        if (!Number.isSafeInteger(end) || end < 0 || !Number.isSafeInteger(input.draftRev)) { blocked('referenceStale'); return; }
        // Claim in the root queue before invoking the business event. StrictMode,
        // another bridge render, and Promise completion cannot replay this id.
        if (activity.getSnapshot().references.find(value => value.id === request.id)?.status !== 'pending') return;
        activity.put('references', { ...request, status: 'inserting', updatedAt: Date.now() });
        const finish = accepted => {
          if (activity.getSnapshot().references.find(value => value.id === request.id)?.status !== 'inserting') return;
          if (accepted === true) activity.remove('references', request.id);
          else blocked('referenceStale');
        };
        try {
          const result = context.bail('slash/input-insert-text', {
            text: `${input.draft && !/\s$/.test(input.draft) ? ' ' : ''}${request.mentions.join(' ')} `,
            span: { start: end, end, draftRev: input.draftRev }, continue: false,
          });
          if (result && typeof result.then === 'function') result.then(finish, () => finish(false));
          else finish(result);
        } catch { finish(false); }
      }, [state.references, input, session.openState, session.removed, sessionId]);
      if (!requests.length) return null;
      return h('div', { style: { padding: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12 } }, requests.map(request => h('div', { key: request.id, role: 'status', 'data-fm-reference-status': request.status },
        h('span', null, t(request.error || 'referenceWaiting')), h('div', { style: { overflowWrap: 'anywhere', maxHeight: 100, overflow: 'auto' } }, request.mentions.join(' ')),
        request.status === 'blocked' && h(ui.Button, { variant: 'primary', size: 'sm', type: 'button', disabled: session.removed || session.openState !== 'open' || input.phase !== 'plain', onClick: () => activity.put('references', { ...request, status: 'pending', error: null, updatedAt: Date.now() }), 'data-fm-reference-action': 'retry' }, t('referenceRetry')),
        h(ui.Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: request.status === 'inserting', onClick: () => activity.remove('references', request.id), 'data-fm-reference-action': 'cancel' }, t('cancel')))));
    }

    function Panel({ t, documents, activity, ui, runtime, useSessions }) {
      const { Button, Modal, Checkbox, Input } = ui;
      const activities = React.useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot);
      const sessionCatalog = useSessions ? useSessions(value => value) : { ids: [], byId: {} };
      const sessionOptions = sessionCatalog.ids.map(id => sessionCatalog.byId[id]).filter(session => session && !session.parentId && session.origin !== 'subagent');
      const documentState = React.useSyncExternalStore(documents.subscribe, documents.getSnapshot, documents.getSnapshot);
      const active = documentState.documents.find(item => item.id === documentState.activeId);
      const [roots, setRoots] = React.useState([]);
      const [workspaces, setWorkspaces] = React.useState([]);
      const [capabilities, setCapabilities] = React.useState({});
      const [limits, setLimits] = React.useState({});
      const isActivityRunning = task => ['queued', 'running'].includes(task.status);
      const isActivityVisible = task => isActivityRunning(task) || task.dismissed !== true;
      const canDismissActivity = task => capabilities.taskHistory && !isActivityRunning(task) && ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(task.status) && !task.dismissed && task.canDismiss === true;
      const visibleTasks = activities.tasks.filter(isActivityVisible);
      const visibleTransfers = activities.transfers.filter(isActivityVisible);
      const activeActivityCount = [...visibleTasks, ...visibleTransfers].filter(task => isActivityRunning(task) || (capabilities.taskHistory && task.canDismiss === false)).length;
      const closableActivityCount = [...visibleTasks, ...visibleTransfers].filter(canDismissActivity).length;
      const [rootId, setRootId] = React.useState(runtime.location.rootId);
      const [directory, setDirectory] = React.useState(runtime.location.path);
      const [listing, setListing] = React.useState({ entries: [], total: 0, nextCursor: null });
      const [selected, setSelected] = React.useState('');
      const [selection, setSelection] = React.useState([]);
      const [nameDialog, setNameDialog] = React.useState(null);
      const [nameInput, setNameInput] = React.useState('');
      const [deleteDialog, setDeleteDialog] = React.useState(null);
      const deleteAttempt = React.useRef(null);
      const [rootRemoval, setRootRemoval] = React.useState(null);
      const rootRemovalAttempt = React.useRef(null);
      const [operationResult, setOperationResult] = React.useState(null);
      const [pastePlan, setPastePlan] = React.useState(null);
      const [uploadPlan, setUploadPlan] = React.useState(null);
      const [download, setDownload] = React.useState(null);
      const [referencePlan, setReferencePlan] = React.useState(null);
      const [referenceSession, setReferenceSession] = React.useState('');
      const [directoryFallback, setDirectoryFallback] = React.useState(false);
      const [watchStatus, setWatchStatus] = React.useState('connecting');
      const interactionBusy = React.useRef(0);
      const uploadInput = React.useRef(null);
      const directoryInput = React.useRef(null);
      const [pathInput, setPathInput] = React.useState('/');
      const [busy, setBusy] = React.useState(0);
      interactionBusy.current = busy;
      const [error, setError] = React.useState(null);
      const [closeId, setCloseId] = React.useState(null);
      const [conflictId, setConflictId] = React.useState(null);
      const alive = React.useRef(false);
      const lifetime = React.useRef(null);
      const generation = React.useRef(0);
      const fileGeneration = React.useRef(0);
      const root = roots.find(item => item.id === rootId);
      const selectedEntries = listing.entries.filter(item => selection.includes(item.path));
      const selectionSaving = documentState.documents.some(document => document.saving && document.rootId === rootId && selectedEntries.some(entry => document.path === entry.path || document.path.startsWith(`${entry.path}/`)));
      const closing = documentState.documents.find(item => item.id === closeId);
      const conflicting = documentState.documents.find(item => item.id === conflictId && item.external);
      const findDocument = id => documents.getSnapshot().documents.find(item => item.id === id);
      const isMissing = failure => ['NOT_FOUND', 'ROOT_NOT_FOUND', 'ROOT_CHANGED', 'ROOT_UNAVAILABLE'].includes(failure.code);
      const errorText = failure => {
        const key = `error.${failure?.code}`;
        const translated = t(key);
        return translated === key ? t('error.IO_ERROR') : translated;
      };
      const button = (label, props = {}) => h(Button, { variant: 'ghost', size: 'sm', type: 'button', ...props }, t(label));

      async function request(url, init, persistent = false) {
        try {
          const response = await fetch(url, { credentials: 'same-origin', ...init, signal: init.signal ?? (persistent ? runtime.controller.signal : lifetime.current?.signal) });
          const result = await response.json();
          if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
          return result.value;
        } catch (failure) {
          if (failure.code) throw failure;
          throw Object.assign(new Error('File manager connection failed.'), { code: 'TRANSPORT' });
        }
      }
      const api = (input, persistent = false, signal) => request('/api/file-manager/control', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, requestId: input.requestId ?? requestId() }), signal,
      }, persistent);
      const readText = (ref, persistent = false) => api({ op: 'text.read', rootId: ref.rootId, path: ref.path }, persistent);
      async function run(operation) {
        if (!alive.current) return;
        setBusy(value => value + 1);
        setError(null);
        try { return await operation(); }
        catch (failure) { if (alive.current && !lifetime.current?.signal.aborted) setError(failure); }
        finally { if (alive.current) setBusy(value => Math.max(0, value - 1)); }
      }
      async function listAt(id, relative, append = false, preserveSelection = false) {
        const ticket = ++generation.current;
        const value = await api({ op: 'entries.list', rootId: id, path: relative, cursor: append ? listing.nextCursor : undefined });
        if (!alive.current || ticket !== generation.current) return;
        setRootId(id); setDirectory(relative);
        runtime.location = { rootId: id, path: relative };
        setListing(previous => append ? { ...value, entries: [...previous.entries, ...value.entries] } : value);
        if (!append) {
          if (preserveSelection) setSelection(previous => previous.filter(filename => value.entries.some(entry => entry.path === filename)));
          else { setSelected(''); setSelection([]); }
        }
      }
      async function refreshDocuments(id) {
        for (const document of documents.getSnapshot().documents.filter(item => item.rootId === id && !item.saving)) {
          try {
            const snapshot = await readText(document);
            const current = findDocument(document.id);
            if (alive.current && current && !current.saving && current.rootId === document.rootId && current.path === document.path && current.base.version === document.base.version) documents.open(snapshot, { activate: false });
          } catch (failure) {
            if (isMissing(failure)) documents.markMissing(document.rootId, document.path);
            else throw failure;
          }
        }
      }
      const openDirectory = (id, relative, append = false) => run(() => listAt(id, relative, append));
      const refresh = () => run(async () => { await listAt(rootId, directory); await refreshDocuments(rootId); });
      const openFile = entry => run(async () => {
        const ticket = ++fileGeneration.current;
        setSelected(entry.path); setSelection([entry.path]);
        const existing = documents.getSnapshot().documents.find(item => item.rootId === rootId && item.path === entry.path);
        if (existing) documents.activate(existing.id);
        const value = await readText({ rootId, path: entry.path });
        if (alive.current && ticket === fileGeneration.current) documents.open(value);
      });
      async function saveDocument(id) {
        const document = findDocument(id);
        if (!capabilities.write || !document || document.missing || document.saving) return false;
        if (!document.dirty) return true;
        if (document.external) { if (alive.current) setConflictId(id); return false; }
        const submitted = document.draft;
        documents.saving(id, true);
        let actual;
        try {
          const receipt = await request('/api/file-manager/text', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'save', requestId: requestId(), rootId: document.rootId, path: document.path, expectedVersion: document.base.version, text: submitted }),
          }, true);
          actual = await readText(document, true);
          if (actual.version !== receipt.version) {
            documents.conflict(id, actual);
            throw Object.assign(new Error('The disk changed after this save.'), { code: 'VERSION_CONFLICT', details: { committed: true } });
          }
          documents.saved(id, receipt, submitted, actual);
          return true;
        } catch (failure) {
          if (isMissing(failure)) documents.markMissing(document.rootId, document.path);
          if (failure.code === 'VERSION_CONFLICT') {
            if (!actual) {
              try { actual = await readText(document, true); documents.conflict(id, actual); }
              catch (readFailure) { if (isMissing(readFailure)) documents.markMissing(document.rootId, document.path); }
            }
            if (alive.current) setConflictId(id);
          }
          throw failure;
        } finally { if (findDocument(id)) documents.saving(id, false); }
      }
      const save = id => run(() => saveDocument(id));
      const closeDocument = id => {
        if (findDocument(id)?.saving) return;
        if (!documents.close(id)) setCloseId(id);
      };
      const saveAndClose = () => run(async () => {
        const id = closeId;
        if (await saveDocument(id)) {
          if (documents.close(id) && alive.current) setCloseId(null);
        }
      });
      React.useEffect(() => {
        alive.current = true;
        lifetime.current = new AbortController();
        const controller = lifetime.current;
        run(async () => {
          const value = await api({ op: 'bootstrap' });
          if (controller.signal.aborted) return;
          setRoots(value.roots); setWorkspaces(value.workspaces ?? []);
          setCapabilities(value.capabilities ?? {}); setLimits(value.limits ?? {});
          const previous = value.roots.find(item => item.id === runtime.location.rootId);
          if (previous || value.roots[0]) await listAt((previous ?? value.roots[0]).id, previous ? runtime.location.path : '');
          await syncActivities(value.capabilities ?? {});
        });
        return () => {
          alive.current = false;
          deleteAttempt.current?.controller?.abort(); deleteAttempt.current = null;
          rootRemovalAttempt.current = null;
          controller.abort(); generation.current++; fileGeneration.current++;
        };
      }, []);
      const add = event => {
        event.preventDefault();
        return run(async () => {
          const added = await api({ op: 'roots.add', path: pathInput });
          const nextRoots = await api({ op: 'roots.list' });
          if (!alive.current) return;
          setRoots(nextRoots); await listAt(added.id, '');
        });
      };
      const beginRootRemoval = item => {
        if (!alive.current || busy || rootRemovalAttempt.current?.phase === 'committing') return;
        const attempt = { id: requestId(), root: item, phase: 'ready', error: null };
        rootRemovalAttempt.current = attempt; setRootRemoval({ ...attempt }); setError(null);
      };
      const cancelRootRemoval = id => {
        const attempt = rootRemovalAttempt.current;
        if (!attempt || attempt.id !== id || attempt.phase === 'committing') return;
        rootRemovalAttempt.current = null; setRootRemoval(null);
      };
      const confirmRootRemoval = id => {
        const attempt = rootRemovalAttempt.current;
        if (!alive.current || !attempt || attempt.id !== id || attempt.phase === 'committing' || busy) return;
        attempt.phase = 'committing'; attempt.error = null; setRootRemoval({ ...attempt });
        return run(async () => {
          try {
            await api({ op: 'roots.remove', rootId: attempt.root.id, requestId: attempt.id }, true);
            documents.markMissing(attempt.root.id, '');
            const nextRoots = await api({ op: 'roots.list' });
            if (!alive.current) return;
            if (rootRemovalAttempt.current === attempt) { rootRemovalAttempt.current = null; setRootRemoval(null); }
            setRoots(nextRoots);
            if (rootId === attempt.root.id) {
              if (nextRoots[0]) await listAt(nextRoots[0].id, '');
              else { generation.current++; setRootId(''); setDirectory(''); runtime.location = { rootId: '', path: '' }; setListing({ entries: [], total: 0, nextCursor: null }); setSelected(''); setSelection([]); }
            }
          } catch (failure) {
            if (alive.current && rootRemovalAttempt.current === attempt) { attempt.phase = 'failed'; attempt.error = failure; setRootRemoval({ ...attempt }); }
            throw failure;
          }
        });
      };
      async function putTask(task) {
        if (activity.put('tasks', task) === false) return;
        if (task.operation !== 'move') return;
        for (const item of task.items) {
          if (!item.result?.sourceRemoved || item.status !== 'completed') continue;
          const identity = `${task.id}:${item.id}`;
          if (runtime.relocations.has(identity)) continue;
          runtime.relocations.add(identity);
          for (const document of documents.getSnapshot().documents.filter(value => value.rootId === item.source.rootId && (value.path === item.source.path || value.path.startsWith(`${item.source.path}/`)))) {
            const destination = item.result.destination;
            const moved = { rootId: destination.rootId, path: destination.path + document.path.slice(item.source.path.length) };
            try { documents.relocate(document.id, await readText(moved, true)); }
            catch (failure) { documents.markMissing(document.rootId, document.path); if (alive.current) setError(failure); }
          }
        }
      }
      async function syncActivities(caps = capabilities) {
        if (caps.tasks) for (const task of await api({ op: 'tasks.list' })) await putTask(task);
        if (caps.transfers) for (const transfer of await api({ op: 'transfers.list' })) activity.put('transfers', transfer);
      }
      const refreshActivities = () => run(async () => { await syncActivities(); if (rootId) await listAt(rootId, directory); });
      const captureActivity = (kind, task) => ({ kind, taskId: task.id, expectedHistoryRevision: task.historyRevision ?? 0 });
      async function dismissActivities(candidates) {
        if (!capabilities.taskHistory || activity.getSnapshot().historyPending || !candidates.length) return;
        const failures = [];
        const accepted = [];
        const failItem = (item, error) => failures.push({ kind: item.kind, taskId: item.taskId, error });
        // Capture only this click's ids and revisions; later completions or
        // retries are never pulled into a subsequent chunk of the same clear.
        for (const item of candidates) {
          const current = activity.getSnapshot()[item.kind === 'task' ? 'tasks' : 'transfers'].find(task => task.id === item.taskId);
          if (!current || current.historyRevision !== item.expectedHistoryRevision) failItem(item, { code: 'TASK_CHANGED' });
          else if (!canDismissActivity(current)) failItem(item, { code: 'TASK_BUSY' });
          else accepted.push({ ...item });
        }
        activity.history(true, []);
        try {
          for (let offset = 0; offset < accepted.length; offset += 256) {
            const batch = accepted.slice(offset, offset + 256);
            let response;
            try {
              response = await api({ op: 'activities.dismiss', items: batch }, true);
              if (!Array.isArray(response?.results)) throw Object.assign(new Error('Invalid dismissal response.'), { code: 'INVALID_HISTORY_RESULT' });
            } catch (failure) {
              for (const item of accepted.slice(offset)) failItem(item, failure);
              break;
            }
            for (const item of batch) {
              const matches = response.results.filter(result => result.kind === item.kind && result.taskId === item.taskId);
              const result = matches.length === 1 ? matches[0] : null;
              if (result?.outcome === 'dismissed' && result.task?.id === item.taskId && result.task.dismissed === true && !isActivityRunning(result.task)
                && Number.isSafeInteger(result.task.historyRevision) && result.task.historyRevision >= item.expectedHistoryRevision) {
                if (activity.put(item.kind === 'task' ? 'tasks' : 'transfers', result.task, { partial: true }) === false) failItem(item, { code: 'TASK_CHANGED' });
              } else if (result?.outcome === 'rejected') failItem(item, result.error ?? { code: 'INVALID_HISTORY_RESULT' });
              else failItem(item, { code: 'INVALID_HISTORY_RESULT' });
            }
          }
        } finally { activity.history(false, failures); }
      }
      const clearEndedActivities = () => {
        const current = activity.getSnapshot();
        return dismissActivities([
          ...current.tasks.filter(canDismissActivity).map(task => captureActivity('task', task)),
          ...current.transfers.filter(canDismissActivity).map(task => captureActivity('transfer', task)),
        ]);
      };
      const closeActivityButton = (kind, task) => canDismissActivity(task) && h(Button, {
        variant: 'ghost', size: 'sm', type: 'button', title: t('closeTaskHint'), 'aria-label': `${t('closeTask')}: ${task.id}`,
        disabled: activities.historyPending, onClick: () => dismissActivities([captureActivity(kind, task)]),
        'data-fm-history-action': 'dismiss', 'data-fm-history-kind': kind, 'data-fm-history-id': task.id,
      }, '×');
      const activitySync = React.useRef(syncActivities);
      activitySync.current = syncActivities;
      const hasActiveTasks = activeActivityCount > 0;
      React.useEffect(() => {
        if (!hasActiveTasks || (!capabilities.tasks && !capabilities.transfers)) return;
        let updating = false;
        const timer = setInterval(async () => {
          if (updating || !alive.current) return;
          updating = true;
          try { await activitySync.current(); }
          catch (failure) { if (alive.current) setError(failure); }
          finally { updating = false; }
        }, capabilities.watch ? 5000 : 1500);
        return () => clearInterval(timer);
      }, [hasActiveTasks, capabilities.tasks, capabilities.transfers, capabilities.watch]);
      const watchTargets = [...new Map([
        ...(rootId ? [{ rootId, path: directory }] : []),
        ...documentState.documents.filter(document => !document.missing).map(document => ({ rootId: document.rootId, path: document.path.split('/').slice(0, -1).join('/') })),
      ].map(target => [JSON.stringify(target), target])).values()];
      const watchKey = JSON.stringify(watchTargets);
      const watchHandlers = React.useRef(null);
      watchHandlers.current = {
        async invalidate(ids) {
          if (!alive.current) return;
          for (const id of ids) {
            if (rootId === id) await listAt(rootId, directory, false, true);
            await refreshDocuments(id);
          }
        },
        sync: syncActivities,
        async task(id) { await putTask(await api({ op: 'tasks.get', taskId: id })); },
        async transfer(id) { activity.put('transfers', await api({ op: 'transfers.get', taskId: id })); },
      };
      React.useEffect(() => {
        if (!capabilities.watch) return;
        const targets = JSON.parse(watchKey);
        if (targets.length > 128) { setWatchStatus('unavailable'); return; }
        const lifetime = new AbortController();
        let debounce, retryTimer, retryResolve, watchdog;
        let closed = false;
        let backoff = 1000;
        const rootsToRefresh = new Set();
        const taskIds = new Set();
        const transferIds = new Set();
        const statuses = new Map();
        const abort = () => lifetime.abort();
        runtime.controller.signal.addEventListener('abort', abort, { once: true });
        async function drain() {
          if (closed) return;
          if (interactionBusy.current) { debounce = setTimeout(drain, 100); return; }
          const ids = [...rootsToRefresh]; rootsToRefresh.clear();
          const tasks = [...taskIds]; taskIds.clear();
          const transfers = [...transferIds]; transferIds.clear();
          try {
            await watchHandlers.current.invalidate(ids);
            for (const id of tasks) await watchHandlers.current.task(id);
            for (const id of transfers) await watchHandlers.current.transfer(id);
          } catch (failure) { if (!closed && alive.current) setError(failure); }
        }
        function schedule() { clearTimeout(debounce); debounce = setTimeout(drain, 80); }
        async function connect() {
          while (!closed && !lifetime.signal.aborted) {
            const connection = new AbortController();
            const disconnect = () => connection.abort();
            lifetime.signal.addEventListener('abort', disconnect, { once: true });
            let sequence = 0;
            const heartbeat = () => { clearTimeout(watchdog); watchdog = setTimeout(disconnect, 45000); };
            if (alive.current) setWatchStatus('connecting');
            try {
              const response = await fetch('/api/file-manager/events', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets }), signal: connection.signal });
              heartbeat();
              await consumeEvents(response, { signal: connection.signal, onFrame: async frame => {
                heartbeat();
                if (typeof frame.seq === 'number' && frame.seq <= sequence) return;
                if (typeof frame.seq === 'number') sequence = frame.seq;
                if (frame.kind === 'ready') {
                  backoff = 1000; statuses.clear();
                  if (!closed) setWatchStatus('watching');
                  for (const target of targets) rootsToRefresh.add(target.rootId);
                  await watchHandlers.current.sync(); schedule();
                } else if (frame.kind === 'invalidate') { rootsToRefresh.add(frame.rootId); schedule(); }
                else if (frame.kind === 'task') { taskIds.add(frame.taskId); schedule(); }
                else if (frame.kind === 'transfer') { transferIds.add(frame.taskId); schedule(); }
                else if (frame.kind === 'watch-status') {
                  statuses.set(`${frame.rootId}:${frame.path}`, frame.status);
                  const values = [...statuses.values()];
                  if (!closed) setWatchStatus(values.includes('unavailable') ? 'unavailable' : values.includes('polling') ? 'polling' : 'watching');
                }
              } });
            } catch (failure) { /* A closed or failed stream is visibly disconnected and resynchronized on ready. */ }
            finally { clearTimeout(watchdog); connection.abort(); lifetime.signal.removeEventListener('abort', disconnect); }
            if (closed || lifetime.signal.aborted) break;
            setWatchStatus('disconnected');
            await new Promise(resolve => { retryResolve = resolve; retryTimer = setTimeout(resolve, backoff); });
            retryResolve = null; backoff = Math.min(backoff * 2, 30000);
          }
        }
        connect();
        return () => {
          closed = true; lifetime.abort(); clearTimeout(debounce); clearTimeout(retryTimer); clearTimeout(watchdog); retryResolve?.();
          runtime.controller.signal.removeEventListener('abort', abort);
        };
      }, [capabilities.watch, watchKey]);
      const copySelection = operation => run(async () => {
        if (!capabilities.tasks || !selectedEntries.length || selectionSaving) return;
        const items = [];
        for (const selected of selectedEntries) {
          const entry = await api({ op: 'entries.stat', rootId, path: selected.path });
          items.push({ ...entry, rootId, expectedVersion: entry.version });
        }
        activity.clipboard({ operation, items });
      });
      const preparePaste = () => run(async () => {
        if (!capabilities.tasks || !activities.clipboard || !rootId) return;
        const destination = { rootId, path: directory };
        const items = [];
        for (const source of activities.clipboard.items) {
          let target = null;
          try { target = await api({ op: 'entries.stat', rootId, path: [directory, source.name].filter(Boolean).join('/') }); }
          catch (failure) { if (failure.code !== 'NOT_FOUND') throw failure; }
          items.push({ source, target, conflict: 'skip', name: '' });
        }
        if (alive.current) setPastePlan({ operation: activities.clipboard.operation, destination, items });
      });
      const changePaste = (index, change) => setPastePlan(plan => ({ ...plan, items: plan.items.map((item, position) => position === index ? { ...item, ...change } : item) }));
      const submitPaste = () => run(async () => {
        if (!capabilities.tasks || !pastePlan) return;
        const plan = pastePlan;
        const task = await api({ op: 'tasks.start', operation: plan.operation, destination: plan.destination, conflict: 'skip', items: plan.items.map(item => ({
          rootId: item.source.rootId, path: item.source.path, expectedVersion: item.source.expectedVersion,
          conflict: item.conflict, ...(item.conflict === 'rename' && item.name ? { name: item.name } : {}),
          ...(item.conflict === 'overwrite' ? { expectedTargetVersion: item.target.version } : {}),
        })) }, true);
        await putTask(task);
        if (plan.operation === 'move') activity.clipboard(null);
        if (alive.current) setPastePlan(null);
      });
      const taskAction = (action, task) => run(async () => {
        if (!capabilities.tasks) return;
        await putTask(await api({ op: `tasks.${action}`, taskId: task.id }, true));
      });
      async function prepareUpload(sources) {
        if (!capabilities.transfers || !rootId || !sources.length) return;
        const bounds = { maxFileBytes: 2 * 1024 ** 3, maxTaskBytes: 10 * 1024 ** 3, maxTaskEntries: 10000, ...limits };
        if (sources.length > bounds.maxTaskEntries || sources.some(item => (item.file?.size ?? 0) > bounds.maxFileBytes) || sources.reduce((total, item) => total + (item.file?.size ?? 0), 0) > bounds.maxTaskBytes) throw Object.assign(new Error('Upload selection exceeds configured limits.'), { code: 'TOO_LARGE' });
        const groups = new Map();
        for (const source of sources) {
          const name = source.path.split('/')[0];
          if (!groups.has(name)) groups.set(name, { name, kind: source.path.includes('/') ? 'directory' : source.kind, target: null, conflict: 'error', renamed: '' });
        }
        for (const group of groups.values()) {
          try { group.target = await api({ op: 'entries.stat', rootId, path: [directory, group.name].filter(Boolean).join('/') }); group.conflict = 'skip'; }
          catch (failure) { if (failure.code !== 'NOT_FOUND') throw failure; }
        }
        if (alive.current) setUploadPlan({ rootId, path: directory, sources, groups: [...groups.values()] });
      }
      const pickFiles = event => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        return run(() => prepareUpload(files.map(file => ({ path: file.webkitRelativePath || file.name, kind: 'file', file }))));
      };
      const pickDirectory = () => {
        if (!capabilities.transfers || !rootId) return;
        if (!window.showDirectoryPicker) { setDirectoryFallback(true); directoryInput.current?.click(); return; }
        return run(async () => {
          let handle;
          try { handle = await window.showDirectoryPicker({ mode: 'read' }); }
          catch (failure) { if (failure.name === 'AbortError') return; throw failure; }
          const sources = [];
          async function collect(entry, relative) {
            if (sources.length >= (limits.maxTaskEntries ?? 10000)) throw Object.assign(new Error('Too many upload entries.'), { code: 'TOO_LARGE' });
            if (entry.kind === 'directory') {
              sources.push({ path: relative, kind: 'directory' });
              for await (const [name, child] of entry.entries()) await collect(child, `${relative}/${name}`);
            } else if (entry.kind === 'file') sources.push({ path: relative, kind: 'file', file: await entry.getFile() });
          }
          await collect(handle, handle.name);
          setDirectoryFallback(false);
          await prepareUpload(sources);
        });
      };
      const changeUpload = (index, change) => setUploadPlan(plan => ({ ...plan, groups: plan.groups.map((group, position) => position === index ? { ...group, ...change } : group) }));
      async function processUpload(taskId) {
        const source = runtime.uploads.get(taskId);
        if (!source || source.working) return;
        source.working = true;
        const abort = () => source.controller.abort();
        runtime.controller.signal.addEventListener('abort', abort, { once: true });
        if (runtime.controller.signal.aborted) abort();
        const getTask = () => activity.getSnapshot().transfers.find(task => task.id === taskId);
        async function sendItem(item) {
          if (source.cancelled || getTask()?.items.find(value => value.id === item.id)?.status !== 'pending') return;
          try {
            const file = source.files.get(item.path);
            if (item.kind === 'file' && !file) throw Object.assign(new Error('The selected browser file is unavailable.'), { code: 'UPLOAD_SOURCE_LOST' });
            const response = await fetch(`/api/file-manager/upload?taskId=${encodeURIComponent(taskId)}&itemId=${encodeURIComponent(item.id)}`, {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' },
              body: item.kind === 'file' ? file : undefined, signal: source.controller.signal,
            });
            const result = await response.json();
            if (result.value) activity.put('transfers', result.value);
            if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
          } catch (failure) {
            if (!source.cancelled && alive.current) setError(failure.code ? failure : Object.assign(new Error('Upload connection failed.'), { code: 'TRANSPORT' }));
          }
        }
        try {
          const task = getTask();
          for (const item of task.items.filter(item => item.kind === 'directory')) { if (source.cancelled) break; await sendItem(item); }
          const files = task.items.filter(item => item.kind === 'file');
          let index = 0;
          await Promise.all(Array.from({ length: Math.min(limits.transferConcurrency ?? 2, files.length) }, async () => {
            while (!source.cancelled && index < files.length) await sendItem(files[index++]);
          }));
          const latest = await api({ op: 'transfers.get', taskId }, true);
          activity.put('transfers', latest);
          for (const item of latest.items) if (item.committed || item.status === 'skipped') source.files.delete(item.path);
          if (alive.current && rootId) await listAt(rootId, directory);
        } catch (failure) { if (!source.cancelled && alive.current) setError(failure); }
        finally {
          source.working = false; runtime.controller.signal.removeEventListener('abort', abort);
          const latest = getTask(); if (latest) activity.put('transfers', latest);
        }
      }
      const submitUpload = async () => {
        let accepted;
        await run(async () => {
          if (!capabilities.transfers || !uploadPlan) return;
          const plan = uploadPlan;
          const files = new Map();
          const items = plan.sources.map(source => {
            const top = source.path.split('/')[0];
            const group = plan.groups.find(item => item.name === top);
            if (group.conflict === 'rename' && (!group.renamed || group.renamed.includes('/') || group.renamed === '.' || group.renamed === '..')) throw Object.assign(new Error('A renamed upload requires a single name.'), { code: 'INVALID_PATH' });
            const filename = group.conflict === 'rename' ? group.renamed + source.path.slice(top.length) : source.path;
            if (source.file) files.set(filename, source.file);
            return { path: filename, kind: source.kind, size: source.file?.size ?? 0,
              conflict: group.conflict === 'rename' ? 'error' : group.conflict,
              ...(group.conflict === 'overwrite' && source.path === top ? { expectedVersion: group.target.version } : {}),
            };
          });
          accepted = await api({ op: 'transfers.begin', direction: 'upload', rootId: plan.rootId, path: plan.path, items }, true);
          runtime.uploads.set(accepted.id, { files, controller: new AbortController(), cancelled: false, working: false });
          activity.put('transfers', accepted);
          if (alive.current) setUploadPlan(null);
        });
        if (accepted) await processUpload(accepted.id);
      };
      const canRetryTransfer = task => task.direction === 'download' || (runtime.uploads.has(task.id) && !runtime.uploads.get(task.id).working && task.items.filter(item => !item.committed && item.kind === 'file' && ['failed', 'cancelled'].includes(item.status)).every(item => runtime.uploads.get(task.id).files.has(item.path)));
      const transferAction = async (action, task) => {
        let retry;
        await run(async () => {
          if (!capabilities.transfers) return;
          const source = runtime.uploads.get(task.id);
          if (action === 'cancel' && source) { source.cancelled = true; source.controller.abort(); }
          if (action === 'retry' && !canRetryTransfer(task)) throw Object.assign(new Error('Upload source files must be selected again.'), { code: 'UPLOAD_SOURCE_LOST' });
          const result = await api({ op: `transfers.${action}`, taskId: task.id }, true);
          activity.put('transfers', result);
          if (action === 'retry') {
            if (task.direction === 'download') setDownload(result);
            else { source.cancelled = false; source.controller = new AbortController(); retry = result.id; }
          }
        });
        if (retry) await processUpload(retry);
      };
      const beginDownload = () => run(async () => {
        if (!capabilities.transfers || !rootId || selectedEntries.length > 1) return;
        const selected = selectedEntries[0];
        const snapshot = selected ? await api({ op: 'entries.stat', rootId, path: selected.path }) : null;
        const task = await api({ op: 'transfers.begin', direction: 'download', rootId, path: selected?.path ?? directory, ...(snapshot ? { expectedVersion: snapshot.version } : {}) }, true);
        activity.put('transfers', task);
        if (alive.current) setDownload(task);
      });
      const beginReference = () => run(async () => {
        if (!capabilities.references || !runtime.openSession || !selectedEntries.length) return;
        const references = [];
        for (const entry of selectedEntries) references.push(await api({ op: 'entries.reference', rootId, path: entry.path }));
        if (alive.current) { setReferencePlan(references); setReferenceSession(''); }
      });
      const submitReference = () => run(async () => {
        if (!referencePlan || !runtime.openSession || !capabilities.references) return;
        const target = sessionOptions.find(session => session.id === referenceSession);
        if (!target) throw Object.assign(new Error('The selected session is unavailable.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' });
        if (target.running) throw Object.assign(new Error('The selected session is busy.'), { code: 'REFERENCE_BUSY' });
        const pending = { id: requestId(), sessionId: target.id, mentions: referencePlan.map(entry => entry.mention), status: 'pending', error: null, createdAt: Date.now(), updatedAt: Date.now() };
        activity.put('references', pending);
        try { runtime.openSession(target.id); }
        catch (failure) { activity.put('references', { ...pending, status: 'blocked', error: 'referenceTargetUnavailable', updatedAt: Date.now() }); throw Object.assign(new Error('Opening the session failed.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' }); }
        if (alive.current) setReferencePlan(null);
      });
      const retryReference = request => run(async () => {
        if (activity.getSnapshot().references.find(item => item.id === request.id)?.status === 'inserting') return;
        const target = sessionOptions.find(session => session.id === request.sessionId);
        if (!target || !runtime.openSession) throw Object.assign(new Error('The selected session is unavailable.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' });
        if (target.running) throw Object.assign(new Error('The selected session is busy.'), { code: 'REFERENCE_BUSY' });
        activity.put('references', { ...request, status: 'pending', error: null, updatedAt: Date.now() });
        try { runtime.openSession(request.sessionId); }
        catch { activity.put('references', { ...request, status: 'blocked', error: 'referenceTargetUnavailable', updatedAt: Date.now() }); throw Object.assign(new Error('Opening the session failed.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' }); }
      });
      const beginName = kind => run(async () => {
        if (!capabilities.write || !rootId || busy || selectionSaving) return;
        if (kind === 'rename' && selectedEntries.length !== 1) return;
        const entry = kind === 'rename' ? await api({ op: 'entries.stat', rootId, path: selectedEntries[0].path }) : null;
        if (alive.current) { setNameInput(entry?.name ?? ''); setNameDialog({ kind, rootId, directory, entry }); }
      });
      const submitName = () => run(async () => {
        if (!capabilities.write || !nameDialog) return;
        if (!nameInput || nameInput === '.' || nameInput === '..' || /[\/\0]/.test(nameInput)) throw Object.assign(new Error('A single name is required.'), { code: 'INVALID_PATH' });
        const operation = nameDialog;
        if (operation.kind === 'rename') {
          const source = operation.entry;
          const result = await api({ op: 'entries.rename', rootId: operation.rootId, path: source.path, name: nameInput, expectedVersion: source.version }, true);
          const affected = documents.getSnapshot().documents.filter(document => document.rootId === operation.rootId && (document.path === source.path || document.path.startsWith(`${source.path}/`)));
          for (const document of affected) {
            const nextPath = result.path + document.path.slice(source.path.length);
            try { documents.relocate(document.id, await readText({ rootId: operation.rootId, path: nextPath }, true)); }
            catch (failure) { documents.markMissing(document.rootId, document.path); throw failure; }
          }
        } else {
          const filename = [operation.directory, nameInput].filter(Boolean).join('/');
          await api({ op: operation.kind === 'file' ? 'entries.create-file' : 'entries.create-directory', rootId: operation.rootId, path: filename }, true);
          if (operation.kind === 'file') documents.open(await readText({ rootId: operation.rootId, path: filename }, true));
        }
        if (alive.current) { setNameDialog(null); await listAt(operation.rootId, operation.directory); }
      });
      const publishDelete = (attempt, change) => {
        if (!alive.current || deleteAttempt.current !== attempt) return;
        Object.assign(attempt, change); setDeleteDialog({ ...attempt });
      };
      const cancelDelete = id => {
        const attempt = deleteAttempt.current;
        if (!attempt || attempt.id !== id || attempt.phase === 'committing') return;
        deleteAttempt.current = null; attempt.controller.abort(); setDeleteDialog(null);
      };
      const acknowledgeDelete = (id, acknowledged) => {
        const attempt = deleteAttempt.current;
        if (!attempt || attempt.id !== id || attempt.phase !== 'ready' || !attempt.plan) return;
        publishDelete(attempt, { acknowledged: acknowledged === true });
      };
      const prepareDelete = async () => {
        if (!alive.current || !capabilities.write || !selectedEntries.length || selectionSaving || busy || deleteAttempt.current?.phase === 'committing') return;
        deleteAttempt.current?.controller.abort();
        const attempt = {
          id: requestId(), phase: 'preparing', controller: new AbortController(), acknowledged: false, plan: null, error: null,
          targets: selectedEntries.map(entry => ({ rootId, path: entry.path })),
        };
        deleteAttempt.current = attempt;
        setError(null); setOperationResult(null); setDeleteDialog({ ...attempt });
        const parentSignal = lifetime.current.signal;
        const abort = () => attempt.controller.abort();
        parentSignal.addEventListener('abort', abort, { once: true });
        try {
          const plan = await api({ op: 'delete.prepare', items: attempt.targets }, false, attempt.controller.signal);
          if (!alive.current || deleteAttempt.current !== attempt || attempt.controller.signal.aborted) return;
          const validTargets = Array.isArray(plan?.targets) && plan.targets.length > 0 && plan.targets.every(target => attempt.targets.some(selected => target.rootId === selected.rootId && target.path === selected.path));
          const validEntries = Array.isArray(plan?.entries) && plan.entries.length > 0 && plan.entries.length === plan.entryCount && plan.entries.every(entry =>
            typeof entry.path === 'string' && typeof entry.version === 'string' && entry.version.length > 0 && ['file', 'directory', 'symlink'].includes(entry.kind)
            && validTargets && plan.targets.some(target => entry.rootId === target.rootId && (entry.path === target.path || entry.path.startsWith(`${target.path}/`))));
          if (!plan || typeof plan.id !== 'string' || !plan.id || plan.permanent !== true || !Number.isFinite(plan.expiresAt) || !validTargets || !validEntries) {
            throw Object.assign(new Error('The server did not return a reviewable deletion manifest.'), { code: 'INVALID_DELETE_PLAN' });
          }
          publishDelete(attempt, { phase: 'ready', plan, acknowledged: false });
        } catch (failure) {
          if (!attempt.controller.signal.aborted) publishDelete(attempt, { phase: 'failed', plan: null, acknowledged: false, error: failure });
        } finally { parentSignal.removeEventListener('abort', abort); }
      };
      const commitDelete = id => {
        const attempt = deleteAttempt.current;
        if (!alive.current || !capabilities.write || !attempt || attempt.id !== id || attempt.phase !== 'ready' || !attempt.plan || !attempt.acknowledged || busy) return;
        const plan = attempt.plan;
        publishDelete(attempt, { phase: 'committing', acknowledged: false });
        return run(async () => {
          try {
            const result = await api({ op: 'delete.commit', planId: plan.id, confirmed: true }, true);
            for (const item of result.results) if (item.status === 'completed' || item.removed) documents.markMissing(item.rootId, item.path);
            if (alive.current) {
              setOperationResult(result);
              if (deleteAttempt.current === attempt) { deleteAttempt.current = null; setDeleteDialog(null); }
              await listAt(rootId, directory);
            }
          } catch (failure) {
            publishDelete(attempt, { phase: 'failed', plan: null, acknowledged: false, error: failure });
            throw failure;
          }
        });
      };
      const crumbs = directory ? directory.split('/') : [];
      return h('section', { className: 'dsh-fm', 'aria-label': t('title'), 'data-fm-version': '0.1.4' },
        h('style', null, css),
        h('header', null, h('div', null, h('h1', null, t('title')), h('div', { className: 'fm-subtitle' }, t('subtitle'))), h('span', { className: 'fm-badge' }, t('stage'))),
        error && h('div', { className: 'fm-error', role: 'alert' }, errorText(error)),
        capabilities.watch && h('div', { className: 'fm-muted', role: 'status', 'data-fm-watch': watchStatus, style: { padding: '6px 14px' } }, t(`watch.${watchStatus}`)),
        activities.references.length > 0 && h('div', { style: { maxHeight: '18vh', overflow: 'auto' } }, activities.references.map(request => h('div', { key: request.id, className: 'fm-notice', 'data-fm-reference-request': request.sessionId },
          h('span', null, `${sessionOptions.find(session => session.id === request.sessionId)?.displayTitle ?? request.sessionId}: ${t(request.error || 'referenceWaiting')}`),
          button('referenceRetry', { disabled: busy > 0 || request.status === 'inserting', onClick: () => retryReference(request) }),
          button('cancel', { disabled: request.status === 'inserting', onClick: () => { if (activity.getSnapshot().references.find(item => item.id === request.id)?.status !== 'inserting') activity.remove('references', request.id); } })))),
        h('div', { className: 'fm-layout' },
          h('aside', null,
            h('h2', null, t('roots')),
            roots.map(item => h('div', { className: 'fm-rootrow', key: item.id },
              h(Button, { variant: 'ghost', size: 'sm', type: 'button', className: item.id === rootId ? 'fm-active' : '', title: item.path, disabled: busy > 0, onClick: () => openDirectory(item.id, ''), 'data-fm-root': true }, h(FolderIcon, { size: 16, active: item.id === rootId }), h('span', null, item.label)),
              h(Button, { variant: 'ghost', size: 'sm', type: 'button', title: t('removeRoot'), 'aria-label': `${t('removeRoot')}: ${item.label}`, disabled: busy > 0, onClick: () => beginRootRemoval(item) }, '×'))),
            h('form', { onSubmit: add, 'data-fm-add-root': true },
              h('input', { value: pathInput, placeholder: t('pathPlaceholder'), 'aria-label': t('pathPlaceholder'), list: 'dsh-fm-workspace-candidates', required: true, disabled: busy > 0, onChange: event => setPathInput(event.target.value), 'data-fm-add-path': true }),
              h('datalist', { id: 'dsh-fm-workspace-candidates' }, workspaces.map(workspace => h('option', { key: workspace.id, value: workspace.path }, workspace.title))),
              button('add', { type: 'submit', variant: 'primary', disabled: busy > 0 || !pathInput.trim() })),
            capabilities.persistentRoots === false && h('p', { className: 'fm-muted' }, t('notPersistent'))),
          h('section', { className: 'fm-files' },
            h('div', { className: 'fm-pathbar' },
              h('nav', { className: 'fm-crumbs', 'aria-label': t('roots') },
                root && h(Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: busy > 0, title: root.path, onClick: () => openDirectory(rootId, '') }, root.label),
                crumbs.map((part, index) => h(React.Fragment, { key: index }, h('i', { 'aria-hidden': true }, '/'), h(Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: busy > 0, onClick: () => openDirectory(rootId, crumbs.slice(0, index + 1).join('/')) }, part)))),
              button('refresh', { disabled: !rootId || busy > 0, onClick: refresh, 'data-fm-action': 'refresh' })),
            h('div', { className: 'fm-pathbar fm-actions' },
              button('newFile', { disabled: !capabilities.write || !rootId || busy > 0, onClick: () => beginName('file'), 'data-fm-action': 'new-file' }),
              button('newDirectory', { disabled: !capabilities.write || !rootId || busy > 0, onClick: () => beginName('directory'), 'data-fm-action': 'new-directory' }),
              button('rename', { disabled: !capabilities.write || selectedEntries.length !== 1 || busy > 0 || selectionSaving, onClick: () => beginName('rename'), 'data-fm-action': 'rename' }),
              button('delete', { disabled: !capabilities.write || !selectedEntries.length || busy > 0 || selectionSaving, onClick: prepareDelete, 'data-fm-action': 'delete' }),
              button('copy', { disabled: !capabilities.tasks || !selectedEntries.length || busy > 0 || selectionSaving, onClick: () => copySelection('copy'), 'data-fm-action': 'copy' }),
              button('cut', { disabled: !capabilities.tasks || !selectedEntries.length || busy > 0 || selectionSaving, onClick: () => copySelection('move'), 'data-fm-action': 'cut' }),
              button('paste', { disabled: !capabilities.tasks || !activities.clipboard || !rootId || busy > 0, onClick: preparePaste, 'data-fm-action': 'paste' }),
              button('uploadFiles', { disabled: !capabilities.transfers || !rootId || busy > 0, onClick: () => uploadInput.current?.click(), 'data-fm-action': 'upload-files' }),
              button('uploadDirectory', { disabled: !capabilities.transfers || !rootId || busy > 0, onClick: pickDirectory, 'data-fm-action': 'upload-directory' }),
              button('download', { disabled: !capabilities.transfers || !rootId || selectedEntries.length > 1 || busy > 0, onClick: beginDownload, 'data-fm-action': 'download' }),
              button('reference', { disabled: !capabilities.references || !runtime.openSession || !useSessions || !selectedEntries.length || busy > 0, onClick: beginReference, 'data-fm-action': 'reference' }),
              h('input', { type: 'file', multiple: true, hidden: true, ref: uploadInput, disabled: !capabilities.transfers, onChange: pickFiles, 'aria-label': t('uploadFiles'), 'data-fm-upload-files': true }),
              h('input', { type: 'file', multiple: true, webkitdirectory: '', hidden: true, ref: directoryInput, disabled: !capabilities.transfers, onChange: pickFiles, 'aria-label': t('uploadDirectory'), 'data-fm-upload-directory-input': true })),
            directoryFallback && h('div', { className: 'fm-notice' }, t('directoryFallback')),
            activities.clipboard && h('div', { className: 'fm-muted', style: { padding: '4px 12px' } }, `${t('clipboard')}: ${t(activities.clipboard.operation === 'move' ? 'cut' : 'copy')} · ${activities.clipboard.items.length} ${t('items')}`),
            selectedEntries.length > 0 && h('div', { className: 'fm-muted', style: { padding: '4px 12px' } }, `${selectedEntries.length} ${t('selected')}`),
            operationResult && h('div', { className: 'fm-notice', 'data-fm-operation-result': operationResult.status }, t(`status.${operationResult.status}`), operationResult.results.map((item, index) => h('div', { key: index }, `${item.path}: ${t(`status.${item.status}`)}${item.error ? ` · ${errorText(item.error)}` : ''}`))),
            h('div', { className: 'fm-scroll', 'aria-busy': busy > 0 },
              !rootId && h('div', { className: 'fm-placeholder' }, h(FolderIcon, { size: 34 }), busy ? t('loading') : t('emptyRoots')),
              rootId && listing.entries.length === 0 && h('div', { className: 'fm-placeholder' }, busy ? t('loading') : t('empty')),
              listing.entries.map(entry => h('div', { key: entry.path, className: 'fm-entryline' },
                h('label', { className: 'fm-selection-control', title: `${t('select')}: ${entry.name}` },
                  h('input', { type: 'checkbox', className: 'fm-selection', checked: selection.includes(entry.path), disabled: busy > 0 || !['file', 'directory', 'symlink'].includes(entry.kind), 'aria-label': `${t('select')}: ${entry.name}`, onChange: event => {
                    const checked = event.target.checked;
                    setSelection(previous => checked ? [...new Set([...previous, entry.path])] : previous.filter(item => item !== entry.path));
                  } })),
                h(Button, {
                  variant: 'ghost', size: 'sm', type: 'button', className: `fm-row${entry.path === selected ? ' fm-active' : ''}`,
                  disabled: busy > 0 || !['directory', 'file'].includes(entry.kind), title: ['directory', 'file'].includes(entry.kind) ? entry.name : t('special'),
                  onClick: () => entry.kind === 'directory' ? openDirectory(rootId, entry.path) : openFile(entry),
                  'data-fm-entry': entry.kind, 'data-fm-path': entry.path,
                }, entry.kind === 'directory' ? h(FolderIcon, { size: 17 }) : h(FileIcon), h('span', { className: 'fm-filename' }, entry.name), entry.kind === 'file' && h('span', { className: 'fm-size' }, `${entry.size.toLocaleString()} ${t('bytes')}`)))),
              listing.nextCursor && button('more', { className: 'fm-more', disabled: busy > 0, onClick: () => openDirectory(rootId, directory, true) }))),
          h('section', { className: 'fm-preview' },
            documentState.documents.length > 0 && h('nav', { className: 'fm-tabs', 'aria-label': t('openDocuments') }, documentState.documents.map(document => h(Button, { key: document.id, variant: 'ghost', size: 'sm', type: 'button', className: document.id === active?.id ? 'fm-active' : '', title: `${document.rootId}: ${document.path}`, onClick: () => documents.activate(document.id), 'data-fm-tab': document.id }, `${document.dirty ? '● ' : ''}${document.path.split('/').at(-1)}`))),
            h('div', { className: 'fm-pathbar' },
              h('span', { className: 'fm-preview-title', title: active?.path }, active?.path || t('preview')),
              active && h('div', { className: 'fm-actions' },
                !active.editing && button('edit', { disabled: !capabilities.write || active.missing, onClick: () => documents.edit(active.id, active.draft), 'data-fm-action': 'edit' }),
                active.editing && button(active.saving ? 'saving' : 'save', { variant: 'primary', disabled: !capabilities.write || !active.dirty || active.saving || active.missing, onClick: () => save(active.id), 'data-fm-action': 'save' }),
                button('closeDocument', { disabled: active.saving, onClick: () => closeDocument(active.id), 'data-fm-action': 'close-document' }))),
            active?.missing && h('div', { className: 'fm-error', 'data-fm-missing': true }, t('missing')),
            active?.external && h('div', { className: 'fm-notice', 'data-fm-external-change': true }, t('external'), ' ', button('compare', { onClick: () => setConflictId(active.id) })),
            active ? (active.editing
              ? h('textarea', { className: 'fm-editor', 'data-fm-editor': true, 'aria-label': `${t('editor')}: ${active.path}`, value: active.draft, readOnly: !capabilities.write, spellCheck: false, onChange: event => documents.edit(active.id, event.target.value), onKeyDown: event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(active.id); } } })
              : h('pre', { 'data-fm-preview': 'text' }, active.base.text))
              : h('div', { className: 'fm-placeholder' }, h(FileIcon), t('selectFile')),
            active && h('footer', null,
              h('span', { role: 'status', 'data-fm-document-state': active.dirty ? 'dirty' : 'clean' }, t(active.saving ? 'saving' : active.dirty ? 'dirty' : 'saved')),
              h('span', null, `UTF-8${active.base.bom ? ' · BOM' : ''} · ${active.base.newline.toUpperCase()}${limits.maxTextBytes ? ` · ≤${Math.round(limits.maxTextBytes / 1024)} KiB` : ''}`)))),
        (capabilities.tasks || capabilities.transfers) && h('section', { className: 'fm-taskarea', 'aria-label': t('tasks'), style: { maxHeight: '24vh', overflow: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
          h('div', { className: 'fm-pathbar' },
            h('div', { className: 'fm-actions' }, h('strong', null, t('tasks')), h('span', { 'data-fm-active-count': activeActivityCount }, `${activeActivityCount} ${t('activeTasks')}`)),
            h('div', { className: 'fm-actions' },
              button('refreshTasks', { onClick: refreshActivities, disabled: busy > 0, 'data-fm-action': 'refresh-tasks' }),
              capabilities.taskHistory && button('clearEndedTasks', { onClick: clearEndedActivities, disabled: activities.historyPending || !closableActivityCount, title: t('closeTaskHint'), 'data-fm-history-action': 'clear' }),
              button(activities.tasksCollapsed ? 'expandTasks' : 'collapseTasks', { onClick: () => activity.collapse(!activities.tasksCollapsed), 'aria-expanded': !activities.tasksCollapsed, 'aria-controls': 'dsh-fm-task-cards', 'data-fm-history-action': 'toggle' }))),
          activities.historyFailures.length > 0 && h('div', { className: 'fm-error', role: 'alert', 'data-fm-history-errors': true }, t('historyFailures'), activities.historyFailures.map((failure, index) => h('div', { key: index }, `${failure.taskId}: ${errorText(failure.error)}`))),
          h('div', { id: 'dsh-fm-task-cards', hidden: activities.tasksCollapsed, 'data-fm-task-cards': true },
          visibleTasks.map(task => h('article', { key: task.id, className: 'fm-notice', 'data-fm-task-id': task.id, 'data-fm-task-status': task.status },
            h('div', { className: 'fm-actions' }, h('strong', null, `${t(task.operation === 'move' ? 'moveTask' : 'copyTask')} · ${t(`status.${task.status}`)}`),
              h('span', null, `${task.progress.completed}/${task.progress.total} ${t('items')} · ${task.progress.bytes.toLocaleString()} ${t('bytes')}`),
              ['queued', 'running'].includes(task.status) && button('cancelTask', { onClick: () => taskAction('cancel', task), disabled: Boolean(task.cancelRequested), 'data-fm-task-action': 'cancel', 'data-fm-task-id': task.id }),
              !['queued', 'running'].includes(task.status) && task.items.some(item => item.status === 'failed') && button('retry', { onClick: () => taskAction('retry', task), disabled: busy > 0, 'data-fm-task-action': 'retry', 'data-fm-task-id': task.id }),
              closeActivityButton('task', task)),
            h('progress', { max: task.progress.totalBytes || Math.max(1, task.progress.total), value: task.progress.totalBytes ? task.progress.bytes : task.progress.completed + task.progress.failed + task.progress.skipped + task.progress.cancelled, 'aria-label': t('tasks') }),
            task.items.map(item => h('div', { key: item.id }, `${item.source.path} → ${item.result?.destination?.path ?? item.destination.path}: ${t(`status.${item.status}`)}`,
              item.error && h('span', null, ` · ${errorText(item.error)}`), item.error?.details?.committed && h('strong', null, ` · ${t('targetCommitted')}`))))),
          visibleTransfers.map(task => h('article', { key: task.id, className: 'fm-notice', 'data-fm-transfer-id': task.id, 'data-fm-transfer-status': task.status },
            h('div', { className: 'fm-actions' }, h('strong', null, `${t(task.direction === 'upload' ? 'uploadTask' : 'downloadTask')} · ${t(task.direction === 'download' && task.completion === 'server-stream-finished' ? 'serverFinished' : `status.${task.status}`)}`),
              h('span', null, `${task.itemsCompleted}/${task.itemsTotal} ${t('items')} · ${task.bytesTransferred.toLocaleString()}/${task.bytesTotal.toLocaleString()} ${t('bytes')}`),
              ['queued', 'running'].includes(task.status) && button('cancelTask', { onClick: () => transferAction('cancel', task), 'data-fm-transfer-action': 'cancel', 'data-fm-transfer-id': task.id }),
              !['queued', 'running', 'completed'].includes(task.status) && button('retry', { disabled: busy > 0 || !canRetryTransfer(task), onClick: () => transferAction('retry', task), 'data-fm-transfer-action': 'retry', 'data-fm-transfer-id': task.id }),
              closeActivityButton('transfer', task)),
            h('progress', { max: Math.max(1, task.bytesTotal), value: task.bytesTransferred, 'aria-label': t(task.direction === 'upload' ? 'uploadTask' : 'downloadTask') }),
            task.items.map(item => h('div', { key: item.id }, `${item.path}: ${t(`status.${item.status}`)}`, item.error && h('span', null, ` · ${errorText(item.error)}`), item.error?.details?.committed && h('strong', null, ` · ${t('targetCommitted')}`))),
            task.error && h('div', null, errorText(task.error)))))),
        h('footer', null, h('span', { role: 'status', 'aria-live': 'polite' }, busy ? t('loading') : `${listing.entries.length} / ${listing.total} ${t('items')}`), h('span', null, t('note'))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(referencePlan), onClose: () => { if (!busy) setReferencePlan(null); }, title: t('referenceTitle'), closeLabel: t('close'), description: t('referenceDescription'),
          footer: h('div', { className: 'fm-dialog-actions' }, button('cancel', { disabled: busy > 0, onClick: () => setReferencePlan(null) }), button('referenceConfirm', { variant: 'primary', disabled: busy > 0 || !referenceSession, onClick: submitReference, 'data-fm-action': 'reference-confirm' })) },
          referencePlan && h('div', { className: 'fm-dialog-content' },
            h('label', { className: 'fm-field' }, t('referenceSession'), h('select', { value: referenceSession, 'data-fm-reference-session': true, disabled: busy > 0, onChange: event => setReferenceSession(event.target.value) },
              h('option', { value: '' }, t('referenceSelect')), sessionOptions.map(session => h('option', { key: session.id, value: session.id }, session.displayTitle)))),
            h('div', { style: { maxHeight: '30vh', overflow: 'auto', overflowWrap: 'anywhere' } }, referencePlan.map((entry, index) => h('div', { key: index }, entry.mention))),
            error && h('div', { role: 'alert' }, errorText(error)))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(uploadPlan), onClose: () => { if (!busy) setUploadPlan(null); }, title: t('uploadTitle'), closeLabel: t('close'), description: t('uploadDescription'),
          footer: h('div', { className: 'fm-dialog-actions' }, button('cancel', { disabled: busy > 0, onClick: () => setUploadPlan(null) }), button('uploadConfirm', { variant: 'primary', disabled: busy > 0 || !capabilities.transfers || uploadPlan?.groups.some(group => group.conflict === 'rename' && !group.renamed), onClick: submitUpload, 'data-fm-action': 'upload-confirm' })) },
          uploadPlan && h('div', { className: 'fm-dialog-content', style: { maxHeight: '45vh', overflow: 'auto' } },
            h('p', null, `${uploadPlan.sources.length} ${t('items')} · ${uploadPlan.sources.reduce((total, item) => total + (item.file?.size ?? 0), 0).toLocaleString()} ${t('bytes')}`),
            uploadPlan.groups.map((group, index) => h('div', { key: group.name, style: { marginBottom: 12 } }, h('strong', null, group.name), ' ',
              h('select', { value: group.conflict, 'aria-label': `${t('name')}: ${group.name}`, 'data-fm-upload-policy': index, disabled: busy > 0, onChange: event => changeUpload(index, { conflict: event.target.value }) },
                !group.target && h('option', { value: 'error' }, t('uploadFiles')), h('option', { value: 'skip' }, t('skip')), h('option', { value: 'rename' }, t('renameConflict')),
                group.kind === 'file' && group.target?.kind === 'file' && h('option', { value: 'overwrite' }, t('overwrite'))),
              group.conflict === 'rename' && h(Input, { className: 'fm-input', value: group.renamed, 'aria-label': `${t('rename')}: ${group.name}`, onChange: event => changeUpload(index, { renamed: event.target.value }) }),
              group.target && h('details', null, h('summary', null, t('versions')), h('code', null, group.target.version)))),
            error && h('div', { role: 'alert' }, errorText(error)))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(download), onClose: () => setDownload(null), title: t('downloadTitle'), closeLabel: t('close'), description: t('downloadNote'),
          footer: button('close', { onClick: () => setDownload(null) }) }, download && h('div', { className: 'fm-dialog-content' },
            h('p', { 'data-fm-download-note': true }, t('downloadNote')),
            h('a', { href: `/api/file-manager/download?taskId=${encodeURIComponent(download.id)}`, download: download.downloadName || '', 'data-fm-download': true }, t('downloadStart')))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(pastePlan), onClose: () => { if (!busy) setPastePlan(null); }, title: t('pasteTitle'), closeLabel: t('close'), description: t('pasteDescription'),
          footer: h('div', { className: 'fm-dialog-actions' }, button('cancel', { disabled: busy > 0, onClick: () => setPastePlan(null) }), button('pasteConfirm', { variant: 'primary', disabled: busy > 0 || !capabilities.tasks, onClick: submitPaste, 'data-fm-action': 'paste-confirm' })) },
          pastePlan && h('div', { className: 'fm-dialog-content', style: { maxHeight: '50vh', overflow: 'auto' } }, pastePlan.items.map((item, index) => h('div', { key: index, style: { marginBottom: 14 } },
            h('div', null, `${item.source.path} → ${[pastePlan.destination.path, item.name || item.source.name].filter(Boolean).join('/')}`),
            h('label', { className: 'fm-field' }, t('name'), h('select', { value: item.conflict, 'data-fm-conflict-policy': index, disabled: busy > 0, onChange: event => changePaste(index, { conflict: event.target.value }) },
              h('option', { value: 'skip' }, t('skip')), h('option', { value: 'rename' }, t('renameConflict')),
              item.source.kind === 'file' && item.target?.kind === 'file' && h('option', { value: 'overwrite' }, t('overwrite')))),
            item.conflict === 'rename' && h(Input, { className: 'fm-input', value: item.name, placeholder: item.source.name, 'aria-label': `${t('rename')}: ${item.source.name}`, 'data-fm-paste-name': index, disabled: busy > 0, onChange: event => changePaste(index, { name: event.target.value }) }),
            item.target && h('details', null, h('summary', null, t('versions')), h('code', null, item.target.version)))), error && h('div', { role: 'alert' }, errorText(error)))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(nameDialog), onClose: () => { if (!busy) setNameDialog(null); }, title: t(nameDialog?.kind === 'rename' ? 'rename' : nameDialog?.kind === 'directory' ? 'newDirectory' : 'newFile'), closeLabel: t('close'), description: t('nameDescription'),
          footer: h('div', { className: 'fm-dialog-actions' }, button('cancel', { disabled: busy > 0, onClick: () => setNameDialog(null) }), button('applyName', { variant: 'primary', disabled: busy > 0 || !nameInput || !capabilities.write, onClick: submitName, 'data-fm-action': 'name-submit' })) },
          nameDialog && h('div', { className: 'fm-dialog-content' },
            h('label', { className: 'fm-field' }, t('name'), h(Input, { className: 'fm-input', autoFocus: true, value: nameInput, disabled: busy > 0, 'aria-label': t('name'), 'data-fm-name': true, onChange: event => setNameInput(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !busy) { event.preventDefault(); submitName(); } } })),
            error && h('div', { role: 'alert' }, errorText(error)))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(rootRemoval), onClose: () => cancelRootRemoval(rootRemoval?.id), title: t('removeRootTitle'), closeLabel: t('close'), description: t('removeRootDescription'),
          footer: h('div', { className: 'fm-dialog-actions' },
            button('cancel', { disabled: rootRemoval?.phase === 'committing', onClick: () => cancelRootRemoval(rootRemoval?.id), 'data-fm-action': 'remove-root-cancel' }),
            button('removeRootConfirm', { variant: 'primary', disabled: rootRemoval?.phase === 'committing' || busy > 0, onClick: () => confirmRootRemoval(rootRemoval?.id), 'data-fm-action': 'remove-root-confirm' })) },
          rootRemoval && h('div', { className: 'fm-dialog-content' },
            h('p', { 'data-fm-remove-root-preview': true, style: { overflowWrap: 'anywhere' } }, rootRemoval.root.path),
            rootRemoval.phase === 'committing' && h('p', { role: 'status' }, t('removeRootWorking')),
            rootRemoval.error && h('div', { role: 'alert' }, errorText(rootRemoval.error)))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(deleteDialog), onClose: () => cancelDelete(deleteDialog?.id), title: t('deleteTitle'), closeLabel: t('close'), description: t('deleteDescription'),
          footer: h('div', { className: 'fm-dialog-actions' },
            button('cancel', { disabled: deleteDialog?.phase === 'committing', onClick: () => cancelDelete(deleteDialog?.id), 'data-fm-action': 'delete-cancel' }),
            button('deleteConfirm', { variant: 'primary', disabled: deleteDialog?.phase !== 'ready' || !deleteDialog?.plan || !deleteDialog.acknowledged || busy > 0 || !capabilities.write, onClick: () => commitDelete(deleteDialog?.id), 'data-fm-action': 'delete-confirm' })) },
          deleteDialog && h('div', { className: 'fm-dialog-content', 'data-fm-delete-phase': deleteDialog.phase },
            h('p', { role: 'status', 'aria-live': 'polite' }, t({ preparing: 'deletePreparing', ready: 'deleteReady', failed: 'deleteFailed', committing: 'deleteCommitting' }[deleteDialog.phase])),
            deleteDialog.error && h('div', { role: 'alert' }, errorText(deleteDialog.error)),
            !deleteDialog.plan && h('div', { style: { maxHeight: '35vh', overflow: 'auto', overflowWrap: 'anywhere' } }, deleteDialog.targets.map((entry, index) => h('div', { key: index }, entry.path))),
            deleteDialog.plan && h(React.Fragment, null,
              h('p', null, `${t('deleteEntries')}: ${deleteDialog.plan.entryCount} · ${t('expires')}: ${new Date(deleteDialog.plan.expiresAt).toLocaleString()}`),
              h('div', { 'data-fm-delete-preview': true, style: { maxHeight: '35vh', overflow: 'auto', overflowWrap: 'anywhere' } },
                deleteDialog.plan.entries.map((entry, index) => h('div', { key: index }, h('strong', null, entry.path), h('details', null, h('summary', null, t('versions')), h('code', null, entry.version)))))),
            h(Checkbox, { checked: deleteDialog.acknowledged, onChange: acknowledged => acknowledgeDelete(deleteDialog.id, acknowledged), label: t('deleteAck'), disabled: deleteDialog.phase !== 'ready' || busy > 0 }))),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(closing), onClose: () => { if (!closing?.saving) setCloseId(null); }, title: t('closeTitle'), closeLabel: t('close'), description: t('closeDescription'),
          footer: h('div', { className: 'fm-dialog-actions' },
            button('cancel', { onClick: () => setCloseId(null), disabled: closing?.saving, 'data-fm-action': 'close-cancel' }),
            button('discard', { onClick: () => { if (documents.close(closeId, { discard: true })) setCloseId(null); }, disabled: closing?.saving, 'data-fm-action': 'close-discard' }),
            button('saveClose', { variant: 'primary', disabled: closing?.saving || closing?.missing || !capabilities.write, onClick: saveAndClose, 'data-fm-action': 'close-save' })) }, closing && h('p', { className: 'fm-dialog-content' }, closing.path)),
        h(Modal, { contentClassName: 'dsh-fm-dialog', open: Boolean(conflicting), onClose: () => setConflictId(null), title: t('conflictTitle'), closeLabel: t('close'), description: t('conflictDescription'),
          footer: h('div', { className: 'fm-dialog-actions' }, button('cancel', { onClick: () => setConflictId(null) }), button('rebase', { variant: 'primary', onClick: () => { documents.rebase(conflictId); setConflictId(null); setError(null); }, 'data-fm-action': 'rebase' })) },
        conflicting && h('div', { className: 'fm-compare' },
          h('div', null, h('h3', null, t('localDraft')), h('pre', { 'data-fm-conflict': 'draft' }, conflicting.draft)),
          h('div', null, h('h3', null, t('diskVersion')), h('pre', { 'data-fm-conflict': 'disk' }, conflicting.external.text)))));
    }
    return {
      createDocumentStore, consumeEvents,
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        const documents = createDocumentStore();
        const activity = createActivityStore();
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const runtime = {
          controller: new AbortController(), location: { rootId: '', path: '' }, relocations: new Set(), uploads: new Map(),
          openSession: ctx.uiWorkspace ? id => ctx.uiWorkspace.openSession(id) : null,
          referenceScope: ctx.sessions ? id => ctx.sessions.scope(id) : null,
        };
        ctx.effect(() => () => runtime.controller.abort());
        ctx.effect(() => ctx.locale.register(NS, 'en', en));
        ctx.effect(() => ctx.locale.register(NS, 'zh-CN', zh));
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh));
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'file-manager', order: -10, label: () => t('title') }, FolderIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'file-manager', locale: NS, inject: () => ({ documents, activity, ui, runtime }) }, Panel));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'file-manager-reference-bridge', locale: NS, inject: () => ({ activity, runtime, ui }) }, ReferenceBridge));
      },
    };
  },
});
