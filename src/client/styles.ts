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
.dsh-fm .fm-rootrow{display:flex;align-items:center;gap:4px;margin:5px 0}.dsh-fm .fm-rootrow>button:first-child{flex:1;min-width:0;text-align:left;justify-content:flex-start;display:flex;gap:8px}
.dsh-fm .fm-rootrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-fm .fm-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.dsh-fm form{margin-top:18px;display:flex;flex-direction:column;gap:9px}.dsh-fm input{width:100%;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px}
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
.dsh-fm .fm-scroll{flex:1;min-height:0;overflow:auto;padding:8px}.dsh-fm .fm-entryline{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:4px;min-width:0}
.dsh-fm .fm-selection-control{display:grid;place-items:center;align-self:stretch;min-height:36px;cursor:pointer}.dsh-fm input.fm-selection[type=checkbox]{width:16px;height:16px;padding:0;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.dsh-fm input.fm-selection:disabled{cursor:not-allowed;opacity:.5}
.dsh-fm .fm-row{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;min-width:0;min-height:36px;text-align:left;padding:8px 9px;margin:1px 0;font-size:13px;line-height:20px;height:auto}
.dsh-fm .fm-filename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-fm .fm-size{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-fm .fm-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;min-height:170px;padding:28px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}
.dsh-fm .fm-preview pre,.dsh-fm .fm-editor{flex:1;min-height:160px;overflow:auto;margin:0;padding:16px;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;white-space:pre;border:0;border-radius:0;resize:none;width:100%;outline-offset:-2px}
.dsh-fm .fm-preview-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-fm .fm-actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.dsh-fm .fm-tabs{display:flex;gap:3px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:5px}
.dsh-fm .fm-tabs button{white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;font-size:12px}.dsh-fm .fm-error,.dsh-fm .fm-notice{margin:8px 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;line-height:1.5}.dsh-fm .fm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
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
@media(max-width:1100px){.dsh-fm .fm-layout{grid-template-columns:180px minmax(230px,1fr);overflow:auto}.dsh-fm .fm-preview{grid-column:1/-1;border-top:1px solid var(--dsw-alias-border-l1);min-height:270px;max-height:55vh}.dsh-fm .fm-files,.dsh-fm aside{min-height:220px}.dsh-fm footer span:last-child{display:none}}
@media(max-width:650px){.dsh-fm header{padding:16px}.dsh-fm .fm-layout{display:flex;flex-direction:column}.dsh-fm aside{min-height:0;max-height:200px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-fm .fm-files{min-height:240px}.dsh-fm .fm-preview{flex:1;max-height:none}.fm-compare{grid-template-columns:1fr}}
`;
