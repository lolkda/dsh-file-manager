/**
 * The panel stylesheet, rendered as a `<style>` child of the panel root.
 *
 * Keeps the original panel layout with scoped dialog refinements. Styles travel
 * with the `.dsh-fm` / `.dsh-fm-dialog` markup; shared primitive menus supply their
 * own theme surfaces. Rendering this inside the panel means React removes it
 * with the panel, so no separate disposal path is needed.
 */
export const PANEL_CSS = `
.dsh-fm{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;overflow:hidden}
.dsh-fm *{box-sizing:border-box}.dsh-fm input,.dsh-fm textarea,.dsh-fm select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base)}
.dsh-fm button:focus-visible,.dsh-fm input:focus-visible,.dsh-fm textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-fm header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-fm h1{font-size:24px;line-height:1.3;margin:0 0 5px}.dsh-fm h2{font-size:12px;font-weight:600;margin:0 0 14px;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-subtitle,.dsh-fm .fm-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-fm .fm-badge{font-size:11px;border-radius:20px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);white-space:nowrap}
.dsh-fm .fm-layout{flex:1;min-height:0;display:grid;grid-template-columns:210px minmax(260px,1fr) minmax(310px,1.2fr)}
.dsh-fm aside{min-width:0;padding:18px 12px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);overflow:auto}
.dsh-fm .fm-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.dsh-fm input{width:100%;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px}
.dsh-fm input[type=checkbox]{width:auto}.dsh-fm .fm-files,.dsh-fm .fm-preview{min-width:0;min-height:0;display:flex;flex-direction:column}.dsh-fm .fm-files{border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-fm .fm-pathbar{min-height:50px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-fm .fm-crumbs{display:flex;gap:2px;align-items:center;overflow:auto;min-width:0}.dsh-fm .fm-crumbs button{font-size:12px;white-space:nowrap}.dsh-fm .fm-crumbs i{font-style:normal;color:var(--dsw-alias-label-secondary)}
/* R20 breadcrumb row. The shared .fm-pathbar rule above also lays out the
   preview title row and the task bar, so the squeezed-path fix lives in these
   dedicated selectors only: the row may shrink, the navigation region is the one
   part that gives way and scrolls sideways, and every level keeps its separator
   and full name on one line. Levels are never folded, hidden or reordered. */
.dsh-fm .fm-breadcrumb-bar{min-width:0}
.dsh-fm .fm-breadcrumb-bar>.fm-crumbs{flex:1 1 0;min-width:0;overflow-x:auto;overflow-y:hidden}
.dsh-fm .fm-breadcrumb-bar>.fm-crumbs>button{flex:none;white-space:nowrap}
.dsh-fm .fm-crumb{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;white-space:nowrap}
.dsh-fm .fm-breadcrumb-bar>button{flex:none;white-space:nowrap}
.dsh-fm .fm-copy-directory-path{min-width:28px;min-height:28px;padding:4px}
.dsh-fm .fm-path-copy-text{display:block;width:100%;min-width:0;margin-top:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:12px/1.5 ui-monospace,monospace;resize:vertical}
.dsh-fm .fm-scroll{flex:1;min-height:0;overflow:auto;padding:8px}.dsh-fm .fm-entryline{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:center;gap:4px;min-width:0}
.dsh-fm .fm-selection-control{display:grid;place-items:center;align-self:stretch;min-width:44px;min-height:44px;cursor:pointer}.dsh-fm input.fm-selection[type=checkbox]{width:16px;height:16px;padding:0;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.dsh-fm input.fm-selection:disabled{cursor:not-allowed;opacity:.5}
.dsh-fm .fm-row{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;min-width:0;min-height:36px;text-align:left;padding:8px 9px;margin:1px 0;font-size:13px;line-height:20px;height:auto}
.dsh-fm .fm-filename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-fm .fm-size{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-fm .fm-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;min-height:170px;padding:28px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}
.dsh-fm .fm-preview pre,.dsh-fm .fm-editor{flex:1;min-height:160px;overflow:auto;margin:0;padding:16px;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;white-space:pre;border:0;border-radius:0;resize:none;width:100%;outline-offset:-2px}
.dsh-fm .fm-preview-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-fm .fm-actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.dsh-fm .fm-tabs{display:flex;gap:3px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:5px}
.dsh-fm .fm-tabs button{white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;font-size:12px}.dsh-fm .fm-error,.dsh-fm .fm-notice{margin:8px 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;line-height:1.5}.dsh-fm .fm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-fm .fm-dismissible-notice{display:flex;align-items:flex-start;gap:8px;min-width:0;flex:none}
.dsh-fm .fm-notice-content{flex:1;min-width:0;max-height:18vh;overflow:auto;overflow-wrap:anywhere}
.dsh-fm .fm-notice-close{flex:none;min-width:28px;min-height:28px}
.dsh-fm footer{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:14px;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-fm .fm-more{display:block;margin:12px auto}
.dsh-fm-dialog{color:var(--dsw-alias-label-primary);font:inherit}
/* Dialogs render in a portal, so the .dsh-fm rules above never reach them:
   without box-sizing, width:100% inputs overflow their field. The border and
   focus ring belong to the UI primitives, which already render one of each:
   adding an outline here drew a second ring inside the first. */
.dsh-fm-dialog,.dsh-fm-dialog *{box-sizing:border-box}
.dsh-fm-dialog input,.dsh-fm-dialog textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-base)}
.dsh-fm-dialog .fm-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0;font-size:13px;line-height:1.5}.dsh-fm-dialog .fm-input{width:100%;min-width:0}.dsh-fm-dialog .fm-field+.fm-input,.dsh-fm-dialog select+.fm-input{margin-top:8px}
.dsh-fm-dialog select{box-sizing:border-box;max-width:100%;min-height:36px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}.dsh-fm-dialog select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fm-dialog-content{color:var(--dsw-alias-label-primary);font:inherit}.fm-dialog-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.fm-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:0}.fm-compare pre{white-space:pre-wrap;overflow:auto;max-height:45vh;padding:12px;border:1px solid var(--dsw-alias-border-l1);font:12px/1.6 ui-monospace,monospace}.fm-compare h3{font-size:13px}.fm-compare>div{min-width:0}
/* Paste review: use the shared Menu's portal/card, not the native select popup.
   The trigger is one real button with one border; focus changes its colour
   instead of drawing a second outline. Other dialogs are intentionally intact. */
.dsh-fm-dialog .fm-paste-content{display:flex;flex-direction:column;gap:16px;max-height:50vh;overflow-y:auto;overflow-x:hidden}
.dsh-fm-dialog .fm-paste-item{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-fm-dialog .fm-paste-item+.fm-paste-item{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-fm-dialog .fm-paste-filename{min-width:0;font-size:14px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}
.dsh-fm-dialog .fm-paste-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-fm-dialog .fm-paste-policy-menu{display:flex;width:100%;min-width:0}
.dsh-fm-dialog .fm-paste-policy-trigger{width:100%;min-width:0;justify-content:space-between;gap:12px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dsh-fm-dialog .fm-paste-policy-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fm-dialog .fm-paste-policy-trigger>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-fm-dialog .fm-paste-policy-trigger:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-fm-dialog .fm-paste-policy-trigger[aria-expanded=true]{border-color:var(--dsw-alias-brand-primary)}
/* Upload review: the same themed portal Menu, with a different row. The file
   name, its policy label, the policy control and the on-demand rename field
   stack in one column, and every level may shrink, so a long name wraps inside
   the dialog instead of widening it. The policy trigger is a borderless ghost
   control: normal, focus and expanded states draw no outline, no outer shadow
   and no border layer. The hint is the design system's interactive overlay —
   the first attempt used --dsw-alias-bg-layer-2, which the real page showed
   resolving to the very same surface as the card, so focus was invisible; this
   token is translucent over the card and is what the theme's own controls use
   for the same interaction. Only this dialog's footer actions take the standard
   (36px) size — the shared dialog helper keeps the small default everywhere
   else. */
.dsh-fm-dialog .fm-upload-content{display:flex;flex-direction:column;gap:16px;min-height:0;max-height:50vh;overflow-y:auto;overflow-x:hidden}
.dsh-fm-dialog .fm-upload-item{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-fm-dialog .fm-upload-item+.fm-upload-item{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-fm-dialog .fm-upload-filename{min-width:0;font-size:14px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}
.dsh-fm-dialog .fm-upload-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-fm-dialog .fm-upload-policy-menu{display:flex;width:100%;min-width:0}
.dsh-fm-dialog .fm-upload-policy-trigger{width:100%;min-width:0;justify-content:space-between;gap:12px;padding:0 12px;border:none;outline:none;box-shadow:none;border-radius:10px}
.dsh-fm-dialog .fm-upload-policy-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fm-dialog .fm-upload-policy-trigger>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-fm-dialog .fm-upload-policy-trigger:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fm-dialog .fm-upload-policy-trigger[aria-expanded=true]{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
/* Height chain. The real page showed the card growing past a short viewport
   (a 600x360 window overflowed its bottom edge), which is a missing height cap,
   not a placement offset: no coordinate compensation belongs here. The Modal
   puts the Modal className on the card and the contentClassName on the wrapper holding the
   header, the description and the body — the footer is a sibling of that
   wrapper, so a footer rule scoped by the wrapper could never match. The card is
   therefore capped by the host's full-screen padding box, and every flex level
   between it and the review body may shrink below its content: only
   .fm-upload-content scrolls, and the footer keeps its height and stays visible. */
.fm-upload-dialog{max-height:100%;min-height:0}
.dsh-fm-dialog.fm-upload-dialog-content{min-height:0}
.dsh-fm-dialog.fm-upload-dialog-content>*{min-height:0}
.fm-upload-dialog .fm-upload-actions>button{min-height:36px}
/* R21 code editor. The container fills the preview column where the legacy
   <pre>/<textarea> sat. This sheet declares layout and typography only: token
   colours come from the theme package's --shiki-* / --dsw-* variables, so a
   theme switch keeps working and no literal colour enters this file. The legacy
   .fm-editor and .fm-preview pre rules above stay in place — the editor's
   initialization-failure fallback renders those very controls. */
.dsh-fm [data-fm-code]{flex:1;min-height:160px;display:flex;flex-direction:column;min-width:0;overflow:hidden}
/* CodeMirror mounts into an unmarked .fm-code-mount child, so the mount is the
   level that has to grow: stretching .cm-editor alone leaves it short by whatever
   the note and language rows above it take, and the panel's own overflow then
   clips the editor instead of scrolling it. An error-state fallback renders no
   mount at all (component contract), and we deliberately do NOT hide an empty
   mount with :empty{display:none}: React commits the empty mount before the
   mount effect appends CodeMirror, and measuring inside a display:none parent
   would give the editor a zero-height viewport. (No backticks anywhere in this
   stylesheet: PANEL_CSS is a template literal.) */
.dsh-fm [data-fm-code] .fm-code-mount{display:flex;flex:1;min-height:0;min-width:0;overflow:hidden}
.dsh-fm [data-fm-code] .cm-editor{flex:1;min-height:0;min-width:0;background:transparent}
/* Keep the focused editor borderless; the fallback .fm-editor textarea keeps
   the shared focus-visible ring above, so this stays scoped to CodeMirror. */
.dsh-fm [data-fm-code] .cm-editor.cm-focused{outline:none}
.dsh-fm [data-fm-code] .cm-scroller{overflow:auto;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}
.dsh-fm [data-fm-code] .cm-content{padding:16px}
.dsh-fm [data-fm-code-wrap=true]>pre,.dsh-fm [data-fm-code-wrap=true]>.fm-editor{white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-fm [data-fm-code] .cm-gutters{border:0;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-code-language,.dsh-fm .fm-code-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;padding:6px 16px 0}
.dsh-fm .fm-code-language{white-space:nowrap}
/* R23: the panel is the responsive boundary, including a Pad split window.
   Overlays stay in this panel; hidden editors remain mounted, never laid out. */
.dsh-fm{position:relative;isolation:isolate;container:fm / size}
.dsh-fm [hidden]{display:none!important}
.dsh-fm .fm-base{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column}
.dsh-fm .fm-main-header{padding:8px 16px;gap:8px;min-height:60px;flex:none}
.dsh-fm .fm-main-header h1{font-size:20px;margin:0;white-space:nowrap}
.dsh-fm .fm-header-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;flex-wrap:wrap}
.dsh-fm button,.dsh-fm summary{min-height:44px;min-width:44px;touch-action:manipulation}
.dsh-fm .fm-layout{display:flex;flex:1;min-height:0;min-width:0}
.dsh-fm .fm-files{flex:1;min-height:0;border:0}
.dsh-fm .fm-pathbar{flex:none;min-height:50px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-fm .fm-breadcrumb-bar{min-width:0;padding:4px 12px;min-height:52px}
.dsh-fm .fm-copy-directory-path{min-width:44px;min-height:44px}
.dsh-fm .fm-file-toolbar{position:relative;justify-content:flex-start;flex-wrap:wrap;gap:6px;padding:4px 12px;min-width:0;min-height:52px;z-index:2}
.dsh-fm .fm-file-toolbar>button{white-space:nowrap;flex:none}
.dsh-fm .fm-action-group{position:relative;flex:none}
.dsh-fm summary{display:flex;gap:6px;align-items:center;justify-content:center;list-style:none;padding:0 8px;border-radius:8px;font-size:13px;white-space:nowrap;cursor:pointer;user-select:none}
.dsh-fm .fm-action-chevron{display:block;flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-action-group[open]>summary>.fm-action-chevron{transform:rotate(180deg)}
.dsh-fm summary::-webkit-details-marker{display:none}
.dsh-fm summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-fm summary:hover,.dsh-fm .fm-action-group[open]>summary{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fm .fm-action-popover{position:absolute;top:calc(100% + 4px);left:0;display:flex;flex-direction:column;gap:2px;width:220px;max-width:calc(100cqw - 24px);max-height:min(360px,55cqh);overflow:auto;overscroll-behavior:contain;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 8px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.dsh-fm .fm-action-group:not([open])>.fm-action-popover{display:none}
.dsh-fm .fm-action-popover>button{justify-content:flex-start;text-align:left;white-space:normal;height:auto;padding:10px 12px;font-size:13px}
.dsh-fm [data-fm-action=delete]{color:var(--dsw-alias-state-error-primary)}
.dsh-fm .fm-action-popover>button:disabled{opacity:.45}
.dsh-fm .fm-scroll{overscroll-behavior:contain;padding:4px 12px}
.dsh-fm .fm-entryline{grid-template-columns:44px minmax(0,1fr);gap:0}
.dsh-fm .fm-selection-control{min-height:48px}
.dsh-fm .fm-row{min-height:48px;font-size:14px;margin:0;padding:10px 12px}
.dsh-fm .fm-entryline:has(input:checked){background:var(--dsw-alias-bg-layer-2);border-radius:8px}
.dsh-fm .fm-size{font-variant-numeric:tabular-nums}
.dsh-fm footer{flex:none;min-height:32px;align-items:center}
.dsh-fm .fm-list-footer{height:32px;min-height:32px;min-width:0;gap:8px;flex-wrap:nowrap;overflow:hidden;padding:6px 14px;line-height:18px}
.dsh-fm .fm-list-status{flex:0 1 auto;min-width:0;white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;font-variant-numeric:tabular-nums}
.dsh-fm .fm-list-status::-webkit-scrollbar{display:none}
.dsh-fm .fm-footer-note{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.dsh-fm .fm-task-attention{color:var(--dsw-alias-state-error-primary)}
.dsh-fm .fm-task-count{font-size:11px}
.dsh-fm .fm-overlay{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:24px}
.dsh-fm .fm-overlay-mask{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}
.dsh-fm .fm-overlay-card{position:relative;display:flex;flex-direction:column;width:100%;max-width:1280px;height:100%;min-height:0;min-width:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 15%,transparent);outline:none}
.dsh-fm .fm-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;min-width:0}
.dsh-fm .fm-overlay-header>button{flex:none}
.dsh-fm .fm-overlay-header strong{font-size:14px}
.dsh-fm .fm-viewer-title{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-fm .fm-overlay-drawer{padding:0;justify-content:flex-end}
.dsh-fm .fm-overlay-drawer>.fm-overlay-card{max-width:480px;border-radius:16px 0 0 16px}
.dsh-fm aside{flex:1;min-height:0;background:var(--dsw-alias-bg-base);border:0;padding:12px 16px;overscroll-behavior:contain}
.dsh-fm .fm-preview{flex:1;min-height:0;overflow:hidden}
.dsh-fm .fm-viewer-header>button{white-space:nowrap}
.dsh-fm .fm-viewer-header>.fm-viewer-tabs{flex:1;min-width:0;border:0;padding:0;overflow-x:auto;overflow-y:hidden}
/* Document tabs, one visible chip per open file: the wrapper owns the surface
   (outline and fill), so the name and its X read as one element. The wrapper is
   non-interactive; its two buttons are siblings, never nested. The strip scrolls
   sideways and truncates a long name inside its own button. The fills are the
   interactive overlays; .fm-active's own bg-layer-2 equals the panel surface. */
.dsh-fm .fm-viewer-tabs>.fm-tab{display:inline-flex;align-items:center;gap:2px;flex:none;padding-right:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dsh-fm .fm-viewer-tabs .fm-tab>button{flex:none;background:transparent}
.dsh-fm .fm-viewer-tabs .fm-tab>button:hover,.dsh-fm .fm-viewer-tabs .fm-tab>button:active{background:transparent}
.dsh-fm .fm-viewer-tabs>.fm-tab:not(.fm-active):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fm .fm-viewer-tabs>.fm-tab.fm-active{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-brand-primary)}
/* Only the tab X artwork scales: the host keeps a 16px box around the icon node,
   so its svg is a grandchild, and the window X sits outside .fm-tab. */
.dsh-fm .fm-viewer-tabs .fm-tab>button[data-fm-close-document] svg{width:12px;height:12px}
/* The strip clips vertically, so the shared focus ring is drawn inset. */
.dsh-fm .fm-viewer-tabs .fm-tab>button:focus-visible{outline-offset:-2px}
/* Desktop browser-tab proportion; the global 44px floor still covers touch and
   narrow panels. */
@media (pointer:fine){
  @container fm (min-width:601px){
    .dsh-fm .fm-viewer-tabs .fm-tab>button{min-height:28px}
    .dsh-fm .fm-viewer-tabs .fm-tab>button[data-fm-close-document]{width:24px;height:24px;min-width:24px;min-height:24px;padding:0}
  }
}
.dsh-fm [data-fm-code]{min-height:0}
.dsh-fm .fm-preview pre,.dsh-fm .fm-editor{min-height:0}
.dsh-fm .fm-viewer-attempt{flex:1;min-height:0;overflow:auto;padding:16px;overflow-wrap:anywhere}
.dsh-fm .fm-taskarea{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.dsh-fm .fm-taskarea>.fm-pathbar{flex-direction:column;align-items:flex-start;padding:8px 12px}
.dsh-fm .fm-taskarea .fm-notice{overflow-wrap:anywhere}
.dsh-fm .fm-taskarea progress{width:100%;max-width:100%;height:6px;accent-color:var(--dsw-alias-brand-primary)}
/* Notification entry point. The badge is small and its own count also lives in the
   drawer, so a new record never reflows the header. */
.dsh-fm .fm-notification-entry{white-space:nowrap}
.dsh-fm .fm-notification-badge{margin-left:6px;min-width:16px;padding:0 5px;border-radius:10px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:10px;line-height:16px;text-align:center}
/* The announcement channel exists for assistive technology: no layout, no focus. */
.dsh-fm .fm-notification-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.dsh-fm .fm-notification-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 12px 12px}
.dsh-fm .fm-notification{display:flex;flex-direction:column;gap:6px;min-width:0;margin:8px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;line-height:1.5}
.dsh-fm .fm-notification-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.dsh-fm .fm-notification-title{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dsh-fm .fm-notification-time{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-fm .fm-notification-level{flex:none;display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-notification[data-fm-notification-level=success] .fm-notification-level{color:var(--dsw-alias-brand-primary)}
.dsh-fm .fm-notification[data-fm-notification-level=warning] .fm-notification-level{color:var(--dsw-alias-label-primary)}
.dsh-fm .fm-notification[data-fm-notification-level=error] .fm-notification-level{color:var(--dsw-alias-state-error-primary)}
.dsh-fm .fm-notification-message{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-fm .fm-notification-details{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-fm .fm-notification-remove{flex:none;min-width:28px;min-height:28px;padding:2px}
.dsh-fm .fm-notification-manual{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-fm .fm-notification-manual>textarea{width:100%;min-width:0;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-fm .fm-notification-goto,.dsh-fm .fm-notification-copy{align-self:flex-start}
/* Degradation keeps a compact chip: the reason is on the title and in the history. */
.dsh-fm .fm-degraded-chip{display:inline-block;align-self:flex-start;margin:6px 12px;padding:3px 10px;border-radius:20px;color:var(--dsw-alias-label-secondary)}
.dsh-fm .fm-pending-references{display:flex;flex-direction:column;gap:8px}
@container fm (max-width:820px){
  .dsh-fm .fm-overlay{padding:0}
  .dsh-fm .fm-overlay>.fm-overlay-card{max-width:none;border:0;border-radius:0}
  .dsh-fm .fm-overlay-card{padding-bottom:env(safe-area-inset-bottom,0px)}
  .dsh-fm .fm-list-footer>.fm-footer-note{display:none}
}
@container fm (max-width:600px){
  .dsh-fm .fm-main-header{padding:6px 12px;min-height:56px}
  .dsh-fm .fm-main-header h1{font-size:18px}
  .dsh-fm .fm-header-actions{gap:0}
  .dsh-fm .fm-header-actions>button{padding-left:8px;padding-right:8px;font-size:12px}
  .dsh-fm .fm-file-toolbar{order:2;justify-content:flex-start;gap:4px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:0;padding-left:8px;padding-right:8px;padding-bottom:max(4px,env(safe-area-inset-bottom,0px))}
  .dsh-fm .fm-file-toolbar>.fm-action-group{position:static;flex:0 0 auto}
  .dsh-fm .fm-file-toolbar>button{flex:0 0 auto;padding-left:8px;padding-right:8px;font-size:13px}
  .dsh-fm .fm-file-toolbar>.fm-action-group>summary{gap:4px;padding-left:6px;padding-right:6px}
  .dsh-fm .fm-file-toolbar .fm-action-popover{top:auto;bottom:calc(100% + 8px);left:8px;max-width:calc(100% - 16px)}
  .dsh-fm .fm-file-toolbar [data-fm-action-group=more]>.fm-action-popover{left:auto;right:8px}
  .dsh-fm .fm-size{font-size:10px;max-width:95px;overflow:hidden;text-overflow:ellipsis}
  .dsh-fm .fm-overlay-header{padding:4px 8px}
  .dsh-fm .fm-list-footer{font-size:10px;padding:3px 12px;height:24px;min-height:24px}
  .dsh-fm .fm-notification-list{padding:0 8px 8px}
  .dsh-fm .fm-notification{padding:8px 10px}
}
@container fm (max-height:540px){
  .dsh-fm .fm-overlay{padding:0}
  .dsh-fm .fm-overlay>.fm-overlay-card{max-width:none;border-radius:0;border:0}
  .dsh-fm .fm-tabs{padding:0}
  .dsh-fm .fm-code-language,.dsh-fm .fm-code-note{padding-top:0}
}
@media(max-width:650px){.fm-compare{grid-template-columns:1fr}.dsh-fm-dialog input,.dsh-fm-dialog textarea{font-size:16px}.fm-dialog-actions>button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.dsh-fm *{scroll-behavior:auto}}
`;
