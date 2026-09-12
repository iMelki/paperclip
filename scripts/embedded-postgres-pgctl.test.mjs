import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual added lifecycle blocks, with no vendor install or database.
const patch = readFileSync(new URL('../patches/embedded-postgres@18.1.0-beta.16.patch', import.meta.url), 'utf8');
const blocks = patch.split(/^@@/m).map((hunk) => hunk.split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1)).join('\n'));
const startBlock = blocks.find((block) => block.includes('this.process = spawn(pg_ctl'));
const stopBlock = blocks.find((block) => block.includes('const stopProcess = spawn(pg_ctl'));
assert.ok(startBlock && stopBlock, 'both lifecycle blocks must exist');
const startSource = startBlock.slice(startBlock.indexOf("            if (platform() === 'win32')"));
const stopSource = stopBlock.slice(stopBlock.indexOf("            if (platform() === 'win32')"),
  stopBlock.lastIndexOf('            this.serverPid'));

async function runGenerator(generator) {
  let result = generator.next();
  while (!result.done) {
    try {
      result = generator.next(await result.value);
    } catch (error) {
      result = generator.throw(error);
    }
  }
  return result.value;
}

function harness(outcome = { code: 0 }, platform = 'win32') {
  const calls = [];
  const reads = [];
  const logs = [];
  const errors = [];
  const mutations = [];
  const context = {
    path: path.win32, platform: () => platform,
    postgres: 'C:\\Postgres Bin\\postgres.exe', pg_ctl: 'C:\\Postgres Bin\\pg_ctl.exe',
    bin: Promise.resolve({ pg_ctl: 'C:\\Postgres Bin\\pg_ctl.exe' }),
    permissionIds: {}, LC_MESSAGES_LOCALE: 'C',
    process: { env: { SystemRoot: 'C:\\Windows' } },
    ensureBinIsExecutable(file) { mutations.push(['executable', file]); },
    __awaiter: (self, args, ignored, generator) => runGenerator(generator.call(self)),
    fs: {
      async rm(file) { mutations.push(['rm', file]); },
      async readFile(file) {
        reads.push(file);
        return file.endsWith('postmaster.pid') ? '4321\r\n' : 'database ready';
      },
    },
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      calls.push({ file, args: Array.from(args), options, child });
      queueMicrotask(() => {
        if (outcome.error) child.emit('error', outcome.error);
        else {
          child.stderr.emit('data', Buffer.from('pg_ctl diagnostic'));
          child.emit('exit', outcome.code);
        }
      });
      return child;
    },
  };
  const instance = {
    process: new EventEmitter(), serverPid: 99,
    options: {
      databaseDir: 'C:\\DB Dir', port: 54329,
      postgresFlags: [],
      onLog: (message) => logs.push(message), onError: (error) => errors.push(error),
    },
  };
  const execute = (source) => runGenerator(
    new vm.Script(`(function* () { ${source} })`).runInNewContext(context).call(instance),
  );
  return { calls, reads, logs, errors, mutations, context, instance,
    start: () => execute(startSource), stop: () => execute(stopSource) };
}

for (const operation of ['start', 'stop']) {
  for (const code of ['ENOENT', 'EACCES']) {
    test(`${operation} rejects the original ${code} spawn error`, { timeout: 1000 }, async () => {
      const error = Object.assign(new Error(`spawn pg_ctl ${code}`), { code });
      const subject = harness({ error });
      await assert.rejects(subject[operation](), (actual) => actual === error);
      assert.equal(subject.calls.length, 1);
      assert.equal(subject.calls[0].options.windowsHide, true, `${operation} must set windowsHide`);
      assert.equal(subject.reads.length, 0);
    });
  }
  test(`${operation} rejects nonzero exit with diagnostics`, { timeout: 1000 }, async () => {
    const subject = harness({ code: 1 });
    await assert.rejects(subject[operation](), new RegExp(`pg_ctl ${operation} exited with code 1.*diagnostic`));
  });
}

test('start without custom flags preserves spaces and recovers the server PID', async () => {
  const subject = harness();
  await subject.start();
  const call = subject.calls[0];
  assert.equal(call.file, 'C:\\Postgres Bin\\pg_ctl.exe');
  assert.deepEqual(call.args.slice(0, 7), ['start', '-D', 'C:\\DB Dir', '-l', 'C:\\DB Dir\\server.log', '-w', '-o']);
  assert.equal(call.args[7], '-p 54329');
  assert.deepEqual(call.args.slice(8), ['-p', 'C:\\Postgres Bin\\postgres.exe']);
  assert.equal(call.options.windowsHide, true, 'start must set windowsHide');
  assert.equal(call.options.shell, undefined);
  assert.equal(call.options.env.SystemRoot, 'C:\\Windows');
  assert.equal(call.options.env.LC_MESSAGES, 'C');
  assert.equal(call.options.env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(subject.instance.serverPid, 4321);
  assert.ok(subject.logs.includes('database ready'));
});

async function rejectsBeforeEffects(subject, reason) {
  await assert.rejects(subject.start(), reason);
  assert.deepEqual(subject.calls, [], 'guard must reject before spawn');
  assert.deepEqual(subject.mutations, [], 'guard must reject before filesystem mutation');
  assert.deepEqual(subject.reads, [], 'guard must reject before filesystem reads');
}

test('Windows guard rejects invalid port values and types before side effects', async () => {
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '5432', '5432 & secret', null, undefined, {}, 1n]) {
    const subject = harness();
    subject.instance.options.port = port;
    await rejectsBeforeEffects(subject, /^Error: Windows PostgreSQL port must be an integer from 1 to 65535$/);
  }
});

test('Windows guard rejects all custom flags and malformed flag types before side effects', async () => {
  for (const flags of [['-c', 'secret'], [''], '', null, undefined, {}, 0]) {
    const subject = harness();
    subject.instance.options.postgresFlags = flags;
    await rejectsBeforeEffects(subject, /^Error: Custom postgresFlags are unsupported on Windows; use an empty array$/);
  }
});

test('Windows guard rejects unsafe path characters and types before side effects', async () => {
  const badPaths = [null, undefined, 1, {}, '', 'relative', 'C:relative', '\\rooted', '\\\\host\\share',
    ...Array.from('\u0000\u0001\t\r\n\u001f\u007f"\'%!&|<>^()`;*?:', (char) => `C:\\secret${char}path`)];
  for (const field of ['databaseDir', 'postgres', 'pg_ctl', 'SystemRoot', 'log']) {
    for (const value of badPaths) {
      const subject = harness();
      if (field === 'databaseDir') subject.instance.options.databaseDir = value;
      else if (field === 'SystemRoot') subject.context.process.env.SystemRoot = value;
      else if (field === 'log') subject.context.path = { ...path.win32, join: () => value };
      else subject.context[field] = value;
      await rejectsBeforeEffects(subject, /^Error: Unsupported Windows [\w ]+: requires a safe absolute drive path$/);
    }
  }
});

test('Windows guard replaces inherited mixed-case COMSPEC without mutating the parent environment', async () => {
  const subject = harness();
  const env = subject.context.process.env;
  Object.assign(env, { COMSPEC: 'secret&bad', ComSpec: 'other.exe', comspec: '%bad%', cOmSpEc: '!bad!' });
  env.SystemRoot = 'C:\\Windows Dir';
  const original = { ...env };
  await subject.start();
  const childEnv = subject.calls[0].options.env;
  assert.deepEqual(Object.keys(childEnv).filter((key) => key.toUpperCase() === 'COMSPEC'), ['COMSPEC']);
  assert.equal(childEnv.COMSPEC, 'C:\\Windows Dir\\System32\\cmd.exe');
  assert.deepEqual(env, original);
});

test('Windows guard accepts both port boundaries', async () => {
  for (const port of [1, 65535]) {
    const subject = harness();
    subject.instance.options.port = port;
    await subject.start();
    assert.equal(subject.calls[0].args[7], `-p ${port}`);
  }
});

test('POSIX start bypasses Windows-only validation and retains executable preparation', async () => {
  const subject = harness({ code: 0 }, 'linux');
  subject.instance.options.postgresFlags = ['-c', 'max_connections=20'];
  subject.context.process.env = {};
  subject.instance.options.databaseDir = '/tmp/db';
  await subject.start();
  assert.deepEqual(subject.mutations, [['executable', subject.context.postgres]]);
  assert.equal(subject.calls.length, 0, 'extracted block falls through to unchanged POSIX spawn');
});

test('stop waits for pg_ctl fast shutdown instead of the old child exit', async () => {
  const subject = harness();
  await subject.stop();
  assert.deepEqual(subject.calls[0].args, ['stop', '-D', 'C:\\DB Dir', '-m', 'fast', '-w']);
  assert.equal(subject.calls[0].options.windowsHide, true, 'stop must set windowsHide');
  assert.equal(subject.calls[0].options.shell, undefined);
});

test('POSIX stop still signals and waits for the server', async () => {
  const subject = harness({ code: 0 }, 'linux');
  subject.instance.process.kill = (signal) => {
    assert.equal(signal, 'SIGINT');
    queueMicrotask(() => subject.instance.process.emit('exit', 0));
  };
  await subject.stop();
  assert.equal(subject.calls.length, 0);
});
