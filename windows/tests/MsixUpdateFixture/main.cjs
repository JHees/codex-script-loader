const {app,BrowserWindow,protocol}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const settings=require('./settings.json');
const version=fs.readFileSync(path.join(__dirname,'version.txt'),'utf8').trim();
app.setPath('userData',path.join(settings.reportRoot,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
 require('./register.node');
 fs.writeFileSync(path.join(settings.reportRoot,`launch-${process.pid}.json`),JSON.stringify({pid:process.pid,version,args:process.argv,port:Number(app.commandLine.getSwitchValue('remote-debugging-port'))}));
 protocol.handle('app',request=>{
  if(new URL(request.url).pathname==='/assets/fixture.js')return new Response(`globalThis.fixtureVersion=${JSON.stringify(version)};export const __webpack_require__=Object.assign(()=>{throw Error('unexpected module load')},{c:{fixture:{exports:{appServices:{appUpdates:{checkForUpdates(){},installUpdate(){}}}}}}});`,{headers:{'content-type':'text/javascript'}});
  return new Response('<!doctype html><html><head><script type="module" src="/assets/fixture.js"></script></head><body><main>Isolated MSIX update fixture</main></body></html>',{headers:{'content-type':'text/html'}});
 });
 const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await window.loadURL('app://-/index.html');
});
app.on('window-all-closed',()=>app.quit());
