import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHiggsfield } from '../collector/lib/higgsfield.mjs';

// Deliberately synthetic HTML: these exercise the extraction contract offline,
// and do not claim that Higgsfield's live selectors have been verified.
const account = (balance, plan = '<div>Current plan: <strong>Pro</strong></div>') =>
  `<!doctype html><html><body><section aria-label="Account">${balance}${plan}</section></body></html>`;

function expectError(html, pattern) {
  const result = extractHiggsfield(html);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  if (pattern) assert.match(result.error, pattern);
  assert.equal(result.credits, undefined, 'an extraction failure must not invent a balance');
}

test('extracts a grouped credit balance and the current plan', () => {
  assert.deepEqual(
    extractHiggsfield(account('<div>Credits remaining: <strong>1,250</strong></div>')),
    { credits: 1250, plan: 'Pro' },
  );
});

test('zero is a real credit balance', () => {
  assert.deepEqual(
    extractHiggsfield(account('<div>0 credits remaining</div>')),
    { credits: 0, plan: 'Pro' },
  );
});

test('reads credit information from an accessible label', () => {
  assert.deepEqual(
    extractHiggsfield(account('<button aria-label="Credit balance: 820"><svg></svg></button>')),
    { credits: 820, plan: 'Pro' },
  );
});

test('reads the numeric sibling of a labelled coin icon', () => {
  assert.deepEqual(
    extractHiggsfield(account('<button><svg aria-label="coin"></svg><span>480</span></button>')),
    { credits: 480, plan: 'Pro' },
  );
});

test('deduplicates repeated copies of the same balance', () => {
  assert.deepEqual(
    extractHiggsfield(account('<button aria-label="Credit balance: 820">820 credits</button>')),
    { credits: 820, plan: 'Pro' },
  );
});

test('signed-out page gives the exact login action', () => {
  assert.deepEqual(
    extractHiggsfield('<html><body><h1>Sign in to Higgsfield</h1><button>Continue with Google</button></body></html>'),
    { error: 'not signed in: run node tools/higgsfield-login.mjs' },
  );
});

test('visible sign-in takes precedence over public balance and plan text', () => {
  assert.deepEqual(
    extractHiggsfield('<html><body><button>Sign in</button><div>Credit balance: 100</div><div>Current plan: Basic</div></body></html>'),
    { error: 'not signed in: run node tools/higgsfield-login.mjs' },
  );
});

test('a plan without a credit balance fails clearly', () => {
  expectError(account('<p>Welcome back</p>'));
});

test('a credit balance without plan evidence fails clearly', () => {
  expectError(account('<div>Credit balance: 120</div>', ''));
});

test('contradictory credit balances are not guessed', () => {
  expectError(account('<div>Credit balance: 120</div><div>Credit balance: 240</div>'));
});

test('contradictory current plan labels are not guessed', () => {
  expectError(account('<div>Credit balance: 120</div>', '<div>Current plan: Pro</div><div>Current plan: Ultimate</div>'));
});

test('script and hidden content cannot supply a credit balance', () => {
  expectError(account(`
    <script>const example = 'Credit balance: 9000';</script>
    <div hidden>Credit balance: 8000</div>
    <div aria-hidden="true">Credit balance: 7000</div>
    <div style="display: none">Credit balance: 6000</div>
  `));
});

test('marketing credit quantities cannot masquerade as account balance', () => {
  expectError(account('<article><h2>Upgrade to Ultimate</h2><p>1,000 credits per month</p><button>Subscribe now</button></article>'));
});

test('an empty document returns an error without throwing', () => {
  expectError('');
});
