import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPhase, hasAuthoritativeRunState } from '../src/conversation-phase.ts';

test('socket open is initialization, not readiness; stale runs cannot survive disconnect', () => {
  const state = {connected: false};
  assert.equal(conversationPhase(state), 'connecting');
  state.transportOpen = true;
  assert.equal(conversationPhase(state), 'initializing');
  state.connected = true;
  state.snapshot = {initializing: true, isStreaming: true};
  assert.equal(conversationPhase(state), 'initializing');
  assert.equal(hasAuthoritativeRunState(state), false);
  state.snapshot.initializing = false;
  assert.equal(conversationPhase(state), 'running');
  assert.equal(hasAuthoritativeRunState(state), true);
  state.connected = false;
  state.reconnecting = true;
  assert.equal(conversationPhase(state), 'reconnecting');
  assert.equal(hasAuthoritativeRunState(state), false);
  state.serviceUnresponsive = true;
  assert.equal(conversationPhase(state, true), 'unresponsive');
});

test('compaction, stopping, fatal failure and command errors remain distinct', () => {
  const state = {connected: true, snapshot: {isStreaming: false}, error: 'previous command failed'};
  assert.equal(conversationPhase(state), 'ready');
  state.compaction = {status: 'running'};
  assert.equal(conversationPhase(state), 'compacting');
  assert.equal(conversationPhase(state, true), 'stopping');
  state.connected = false;
  assert.equal(conversationPhase(state), 'failed');
});
