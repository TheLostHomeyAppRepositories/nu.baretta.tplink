'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('settings calls ready first, shows green only for a successful local test, and clears stale feedback', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  const translations = require('../locales/en.json').settings.credentials;
  const elements = new Map();
  const calls = [];
  const alerts = [];
  let current = { configured: true, validation: { status: 'unverified' } };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false, attributes: {}, handlers: {},
      classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
    });
    return elements.get(id);
  };
  const context = { window: {}, document: { getElementById: id => {
    assert.equal(calls[0], 'ready');
    return element(id);
  } } };
  vm.runInNewContext(script, context);
  const Homey = {
    ready() { calls.push('ready'); },
    __(key, values = {}) {
      let text = translations[key.replace('settings.credentials.', '')];
      assert.equal(typeof text, 'string', key);
      for (const [name, value] of Object.entries(values)) text = text.replace('__' + name + '__', value);
      return text;
    },
    api(method, url, body, callback) {
      calls.push({ method, url, body });
      if (method === 'GET') body(null, current);
      else callback(null, { status: current, validation: current.validation });
    },
    alert(message) { alerts.push(message); },
  };
  context.window.onHomeyReady(Homey);
  await new Promise(resolve => setImmediate(resolve));
  const status = element('credential-validation');
  assert.equal(status.attributes['data-state'], 'unverified');
  assert.equal(status.textContent.includes('\u2713'), false);
  element('test-ip').value = '192.168.10.103';
  current = { configured: true, validation: { status: 'validated', checkedAt: '2026-09-13T16:00:00.000Z' } };
  await element('test').handlers.click();
  assert.equal(status.attributes['data-state'], 'validated');
  assert.match(status.textContent, /^\u2713 Local connection succeeded/);
  assert.match(status.textContent, /Last tested:/);
  assert.equal(calls.at(-1).body.ip, '192.168.10.103');
  assert.equal(element('test').disabled, false);

  element('password').value = 'unsaved-password';
  const previousCalls = calls.length;
  await element('test').handlers.click();
  assert.equal(calls.length, previousCalls);
  assert.equal(alerts.length, 1);
  element('password').value = '';

  current = { configured: true, validation: { status: 'rejected', error: 'KLAP challenge mismatch' } };
  await element('test').handlers.click();
  assert.equal(status.attributes['data-state'], 'rejected');
  assert.match(status.textContent, /KLAP challenge mismatch/);
  assert.equal(status.textContent.includes('\u2713'), false);

  current = { configured: true, validation: { status: 'unverified' } };
  element('username').value = 'new@example.com';
  element('password').value = 'new-password';
  await element('save').handlers.click();
  assert.equal(status.attributes['data-state'], 'unverified');
  assert.equal(element('password').value, '');

  current = { configured: false, validation: { status: 'unverified' } };
  context.window.confirm = () => true;
  await element('clear').handlers.click();
  assert.equal(status.hidden, true);
});
