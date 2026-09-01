/** Queue identity, revision and mutation safety regressions. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionQueueAdapter } from "../dist/queue-adapter.js";

function userMessage(text, extraContent = []) {
  return {
    role: "user",
    content: [{ type: "text", text }, ...extraContent],
    timestamp: Date.now(),
  };
}

function fixture(steeringTexts = [], followUpTexts = []) {
  const updates = [];
  const session = {
    _steeringMessages: [...steeringTexts],
    _followUpMessages: [...followUpTexts],
    agent: {
      steeringQueue: {
        messages: steeringTexts.map((text) => userMessage(text)),
      },
      followUpQueue: {
        messages: followUpTexts.map((text) => userMessage(text)),
      },
    },
    _emitQueueUpdate() {
      updates.push({
        steering: [...this._steeringMessages],
        followUp: [...this._followUpMessages],
      });
    },
  };
  return {
    session,
    updates,
    adapter: new SessionQueueAdapter(() => session),
  };
}

test("removes one duplicate queue item only when its revision is current", () => {
  const { adapter, session, updates } = fixture(["same", "same"], ["later"]);
  const initial = adapter.view();
  assert.equal(initial.capabilities.remove, true);
  assert.equal(typeof initial.capabilities.revision, "number");

  assert.equal(
    adapter.remove("steering", 1, "same", initial.capabilities.revision),
    "same",
  );
  assert.deepEqual(session._steeringMessages, ["same"]);
  assert.equal(session.agent.steeringQueue.messages.length, 1);
  assert.deepEqual(updates, [{ steering: ["same"], followUp: ["later"] }]);

  assert.throws(
    () =>
      adapter.remove("steering", 0, "same", initial.capabilities.revision),
    /队列已变化/,
  );
});

test("moves the exact pending message object between delivery lanes", () => {
  const { adapter, session } = fixture(["interrupt"], ["after"]);
  const movedMessage = session.agent.steeringQueue.messages[0];
  const initial = adapter.view();

  adapter.move(
    "steering",
    "followUp",
    0,
    "interrupt",
    initial.capabilities.revision,
  );

  assert.deepEqual(session._steeringMessages, []);
  assert.deepEqual(session._followUpMessages, ["after", "interrupt"]);
  assert.equal(session.agent.followUpQueue.messages[1], movedMessage);
});

test("rejects a stale operation when an identical message object changed", () => {
  const { adapter, session } = fixture(["duplicate"], []);
  const initial = adapter.view();
  session.agent.steeringQueue.messages[0] = userMessage("duplicate");

  assert.throws(
    () =>
      adapter.remove(
        "steering",
        0,
        "duplicate",
        initial.capabilities.revision,
      ),
    /队列已变化/,
  );
});

test("fails closed for rich messages and an in-flight queue mismatch", () => {
  const rich = fixture(["with image"], []);
  rich.session.agent.steeringQueue.messages[0] = userMessage("with image", [
    { type: "image", data: "AA==", mimeType: "image/png" },
  ]);
  const richView = rich.adapter.view();
  assert.equal(richView.capabilities.remove, false);
  assert.match(richView.capabilities.reason, /图片|自定义内容/);

  const inFlight = fixture(["being delivered"], []);
  inFlight.session.agent.steeringQueue.messages.length = 0;
  const inFlightView = inFlight.adapter.view();
  assert.equal(inFlightView.capabilities.reorder, false);
  assert.match(inFlightView.capabilities.reason, /交付/);
});
