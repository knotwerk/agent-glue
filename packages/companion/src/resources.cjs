'use strict';
const core=require('./core.cjs');
const {reviewLabel}=require('./review-label.cjs');
const localReviews=require('./local-reviews.cjs');
const filters={decisions:'Decision in:title sort:updated-desc',priority:'sort:updated-desc',all:'sort:updated-desc',open:'sort:updated-desc',merged:'sort:updated-desc',closed:'sort:updated-desc',drafts:'is:draft sort:updated-desc',review:'review-requested:@me sort:updated-desc',mine:'author:@me review:required sort:updated-desc',comments:'sort:updated-desc comments:>0'};
async function list(kind,cwd,{exec=core.run,project=core.project,filter='priority',session}={}){
  if(kind==='tasks')return require('./tasks.cjs').read(await project(cwd),{session});
  if(kind!=='prs')return {root:await project(cwd),items:[]};
  const root=await project(cwd);
  const prepared=await localReviews.read(root,{exec});
  const local=filter==='decisions'?prepared.filter(d=>/^Decision:/i.test(d.title)):prepared;
  if(kind==='prs'){
    const query=async selected=>{
      const {stdout}=await exec('gh',['pr','list','--state',['priority','all','comments'].includes(selected)?'all':['merged','closed'].includes(selected)?selected:'open','--limit','30','--json','number,title,url,isDraft,state,comments,reviews,updatedAt,headRefName,isCrossRepository','--search',filters[selected]||filters.priority],{cwd:root,timeout:20000,maxBuffer:4*1024*1024});
      const rows=JSON.parse(stdout);
      if(!Array.isArray(rows))throw new Error('GitHub returned an invalid pull request list.');
      return rows;
    };
    let rows,review=[],mine=[];
    try{
      if(filter==='priority')[rows,review,mine]=await Promise.all([query('priority'),query('review'),query('mine')]);
      else rows=await query(filter);
    }catch(error){if(local.length)return {root,items:['priority','all','open','drafts','decisions'].includes(filter)?local:[],warning:'Local drafts shown; GitHub lookup failed. Check GitHub CLI login and Refresh.'};throw new Error(error.code==='ENOENT'?'Install GitHub CLI on the SSH host to list pull requests.':'Could not load pull requests. Check GitHub CLI login and this repository’s remote, then Refresh.');}
    const reviewIds=new Set(review.map(r=>r.url)),mineIds=new Set(mine.map(r=>r.url));
    const unique=[...new Map([...rows,...review,...mine].map(r=>[r.url,r])).values()];
    const visibleLocal=local.filter(d=>!unique.some(r=>(d.publishedUrl&&d.publishedUrl===r.url)||(d.branch&&d.branch===r.headRefName&&!r.isCrossRepository&&!['CLOSED','MERGED'].includes(r.state))));
    return {root,items:[...(['priority','all','open','drafts','decisions'].includes(filter)?visibleLocal:[]),...unique.filter(r=>(filter!=='decisions'||/^Decision:/i.test(r.title))&&Number.isInteger(r.number)&&typeof r.title==='string'&&typeof r.url==='string'&&/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+$/.test(r.url)).map(r=>({
      id:r.url,url:r.url,label:reviewLabel(r.title,`#${r.number}`),number:r.number,state:r.state,updatedAt:r.updatedAt||'',reviewRequested:reviewIds.has(r.url),mineAwaitingReview:mineIds.has(r.url),
      description:[r.isDraft?'Draft':r.state==='MERGED'?'Merged':r.state==='CLOSED'?'Closed':'Open',reviewIds.has(r.url)?'Your review requested':mineIds.has(r.url)?'Awaiting review':'',r.comments?.length?`${r.comments.length} comments`:'' ].filter(Boolean).join(' · '),
      commentAt:[...(r.comments||[]).map(c=>c.updatedAt||c.createdAt||''),...(r.reviews||[]).map(r=>r.submittedAt||'')].sort().at(-1)||''
    }))]};
  }
}

function prioritize(items){
  const rank=item=>item.state==='CLOSED'||item.state==='MERGED'?4:item.newComments?0:item.reviewRequested?1:item.mineAwaitingReview?2:3;
  return [...items].sort((a,b)=>rank(a)-rank(b)||(rank(a)===0?(b.commentAt||'').localeCompare(a.commentAt||''):0)||(b.updatedAt||'').localeCompare(a.updatedAt||'')||b.number-a.number);
}
function sortItems(items,sort='title'){
  const title=(a,b)=>String(a.label||a.title||'').localeCompare(String(b.label||b.title||''),undefined,{numeric:true,sensitivity:'base'})||String(a.id).localeCompare(String(b.id));
  if(sort==='priority')return prioritize(items);
  return [...items].sort((a,b)=>sort==='number'?(b.number||0)-(a.number||0)||title(a,b):sort==='updated'?(b.updatedAt||'').localeCompare(a.updatedAt||'')||title(a,b):title(a,b));
}
module.exports={list,filters,prioritize,sortItems};
