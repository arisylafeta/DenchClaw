"""Private, client-side encrypted storage for captured WhatsApp media.

House pattern from database-backups: an ephemeral rclone `crypt` remote over the private
Hetzner bucket, with the established crypt passwords from Bitwarden (REBATTERY_S3_CRYPT_PASSWORD
and REBATTERY_S3_CRYPT_PASSWORD2, read through hermes-secret or the process environment).
Never falls back to unencrypted storage. Objects live under
static/encrypted/whatsapp-media/<account>/<chat>/<message-id>-<sha256>; the key holds
hashes only, no phone numbers or filenames.

Used in-process by the CLI reader/retention and as a small subprocess by the capture service:

    media_store.py put --account A --chat C --message-id M --sha256 H   (plaintext on stdin)
    media_store.py get <key> --sha256 H --out FILE
    media_store.py delete <key>

Every command prints one JSON line and exits non-zero on failure. No secrets are printed.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

DEFAULT_REMOTE = 'rebattery-hel1:rebattery-hermes-storage-hel1-20260719/static/encrypted'
SECRET_CLI = '/root/.hermes/scripts/hermes-secret'
TIMEOUT = 600


class StoreError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def object_key(account, chat, message_id, sha256):
    """Stable key from hashed account/chat plus provider message id and content hash."""
    def short(value):
        return hashlib.sha256(str(value).encode()).hexdigest()[:16]
    account = str(account).split('@')[0].split(':')[0]
    if not re.fullmatch(r'[0-9a-f]{64}', sha256 or ''):
        raise StoreError('invalid_sha256')
    mid = re.sub(r'[^A-Za-z0-9_-]', '_', str(message_id))[:80]
    if not mid:
        raise StoreError('invalid_message_id')
    return f'whatsapp-media/{short(account)}/{short(chat)}/{mid}-{sha256}'


def _secret(name):
    value = os.environ.get(name)
    if value:
        return value
    try:
        result = subprocess.run([SECRET_CLI, name], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StoreError('crypt_secret_unavailable') from exc
    if result.returncode or not result.stdout.strip():
        raise StoreError('crypt_secret_unavailable')
    return result.stdout.strip()


def _obscure(rclone, value):
    result = subprocess.run([rclone, 'obscure', '-'], input=value + '\n', capture_output=True, text=True, timeout=60)
    if result.returncode or not result.stdout.strip():
        raise StoreError('crypt_obscure_failed')
    return result.stdout.strip()


_ENV_CACHE = {}


def crypt_env(rclone='rclone'):
    if rclone in _ENV_CACHE:
        return _ENV_CACHE[rclone]
    env = {k: v for k, v in os.environ.items() if not k.startswith('REBATTERY_S3_CRYPT_PASSWORD')}
    env.update({
        'RCLONE_CONFIG_WAMEDIA_TYPE': 'crypt',
        'RCLONE_CONFIG_WAMEDIA_REMOTE': os.environ.get('REBATTERY_WHATSAPP_MEDIA_REMOTE', DEFAULT_REMOTE),
        'RCLONE_CONFIG_WAMEDIA_FILENAME_ENCRYPTION': 'off',
        'RCLONE_CONFIG_WAMEDIA_DIRECTORY_NAME_ENCRYPTION': 'false',
        'RCLONE_CONFIG_WAMEDIA_PASSWORD': _obscure(rclone, _secret('REBATTERY_S3_CRYPT_PASSWORD')),
        'RCLONE_CONFIG_WAMEDIA_PASSWORD2': _obscure(rclone, _secret('REBATTERY_S3_CRYPT_PASSWORD2')),
    })
    _ENV_CACHE[rclone] = env
    return env


def _run(args, env, stdin=None, stdout=None):
    base = ['ionice', '-c3', 'nice', '-n', '10', 'rclone', *args, '--retries', '3', '--low-level-retries', '5']
    try:
        return subprocess.run(base, env=env, input=stdin, stdout=stdout or subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StoreError('rclone_unavailable') from exc


def _check_key(key):
    if not re.fullmatch(r'whatsapp-media/[0-9a-f]{16}/[0-9a-f]{16}/[A-Za-z0-9_-]+-[0-9a-f]{64}', key or ''):
        raise StoreError('invalid_key')


def _exists(key, env):
    # `rclone cat` of a missing object exits 0 with no output here, so test existence by listing.
    result = _run(['lsf', f'WAMEDIA:{key}'], env)
    return result.returncode == 0 and bool(result.stdout.strip())


def _digest_remote(key, env):
    if not _exists(key, env):
        return None
    result = _run(['cat', f'WAMEDIA:{key}'], env)
    if result.returncode:
        return None
    return hashlib.sha256(result.stdout).hexdigest(), len(result.stdout)


def put(key, data, sha256, env=None):
    """Upload plaintext, then read the whole object back through crypt and compare SHA-256."""
    _check_key(key)
    if hashlib.sha256(data).hexdigest() != sha256:
        raise StoreError('sha256_mismatch')
    env = env or crypt_env()
    existing = _digest_remote(key, env)
    if existing is None:
        if _run(['rcat', f'WAMEDIA:{key}'], env, stdin=data).returncode:
            raise StoreError('upload_failed')
        existing = _digest_remote(key, env)
    if existing != (sha256, len(data)):
        raise StoreError('readback_mismatch')
    return {'ref': key, 'size': len(data), 'sha256': sha256}


def get(key, out, sha256=None, env=None):
    """Download to `out` (a file path) with SHA-256 verified; the file is created 0600."""
    _check_key(key)
    env = env or crypt_env()
    result = _run(['cat', f'WAMEDIA:{key}'], env) if _exists(key, env) else None
    if result is None or result.returncode:
        raise StoreError('object_not_found')
    digest = hashlib.sha256(result.stdout).hexdigest()
    if digest != (sha256 or key[-64:]):
        raise StoreError('sha256_mismatch')
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(result.stdout)
    return {'path': str(out), 'size': len(result.stdout), 'sha256': digest}


def delete(key, env=None):
    _check_key(key)
    env = env or crypt_env()
    if not _exists(key, env):
        return {'ref': key, 'deleted': True}  # already gone
    if _run(['deletefile', f'WAMEDIA:{key}'], env).returncode:
        raise StoreError('delete_failed')
    return {'ref': key, 'deleted': True}


def main(argv=None):
    parser = argparse.ArgumentParser(prog='media_store')
    sub = parser.add_subparsers(dest='cmd', required=True)
    put_p = sub.add_parser('put')
    for flag in ('account', 'chat', 'message-id', 'sha256'):
        put_p.add_argument('--' + flag, required=True)
    get_p = sub.add_parser('get')
    get_p.add_argument('key')
    get_p.add_argument('--sha256')
    get_p.add_argument('--out', required=True)
    sub.add_parser('delete').add_argument('key')
    args = parser.parse_args(argv)
    try:
        if args.cmd == 'put':
            out = put(object_key(args.account, args.chat, args.message_id, args.sha256), sys.stdin.buffer.read(), args.sha256)
        elif args.cmd == 'get':
            out = get(args.key, args.out, args.sha256)
        else:
            out = delete(args.key)
        print(json.dumps(out))
        return 0
    except StoreError as exc:
        print(json.dumps({'error': exc.code}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
