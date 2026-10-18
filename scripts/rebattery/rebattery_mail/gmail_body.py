"""Decode raw Gmail MIME bodies without rewriting or sanitising their content."""
import base64
import binascii
from email.message import Message


def extract_bodies(full):
    """Return (text, html, has_attachments), tolerating malformed MIME parts."""
    full = full if isinstance(full, dict) else {}
    message = full.get('message')
    payload = message.get('payload') if isinstance(message, dict) else None
    pending = [payload]
    candidates = {'text/plain': [], 'text/html': []}
    attachments = bool(full.get('attachments'))
    while pending:
        part = pending.pop()
        if not isinstance(part, dict):
            continue
        headers = Message()
        raw_headers = part.get('headers')
        if isinstance(raw_headers, list):
            for header in raw_headers:
                if isinstance(header, dict) and isinstance(header.get('name'), str) and isinstance(header.get('value'), str):
                    headers[header['name']] = header['value']
        body = part.get('body')
        body = body if isinstance(body, dict) else {}
        attached = headers.get_content_disposition() == 'attachment'
        attachments = attachments or attached or bool(part.get('filename')) or bool(body.get('attachmentId'))
        if attached:
            continue
        children = part.get('parts')
        if isinstance(children, list):
            pending.extend(children)
        mime = part.get('mimeType')
        mime = mime.lower().split(';', 1)[0].strip() if isinstance(mime, str) else headers.get_content_type()
        data = body.get('data')
        if mime not in candidates or not isinstance(data, str) or not data:
            continue
        try:
            decoded = base64.b64decode(data + '=' * (-len(data) % 4), altchars=b'-_', validate=True)
            charset = headers.get_content_charset() or 'utf-8'
            try:
                text = decoded.decode(charset, errors='replace')
            except LookupError:
                text = decoded.decode('utf-8', errors='replace')
        except (ValueError, TypeError, binascii.Error):
            continue
        if text:
            candidates[mime].append((len(decoded), text))
    def largest(mime):
        return max(candidates[mime], key=lambda item: item[0])[1] if candidates[mime] else None
    body = full.get('body')
    return (body if isinstance(body, str) and body else largest('text/plain') or '', largest('text/html'), attachments)
