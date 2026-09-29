import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmails, htmlToText, isValidEmail } from '../src/utils/csv';

test('extractEmails pulls addresses out of a CSV with a header row', () => {
  const result = extractEmails(
    'name,email,company\nAda,ADA@Example.com,Acme\nBob,bob@x.io,Widgets\n',
  );
  assert.deepEqual(result.emails, ['ada@example.com', 'bob@x.io']);
});

test('extractEmails de-duplicates case-insensitively and reports the count', () => {
  const result = extractEmails('ada@example.com\nADA@EXAMPLE.COM\nbob@x.io\n');
  assert.deepEqual(result.emails, ['ada@example.com', 'bob@x.io']);
  assert.equal(result.duplicates, 1);
});

test('extractEmails handles a bare one-address-per-line list', () => {
  const result = extractEmails('a@b.co\n\nc@d.io\n');
  assert.deepEqual(result.emails, ['a@b.co', 'c@d.io']);
  assert.equal(result.invalidLines, 0);
});

test('extractEmails counts lines that contain no address', () => {
  const result = extractEmails('name,email\nnot an address\nok@x.io\n');
  assert.equal(result.invalidLines, 2); // the header and the junk line
  assert.deepEqual(result.emails, ['ok@x.io']);
});

test('htmlToText drops scripts and keeps block boundaries', () => {
  assert.equal(
    htmlToText('<p>Hi <b>there</b></p><script>tracker()</script><p>Bye</p>'),
    'Hi there\nBye',
  );
});

test('htmlToText decodes the common entities', () => {
  assert.equal(htmlToText('<p>Tom &amp; Jerry &lt;3</p>'), 'Tom & Jerry <3');
});

test('isValidEmail rejects the obvious non-addresses', () => {
  assert.equal(isValidEmail('ada@example.com'), true);
  assert.equal(isValidEmail('ada@example'), false);
  assert.equal(isValidEmail('not-an-address'), false);
});
