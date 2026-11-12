import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function neverCalled() {
  return 1;
}

const unusedValue = 42;

const out = execSync('ls');
const body = await fetch('https://example.com/data').then((r) => r.text());
fs.writeFileSync('/home/bob/out.txt', body + out);
console.log('done');
