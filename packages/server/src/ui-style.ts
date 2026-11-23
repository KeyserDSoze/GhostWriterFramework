/**
 * The admin panel's style. Colours live in the tokens below and nowhere else (a test reads the tokens and checks the contrast of every pair that the panel draws, in the light and in the dark
 * scheme, and that nothing after the tokens spells a colour of its own). Sizes are in rem, so the text can be enlarged to 200% without anything overlapping; spacing is a scale of 8 px
 * (half and quarter steps included). Nothing here loads anything: no `url()`, no `@import`, no font from outside.
 *
 * Accessibility (WCAG 2.2 AA): the focus ring is 3 px and never hidden by the sticky bar (`scroll-padding-top`); controls are at least 32 px high (40 px for a field and a button, 44 px
 * on a phone), and a link that stands alone has room to be pressed; a state is never a colour alone (the script puts a glyph and a word next to it); tables become one block for each row when
 * their own box is narrow, whatever the size of the window, and keep their roles.
 */

export const ADMIN_CSS = `:root{color-scheme:light dark;--bg:#f4f3ef;--card:#ffffff;--fg:#1d2127;--muted:#59606b;--line:#dedbd3;--accent:#0b6a63;--accent-fg:#ffffff;--warn:#954400;--bad:#b3261e;--ok:#176a37;--control:#757b85;--focus:#1a56db;--soft:#ecebe6;--accent-soft:#d9eeeb;--shadow:0 1px 2px rgba(20,24,30,.08),0 1px 1px rgba(20,24,30,.04);--s1:.25rem;--s2:.5rem;--s3:.75rem;--s4:1rem;--s5:1.5rem;--s6:2rem;--s7:3rem;--r1:.5rem;--r2:.75rem;--bar:3.5rem;font:100%/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b20;--fg:#e8e6e2;--muted:#a1a8b2;--line:#2a3038;--accent:#3dd6c3;--accent-fg:#03201c;--warn:#f3ab3c;--bad:#ff8d83;--ok:#62d48c;--control:#8993a0;--focus:#7fb6ff;--soft:#212730;--accent-soft:#123a36;--shadow:0 1px 2px rgba(0,0,0,.5)}}
/* views */
*,*::before,*::after{box-sizing:border-box}
html{scroll-padding-top:5rem;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);min-height:100vh}
h1,h2,h3,p,ul,ol,dl,dd,figure{margin:0}
:focus-visible{outline:.1875rem solid var(--focus);outline-offset:.125rem}
a{color:var(--accent);text-underline-offset:.2em}a:hover{text-decoration-thickness:.125rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:max(.9em,.8125rem)}
code{overflow-wrap:anywhere}
p,li,dd,h1,h2,h3,label,summary{overflow-wrap:anywhere}
pre.code{margin:var(--s3) 0;padding:var(--s2) var(--s3);background:var(--soft);border:1px solid var(--line);border-radius:var(--r1);overflow:auto}
.hidden{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.muted{color:var(--muted)}.small{font-size:.875rem}.nowrap{white-space:nowrap}
p.small>a{display:inline-block;padding:var(--s1) 0}
.skip{position:absolute;left:var(--s2);top:-5rem;z-index:40;padding:var(--s3) var(--s4);border-radius:var(--r1);background:var(--accent);color:var(--accent-fg);font-weight:700;text-decoration:none}.skip:focus{top:var(--s2)}

.topbar{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3);min-height:var(--bar);padding:var(--s2) var(--s4);background:var(--card);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;flex:1 1 6rem;gap:var(--s3);min-width:0;margin-inline-end:auto}
.logo{display:grid;place-items:center;flex:none;width:2.25rem;height:2.25rem;border-radius:var(--r1);background:var(--accent);color:var(--accent-fg);font-weight:800}
.brand-text{display:grid;min-width:0;line-height:1.25}.brand-name{font-weight:700}.brand-sub{overflow:hidden;color:var(--muted);font-size:.8125rem;text-overflow:ellipsis;white-space:nowrap}
.layout{display:block}
.sidebar{display:none;background:var(--card);border-bottom:1px solid var(--line)}
.signed.nav-open .sidebar{display:flex;flex-direction:column;max-height:calc(100vh - var(--bar));overflow:auto}
.nav{padding:var(--s3)}.nav ul{display:grid;gap:var(--s1);margin:0;padding:0;list-style:none}
.nav a{display:flex;align-items:center;gap:var(--s3);min-height:2.75rem;padding:var(--s2) var(--s3);border-inline-start:.25rem solid transparent;border-radius:var(--r1);color:var(--fg);font-weight:500;text-decoration:none}
.nav a:hover{background:var(--soft)}
.nav a[aria-current=page]{border-inline-start-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:700}
.nav svg,.menu-btn svg{flex:none;width:1.25rem;height:1.25rem;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.nav .label{flex:1;min-width:0}
.count{display:inline-flex;align-items:center;justify-content:center;min-width:1.5rem;padding:0 .4rem;border:1px solid currentColor;border-radius:999px;font-size:.8125rem;font-weight:700;line-height:1.4}
.count.warn{color:var(--warn)}.count.bad{color:var(--bad)}.count.ok{color:var(--ok)}.count.info{color:var(--accent)}
.side-foot{display:grid;gap:var(--s2);margin-top:auto;padding:var(--s3) var(--s4) var(--s4);border-top:1px solid var(--line)}
@media (min-width:60rem){
  html{scroll-padding-top:2rem}
  .signed{display:grid;grid-template-columns:16.5rem minmax(0,1fr);align-items:start}
  .signed .sidebar{display:flex;flex-direction:column;position:sticky;top:var(--bar);height:calc(100vh - var(--bar));overflow:auto;border-bottom:0;border-inline-end:1px solid var(--line)}
  .menu-btn{display:none!important}
}
@media (max-width:59.99rem){html{scroll-padding-top:5rem}}

main{width:100%;max-width:74rem;margin:0 auto;padding:var(--s5) var(--s4) var(--s7)}main:focus{outline:none}
@media (min-width:40rem){main{padding:var(--s6) var(--s6) var(--s7)}}
.page{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s4);align-content:start}
.page-head{margin-bottom:var(--s2)}
h1{font-size:1.5rem;line-height:1.25;font-weight:750;letter-spacing:-.01em}h1:focus{outline:none}
@media (min-width:40rem){h1{font-size:1.75rem}}
.lede{margin-top:var(--s1);max-width:44rem;color:var(--muted)}
h2{font-size:1.125rem;line-height:1.35;font-weight:700}
h3{margin:var(--s5) 0 var(--s1);font-size:1rem;line-height:1.4;font-weight:700}
.panel{padding:var(--s4);background:var(--card);border:1px solid var(--line);border-radius:var(--r2);box-shadow:var(--shadow)}
@media (min-width:40rem){.panel{padding:var(--s4) var(--s5)}}
.panel-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s2) var(--s4);margin-bottom:var(--s2)}
.panel-help{max-width:46rem;margin:0 0 var(--s3);color:var(--muted)}
.panel.risks{border-inline-start:.375rem solid var(--accent)}.panel.risks.risks-high{border-inline-start-color:var(--bad)}.panel.risks.risks-medium{border-inline-start-color:var(--warn)}
.login{max-width:30rem;margin:var(--s5) auto}
.login .panel-help{margin-bottom:var(--s2)}

.tiles{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))}
.tile{display:flex;flex-direction:column;gap:var(--s1);padding:var(--s4);background:var(--card);border:1px solid var(--line);border-radius:var(--r2);box-shadow:var(--shadow);color:var(--fg);text-decoration:none}
a.tile:hover{border-color:var(--accent)}
.tile-label{color:var(--muted);font-size:.8125rem;font-weight:700}
.tile-value{font-size:1.25rem;font-weight:700;line-height:1.3;overflow-wrap:anywhere}
.tile-sub{color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}

label{display:block;margin:var(--s4) 0 var(--s1);font-size:.9375rem;font-weight:600}
label.check{display:flex;align-items:flex-start;gap:var(--s3);margin:var(--s3) 0;min-height:1.5rem;font-weight:400}
.field-help{margin:var(--s1) 0 0;color:var(--muted);font-size:.875rem}
input,textarea,select{width:100%;min-height:2.5rem;padding:var(--s2) var(--s3);border:1px solid var(--control);border-radius:var(--r1);background:var(--card);color:var(--fg);font:inherit}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875rem;line-height:1.5;resize:vertical}
input[type=checkbox]{flex:none;width:1.5rem;min-height:0;height:1.5rem;margin:0;padding:0;accent-color:var(--accent)}
form.form{max-width:38rem}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);min-height:2.5rem;padding:var(--s2) var(--s4);border:1px solid var(--accent);border-radius:var(--r1);background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button:hover{filter:brightness(1.08)}
button.ghost{border-color:var(--control);background:transparent;color:var(--fg)}button.ghost:hover{background:var(--soft);filter:none}
button.danger{border-color:var(--bad);color:var(--bad)}
button.small{min-height:2rem;padding:var(--s1) var(--s3);font-size:.875rem}
button:disabled{opacity:.55;cursor:not-allowed}
form button[type=submit],.row{margin-top:var(--s4)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2)}
.inline{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);margin-top:var(--s3)}.inline>input{flex:1 1 11rem;min-width:0}.inline>button,.inline>label,.inline .row{margin-top:0}
.panel-head button,.panel-head .row{margin-top:0}
td button,td .row,.list button,.list .row{margin-top:0}
@media (max-width:40rem),(pointer:coarse){input,select,textarea{min-height:2.75rem}button{min-height:2.75rem}button.small{min-height:2.5rem}.nav a{min-height:3rem}}

.badge,.pill{display:inline-flex;align-items:baseline;gap:.375rem;max-width:100%;overflow-wrap:anywhere;padding:.0625rem .625rem;border:1px solid var(--control);border-radius:999px;font-size:.8125rem;font-weight:650;line-height:1.5}
.badge.ok,.pill.ok{border-color:var(--ok);color:var(--ok)}.badge.info,.pill.info{border-color:var(--accent);color:var(--accent)}.badge.warn,.pill.warn{border-color:var(--warn);color:var(--warn)}.badge.bad,.pill.bad{border-color:var(--bad);color:var(--bad)}.badge.off,.pill.off{color:var(--muted)}
.glyph{font-weight:800}
.pills{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s2) 0 var(--s4)}
.chip{display:inline-block;margin:.0625rem .125rem;padding:0 .5rem;border:1px solid var(--line);border-radius:var(--r1);background:var(--soft);font-size:.8125rem}.chip.update{border-color:var(--warn);color:var(--warn)}
.facts{display:grid;grid-template-columns:minmax(6rem,max-content) minmax(0,1fr);align-items:baseline;gap:var(--s2) var(--s5);margin:0}.facts dt{color:var(--muted);font-size:.875rem}.facts dd{margin:0;overflow-wrap:anywhere}
@media (max-width:30rem){.facts{grid-template-columns:minmax(0,1fr);gap:0}.facts dd{margin-bottom:var(--s2)}}
.notice{margin:var(--s3) 0;padding:var(--s3) var(--s4);border:1px solid var(--line);border-inline-start:.25rem solid var(--accent);border-radius:var(--r1);background:var(--soft);overflow-wrap:anywhere}
.error{min-height:1.5rem;color:var(--bad);font-weight:600}
.pair-code{margin:var(--s1) 0;font:600 1.75rem/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.2rem}
.list{margin:0;padding:0;list-style:none}.list li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s2) var(--s4);padding:var(--s3) 0;border-bottom:1px solid var(--line)}.list li:last-child{border-bottom:0}
.list li.mcp-book{display:block}.mcp-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s2)}.mcp-head label{margin:0}.mcp-book .list{margin:var(--s2) 0 0 var(--s3)}.mcp-book .inline{margin-top:var(--s2)}
.revoked{opacity:.65}.agent{max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toast{position:fixed;right:var(--s4);bottom:var(--s4);left:var(--s4);z-index:50;max-width:28rem;margin-inline:auto 0;padding:var(--s3) var(--s4);border-radius:var(--r1);background:var(--fg);color:var(--bg);box-shadow:var(--shadow)}
@media (max-width:40rem){.toast{margin-inline:auto}}
.loading,.empty-state{color:var(--muted)}
td.empty-state,td.loading{padding:var(--s5) var(--s4);text-align:center}
.glance{display:grid;gap:0;margin:0;padding:0;list-style:none}.glance li{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3);padding:var(--s3) 0;border-bottom:1px solid var(--line)}.glance li:last-child{border-bottom:0}.glance .glance-title{flex:1 1 12rem;font-weight:600;overflow-wrap:anywhere}

.risk-summary,.health-summary,.runs-summary{margin:0 0 var(--s3);font-weight:600}
.risk-list{display:grid;gap:var(--s3);margin:0;padding:0;list-style:none}
.risk{padding:var(--s3) var(--s4);border:1px solid var(--line);border-inline-start-width:.3125rem;border-radius:var(--r1);background:var(--bg)}.risk.high{border-inline-start-color:var(--bad)}.risk.medium{border-inline-start-color:var(--warn)}.risk.note{border-inline-start-color:var(--accent)}
.risk-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s2)}.risk-title{font-weight:650;overflow-wrap:anywhere}.risk p{margin:var(--s1) 0 0;overflow-wrap:anywhere}.risk a{display:inline-block;padding:var(--s1) 0}
details.risk-notes{margin-top:var(--s4)}summary{min-height:1.75rem;padding:var(--s1) 0;cursor:pointer;font-weight:600}
details.checks>summary{margin-top:var(--s1);color:var(--accent)}details.checks ul{margin:var(--s1) 0 0;padding-inline-start:var(--s5)}
.filters{display:flex;flex-wrap:wrap;gap:var(--s3) var(--s4);margin:var(--s2) 0 var(--s3)}.filters>div{flex:1 1 11rem;max-width:16rem}.filters label{margin-top:0}

.table-wrap{overflow-x:auto;container-type:inline-size;border:1px solid var(--line);border-radius:var(--r1)}
.table-wrap.long{max-height:min(75vh,44rem);overflow:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.9375rem}
th,td{padding:var(--s3);border-bottom:1px solid var(--line);text-align:start;vertical-align:top;overflow-wrap:break-word}
thead th{position:sticky;top:0;z-index:1;background:var(--soft);color:var(--muted);font-size:.8125rem;font-weight:700}
tbody tr:last-child>*{border-bottom:0}
th[scope=row]{color:var(--fg);font-size:.9375rem;font-weight:650}
td code{overflow-wrap:anywhere}
th.c-status{min-width:10rem}th.c-state{min-width:9rem}th.c-progress{min-width:8rem}th.c-checks{min-width:11rem}td.state-cell{max-width:26rem}
progress{display:block;width:100%;max-width:12.5rem;height:.5rem;margin:var(--s1) 0;border:0;border-radius:.25rem;background:var(--line);accent-color:var(--accent)}
progress::-webkit-progress-bar{background:var(--line);border-radius:.25rem}progress::-webkit-progress-value{background:var(--accent);border-radius:.25rem}progress::-moz-progress-bar{background:var(--accent);border-radius:.25rem}
@container (max-width:42rem){
  table.stack,table.stack tbody{display:block}
  table.stack thead{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
  table.stack tr{display:block;padding:var(--s2) var(--s3);border-bottom:1px solid var(--line)}
  table.stack tbody tr:last-child{border-bottom:0}
  table.stack th[scope=row],table.stack td{display:block;min-width:0;max-width:none;padding:var(--s1) 0;border:0}
  table.stack td::before{content:attr(data-label);display:block;color:var(--muted);font-size:.8125rem;font-weight:700}
  table.stack td.empty{display:none}table.stack td.nowrap{white-space:normal}
  table.stack.pairs tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:var(--s3)}
  table.stack.pairs th[scope=row],table.stack.pairs td.wide{grid-column:1/-1}
  table.stack.lines tr{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:var(--s3)}
  table.stack.lines td::before{display:none}table.stack.lines td:last-child{grid-column:1/-1}
}
/* A short window, in the size of the text (a phone on its side, text enlarged): a bar that stays would leave little to read, and could hide what has the focus. */
@media (max-height:36rem){.topbar{position:static}html{scroll-padding-top:1rem}.signed .sidebar{position:static;height:auto}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
@media (forced-colors:active){.panel,.tile,.risk,.notice,.table-wrap{border-color:CanvasText}.nav a[aria-current=page]{border-inline-start-color:Highlight}}
`;
