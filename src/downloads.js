'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashFile, validateModel, findBinary, run } = require('./runtime');
async function download(
  url,
  destination,
  { signal, onProgress, minFreeGB = 2, checksum, headers = {} } = {}
) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Downloads require HTTPS.');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.access(destination);
    throw new Error(
      'Destination already exists. Choose another path or validate the existing model.'
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const response = await fetch(url, { signal, headers });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}.`);
  if (new URL(response.url).protocol !== 'https:')
    throw new Error('Insecure download redirect refused.');
  const total = Number(response.headers.get('content-length')) || 0;
  const space = await fs.statfs(path.dirname(destination));
  if (space.bavail * space.bsize < total + minFreeGB * 2 ** 30)
    throw new Error('Not enough disk space, including the configured free-space reserve.');
  const temp = destination + '.' + crypto.randomUUID() + '.part';
  let handle;
  try {
    handle = await fs.open(temp, 'wx');
    let received = 0,
      last = 0;
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('Download cancelled.');
      await handle.writeFile(chunk);
      received += chunk.length;
      if (Date.now() - last > 300) {
        const free = await fs.statfs(path.dirname(destination));
        if (free.bavail * free.bsize < minFreeGB * 2 ** 30)
          throw new Error('Download stopped to preserve the disk-space reserve.');
        onProgress?.({ received, total });
        last = Date.now();
      }
    }
    await handle.close();
    handle = null;
    if (total && received !== total) throw new Error('Download size did not match Content-Length.');
    if (checksum && (await hashFile(temp, signal)).toLowerCase() !== checksum.toLowerCase())
      throw new Error('Download SHA-256 verification failed.');
    // Hard-link commit is atomic and refuses to overwrite an existing destination.
    await fs.link(temp, destination);
    onProgress?.({ received, total, done: true });
    return destination;
  } finally {
    await handle?.close();
    await fs.rm(temp, { force: true });
  }
}
async function modelSource(model, token, signal) {
  if (model.source === 'url') {
    const url = new URL(model.path);
    if (url.protocol !== 'https:') throw new Error('Use an HTTPS model URL.');
    return { url: url.href, name: path.basename(url.pathname), checksum: model.checksum };
  }
  const parts = model.path.split('/');
  if (parts.length < 3)
    throw new Error('Hugging Face identifier must be owner/repository/path/to/file.gguf.');
  const repo = parts.slice(0, 2).join('/'),
    file = parts.slice(2).join('/');
  if (parts.some((x) => !x || x === '..' || x === '.') || !file.toLowerCase().endsWith('.gguf'))
    throw new Error('Specify one complete GGUF file; split/sharded models are not supported.');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let checksum = model.checksum;
  if (!checksum) {
    try {
      const meta = await fetch(
        `https://huggingface.co/api/models/${repo}/tree/main/${parts.slice(2, -1).map(encodeURIComponent).join('/')}?recursive=false`,
        {
          headers,
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)])
        }
      ).then((r) => r.json());
      checksum = meta.find((x) => x.path === file)?.lfs?.oid;
    } catch {}
  }
  return {
    url: `https://huggingface.co/${repo}/resolve/main/${parts.slice(2).map(encodeURIComponent).join('/')}?download=true`,
    name: path.basename(file),
    checksum,
    headers
  };
}
async function downloadModel(model, config, options) {
  const source = await modelSource(model, options.token, options.signal);
  if (config.checksum === 'required' && !source.checksum)
    throw new Error('A SHA-256 is required. Enter the publisher checksum in the model row.');
  if (!source.name.endsWith('.gguf') || /-\d{5}-of-\d{5}\.gguf$/i.test(source.name))
    throw new Error('Select a single-file .gguf model. Sharded GGUF downloads are not supported.');
  const destination = path.join(
    config.modelDirectory,
    `${model.id.replace(/[^a-zA-Z0-9-]/g, '')}-${source.name}`
  );
  await download(source.url, destination, {
    ...options,
    headers: source.headers,
    checksum: source.checksum,
    minFreeGB: config.minFreeGB
  });
  try {
    const details = await validateModel(destination, undefined, options.signal);
    return { path: destination, checksum: source.checksum, ...details };
  } catch (e) {
    await fs.rm(destination, { force: true });
    throw e;
  }
}
async function releasePlan() {
  const response = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
    headers: { 'User-Agent': 'EZLlama' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Release lookup failed: HTTP ${response.status}.`);
  let release = await response.json();
  const platform = process.platform,
    arch = process.arch;
  const pattern =
    platform === 'win32'
      ? new RegExp(`win.*cpu.*${arch === 'arm64' ? 'arm64' : 'x64'}.*\\.zip$`, 'i')
      : platform === 'darwin'
        ? new RegExp(
            `(?:macos|osx).*${arch === 'arm64' ? 'arm64' : 'x64'}.*\\.(?:tar\\.gz|zip)$`,
            'i'
          )
        : new RegExp(
            `(?:ubuntu|linux).*(?:${arch === 'arm64' ? 'arm64|aarch64' : 'x64|x86_64'}).*\\.(?:tar\\.gz|zip)$`,
            'i'
          );
  const compatible = (a) => pattern.test(a.name) && !/cuda|rocm|vulkan|sycl|openvino/i.test(a.name);
  let asset = release.assets.find(compatible);
  if (!asset) {
    // Semantic releases may only point to a build tag; binaries live on the numbered releases.
    const builds = await fetch(
      'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20',
      { headers: { 'User-Agent': 'EZLlama' }, signal: AbortSignal.timeout(20000) }
    );
    if (!builds.ok) throw new Error(`Binary release lookup failed: HTTP ${builds.status}.`);
    for (const candidate of await builds.json())
      if (!candidate.draft && candidate.assets.some(compatible)) {
        release = candidate;
        asset = candidate.assets.find(compatible);
        break;
      }
  }
  if (!asset)
    throw new Error(
      `No compatible CPU release for ${platform}/${arch}. Use PATH or a custom build.`
    );
  const checksum = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
  if (!checksum)
    throw new Error(
      'The release API did not provide a SHA-256 digest. Use a verified custom installation.'
    );
  return {
    version: release.tag_name,
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
    checksum,
    platform: `${platform}/${arch}`
  };
}
async function installRelease(plan, root, options) {
  await fs.mkdir(root, { recursive: true });
  const stage = path.join(root, 'staging-' + crypto.randomUUID());
  await fs.mkdir(stage);
  const archive = path.join(stage, plan.name);
  try {
    await download(plan.url, archive, { ...options, checksum: plan.checksum });
    options.onProgress?.({ stage: 'Verifying archive and extracting…' });
    const listing = await run('tar', ['-tf', archive]);
    if (
      listing.stdout
        .split(/\r?\n/)
        .some(
          (p) =>
            p && (path.isAbsolute(p) || p.split(/[\\/]/).includes('..') || /^[A-Za-z]:/.test(p))
        )
    )
      throw new Error('Unsafe archive path.');
    // Allow ordinary same-directory shared-library symlinks, never directory links or traversal.
    const verbose = await run('tar', ['-tvf', archive]);
    for (const line of verbose.stdout.split('\n')) {
      if (/^h/.test(line)) throw new Error('Archive hard links are unsupported.');
      if (
        /^l/.test(line) &&
        !/\blib[^\s/\\]+(?:\.so(?:\.[\d.]+)?|\.dylib)\s+->\s+lib[^\s/\\]+(?:\.so(?:\.[\d.]+)?|\.dylib)\s*$/.test(
          line
        )
      )
        throw new Error('Unsafe archive symbolic link.');
    }
    await run('tar', ['-xf', archive, '-C', stage], { timeout: 120000 });
    await fs.rm(archive);
    if (options.signal?.aborted) throw new Error('Installation cancelled.');
    const binary = await findBinary(stage);
    await run(binary, ['--version']);
    const installed = path.join(root, 'installed-' + crypto.randomUUID());
    await fs.rename(stage, installed);
    await fs.writeFile(path.join(installed, 'ezllama-release.json'), JSON.stringify(plan, null, 2));
    return installed;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
module.exports = { download, modelSource, downloadModel, releasePlan, installRelease };
