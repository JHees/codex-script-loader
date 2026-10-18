import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../src/settings-host.mjs',import.meta.url),'utf8');
const discovery=source.slice(source.indexOf('  const compact ='),source.indexOf('  function findContentArea('));

class Element {
  constructor(tag='nav',attrs={},labels=[],children=[]) {Object.assign(this,{tag,attrs,labels,children,dataset:{},isConnected:true});for(const child of children)child.parentElement=this;}
  getAttribute(name){return this.attrs[name]??null;}
  getBoundingClientRect(){return {left:0,width:230,height:500};}
  matches(selector){return selector.split(',').some(part=>{
    const query=part.trim();const has=query.includes(':has(');const base=query.split(':has(')[0];
    const tag=base.match(/^\w+/)?.[0];if(tag&&tag!==this.tag)return false;
    const attrs=[...base.matchAll(/\[([^=\]]+)(?:=['"]([^'"]+)['"])?\]/g)];
    if(!attrs.every(([,name,value])=>name in this.attrs&&(value===undefined||this.attrs[name]===value)))return false;
    return !has||!!this.querySelector('[data-settings-panel-slug]');
  });}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  querySelectorAll(selector){
    if(selector==="button,a,[role='button'],[role='link']")return this.labels.map(textContent=>({textContent,getAttribute:()=>null}));
    return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function find(...roots){
  const document=new Element('body',{},[],roots);
  return vm.runInNewContext(`${discovery}\nfindSidebar()`,{document,HTMLElement:Element,innerWidth:1200,getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})});
}

test('chat titles that contain settings words never establish a settings sidebar',()=>{
  const chat=new Element('nav',{},['新聊天','Appearance notes','Configuration guide','Usage log']);
  assert.equal(find(chat),null);
});

test('native settings identity works across languages and selects the nav instead of its layout parent',()=>{
  for(const label of ['Settings','设置','Einstellungen']){
    const nav=new Element('nav',{'aria-label':label},[],[new Element('button',{'data-settings-panel-slug':'general'})]);
    const aside=new Element('aside',{},[],[nav]);
    assert.equal(find(aside),nav);
    nav.hidden=true;aside.hidden=true;
    assert.equal(find(aside),null);
  }
  const ownNav=new Element('nav',{'aria-label':'Settings'});
  const plugin=new Element('div',{'data-codex-loader-settings':'panel-host'},[],[ownNav]);
  assert.equal(find(plugin),null,'plugin content cannot impersonate the native settings shell');
});

test('a stale settings button cannot activate after its sidebar has become a chat sidebar',()=>{
  const activate=source.slice(source.indexOf('  function activate(id)'),source.indexOf('  function scheduleSync()'));
  const run=vm.runInNewContext(`${activate}\nactivate`,{
    stopped:false,combinedEntries:()=>[{id:'example:main'}],sidebarRoot:{},findSidebar:()=>null,
    findContentArea:()=>{throw Error('must reject the stale sidebar before touching content');},
  });
  assert.doesNotThrow(()=>run('example:main'));
});

test('unmount restores native content and releases the old navigation, panel and click handler',()=>{
  const routines=source.slice(source.indexOf('  function restoreNative()'),source.indexOf('  function activate(id)'));
  let teardowns=0,removed=0,listenerRemoved=0;
  class Node {}
  const native=new Node();native.style={display:'none'};native.dataset={codexLoaderPreviousDisplay:'grid'};
  const panel={style:{},remove(){removed++;}};
  const listener=()=>{};
  const context=vm.createContext({HTMLElement:Node,activeId:'example:main',activeTeardown:()=>teardowns++,
    panelHost:panel,panelSurface:{isConnected:true,children:[native,panel]},
    sidebarRoot:{removeAttribute(){},removeEventListener(type,fn,capture){assert.equal(type,'click');assert.equal(fn,listener);assert.equal(capture,true);listenerRemoved++;}},
    restoreHandler:listener,pagesGroup:{remove(){removed++;}},applyActive(){},
  });
  vm.runInContext(routines,context);
  assert.equal(typeof context.unmountSettingsUi,'function');
  context.unmountSettingsUi();context.unmountSettingsUi();
  assert.equal(teardowns,1);assert.equal(removed,2);assert.equal(listenerRemoved,1);
  assert.equal(native.style.display,'grid');assert.equal(native.dataset.codexLoaderPreviousDisplay,undefined);
  for(const key of ['activeId','panelHost','panelSurface','sidebarRoot','pagesGroup','restoreHandler'])assert.equal(context[key],null,key);
});

test('retained callbacks cannot remount a stopped settings host',()=>{
  const schedule=source.slice(source.indexOf('  function scheduleSync()'),source.indexOf('  // A registered page handle'));
  const sync=source.slice(source.indexOf('  function sync()'),source.indexOf('  function applyActive()'));
  const context=vm.createContext({stopped:true,scanTimer:0,
    setTimeout(){throw Error('stopped hosts must not queue work');},
    findSidebar(){throw Error('stopped hosts must not discover or mount UI');},
  });
  vm.runInContext(schedule+'\n'+sync,context);
  assert.doesNotThrow(()=>context.scheduleSync());
  assert.doesNotThrow(()=>context.sync());
});
