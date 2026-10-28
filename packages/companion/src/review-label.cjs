'use strict';
// Keep identifiers visible in narrow sidebars without changing review titles.
function reviewLabel(title, code) {
  const text=String(title||'').trim();
  const identifier=String(code||'').trim();
  if(!identifier)return text;
  const escaped=identifier.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const topic=text.replace(new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`,'gi'),'$1')
    .replace(/^\s*Decision\s*:\s*/i,'Decision · ')
    .replace(/\s*[:·—–|]\s*[:·—–|]\s*/g,' · ')
    .replace(/^[\s:·—–|\-]+|[\s:·—–|\-]+$/g,'').replace(/\s{2,}/g,' ').trim();
  return topic?`${identifier} · ${topic}`:identifier;
}
module.exports={reviewLabel};
