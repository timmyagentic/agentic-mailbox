import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build the Mac arm64 package on Apple Silicon.');
const root = process.cwd();
const output = resolve('outputs');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, '.build-'));
const folder = 'Agentic Mailbox';
const app = join(staging, folder);
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true, filter: path => !path.endsWith('.map') && !path.endsWith('/node_modules') });
};
try {
  for (const item of ['dist', 'migrations', 'local', 'scripts/local.mjs', 'scripts/chatgpt-local.mjs', 'scripts/configure-local.mjs', 'scripts/local-settings.mjs',
    '打开本地邮箱.command', '配置本机 OAuth.command', 'LICENSE', 'LICENSE.agentic-inbox', '.wrangler/local-worker']) {
    copy(join(root, item), join(app, item));
  }
  copy(join(root, 'local/README.md'), join(app, '使用说明.md'));
  copy(process.execPath, join(app, 'runtime/node'));
  copy(join(dirname(process.execPath), '../LICENSE'), join(app, 'runtime/NODE-LICENSE'));
  const seen = new Set();
  function include(name, from) {
    const req = createRequire(join(from, 'package.json'));
    const source = req.resolve.paths(name)?.map(candidate => join(candidate, name)).find(candidate => existsSync(join(candidate, 'package.json')));
    if (!source || seen.has(source)) return;
    if (!source.startsWith(join(root, 'node_modules/'))) throw new Error('Unexpected dependency location');
    seen.add(source);
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    copy(source, join(app, relative(root, source)));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) include(dependency, source);
  }
  for (const name of ['miniflare', 'jose', 'openai']) include(name, root);
  // npm installs two copies of the identical workerd executable on macOS.
  const workerdBin = join(app, 'node_modules/workerd/bin/workerd');
  rmSync(workerdBin);
  symlinkSync('../../@cloudflare/workerd-darwin-arm64/bin/workerd', workerdBin);
  // Ship notices for the client and Worker libraries incorporated into the compiled bundles.
  const licenses = new Set();
  function notices(name, from) {
    const req = createRequire(join(from, 'package.json'));
    const dir = req.resolve.paths(name)?.map(base => join(base, name)).find(path => existsSync(join(path, 'package.json')));
    if (!dir || licenses.has(dir)) return;
    licenses.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const target = join(app, 'licenses', pkg.name + '-' + pkg.version);
    for (const file of readdirSync(dir).filter(file => /^(licen[cs]e|notice|copying)([.-]|$)/i.test(file))) {
      copy(join(dir, file), join(target, file));
    }
    for (const dependency of Object.keys(pkg.dependencies || {})) notices(dependency, dir);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(pkg.dependencies)) notices(dependency, root);
  const zip = join(output, 'agentic-mailbox-mac-arm64.zip');
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--keepParent', app, zip]);
  console.log(zip);
} finally { rmSync(staging, { recursive: true, force: true }); }
