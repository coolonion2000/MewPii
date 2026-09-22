/** Deterministic layout/interaction regression tests. @author coolonion */
import test from 'node:test';
import assert from 'node:assert/strict';
import { followChatTail } from '../src/chat-tail-follow.ts';

function fixture() {
  globalThis.window = new EventTarget();
  const frames = new Map(); let seq = 0, observer;
  globalThis.requestAnimationFrame = fn => { frames.set(++seq, fn); return seq; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observer = this; } observe() {} disconnect() { this.disconnected = true; } };
  const viewport = Object.assign(new EventTarget(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 });
  const states = [];
  const controller = followChatTail(viewport, {}, s => states.push(s));
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const grow = height => { viewport.scrollHeight = height; observer.cb(); };
  const wheelUp = () => { const e = new Event('wheel'); e.deltaY = -50; viewport.dispatchEvent(e); viewport.scrollTop -= 50; viewport.dispatchEvent(new Event('scroll')); };
  return { viewport, states, controller, flush, grow, wheelUp, observer, frames };
}
test('initial attach and late layout growth always reach newest content, even after an anchoring scroll', () => {
  const f = fixture();
  f.flush(); assert.equal(f.viewport.scrollTop, 700);
  f.grow(1400);
  f.viewport.dispatchEvent(new Event('scroll'));
  f.flush(); assert.equal(f.viewport.scrollTop, 1100);
  f.controller.dispose();
});
test('user scrolling up wins over a pending resize, and jumping down resumes follow', () => {
  const f = fixture(); f.flush();
  f.grow(1500); f.wheelUp(); f.flush();
  assert.equal(f.viewport.scrollTop, 650);
  assert.equal(f.states.at(-1), false);
  f.grow(2000); f.flush(); assert.equal(f.viewport.scrollTop, 650);
  f.controller.jumpToBottom(); f.flush(); assert.equal(f.viewport.scrollTop, 1700);
  f.grow(2200); f.flush(); assert.equal(f.viewport.scrollTop, 1900);
  f.controller.dispose();
});
test('session replacement cancels old layout work and starts following the new conversation', () => {
  const first = fixture(); first.controller.dispose(); first.flush();
  assert.equal(first.viewport.scrollTop, 0);
  assert.equal(first.observer.disconnected, true);
  const second = fixture(); second.flush(); assert.equal(second.viewport.scrollTop, 700);
  second.controller.dispose();
});
