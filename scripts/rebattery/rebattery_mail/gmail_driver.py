"""Read-only Gmail driver. Provider access is injectable in synchroniser tests."""
import json
import os
import subprocess
from pathlib import Path
from .core import ProviderError, gog_env


class GmailDriver:
    def call(self, account, *args, timeout=120):
        try:
            env = gog_env()
            # No --wrap-untrusted here: it rewrites subject and body with markers and would corrupt stored mail.
            # Untrusted-content handling is for what agents read back, not for ingestion.
            result = subprocess.run(['/usr/local/bin/gog','--account',account,*args,'--json','--no-input'], env=env, capture_output=True, text=True, timeout=timeout)
            if result.returncode:
                raise ProviderError('gmail_read_failed', provider='gog', returncode=result.returncode)
            return json.loads(result.stdout)
        except (OSError,ValueError,subprocess.TimeoutExpired) as exc:
            raise ProviderError('gmail_read_failed', provider='gog', cause=type(exc).__name__) from exc

    def search(self, account, query):
        token = None
        seen = set()
        while True:
            args = ['gmail','messages','search',query,'--max','500']
            if token:
                args.extend(['--page',token])
            result = self.call(account,*args)
            messages = result if isinstance(result,list) else result.get('messages',[])
            for message in messages:
                if message.get('id') and message['id'] not in seen:
                    seen.add(message['id'])
                    yield message
            next_token = result.get('nextPageToken') if isinstance(result,dict) else None
            if not next_token:
                break
            if next_token == token:
                raise ProviderError('gmail_pagination_stalled')
            token = next_token

    def fetch(self, account, message_id):
        return self.call(account,'gmail','get',message_id,timeout=60)
