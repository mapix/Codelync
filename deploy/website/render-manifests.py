#!/usr/bin/env python3
"""Render one website publication phase; never connects or applies resources."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--phase', choices=['prepare', 'route', 'legacy'], required=True)
parser.add_argument('--image', help='Frozen local image for prepare or legacy phase')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--validation-namespace', choices=['codelight'], help='Dry-run projection only; not a deployable new-site manifest')
args = parser.parse_args()
base = Path(__file__).resolve().parent
image_ok = args.image and re.fullmatch(r'docker\.io/library/codelync-website:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', args.image)
if args.phase == 'legacy':
    if not image_ok or args.validation_namespace:
        parser.error('Legacy requires a frozen redirect image and no namespace override')
    result = json.dumps({'spec': {'template': {'spec': {'containers': [
        {'name': 'website', 'image': args.image}
    ]}}}}, indent=2) + '\n'
else:
    documents = (base / 'kubernetes.yaml').read_text().split('\n---\n')
    selected = []
    for document in documents:
        kind = re.search(r'^kind: ([A-Za-z]+)$', document, re.M)
        if not kind:
            parser.error('Website template kind is missing')
        is_route = kind.group(1) == 'Ingress'
        if (args.phase == 'route') == is_route:
            selected.append(document.rstrip())
    result = '\n---\n'.join(selected) + '\n'
    if args.phase == 'prepare':
        if not image_ok:
            parser.error('Prepare requires a frozen codelync-website image tag')
        result = result.replace('docker.io/library/codelync-website:RELEASE_TAG', args.image)
    elif args.image:
        parser.error('Route phase does not take an image')
    if args.validation_namespace:
        result = '# DRY-RUN PROJECTION ONLY; DO NOT APPLY\n' + result.replace('namespace: codelync\n', 'namespace: codelight\n')
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(result)
