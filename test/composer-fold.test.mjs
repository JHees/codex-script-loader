import test from "node:test";
import assert from "node:assert/strict";
import { mountContextFold } from "../src/composer-host.mjs";

function fixture() {
  const listeners = new Map();
  let document;
  function element() {
    return {style:{},dataset:{},children:[],hidden:false,attrs:{},
      append(...nodes) { this.children.push(...nodes); },
      contains(node) { return node === this || this.children.some(child=>child.contains(node)); },
      setAttribute(key,value) { this.attrs[key]=value; }, focus() { document.activeElement=this; },
      addEventListener(type,fn) { listeners.set(type,fn); }, removeEventListener(type) { listeners.delete(type); },
    };
  }
  document={documentElement:{lang:"en"},createElement:element,activeElement:null,addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);}};
  const dom=element(); dom.ownerDocument=document;
  class Cursor {
    constructor(from) { this.from=this.to=from; this.empty=true; }
    static findFrom(position,direction,textOnly) { assert.equal(direction,-1); assert.equal(textOnly,true); return new Cursor(position.pos-1); }
  }
  const view={dom,props:{nodeViews:{unrelated:()=>{}}},nodeViews:{},state:{selection:new Cursor(0)},setProps(next){this.props={...this.props,...next};this.nodeViews=this.props.nodeViews;},dispatch(tr){this.state.selection=tr.selection;}};
  view.state.doc={resolve:pos=>({pos})};
  Object.defineProperty(view.state,"tr",{get:()=>({doc:view.state.doc,setSelection(selection){this.selection=selection;return this;},setMeta(){return this;}})});
  const node=text=>({type:{name:"paragraph"},content:{size:text.length},textBetween:()=>text,nodeSize:text.length+2});
  return{view,node,listeners,document,Cursor};
}

test("fold owns only its exact paragraph; expansion and teardown never edit the document",()=>{
  const f=fixture();let removed=0;const changes=[];
  const fold=mountContextFold(f.view,"owned","Summary",()=>{removed++;}, expanded=>changes.push(expanded));
  const factory=f.view.props.nodeViews.paragraph;
  assert.equal(factory(f.node("user"),f.view,()=>0),undefined);
  const rendered=factory(f.node("owned"),f.view,()=>10);
  f.view.dom.append(rendered.dom);
  const [,toggle,erase]=rendered.dom.children[0].children;
  assert.equal(rendered.contentDOM.hidden,true);
  toggle.onclick(); assert.equal(rendered.contentDOM.hidden,false);
  toggle.onclick(); assert.equal(rendered.contentDOM.hidden,true);
  assert.deepEqual(changes,[true,false]);
  f.document.activeElement=f.view.dom;f.view.state.selection=new f.Cursor(11);
  f.listeners.get("selectionchange")?.();
  assert.equal(rendered.contentDOM.hidden,true,"restoring the cursor must not expand a collapsed draft");
  assert.equal(f.view.state.selection.from,9,"a hidden cursor returns to the preceding user text");
  assert.equal(rendered.update(f.node("owned")),true);
  assert.equal(rendered.contentDOM.hidden,true,"editor refresh must preserve the collapsed state");
  f.view.state.selection=new f.Cursor(11);f.listeners.get("beforeinput")?.();
  assert.equal(f.view.state.selection.from,9);
  assert.equal(rendered.contentDOM.hidden,true,"typing must not reveal or edit the hidden instructions");
  f.view.state.selection=new f.Cursor(11);f.view.state.selection.to=13;f.view.state.selection.empty=false;
  f.listeners.get("beforeinput")?.();assert.equal(f.view.state.selection.from,9,"a selection entirely in hidden instructions also returns to user text");
  toggle.onclick();f.view.state.selection=new f.Cursor(11);f.listeners.get("beforeinput")?.();
  assert.equal(f.view.state.selection.from,11,"explicitly expanded instructions remain editable");
  assert.equal(rendered.update(f.node("edited")),false);
  erase.onclick();assert.equal(removed,1);
  assert.equal(rendered.ignoreMutation({type:"characterData",target:rendered.contentDOM}),false);
  assert.equal(rendered.ignoreMutation({type:"selection",target:rendered.dom}),false);
  rendered.destroy();fold.stop();fold.stop();
  assert.equal(f.listeners.size,0);
  assert.equal(f.view.props.nodeViews.paragraph,undefined);
  assert.equal(typeof f.view.props.nodeViews.unrelated,"function");
});

test("caret routing preserves selections across the user document and active composition",()=>{
  const f=fixture();const fold=mountContextFold(f.view,"owned","Summary",()=>{});
  const rendered=f.view.props.nodeViews.paragraph(f.node("owned"),f.view,()=>10);
  f.view.state.selection=new f.Cursor(0);f.view.state.selection.to=16;f.view.state.selection.empty=false;
  f.listeners.get("beforeinput")?.();assert.equal(f.view.state.selection.from,0);
  f.view.state.selection=new f.Cursor(11);f.view.composing=true;
  f.listeners.get("selectionchange")?.();assert.equal(f.view.state.selection.from,11);
  f.view.composing=false;f.listeners.get("compositionstart")?.();assert.equal(f.view.state.selection.from,9);
  assert.equal(rendered.contentDOM.hidden,true);rendered.destroy();fold.stop();
});

test("never overwrites an existing paragraph renderer or a later owner's props",()=>{
  const f=fixture(), other=()=>{};
  f.view.nodeViews.paragraph=other;
  assert.equal(mountContextFold(f.view,"owned","Summary",()=>{}),null);
  delete f.view.nodeViews.paragraph;
  const fold=mountContextFold(f.view,"owned","Summary",()=>{});
  f.view.setProps({nodeViews:{paragraph:other}});fold.stop();
  assert.equal(f.view.props.nodeViews.paragraph,other);
  f.view.composing=true;delete f.view.nodeViews.paragraph;
  assert.equal(mountContextFold(f.view,"owned","Summary",()=>{}),null);
});
