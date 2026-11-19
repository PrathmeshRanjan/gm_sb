import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Export an allowlisted tree without publishing the authenticated checkout or its history.
const paths = [
  '.gitignore', 'README.md', 'PHASE-1-RESEARCH.md', 'index.html', 'package.json',
  'package-lock.json', 'playwright.config.ts', 'tsconfig.json', 'vite.config.ts',
  'src', 'tests', 'scripts', 'research/IMPLEMENTATION-EVIDENCE.md', 'research/NUMERICAL-REVIEW.md',
  'public/data', 'public/favicon.svg', 'public/geometry-credits.txt', 'public/geos-wasm-license.txt',
];

function execute(command, args, options = {}) {
  return execFileSync(command, args, { maxBuffer: 20 * 1024 * 1024, ...options });
}

const sourceRevision = execute('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const date = execute('git', ['show', '-s', '--format=%cI', sourceRevision], { encoding: 'utf8' }).trim();
const temporary = mkdtempSync(join(tmpdir(), 'gm-review-source-'));
const output = resolve('dist', 'source');

try {
  const checkout = join(temporary, 'checkout');
  const bare = join(temporary, 'repository.git');
  mkdirSync(checkout);
  const tracked = execute('git', ['ls-tree', '-r', '--name-only', sourceRevision], { encoding: 'utf8' }).trim().split('\n');
  const selected = tracked.filter((file) => paths.some((path) => file === path || file.startsWith(`${path}/`)));
  const contents = execute('git', ['archive', '--format=tar', sourceRevision, '--', ...selected]);
  execute('tar', ['-xf', '-', '-C', checkout], { input: contents });
  execute('git', ['-C', checkout, 'init', '-q', '-b', 'main']);
  execute('git', ['-C', checkout, 'add', '--', '.']);
  execute('git', ['-C', checkout, '-c', 'commit.gpgsign=false', 'commit', '-qm',
    `Reviewed source for application revision ${sourceRevision}`], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Bangkok Site Study',
      GIT_AUTHOR_EMAIL: 'site-study@users.noreply.github.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Bangkok Site Study',
      GIT_COMMITTER_EMAIL: 'site-study@users.noreply.github.com',
      GIT_COMMITTER_DATE: date,
    },
  });
  const reviewRevision = execute('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execute('git', ['clone', '-q', '--bare', '--no-local', checkout, bare]);
  execute('git', ['--git-dir', bare, 'repack', '-ad']);
  execute('git', ['--git-dir', bare, 'update-server-info']);

  const staticGit = join(output, 'repository.git');
  for (const directory of ['info', 'refs/heads', 'objects/info', 'objects/pack']) {
    mkdirSync(join(staticGit, directory), { recursive: true });
  }
  for (const path of ['HEAD', 'info/refs', 'objects/info/packs']) {
    cpSync(join(bare, path), join(staticGit, path));
  }
  writeFileSync(join(staticGit, 'refs', 'heads', 'main'), `${reviewRevision}\n`);
  for (const file of readdirSync(join(bare, 'objects', 'pack'))) {
    if (/^pack-[a-f0-9]+\.(idx|pack)$/.test(file)) {
      cpSync(join(bare, 'objects', 'pack', file), join(staticGit, 'objects', 'pack', file));
    }
  }
  execute('git', ['-C', checkout, 'archive', '--format=zip', '-o', join(output, 'source.zip'), 'HEAD']);
  cpSync(join(checkout, 'README.md'), join(output, 'README.md'));
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ sourceRevision, reviewRevision, branch: 'main' }, null, 2));
  writeFileSync(join(output, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bangkok Site Study source</title><style>
body{margin:0;background:#f4f6f2;color:#16362b;font:16px/1.55 system-ui,sans-serif}main{max-width:48rem;margin:5rem auto;padding:0 1.5rem}h1{font-size:2.3rem;line-height:1.12}a{color:#105e48}code{overflow-wrap:anywhere}li{margin:.45rem 0}
</style></head><body><main><a href="/">Bangkok Site Study</a><h1>Source repository</h1>
<p>Read-only Git mirror of the source, tests, documentation, and attributed map assets for this release.</p>
<ul><li><a href="./source.zip">Download the source ZIP</a></li><li><a href="./README.md">Read setup and build instructions</a></li><li><a href="./manifest.json">View revision metadata</a></li></ul>
<p>Git endpoint <code id="endpoint">/source/repository.git</code></p>
<p>Application revision <code>${sourceRevision}</code><br>Review repository revision <code>${reviewRevision}</code></p>
<script>document.getElementById('endpoint').textContent='git clone '+new URL('./repository.git',location.href).href;</script>
</main></body></html>\n`);
  console.log(`Review source ${reviewRevision} from application ${sourceRevision}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
