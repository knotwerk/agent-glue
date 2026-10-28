'use strict';
const http=require('node:http');
const {pipeline}=require('node:stream/promises');
const os=require('node:os');
const crypto=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs/promises');
const core=require('./core.cjs');
const {documentHtml,escape}=require('./preview.cjs');
function zeroTierAddress(interfaces=os.networkInterfaces()){
  for(const [name,addresses] of Object.entries(interfaces))if(/^zt/i.test(name)){
    const address=(addresses||[]).find(a=>!a.internal&&(a.family==='IPv4'||a.family===4));
    if(address)return address.address;
  }
  throw new Error('No ZeroTier IPv4 interface found on the SSH host. Connect ZeroTier before opening browser previews.');
}
class BrowserLinks{
  constructor({host,mermaidPath}={}){this.host=host;this.mermaidPath=mermaidPath;this.routes=new Map();this.keys=new Map();this.closed=false;}
  async start(){
    if(this.closed)throw new Error('Browser preview server has closed.');
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      this.host=this.host||zeroTierAddress();
      const server=http.createServer((req,res)=>{void this.serve(req,res);});this.server=server;
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,this.host,()=>{server.removeListener('error',reject);resolve();});});
      server.on('error',()=>{});server.unref();
      if(this.closed){server.close();throw new Error('Browser preview server has closed.');}
      return server.address().port;
    })().catch(error=>{this.starting=undefined;throw error;});
    return this.starting;
  }
  async link(file,root,{download=false}={}){
    const actual=await core.inside(root,file);
    if(!download&&!core.supported(actual))throw new Error('Browser previews support Markdown and HTML files.');
    if(!(await fs.stat(actual)).isFile())throw new Error('Preview requires a file.');
    const port=await this.start();
    const key=(download?'download:':'preview:')+actual;
    let route=this.keys.get(key);
    if(!route){
      route='/'+crypto.randomBytes(24).toString('hex')+'/'+encodeURIComponent(path.basename(actual));
      this.keys.set(key,route);this.routes.set(route,{file:actual,root,download});
    }
    return `http://${this.host}:${port}${route}`;
  }
  async serve(req,res){
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    const entry=this.routes.get(req.url);
    if(!entry||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end('Preview not found');return;}
    try{
      if(entry.download){
        const actual=await core.inside(entry.root,entry.file);
        const handle=await fs.open(actual,'r');
        try{
          const stat=await handle.stat();if(!stat.isFile())throw new Error('Not a file');
          res.setHeader('Content-Type','application/octet-stream');
          res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(path.basename(actual)).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)));
          res.setHeader('Content-Length',stat.size);
          res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
          if(req.method==='HEAD'){res.writeHead(200);res.end();}
          else await pipeline(handle.createReadStream({autoClose:false}),res);
        }finally{await handle.close();}
        return;
      }
      const mermaid=/\.(md|markdown)$/i.test(entry.file)&&this.mermaidPath?await fs.readFile(this.mermaidPath,'utf8'):'';
      const content=await documentHtml(entry.file,entry.root,mermaid);
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      const page=`<!doctype html><html><head><meta charset="utf-8"><title>${escape(path.basename(entry.file))}</title><style>body{margin:0}iframe{border:0;width:100%;height:100vh;display:block}</style></head><body><iframe title="Document preview" sandbox="allow-scripts" srcdoc="${escape(content)}"></iframe></body></html>`;
      res.writeHead(200);res.end(req.method==='HEAD'?undefined:page);
    }catch{if(res.headersSent)res.destroy();else{res.writeHead(404);res.end('Document unavailable or outside preview limits');}}
  }
  dispose(){this.closed=true;this.server?.close();this.routes.clear();this.keys.clear();}
}
module.exports={BrowserLinks,zeroTierAddress};
