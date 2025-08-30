// motion-utils@12.23.6 downloaded from https://ga.jspm.io/npm:motion-utils@12.23.6/dist/es/index.mjs

function t(t,n){t.indexOf(n)===-1&&t.push(n)}function n(t,n){const s=t.indexOf(n);s>-1&&t.splice(s,1)}function s([...t],n,s){const o=n<0?t.length+n:n;if(o>=0&&o<t.length){const o=s<0?t.length+s:s;const[e]=t.splice(n,1);t.splice(o,0,e)}return t}const o=(t,n,s)=>s>n?n:s<t?t:s;function e(t,n){return n?`${t}. For more information and steps for solving, visit https://motion.dev/troubleshooting/${n}`:t}let c=()=>{};let r=()=>{};if(process.env.NODE_ENV!=="production"){c=(t,n,s)=>{t||typeof console==="undefined"||console.warn(e(n,s))};r=(t,n,s)=>{if(!t)throw new Error(e(n,s))}}const i={};const u=t=>/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(t);function a(t){return typeof t==="object"&&t!==null}const l=t=>/^0[^.\s]+$/u.test(t);function f(t){let n;return()=>{n===void 0&&(n=t());return n}}const h=t=>t
/**
 * Pipe
 * Compose other transformers to run linearily
 * pipe(min(20), max(40))
 * @param  {...functions} transformers
 * @return {function}
 */;const p=(t,n)=>s=>n(t(s));const d=(...t)=>t.reduce(p)
/*
  Progress within given range

  Given a lower limit and an upper limit, we return the progress
  (expressed as a number 0-1) represented by the given value, and
  limit that progress to within 0-1.

  @param [number]: Lower limit
  @param [number]: Upper limit
  @param [number]: Value to find progress within given range
  @return [number]: Progress of value within range as expressed 0-1
*/;const b=(t,n,s)=>{const o=n-t;return o===0?1:(s-t)/o};class SubscriptionManager{constructor(){this.subscriptions=[]}add(s){t(this.subscriptions,s);return()=>n(this.subscriptions,s)}notify(t,n,s){const o=this.subscriptions.length;if(o)if(o===1)this.subscriptions[0](t,n,s);else for(let e=0;e<o;e++){const o=this.subscriptions[e];o&&o(t,n,s)}}getSize(){return this.subscriptions.length}clear(){this.subscriptions.length=0}}
/**
 * Converts seconds to milliseconds
 *
 * @param seconds - Time in seconds.
 * @return milliseconds - Converted time in milliseconds.
 */const g=t=>t*1e3;const y=t=>t/1e3
/*
  Convert velocity into velocity per second

  @param [number]: Unit per frame
  @param [number]: Frame duration in ms
*/;function M(t,n){return n?t*(1e3/n):0}const m=new Set;function v(t){return m.has(t)}function O(t,n,s){if(!t&&!m.has(n)){console.warn(e(n,s));m.add(n)}}const w=(t,n,s)=>{const o=n-t;return((s-t)%o+o)%o+t};const I=(t,n,s)=>(((1-3*s+3*n)*t+(3*s-6*n))*t+3*n)*t;const $=1e-7;const x=12;function A(t,n,s,o,e){let c;let r;let i=0;do{r=n+(s-n)/2;c=I(r,o,e)-t;c>0?s=r:n=r}while(Math.abs(c)>$&&++i<x);return r}function S(t,n,s,o){if(t===n&&s===o)return h;const e=n=>A(n,0,1,t,s);return t=>t===0||t===1?t:I(e(t),n,o)}const k=t=>n=>n<=.5?t(2*n)/2:(2-t(2*(1-n)))/2;const z=t=>n=>1-t(1-n);const E=S(.33,1.53,.69,.99);const N=z(E);const j=k(N);const C=t=>(t*=2)<1?.5*N(t):.5*(2-Math.pow(2,-10*(t-1)));const D=t=>1-Math.sin(Math.acos(t));const F=z(D);const V=k(D);const _=S(.42,0,1,1);const q=S(0,0,.58,1);const B=S(.42,0,.58,1);function G(t,n="end"){return s=>{s=n==="end"?Math.min(s,.999):Math.max(s,.001);const e=s*t;const c=n==="end"?Math.floor(e):Math.ceil(e);return o(0,1,c/t)}}const H=t=>Array.isArray(t)&&typeof t[0]!=="number";function J(t,n){return H(t)?t[w(0,t.length,n)]:t}const K=t=>Array.isArray(t)&&typeof t[0]==="number";const L={linear:h,easeIn:_,easeInOut:B,easeOut:q,circIn:D,circInOut:V,circOut:F,backIn:N,backInOut:j,backOut:E,anticipate:C};const P=t=>typeof t==="string";const Q=t=>{if(K(t)){r(t.length===4,"Cubic bezier arrays must contain four numerical values.","cubic-bezier-length");const[n,s,o,e]=t;return S(n,s,o,e)}if(P(t)){r(L[t]!==void 0,`Invalid easing type '${t}'`,"invalid-easing-type");return L[t]}return t};export{i as MotionGlobalConfig,SubscriptionManager,t as addUniqueItem,C as anticipate,N as backIn,j as backInOut,E as backOut,D as circIn,V as circInOut,F as circOut,o as clamp,S as cubicBezier,_ as easeIn,B as easeInOut,q as easeOut,Q as easingDefinitionToFunction,J as getEasingForSegment,v as hasWarned,r as invariant,K as isBezierDefinition,H as isEasingArray,u as isNumericalString,a as isObject,l as isZeroValueString,f as memo,y as millisecondsToSeconds,k as mirrorEasing,s as moveItem,h as noop,d as pipe,b as progress,n as removeItem,z as reverseEasing,g as secondsToMilliseconds,G as steps,M as velocityPerSecond,O as warnOnce,c as warning,w as wrap};

