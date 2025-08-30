// framer-motion@12.23.12 downloaded from https://ga.jspm.io/npm:framer-motion@12.23.12/dist/es/index.mjs

import{jsx as t,Fragment as n}from"react/jsx-runtime";import*as o from"react";import{useId as s,useRef as u,useContext as l,useInsertionEffect as p,useMemo as m,Children as g,isValidElement as y,useState as w,createContext as x,useCallback as E,useEffect as C,useLayoutEffect as P,forwardRef as M}from"react";import{M as _,P as j,u as A,L as V,l as I,a as O,b as R,c as T,m as D,d as N,e as L}from"../../_/BN4Zrqpv.js";export{S as SwitchLayoutGroupContext,f as filterProps,i as isValidMotionProp}from"../../_/BN4Zrqpv.js";import{u as X}from"../../_/Dyfu37JU.js";import{isHTMLElement as Y,frame as $,motionValue as H,cancelFrame as z,isMotionValue as B,collectMotionValues as U,transform as k,attachSpring as G,MotionValue as W,transformProps as J,acceleratedValues as q,startWaapiAnimation as K,mixNumber as Q}from"motion-dom";export*from"motion-dom";import{u as Z,f as tt,c as et,g as nt,a as rt,l as ot,d as st,b as it}from"../../_/BVT8BkoD.js";export{e as addPointerEvent,h as addPointerInfo,i as useIsPresent}from"../../_/BVT8BkoD.js";import{n as ct}from"../../_/Bu2I-vD4.js";import{warnOnce as at,invariant as ut,wrap as lt,MotionGlobalConfig as ft,noop as dt,warning as pt,moveItem as mt}from"motion-utils";export*from"motion-utils";export{MotionGlobalConfig}from"motion-utils";import{a as ht,r as gt}from"../../_/w4y0hvjV.js";export{F as FlatTree,c as calcLength}from"../../_/w4y0hvjV.js";import{h as vt,i as yt,p as wt,g as xt,V as Et,c as Ct}from"../../_/DWI5emuk.js";export{d as delay,v as visualElementStore}from"../../_/DWI5emuk.js";import{o as Pt}from"../../_/Bcs7DGyj.js";export{a as addScaleCorrector,b as buildTransform,i as isBrowser,c as optimizedAppearDataAttribute}from"../../_/Bcs7DGyj.js";import{u as Mt}from"../../_/Cq3kCJQA.js";export{a as useAnimateMini}from"../../_/Cq3kCJQA.js";import{s as St,c as bt,i as _t}from"../../_/BB7yYx_0.js";export{a as animate,b as scrollInfo}from"../../_/BB7yYx_0.js";export{r as resolveMotionValue}from"../../_/SgKeg4Dw.js";import{s as jt}from"../../_/Co-w3Pxf.js";export{d as distance,a as distance2D}from"../../_/Co-w3Pxf.js";export{a as animateMini}from"../../_/C0leSnL_.js";import"../../_/DNGLc6CK.js";import"../../_/BXW0OWoB.js";"use client";class PopChildMeasure extends o.Component{getSnapshotBeforeUpdate(t){const e=this.props.childRef.current;if(e&&t.isPresent&&!this.props.isPresent){const t=e.offsetParent;const n=Y(t)&&t.offsetWidth||0;const r=this.props.sizeRef.current;r.height=e.offsetHeight||0;r.width=e.offsetWidth||0;r.top=e.offsetTop;r.left=e.offsetLeft;r.right=n-r.width-r.left}return null}componentDidUpdate(){}render(){return this.props.children}}function At({children:e,isPresent:n,anchorX:r,root:i}){const c=s();const a=u(null);const f=u({width:0,height:0,top:0,left:0,right:0});const{nonce:d}=l(_);p((()=>{const{width:t,height:e,top:o,left:s,right:u}=f.current;if(n||!a.current||!t||!e)return;const l=r==="left"?`left: ${s}`:`right: ${u}`;a.current.dataset.motionPopId=c;const p=document.createElement("style");d&&(p.nonce=d);const m=i??document.head;m.appendChild(p);p.sheet&&p.sheet.insertRule(`\n          [data-motion-pop-id="${c}"] {\n            position: absolute !important;\n            width: ${t}px !important;\n            height: ${e}px !important;\n            ${l}px !important;\n            top: ${o}px !important;\n          }\n        `);return()=>{m.contains(p)&&m.removeChild(p)}}),[n]);return t(PopChildMeasure,{isPresent:n,childRef:a,sizeRef:f,children:o.cloneElement(e,{ref:a})})}"use client";const Vt=({children:e,initial:n,isPresent:r,onExitComplete:i,custom:c,presenceAffectsLayout:a,mode:u,anchorX:l,root:f})=>{const d=X(It);const p=s();let h=true;let g=m((()=>{h=false;return{id:p,initial:n,isPresent:r,custom:c,onExitComplete:t=>{d.set(t,true);for(const t of d.values())if(!t)return;i&&i()},register:t=>{d.set(t,false);return()=>d.delete(t)}}}),[r,d,i]);a&&h&&(g={...g});m((()=>{d.forEach(((t,e)=>d.set(e,false)))}),[r]);o.useEffect((()=>{!r&&!d.size&&i&&i()}),[r]);u==="popLayout"&&(e=t(At,{isPresent:r,anchorX:l,root:f,children:e}));return t(j.Provider,{value:g,children:e})};function It(){return new Map}const Ot=t=>t.key||"";function Rt(t){const e=[];g.forEach(t,(t=>{y(t)&&e.push(t)}));return e}"use client";const Tt=({children:e,custom:r,initial:o=true,onExitComplete:s,presenceAffectsLayout:i=true,mode:c="sync",propagate:a=false,anchorX:f="left",root:d})=>{const[p,h]=Z(a);const g=m((()=>Rt(e)),[e]);const v=a&&!p?[]:g.map(Ot);const y=u(true);const x=u(g);const E=X((()=>new Map));const[C,P]=w(g);const[M,S]=w(g);A((()=>{y.current=false;x.current=g;for(let t=0;t<M.length;t++){const e=Ot(M[t]);v.includes(e)?E.delete(e):E.get(e)!==true&&E.set(e,false)}}),[M,v.length,v.join("-")]);const b=[];if(g!==C){let t=[...g];for(let e=0;e<M.length;e++){const n=M[e];const r=Ot(n);if(!v.includes(r)){t.splice(e,0,n);b.push(n)}}c==="wait"&&b.length&&(t=b);S(Rt(t));P(g);return null}process.env.NODE_ENV!=="production"&&c==="wait"&&M.length>1&&console.warn('You\'re attempting to animate multiple children within AnimatePresence, but its mode is set to "wait". This will lead to odd visual behaviour.');const{forceRender:_}=l(V);return t(n,{children:M.map((e=>{const n=Ot(e);const u=!(a&&!p)&&(g===M||v.includes(n));const l=()=>{if(!E.has(n))return;E.set(n,true);let t=true;E.forEach((e=>{e||(t=false)}));if(t){_?.();S(x.current);a&&h?.();s&&s()}};return t(Vt,{isPresent:u,initial:!(y.current&&!o)&&void 0,custom:r,presenceAffectsLayout:i,mode:c,root:d,onExitComplete:u?void 0:l,anchorX:f,children:e},n)}))})};
/**
 * Note: Still used by components generated by old versions of Framer
 *
 * @deprecated
 */const Dt=x(null);function Nt(){const t=u(false);A((()=>{t.current=true;return()=>{t.current=false}}),[]);return t}function Lt(){const t=Nt();const[e,n]=w(0);const r=E((()=>{t.current&&n(e+1)}),[e]);const o=E((()=>$.postRender(r)),[r]);return[o,e]}"use client";const Xt=t=>t===true;const Yt=t=>Xt(t===true)||t==="id";const $t=({children:e,id:n,inherit:r=true})=>{const o=l(V);const s=l(Dt);const[i,c]=Lt();const a=u(null);const f=o.id||s;if(a.current===null){Yt(r)&&f&&(n=n?f+"-"+n:f);a.current={id:n,group:Xt(r)&&o.group||ct()}}const d=m((()=>({...a.current,forceRender:i})),[c]);return t(V.Provider,{value:d,children:e})};"use client";function Ht({children:e,features:n,strict:r=false}){const[,o]=w(!zt(n));const s=u(void 0);if(!zt(n)){const{renderer:t,...e}=n;s.current=t;I(e)}C((()=>{zt(n)&&n().then((({renderer:t,...e})=>{I(e);s.current=t;o(true)}))}),[]);return t(O.Provider,{value:{renderer:s.current,strict:r},children:e})}function zt(t){return typeof t==="function"}"use client";function Bt({children:e,isValidProp:n,...r}){n&&R(n);r={...l(_),...r};r.isStatic=X((()=>r.isStatic));const o=m((()=>r),[JSON.stringify(r.transition),r.transformPagePoint,r.reducedMotion]);return t(_.Provider,{value:o,children:e})}function Ft(t,e){if(typeof Proxy==="undefined")return T;const n=new Map;const r=(n,r)=>T(n,r,t,e);const o=(t,e)=>{process.env.NODE_ENV!=="production"&&at(false,"motion() is deprecated. Use motion.create() instead.");return r(t,e)};return new Proxy(o,{get:(o,s)=>{if(s==="create")return r;n.has(s)||n.set(s,T(s,void 0,t,e));return n.get(s)}})}const Ut=Ft();const kt=Ft(tt,et);const Gt={renderer:et,...rt,...nt};const Wt={...Gt,...st,...ot};const Jt={renderer:et,...rt};function qt(t,e,n){p((()=>t.on(e,n)),[t,e,n])}const Kt=()=>({scrollX:H(0),scrollY:H(0),scrollXProgress:H(0),scrollYProgress:H(0)});const Qt=t=>!!t&&!t.current;function Zt({container:t,target:e,...n}={}){const r=X(Kt);const o=u(null);const s=u(false);const i=E((()=>{o.current=St(((t,{x:e,y:n})=>{r.scrollX.set(e.current);r.scrollXProgress.set(e.progress);r.scrollY.set(n.current);r.scrollYProgress.set(n.progress)}),{...n,container:t?.current||void 0,target:e?.current||void 0});return()=>{o.current?.()}}),[t,e,JSON.stringify(n.offset)]);A((()=>{s.current=false;if(!Qt(t)&&!Qt(e))return i();s.current=true}),[i]);C((()=>{if(s.current){ut(!Qt(t),"Container ref is defined but not hydrated","use-scroll-ref");ut(!Qt(e),"Target ref is defined but not hydrated","use-scroll-ref");return i()}}),[i]);return r}
/**
 * @deprecated useElementScroll is deprecated. Convert to useScroll({ container: ref })
 */function te(t){process.env.NODE_ENV==="development"&&at(false,"useElementScroll is deprecated. Convert to useScroll({ container: ref }).");return Zt({container:t})}
/**
 * @deprecated useViewportScroll is deprecated. Convert to useScroll()
 */function ee(){process.env.NODE_ENV!=="production"&&at(false,"useViewportScroll is deprecated. Convert to useScroll().");return Zt()}
/**
 * Creates a `MotionValue` to track the state and velocity of a value.
 *
 * Usually, these are created automatically. For advanced use-cases, like use with `useTransform`, you can create `MotionValue`s externally and pass them into the animated component via the `style` prop.
 *
 * ```jsx
 * export const MyComponent = () => {
 *   const scale = useMotionValue(1)
 *
 *   return <motion.div style={{ scale }} />
 * }
 * ```
 *
 * @param initial - The initial state.
 *
 * @public
 */function ne(t){const e=X((()=>H(t)));const{isStatic:n}=l(_);if(n){const[,n]=w(t);C((()=>e.on("change",n)),[])}return e}function re(t,e){const n=ne(e());const r=()=>n.set(e());r();A((()=>{const e=()=>$.preRender(r,false,true);const n=t.map((t=>t.on("change",e)));return()=>{n.forEach((t=>t()));z(r)}}));return n}function oe(t,...e){const n=t.length;function r(){let r="";for(let o=0;o<n;o++){r+=t[o];const n=e[o];n&&(r+=B(n)?n.get():n)}return r}return re(e.filter(B),r)}function se(t){U.current=[];t();const e=re(U.current,t);U.current=void 0;return e}function ie(t,e,n,r){if(typeof t==="function")return se(t);const o=typeof e==="function"?e:k(e,n,r);return Array.isArray(t)?ce(t,o):ce([t],(([t])=>o(t)))}function ce(t,e){const n=X((()=>[]));return re(t,(()=>{n.length=0;const r=t.length;for(let e=0;e<r;e++)n[e]=t[e].get();return e(n)}))}function ae(t,e={}){const{isStatic:n}=l(_);const r=()=>B(t)?t.get():t;if(n)return ie(r);const o=ne(r());p((()=>G(o,t,e)),[o,JSON.stringify(e)]);return o}function ue(t){const e=u(0);const{isStatic:n}=l(_);C((()=>{if(n)return;const r=({timestamp:n,delta:r})=>{e.current||(e.current=n);t(n-e.current,r)};$.update(r,true);return()=>z(r)}),[t])}function le(){const t=ne(0);ue((e=>t.set(e)));return t}function fe(t){const e=ne(t.getVelocity());const n=()=>{const r=t.getVelocity();e.set(r);r&&$.update(n)};qt(t,"change",(()=>{$.update(n,false,true)}));return e}class WillChangeMotionValue extends W{constructor(){super(...arguments);this.isEnabled=false}add(t){if(J.has(t)||q.has(t)){this.isEnabled=true;this.update()}}update(){this.set(this.isEnabled?"transform":"auto")}}function de(){return X((()=>new WillChangeMotionValue("auto")))}function pe(){!vt.current&&yt();const[t]=w(wt.current);process.env.NODE_ENV!=="production"&&at(t!==true,"You have Reduced Motion enabled on your device. Animations may not appear as expected.","reduced-motion-disabled");return t}function me(){const t=pe();const{reducedMotion:e}=l(_);return e!=="never"&&(e==="always"||t)}function he(t){t.values.forEach((t=>t.stop()))}function ge(t,e){const n=[...e].reverse();n.forEach((n=>{const r=t.getVariant(n);r&&jt(t,r);t.variantChildren&&t.variantChildren.forEach((t=>{ge(t,e)}))}))}function ve(t,e){if(Array.isArray(e))return ge(t,e);if(typeof e==="string")return ge(t,[e]);jt(t,e)}function ye(){let t=false;const e=new Set;const n={subscribe(t){e.add(t);return()=>{e.delete(t)}},start(n,r){ut(t,"controls.start() should only be called after a component has mounted. Consider calling within a useEffect hook.");const o=[];e.forEach((t=>{o.push(it(t,n,{transitionOverride:r}))}));return Promise.all(o)},set(n){ut(t,"controls.set() should only be called after a component has mounted. Consider calling within a useEffect hook.");return e.forEach((t=>{ve(t,n)}))},stop(){e.forEach((t=>{he(t)}))},mount(){t=true;return()=>{t=false;n.stop()}}};return n}function we(){const t=X((()=>({current:null,animations:[]})));const e=X((()=>bt(t)));Mt((()=>{t.animations.forEach((t=>t.stop()));t.animations.length=0}));return[t,e]}
/**
 * Creates `LegacyAnimationControls`, which can be used to manually start, stop
 * and sequence animations on one or more components.
 *
 * The returned `LegacyAnimationControls` should be passed to the `animate` property
 * of the components you want to animate.
 *
 * These components can then be animated with the `start` method.
 *
 * ```jsx
 * import * as React from 'react'
 * import { motion, useAnimation } from 'framer-motion'
 *
 * export function MyComponent(props) {
 *    const controls = useAnimation()
 *
 *    controls.start({
 *        x: 100,
 *        transition: { duration: 0.5 },
 *    })
 *
 *    return <motion.div animate={controls} />
 * }
 * ```
 *
 * @returns Animation controller with `start` and `stop` methods
 *
 * @public
 */function xe(){const t=X(ye);A(t.mount,[]);return t}const Ee=xe;function Ce(){const t=l(j);return t?t.custom:void 0}
/**
 * Attaches an event listener directly to the provided DOM element.
 *
 * Bypassing React's event system can be desirable, for instance when attaching non-passive
 * event handlers.
 *
 * ```jsx
 * const ref = useRef(null)
 *
 * useDomEvent(ref, 'wheel', onWheel, { passive: false })
 *
 * return <div ref={ref} />
 * ```
 *
 * @param ref - React.RefObject that's been provided to the element you want to bind the listener to.
 * @param eventName - Name of the event you want listen for.
 * @param handler - Function to fire when receiving the event.
 * @param options - Options to pass to `Event.addEventListener`.
 *
 * @public
 */function Pe(t,e,n,r){C((()=>{const o=t.current;if(n&&o)return ht(o,e,n,r)}),[t,e,n,r])}class DragControls{constructor(){this.componentControls=new Set}subscribe(t){this.componentControls.add(t);return()=>this.componentControls.delete(t)}
/**
     * Start a drag gesture on every `motion` component that has this set of drag controls
     * passed into it via the `dragControls` prop.
     *
     * ```jsx
     * dragControls.start(e, {
     *   snapToCursor: true
     * })
     * ```
     *
     * @param event - PointerEvent
     * @param options - Options
     *
     * @public
     */start(t,e){this.componentControls.forEach((n=>{n.start(t.nativeEvent||t,e)}))}cancel(){this.componentControls.forEach((t=>{t.cancel()}))}stop(){this.componentControls.forEach((t=>{t.stop()}))}}const Me=()=>new DragControls;function Se(){return X(Me)}function be(t){return t!==null&&typeof t==="object"&&D in t}function _e(t){if(be(t))return t[D]}function je(){return Ae}function Ae(t){if(gt.current){gt.current.isUpdating=false;gt.current.blockUpdate();t&&t()}}function Ve(){const t=E((()=>{const t=gt.current;t&&t.resetTree()}),[]);return t}
/**
 * Cycles through a series of visual properties. Can be used to toggle between or cycle through animations. It works similar to `useState` in React. It is provided an initial array of possible states, and returns an array of two arguments.
 *
 * An index value can be passed to the returned `cycle` function to cycle to a specific index.
 *
 * ```jsx
 * import * as React from "react"
 * import { motion, useCycle } from "framer-motion"
 *
 * export const MyComponent = () => {
 *   const [x, cycleX] = useCycle(0, 50, 100)
 *
 *   return (
 *     <motion.div
 *       animate={{ x: x }}
 *       onTap={() => cycleX()}
 *      />
 *    )
 * }
 * ```
 *
 * @param items - items to cycle through
 * @returns [currentState, cycleState]
 *
 * @public
 */function Ie(...t){const e=u(0);const[n,r]=w(t[e.current]);const o=E((n=>{e.current=typeof n!=="number"?lt(0,t.length,e.current+1):n;r(t[e.current])}),[t.length,...t]);return[n,o]}function Oe(t,{root:e,margin:n,amount:r,once:o=false,initial:s=false}={}){const[i,c]=w(s);C((()=>{if(!t.current||o&&i)return;const s=()=>{c(true);return o?void 0:()=>c(false)};const a={root:e&&e.current||void 0,margin:n,amount:r};return _t(t.current,s,a)}),[e,t,n,o,r]);return i}function Re(){const[t,e]=Lt();const n=je();const r=u(-1);C((()=>{$.postRender((()=>$.postRender((()=>{e===r.current&&(ft.instantAnimations=false)}))))}),[e]);return o=>{n((()=>{ft.instantAnimations=true;t();o();r.current=e+1}))}}function Te(){ft.instantAnimations=false}function De(){const[t,e]=w(true);C((()=>{const t=()=>e(!document.hidden);document.hidden&&t();document.addEventListener("visibilitychange",t);return()=>{document.removeEventListener("visibilitychange",t)}}),[]);return t}const Ne=new Map;const Le=new Map;const Xe=(t,e)=>{const n=J.has(e)?"transform":e;return`${t}: ${n}`};function Ye(t,e,n){const r=Xe(t,e);const o=Ne.get(r);if(!o)return null;const{animation:s,startTime:i}=o;function c(){window.MotionCancelOptimisedAnimation?.(t,e,n)}s.onfinish=c;if(i===null||window.MotionHandoffIsComplete?.(t)){c();return null}return i}let $e;let He;const ze=new Set;function Be(){ze.forEach((t=>{t.animation.play();t.animation.startTime=t.startTime}));ze.clear()}function Fe(t,e,n,r,o){if(window.MotionIsMounted)return;const s=t.dataset[Pt];if(!s)return;window.MotionHandoffAnimation=Ye;const i=Xe(s,e);if(!He){He=K(t,e,[n[0],n[0]],{duration:1e4,ease:"linear"});Ne.set(i,{animation:He,startTime:null});window.MotionHandoffAnimation=Ye;window.MotionHasOptimisedAnimation=(t,e)=>{if(!t)return false;if(!e)return Le.has(t);const n=Xe(t,e);return Boolean(Ne.get(n))};window.MotionHandoffMarkAsComplete=t=>{Le.has(t)&&Le.set(t,true)};window.MotionHandoffIsComplete=t=>Le.get(t)===true;window.MotionCancelOptimisedAnimation=(t,e,n,r)=>{const o=Xe(t,e);const s=Ne.get(o);if(s){n&&r===void 0?n.postRender((()=>{n.postRender((()=>{s.animation.cancel()}))})):s.animation.cancel();if(n&&r){ze.add(s);n.render(Be)}else{Ne.delete(o);Ne.size||(window.MotionCancelOptimisedAnimation=void 0)}}};window.MotionCheckAppearSync=(t,e,n)=>{const r=xt(t);if(!r)return;const o=window.MotionHasOptimisedAnimation?.(r,e);const s=t.props.values?.[e];if(!o||!s)return;const i=n.on("change",(t=>{if(s.get()!==t){window.MotionCancelOptimisedAnimation?.(r,e);i()}}));return i}}const c=()=>{He.cancel();const s=K(t,e,n,r);$e===void 0&&($e=performance.now());s.startTime=$e;Ne.set(i,{animation:s,startTime:$e});o&&o(s)};Le.set(s,false);He.ready?He.ready.then(c).catch(dt):c()}const Ue=()=>({});class StateVisualElement extends Et{constructor(){super(...arguments);this.measureInstanceViewportBox=Ct}build(){}resetTransform(){}restoreTransform(){}removeValueFromRenderState(){}renderInstance(){}scrapeMotionValuesFromProps(){return Ue()}getBaseTargetFromProps(){}readValueFromInstance(t,e,n){return n.initialState[e]||0}sortInstanceNodePosition(){return 0}}const ke=N({scrapeMotionValuesFromProps:Ue,createRenderState:Ue});function Ge(t){const[e,n]=w(t);const r=ke({},false);const o=X((()=>new StateVisualElement({props:{onUpdate:t=>{n({...t})}},visualState:r,presenceContext:null},{initialState:t})));P((()=>{o.mount({});return()=>o.unmount()}),[o]);const s=X((()=>t=>it(o,t)));return[e,s]}let We=0;const Je=({children:e})=>{o.useEffect((()=>{ut(false,"AnimateSharedLayout is deprecated: https://www.framer.com/docs/guide-upgrade/##shared-layout-animations")}),[]);return t($t,{id:X((()=>"asl-"+We++)),children:e})};const qe=1e5;const Ke=t=>t>.001?1/t:qe;let Qe=false;
/**
 * Returns a `MotionValue` each for `scaleX` and `scaleY` that update with the inverse
 * of their respective parent scales.
 *
 * This is useful for undoing the distortion of content when scaling a parent component.
 *
 * By default, `useInvertedScale` will automatically fetch `scaleX` and `scaleY` from the nearest parent.
 * By passing other `MotionValue`s in as `useInvertedScale({ scaleX, scaleY })`, it will invert the output
 * of those instead.
 *
 * ```jsx
 * const MyComponent = () => {
 *   const { scaleX, scaleY } = useInvertedScale()
 *   return <motion.div style={{ scaleX, scaleY }} />
 * }
 * ```
 *
 * @deprecated
 */function Ze(t){let e=ne(1);let n=ne(1);const{visualElement:r}=l(L);ut(!!(t||r),"If no scale values are provided, useInvertedScale must be used within a child of another motion component.");pt(Qe,"useInvertedScale is deprecated and will be removed in 3.0. Use the layout prop instead.");Qe=true;if(t){e=t.scaleX||e;n=t.scaleY||n}else if(r){e=r.getValue("scaleX",1);n=r.getValue("scaleY",1)}const o=ie(e,Ke);const s=ie(n,Ke);return{scaleX:o,scaleY:s}}"use client";const tn=x(null);function en(t,e,n,r){if(!r)return t;const o=t.findIndex((t=>t.value===e));if(o===-1)return t;const s=r>0?1:-1;const i=t[o+s];if(!i)return t;const c=t[o];const a=i.layout;const u=Q(a.min,a.max,.5);return s===1&&c.layout.max+n>u||s===-1&&c.layout.min+n<u?mt(t,o,o+s):t}"use client";function nn({children:e,as:n="ul",axis:r="y",onReorder:o,values:s,...i},c){const a=X((()=>kt[n]));const l=[];const f=u(false);ut(Boolean(s),"Reorder.Group must be provided a values prop","reorder-values");const d={axis:r,registerItem:(t,e)=>{const n=l.findIndex((e=>t===e.value));n!==-1?l[n].layout=e[r]:l.push({value:t,layout:e[r]});l.sort(sn)},updateOrder:(t,e,n)=>{if(f.current)return;const r=en(l,t,e,n);if(l!==r){f.current=true;o(r.map(on).filter((t=>s.indexOf(t)!==-1)))}}};C((()=>{f.current=false}));return t(a,{...i,ref:c,ignoreStrict:true,children:t(tn.Provider,{value:d,children:e})})}const rn=M(nn);function on(t){return t.value}function sn(t,e){return t.layout.min-e.layout.min}"use client";function cn(t,e=0){return B(t)?t:ne(e)}function an({children:e,style:n={},value:r,as:o="li",onDrag:s,layout:i=true,...c},a){const u=X((()=>kt[o]));const f=l(tn);const d={x:cn(n.x),y:cn(n.y)};const p=ie([d.x,d.y],(([t,e])=>t||e?1:"unset"));ut(Boolean(f),"Reorder.Item must be a child of Reorder.Group","reorder-item-child");const{axis:m,registerItem:h,updateOrder:g}=f;return t(u,{drag:m,...c,dragSnapToOrigin:true,style:{...n,x:d.x,y:d.y,zIndex:p},layout:i,onDrag:(t,e)=>{const{velocity:n}=e;n[m]&&g(r,d[m].get(),n[m]);s&&s(t,e)},onLayoutMeasure:t=>h(r,t),ref:a,ignoreStrict:true,children:e})}const un=M(an);var ln=Object.freeze(Object.defineProperty({__proto__:null,Group:rn,Item:un},Symbol.toStringTag,{value:"Module"}));"use client";export{Tt as AnimatePresence,Je as AnimateSharedLayout,Dt as DeprecatedLayoutGroupContext,DragControls,$t as LayoutGroup,V as LayoutGroupContext,Ht as LazyMotion,Bt as MotionConfig,_ as MotionConfigContext,L as MotionContext,j as PresenceContext,ln as Reorder,Et as VisualElement,WillChangeMotionValue,it as animateVisualElement,ye as animationControls,rt as animations,Ct as createBox,bt as createScopedAnimate,Te as disableInstantTransitions,Gt as domAnimation,Wt as domMax,Jt as domMin,_t as inView,be as isMotionComponent,Ut as m,N as makeUseVisualState,kt as motion,St as scroll,Fe as startOptimizedAppearAnimation,_e as unwrapMotionComponent,we as useAnimate,Ee as useAnimation,xe as useAnimationControls,ue as useAnimationFrame,Ie as useCycle,Ge as useDeprecatedAnimatedState,Ze as useDeprecatedInvertedScale,Pe as useDomEvent,Se as useDragControls,te as useElementScroll,Lt as useForceUpdate,Oe as useInView,je as useInstantLayoutTransition,Re as useInstantTransition,A as useIsomorphicLayoutEffect,oe as useMotionTemplate,ne as useMotionValue,qt as useMotionValueEvent,De as usePageInView,Z as usePresence,Ce as usePresenceData,pe as useReducedMotion,me as useReducedMotionConfig,Ve as useResetProjection,Zt as useScroll,ae as useSpring,le as useTime,ie as useTransform,Mt as useUnmountEffect,fe as useVelocity,ee as useViewportScroll,de as useWillChange};

