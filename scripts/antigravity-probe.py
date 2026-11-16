#!/usr/bin/env python3
"""Reproducible private Antigravity Desktop probe; never edits /Applications."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import struct
import subprocess
import time

DEFAULT_ROOT = Path.home() / '.codelight-antigravity-probe'


def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2))
    temp.chmod(0o600)
    temp.replace(path)


def rewrite_asar(path, replacements):
    data = path.read_bytes()
    _, header_size, _, json_size = struct.unpack_from('<IIII', data)
    header = json.loads(data[16:16 + json_size])
    payload = bytearray()
    changed = set()

    def walk(node, prefix=''):
        for name, entry in node.get('files', {}).items():
            key = prefix + name
            if 'files' in entry:
                walk(entry, key + '/')
            elif 'offset' in entry and not entry.get('unpacked'):
                start = 8 + header_size + int(entry['offset'])
                content = data[start:start + entry['size']]
                if key in replacements:
                    content = replacements[key](content.decode()).encode()
                    changed.add(key)
                entry['offset'] = str(len(payload))
                entry['size'] = len(content)
                if 'integrity' in entry:
                    block_size = entry['integrity'].get('blockSize', 4 * 1024 * 1024)
                    entry['integrity'] = {'algorithm': 'SHA256',
                        'hash': hashlib.sha256(content).hexdigest(), 'blockSize': block_size,
                        'blocks': [hashlib.sha256(content[n:n + block_size]).hexdigest()
                                   for n in range(0, len(content), block_size)]}
                payload.extend(content)

    walk(header)
    if changed != set(replacements):
        raise RuntimeError('Shipped ASAR contract changed')
    raw = json.dumps(header, separators=(',', ':')).encode()
    padded = (len(raw) + 3) & ~3
    new_header_size = padded + 8
    path.write_bytes(struct.pack('<IIII', 4, new_header_size, new_header_size - 4, len(raw))
                     + raw + b'\0' * (padded - len(raw)) + payload)


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Shipped launcher contract changed: ' + old[:60])
    return text.replace(old, new)


def prepare(root, source):
    app = root / 'Antigravity Probe.app'
    if app.exists():
        raise RuntimeError('Probe already exists; reuse it or choose another --root')
    info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleShortVersionString') != '2.31.2':
        raise RuntimeError('Only inspected Antigravity 2.31.2 is supported')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    subprocess.run(['cp', '-cR', str(source), str(app)], check=True)
    probe_home = root / 'home'
    for folder in [probe_home, root / 'user-data', root / 'logs', root / 'workspace']:
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    source_config = json.loads((Path.home() / '.gemini/config/config.json').read_text())
    config = {key: source_config[key] for key in ['gateway', 'models'] if key in source_config}
    config['userSettings'] = {'remoteControlEnabled': False,
        'remoteControlHostname': 'CodeLight isolated probe'}
    private_json(probe_home / '.gemini/config/config.json', config)
    info['CFBundleIdentifier'] = 'io.codelight.antigravity.probe'
    # Electron locates its helpers using CFBundleName before loading JavaScript.
    # Keep that internal name; the display name and runtime name identify probes.
    info['CFBundleDisplayName'] = 'CodeLight Antigravity Probe'
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))

    def main(text):
        text = replace_once(text, 'const electron_1 = require("electron");',
            'const electron_1 = require("electron");\n'
            'electron_1.app.setName("CodeLight Antigravity Probe");\n'
            'electron_1.app.setPath("userData", process.env.CODELIGHT_AGY_PROBE_ROOT + "/user-data");\n'
            'electron_1.app.setPath("logs", process.env.CODELIGHT_AGY_PROBE_ROOT + "/logs");')
        return replace_once(text,
            'if (!electron_1.app.isDefaultProtocolClient(PROTOCOL, ...protocolClientArgs)) {',
            'if (false && !electron_1.app.isDefaultProtocolClient(PROTOCOL, ...protocolClientArgs)) {')

    def launcher(text):
        return replace_once(text, 'const env = { ...process.env, ...loginShellEnv };',
            'const env = { ...process.env, ...loginShellEnv, HOME: process.env.HOME };')

    rewrite_asar(app / 'Contents/Resources/app.asar',
                 {'dist/main.js': main, 'dist/languageServer.js': launcher})
    entitlements = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(source)],
                                  capture_output=True, check=True).stdout
    ent_path = root / 'probe-entitlements.plist'
    ent_path.write_bytes(entitlements)
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--entitlements',
                    str(ent_path), str(app)], check=True, capture_output=True)
    private_json(root / 'manifest.json', {'version': info['CFBundleShortVersionString'],
        'sourceApp': str(source), 'probeApp': str(app), 'home': str(probe_home),
        'workspace': str(root / 'workspace'),
        'originalAsarSha256': hashlib.sha256((source / 'Contents/Resources/app.asar').read_bytes()).hexdigest(),
        'originalBinarySha256': hashlib.sha256((source / 'Contents/Resources/bin/language_server').read_bytes()).hexdigest(),
        'probeAsarSha256': hashlib.sha256((app / 'Contents/Resources/app.asar').read_bytes()).hexdigest()})
    return {'prepared': True, 'root': str(root), 'version': info['CFBundleShortVersionString']}


def status(root):
    app = root / 'Antigravity Probe.app'
    binary = str(app / 'Contents/Resources/bin/language_server')
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True)
    owners = []
    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[2].startswith(binary + ' '):
            owners.append((int(parts[0]), int(parts[1]), parts[2]))
    if len(owners) != 1:
        return {'running': False, 'owners': len(owners)}
    pid, parent, command = owners[0]
    csrf = re.search(r'--csrf_token(?:=|\s+)(\S+)', command)
    log_path = root / 'logs/language_server.log'
    log = log_path.read_text(errors='replace') if log_path.exists() else ''
    ports = re.findall(r'listening on \w+ port at (\d+) for HTTP\b', log)
    https = re.findall(r'listening on \w+ port at (\d+) for HTTPS\b', log)
    if csrf and ports and re.search(r'with pid ' + str(pid) + r'\b', log):
        start_time = ' '.join(subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True).split())
        endpoint = {'version': 1, 'pid': pid, 'parentPid': parent,
            'binary': binary, 'executable': binary, 'origin': 'http://127.0.0.1:' + ports[-1],
            'startTime': start_time, 'generation': str(pid) + ':' + start_time,
            'appDataDir': 'codelightantigravityprobe',
            'csrfToken': csrf.group(1), 'httpsPort': int(https[-1]) if https else None,
            'home': str(root / 'home'), 'logPath': str(log_path)}
        private_json(root / 'endpoint.json', endpoint)
        private_json(root / 'runtime.json', endpoint)
        return {'running': True, 'pid': pid, 'httpPort': int(ports[-1]),
                'httpsPort': int(https[-1]) if https else None, 'endpointReady': True}
    return {'running': True, 'pid': pid, 'endpointReady': False}


def start(root):
    if status(root)['running']:
        raise RuntimeError('Probe is already running')
    app = root / 'Antigravity Probe.app'
    env = dict(os.environ, HOME=str(root / 'home'), CODELIGHT_AGY_PROBE_ROOT=str(root))
    env.pop('ELECTRON_RUN_AS_NODE', None)
    with (root / 'desktop.log').open('ab') as log:
        process = subprocess.Popen([str(app / 'Contents/MacOS/Antigravity'),
            '--user-data-dir=' + str(root / 'user-data')], cwd=root / 'workspace',
            env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    private_json(root / 'desktop-process.json', {'pid': process.pid})
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = status(root)
        if result.get('endpointReady'):
            return result
        if process.poll() is not None:
            raise RuntimeError('Probe desktop exited; inspect private desktop.log')
        time.sleep(0.25)
    raise RuntimeError('Probe startup timeout; inspect private logs')


def stop(root):
    record = json.loads((root / 'desktop-process.json').read_text())
    pid = record['pid']
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True,
                             text=True).stdout.strip()
    if not command.startswith(str(root / 'Antigravity Probe.app/Contents/MacOS/Antigravity') + ' '):
        raise RuntimeError('Recorded PID no longer belongs to this probe')
    os.kill(pid, signal.SIGTERM)
    return {'stoppedProbePid': pid}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'start', 'status', 'stop'])
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--source', type=Path, default=Path('/Applications/Antigravity.app'))
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    if root == Path.home() or root == Path('/Applications') or root == args.source.resolve():
        raise RuntimeError('An independent private probe directory is required')
    result = prepare(root, args.source.resolve()) if args.action == 'prepare' else globals()[args.action](root)
    print(json.dumps(result))
